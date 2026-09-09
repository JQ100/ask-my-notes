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

/** Inserts a document and its chunks, replacing any earlier ingest of the same source. */
export function saveDocument(db: Database, source: string, chunks: StoredChunk[]): void {
  const save = db.transaction((): void => {
    const existing = db
      .query<{ id: number }, [string]>("select id from documents where source = ?")
      .get(source);

    if (existing) {
      db.run("delete from chunk_vectors where chunk_id in (select id from chunks where document_id = ?)", [existing.id]);
      db.run("delete from documents where id = ?", [existing.id]);
    }

    db.run("insert into documents (source, ingested_at) values (?, ?)", [
      source,
      new Date().toISOString(),
    ]);
    const documentId = Number(
      db.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id,
    );

    const insertChunk = db.prepare(
      "insert into chunks (document_id, chunk_index, text) values (?, ?, ?)",
    );
    const insertVector = db.prepare(
      "insert into chunk_vectors (chunk_id, embedding) values (?, ?)",
    );

    for (const chunk of chunks) {
      insertChunk.run(documentId, chunk.chunkIndex, chunk.text);
      const chunkId = Number(
        db.query<{ id: number }, []>("select last_insert_rowid() as id").get()?.id,
      );
      insertVector.run(chunkId, new Float32Array(chunk.embedding));
    }
  });

  save();
}

export function countChunks(db: Database): number {
  return db.query<{ n: number }, []>("select count(*) as n from chunks").get()?.n ?? 0;
}
