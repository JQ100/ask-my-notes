# Ask My Notes

A CLI that ingests documents, embeds them, and answers questions about them
with citations — built on [Bun](https://bun.sh), TypeScript, and Claude.

> **Status: Week 2 of 4.** `ingest` runs end to end — chunking, embedding, and
> storage into SQLite with vector search. `query` still stops at a stub;
> retrieval and answering land in Week 3.

## Setup

```sh
bun install
```

Embedding needs an API key from one provider — Voyage is preferred when both
are present:

```sh
export VOYAGE_API_KEY=...    # or
export OPENAI_API_KEY=...
```

**macOS only:** Apple's system SQLite is compiled without extension loading, so
`sqlite-vec` cannot load into it. Install Homebrew's build once:

```sh
brew install sqlite
```

The database layer finds it automatically, or set `CUSTOM_SQLITE_PATH`.

## Usage

```sh
# grab the sample corpus (~3,200 Wikipedia passages)
bun run fetch-dataset

bun run index.ts ingest data/rag-mini-wikipedia.jsonl
bun run index.ts ingest ./notes --size 400 --overlap 40
bun run index.ts query "what did I decide about X?" -k 12
```

Quote multi-word questions — the question is a single positional argument.

| Command | Argument | Options |
| --- | --- | --- |
| `ingest` | `<path>` | `--db <path>`, `--size <n>`, `--overlap <n>` |
| `query` | `<question>` | `-k, --topK <n>` (1–50, default 5) |

`ingest` accepts a single file, a directory (walked recursively for `.md` and
`.txt`), or a `.jsonl` file where each line is one document. Re-ingesting the
same source replaces its previous chunks rather than duplicating them.

### Environment

| Variable | Purpose |
| --- | --- |
| `VOYAGE_API_KEY` / `OPENAI_API_KEY` | Selects the embedding provider |
| `EMBED_MODEL` | Overrides the default model |
| `EMBED_BASE_URL` | Points the embedder at a proxy or mock |
| `CUSTOM_SQLITE_PATH` | An extension-capable `libsqlite3` |

## How it fits together

```
argv → citty (parse + help) → zod (validate) → ingest
                                                 │
                    read → chunk → embed → SQLite + sqlite-vec
```

| Module | Responsibility |
| --- | --- |
| `src/chunk.ts` | Splits text into overlapping windows |
| `src/embed.ts` | Batches text to Voyage or OpenAI |
| `src/db.ts` | SQLite schema plus a `vec0` virtual table |
| `src/ingest.ts` | Orchestrates read → chunk → embed → store |

- **[citty](https://github.com/unjs/citty)** turns `argv` into subcommands and
  generates `--help` from the command definitions.
- **[zod](https://zod.dev)** validates at runtime — coercing `-k 12` to a
  number, rejecting out-of-range values, and checking API responses.
  TypeScript's types are erased before the program runs; zod guards the
  boundaries.

Chunk sizes are measured in whitespace-separated words rather than real tokens.
That is deliberate — a tokenizer is a dependency and a speed hit, and retrieval
quality barely moves at this scale.

## Development

```sh
bun run typecheck   # tsc --noEmit, strict
bun test
```

CI runs both on every push and pull request.

## Roadmap

- [x] **Week 1** — CLI skeleton, strict TypeScript, CI
- [x] **Week 2** — chunking, embeddings, SQLite + `sqlite-vec`
- [ ] **Week 3** — top-K retrieval, streamed answers from Claude, citations
- [ ] **Week 4** — one of: web UI, tool use, or retrieval evals
