/**
 * The ingest pipeline: read → chunk → embed → store.
 */

import { readdir, stat } from "node:fs/promises";
import { extname, join, relative } from "node:path";

import { chunkText, type ChunkOptions } from "./chunk.ts";
import { createEmbedder, embedAll } from "./embed.ts";
import { countChunks, ensureVectorTable, openDatabase, saveDocument, type StoredChunk } from "./db.ts";

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

  // Chunk everything first so the embedding calls can be batched across documents.
  const pending = documents.flatMap((document) =>
    chunkText(document.text, options).map((chunk) => ({ document, chunk })),
  );

  if (pending.length === 0) {
    console.error(`no text found in ${documents.length} document(s)`);
    return;
  }

  const embedder = createEmbedder();
  console.log(
    `ingest: ${documents.length} document(s), ${pending.length} chunk(s) via ${embedder.provider}/${embedder.model}`,
  );

  const vectors = await embedAll(
    embedder,
    pending.map((item) => item.chunk.text),
    (done, total) => process.stdout.write(`\rembedded ${done}/${total}`),
  );
  process.stdout.write("\n");

  const dimensions = vectors[0]?.length;
  if (!dimensions) throw new Error("embedding provider returned no vectors");

  const db = openDatabase(options.dbPath);
  try {
    ensureVectorTable(db, dimensions);

    // Regroup by document so each is written in a single transaction.
    const byDocument = new Map<string, StoredChunk[]>();
    for (const [index, item] of pending.entries()) {
      const embedding = vectors[index];
      if (!embedding) throw new Error(`missing embedding for chunk ${index}`);

      const chunks = byDocument.get(item.document.source) ?? [];
      chunks.push({ chunkIndex: item.chunk.index, text: item.chunk.text, embedding });
      byDocument.set(item.document.source, chunks);
    }

    for (const [documentSource, chunks] of byDocument) saveDocument(db, documentSource, chunks);

    console.log(`stored ${pending.length} chunk(s); database now holds ${countChunks(db)}`);
  } finally {
    db.close();
  }
}
