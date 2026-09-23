/**
 * SQLite storage, one file on disk, no server.
 *
 * Vectors live in a `vec0` virtual table from the sqlite-vec extension, which
 * does the nearest-neighbour search in Week 3. macOS ships a SQLite compiled
 * without extension loading, so we point Bun at Homebrew's build first.
 */

import { Database } from "bun:sqlite";
import * as sqliteVec from "sqlite-vec";

const SQLITE_CANDIDATES = [
  process.env.CUSTOM_SQLITE_PATH,
  "/opt/homebrew/opt/sqlite/lib/libsqlite3.dylib",
  "/usr/local/opt/sqlite/lib/libsqlite3.dylib",
].filter((path): path is string => typeof path === "string");

export const DEFAULT_DB_PATH = "data/notes.db";

export interface StoredChunk {
  chunkIndex: number;
  text: string;
  embedding: number[];
}

let customSqliteConfigured = false;

/** Extension loading needs a SQLite build that allows it; only macOS needs help. */
function useExtensionCapableSqlite(): void {
  if (customSqliteConfigured || process.platform !== "darwin") return;

  for (const candidate of SQLITE_CANDIDATES) {
    if (!Bun.file(candidate).size) continue;
    Database.setCustomSQLite(candidate);
    customSqliteConfigured = true;
    return;
  }

  throw new Error(
    "no extension-capable SQLite found — run `brew install sqlite`, " +
      "or set CUSTOM_SQLITE_PATH to a libsqlite3 built with extension support",
  );
}

export function openDatabase(path: string = DEFAULT_DB_PATH): Database {
  useExtensionCapableSqlite();

  const db = new Database(path, { create: true });
  db.loadExtension(sqliteVec.getLoadablePath());
  db.run("pragma foreign_keys = on");
  db.run("pragma journal_mode = wal");

  db.run(`
    create table if not exists meta (
      key   text primary key,
      value text not null
    );
    create table if not exists documents (
      id          integer primary key,
      source      text not null unique,
      ingested_at text not null
    );
    create table if not exists chunks (
      id          integer primary key,
      document_id integer not null references documents(id) on delete cascade,
      chunk_index integer not null,
      text        text not null,
      unique (document_id, chunk_index)
    );
  `);

  return db;
}

/**
 * Creates the vector table on first use, once the embedding width is known.
 * Dimensions are fixed at creation, so a model change means a fresh database.
 */
export function ensureVectorTable(db: Database, dimensions: number): void {
  const row = db.query<{ value: string }, []>("select value from meta where key = 'dimensions'").get();

  if (row) {
    if (Number(row.value) !== dimensions) {
      throw new Error(
        `this database holds ${row.value}-dimension vectors but the current model produces ` +
          `${dimensions} — delete the database or point at a different one`,
      );
    }
    return;
  }

  db.run(
    `create virtual table if not exists chunk_vectors using vec0(
       chunk_id  integer primary key,
       embedding float[${dimensions}]
     )`,
  );
  db.run("insert into meta (key, value) values ('dimensions', ?)", [String(dimensions)]);
}

/**
 * Clears any previous ingest of `source` and returns a fresh document id.
 *
 * Chunks are appended afterwards, batch by batch, so a crash mid-ingest leaves
 * the document partially populated rather than losing the whole run. That is a
 * deliberate trade of atomicity for resumability and progress reporting.
 */
export function beginDocument(db: Database, source: string): number {
  const start = db.transaction((): number => {
    const existing = db
      .query<{ id: number }, [string]>("select id from documents where source = ?")
      .get(source);

    if (existing) {
      db.run(
        "delete from chunk_vectors where chunk_id in (select id from chunks where document_id = ?)",
        [existing.id],
      );
      db.run("delete from documents where id = ?", [existing.id]);
    }

    db.run("insert into documents (source, ingested_at) values (?, ?)", [
      source,
      new Date().toISOString(),
    ]);

    return Number(db.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id);
  });

  return start();
}

/** Appends chunks and their vectors to an existing document, in one transaction. */
export function appendChunks(db: Database, documentId: number, chunks: StoredChunk[]): void {
  const insertChunk = db.prepare(
    "insert into chunks (document_id, chunk_index, text) values (?, ?, ?)",
  );
  const insertVector = db.prepare("insert into chunk_vectors (chunk_id, embedding) values (?, ?)");

  const append = db.transaction((): void => {
    for (const chunk of chunks) {
      insertChunk.run(documentId, chunk.chunkIndex, chunk.text);
      const chunkId = Number(
        db.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id,
      );
      insertVector.run(chunkId, new Float32Array(chunk.embedding));
    }
  });

  append();
}

export function countChunks(db: Database): number {
  return db.query<{ n: number }, []>("select count(*) as n from chunks").get()?.n ?? 0;
}

export interface SearchHit {
  chunkId: number;
  /** The document this chunk came from, shown as the citation. */
  source: string;
  chunkIndex: number;
  text: string;
  /** Cosine-ish distance from sqlite-vec; smaller is closer. */
  distance: number;
}

/**
 * Nearest neighbours to `embedding`, closest first.
 *
 * `match` plus `k` is sqlite-vec's KNN form — a plain `order by ... limit` would
 * scan every vector instead of using the index.
 */
export function searchChunks(db: Database, embedding: number[], k: number): SearchHit[] {
  const row = db.query<{ value: string }, []>("select value from meta where key = 'dimensions'").get();

  if (!row) throw new Error("this database holds no embeddings yet — run `ingest` first");
  if (Number(row.value) !== embedding.length) {
    throw new Error(
      `this database holds ${row.value}-dimension vectors but the current model produces ` +
        `${embedding.length} — re-ingest with the same model, or point at a different database`,
    );
  }

  return db
    .query<SearchHit, [Float32Array, number]>(
      `select v.chunk_id    as chunkId,
              d.source      as source,
              c.chunk_index as chunkIndex,
              c.text        as text,
              v.distance    as distance
         from chunk_vectors v
         join chunks c    on c.id = v.chunk_id
         join documents d on d.id = c.document_id
        where v.embedding match ? and k = ?
        order by v.distance`,
    )
    .all(new Float32Array(embedding), k);
}

/**
 * Keyword search over the same chunks, using SQLite's built-in FTS5.
 *
 * Vector search is blind to exact tokens — a surname, an error code, a serial
 * number — because those carry little semantic signal and get smeared across
 * the embedding space. BM25 is the opposite: it only sees literal terms. The
 * two fail in different places, which is the whole argument for running both.
 */

/** An FTS5 index over `chunks`, storing no text of its own. */
export function ensureKeywordIndex(db: Database): void {
  db.run(
    `create virtual table if not exists chunks_fts using fts5(
       text,
       content='chunks',
       content_rowid='id',
       tokenize='porter unicode61'
     )`,
  );

  // Rebuilding is milliseconds at this scale, and it keeps the index honest
  // after an ingest without needing triggers on the chunks table.
  db.run("insert into chunks_fts(chunks_fts) values('rebuild')");
}

/**
 * Questions are prose, and FTS5's query language would choke on the
 * punctuation, so reduce to bare terms joined by OR.
 */
function ftsQuery(text: string): string {
  const terms = text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((term) => term.length > 1);

  return [...new Set(terms)].map((term) => `"${term}"`).join(" OR ");
}

export function keywordSearch(db: Database, text: string, k: number): number[] {
  const match = ftsQuery(text);
  if (!match) return [];

  return db
    .query<{ chunkId: number }, [string, number]>(
      "select rowid as chunkId from chunks_fts where chunks_fts match ? order by rank limit ?",
    )
    .all(match, k)
    .map((row) => row.chunkId);
}

export interface FusedHit {
  chunkId: number;
  source: string;
  chunkIndex: number;
  text: string;
  /** Reciprocal-rank-fusion score; larger is better. */
  score: number;
}

/** Reciprocal rank fusion: rank position matters, raw scores do not. */
const RRF_K = 60;

/**
 * Merges the two rankings by position rather than by score.
 *
 * Distances and BM25 scores live on incommensurable scales, so adding them
 * would be meaningless. RRF sidesteps that: a chunk ranked 1st by either
 * retriever scores 1/(60+1), and agreement between them accumulates.
 */
export function hybridSearch(
  db: Database,
  embedding: number[],
  text: string,
  k: number,
): FusedHit[] {
  // Fuse over a deeper pool than we return, so a chunk ranked 8th by one
  // retriever and 2nd by the other can still surface.
  const pool = Math.max(k * 4, 20);

  const vector = searchChunks(db, embedding, pool).map((hit) => hit.chunkId);
  const keyword = keywordSearch(db, text, pool);

  const scores = new Map<number, number>();
  for (const ranking of [vector, keyword]) {
    ranking.forEach((chunkId, index) => {
      scores.set(chunkId, (scores.get(chunkId) ?? 0) + 1 / (RRF_K + index + 1));
    });
  }

  const top = [...scores.entries()]
    .sort(([, a], [, b]) => b - a)
    .slice(0, k);
  if (top.length === 0) return [];

  const rows = db
    .query<Omit<FusedHit, "score">, []>(
      `select c.id as chunkId, d.source as source, c.chunk_index as chunkIndex, c.text as text
         from chunks c
         join documents d on d.id = c.document_id
        where c.id in (${top.map(([id]) => id).join(",")})`,
    )
    .all();

  const byId = new Map(rows.map((row) => [row.chunkId, row]));

  return top.flatMap(([chunkId, score]) => {
    const row = byId.get(chunkId);
    return row ? [{ ...row, score }] : [];
  });
}

/**
 * The text around a chunk, not just the chunk itself.
 *
 * Chunk ids are handed out in reading order at ingest — document by document,
 * chunk_index ascending — so neighbouring ids are neighbouring text. That makes
 * `id ± radius` a cheap stand-in for "the passage this sentence came from",
 * which matters when a chunk lost its subject to the split: "He graduated in
 * ecclesiastical law" is unfindable by name, while the passage before it says
 * "Amedeo Avogadro was born in Turin".
 *
 * The assumption breaks at document boundaries, where id+1 is an unrelated
 * document. That is tolerable for a sequential corpus and the reason this is an
 * eval-time option rather than the CLI's default.
 */
export function neighbourhood(db: Database, chunkId: number, radius: number): string {
  if (radius <= 0) {
    return (
      db.query<{ text: string }, [number]>("select text from chunks where id = ?").get(chunkId)
        ?.text ?? ""
    );
  }

  return db
    .query<{ text: string }, [number, number]>(
      "select text from chunks where id between ? and ? order by id",
    )
    .all(chunkId - radius, chunkId + radius)
    .map((row) => row.text)
    .join(" ");
}
