/**
 * The ingest pipeline: read → chunk → embed → store.
 */

import { readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { chunkText, type ChunkOptions } from "./chunk.ts";
import { BATCH_SIZE, createEmbedder } from "./embed.ts";
import {
  appendChunks,
  beginDocument,
  countChunks,
  ensureVectorTable,
  openDatabase,
  type StoredChunk,
} from "./db.ts";

/** Plain-text formats only; PDFs and the like would each need a parser. */
const TEXT_EXTENSIONS = new Set([".md", ".markdown", ".txt", ".text"]);

export interface IngestOptions extends ChunkOptions {
  dbPath?: string;
}

export interface Document {
  /** Stable identifier, shown later as a citation. */
  source: string;
  text: string;
}

async function collectFiles(path: string): Promise<string[]> {
  const info = await stat(path);
  if (info.isFile()) return [path];

  const entries = await readdir(path, { recursive: true, withFileTypes: true });
  return entries
    .filter((entry) => entry.isFile() && TEXT_EXTENSIONS.has(extname(entry.name).toLowerCase()))
    .map((entry) => join(entry.parentPath, entry.name))
    .sort();
}

/** Each line of a .jsonl file is its own document — that is how the HF dataset arrives. */
async function readJsonl(path: string): Promise<Document[]> {
  const documents: Document[] = [];
  const lines = (await Bun.file(path).text()).split("\n");

  for (const [lineNumber, line] of lines.entries()) {
    if (!line.trim()) continue;
    const row: unknown = JSON.parse(line);
    if (typeof row !== "object" || row === null) continue;

    const { id, passage, text } = row as Record<string, unknown>;
    const body = typeof passage === "string" ? passage : typeof text === "string" ? text : undefined;
    if (!body) continue;

    documents.push({ source: `${path}#${id ?? lineNumber}`, text: body });
  }

  return documents;
}

async function loadDocuments(path: string): Promise<Document[]> {
  if (extname(path).toLowerCase() === ".jsonl") return readJsonl(path);

  const files = await collectFiles(path);
  return Promise.all(
    files.map(async (file) => ({
      source: relative(process.cwd(), file) || file,
      text: await Bun.file(file).text(),
    })),
  );
}

export async function ingestPath(source: string, options: IngestOptions = {}): Promise<void> {
  const documents = await loadDocuments(source);
  if (documents.length === 0) {
    console.error(`nothing to ingest at ${source}`);
    return;
  }

  // Chunk everything up front so embedding calls batch across document boundaries.
  const pending = documents.flatMap((document) =>
    chunkText(document.text, options).map((chunk) => ({ source: document.source, chunk })),
  );

  if (pending.length === 0) {
    console.error(`no text found in ${documents.length} document(s)`);
    return;
  }

  const embedder = createEmbedder();
  console.log(
    `ingest: ${documents.length} document(s), ${pending.length} chunk(s) via ${embedder.provider}/${embedder.model}`,
  );

  const db = openDatabase(options.dbPath);
  const documentIds = new Map<string, number>();
  let vectorTableReady = false;
  let stored = 0;

  try {
    for (let start = 0; start < pending.length; start += BATCH_SIZE) {
      const batch = pending.slice(start, start + BATCH_SIZE);
      const vectors = await embedder.embed(batch.map((item) => item.chunk.text));

      const dimensions = vectors[0]?.length;
      if (!dimensions) throw new Error("embedding provider returned no vectors");
      if (!vectorTableReady) {
        ensureVectorTable(db, dimensions);
        vectorTableReady = true;
      }

      // Group this batch by document so each write is a single transaction.
      const grouped = new Map<string, StoredChunk[]>();
      for (const [offset, item] of batch.entries()) {
        const embedding = vectors[offset];
        if (!embedding) throw new Error(`missing embedding for chunk ${start + offset}`);

        const chunks = grouped.get(item.source) ?? [];
        chunks.push({ chunkIndex: item.chunk.index, text: item.chunk.text, embedding });
        grouped.set(item.source, chunks);
      }

      for (const [documentSource, chunks] of grouped) {
        let documentId = documentIds.get(documentSource);
        if (documentId === undefined) {
          documentId = beginDocument(db, documentSource);
          documentIds.set(documentSource, documentId);
        }
        appendChunks(db, documentId, chunks);
      }

      stored += batch.length;
      process.stdout.write(`\rstored ${stored}/${pending.length} chunk(s)`);
    }

    process.stdout.write("\n");
    console.log(`database now holds ${countChunks(db)} chunk(s)`);
  } catch (error) {
    process.stdout.write("\n");
    if (stored > 0) console.error(`kept ${stored} chunk(s) written before the failure`);
    throw error;
  } finally {
    db.close();
  }
}
