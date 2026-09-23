# Ask My Notes

A CLI that ingests documents, embeds them, and answers questions about them
with citations — built on [Bun](https://bun.sh), TypeScript, and Claude.

> **Status: complete.** Both commands run end to end, and retrieval is measured
> against the dataset's own 918 question/answer pairs — see
> [Retrieval evaluation](#retrieval-evaluation) for the numbers and
> [the write-up](writeup.md) for what they turned out to mean.

## Setup

```sh
bun install
```

Embedding needs an API key from one provider — Voyage is preferred when both
are present. Answering needs an Anthropic key:

```sh
export VOYAGE_API_KEY=...       # or OPENAI_API_KEY
export ANTHROPIC_API_KEY=...
```

A `.env` file works too; Bun loads it automatically.

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
bun run index.ts ingest ~/notes --db data/mine.db --size 400 --overlap 40
bun run index.ts query "what did I decide about X?" --db data/mine.db
```

Quote multi-word questions — the question is a single positional argument.

| Command | Argument | Options |
| --- | --- | --- |
| `ingest` | `<path>` | `--db <path>`, `--size <n>`, `--overlap <n>` |
| `query` | `<question>` | `-k, --topK <n>` (1–50, default 5), `--db <path>` |

An answer streams as it is generated, then the retrieved sources print with
`*` marking the ones the answer actually cited:

```
$ bun run index.ts query "What is the capital of Uruguay, and how many people live there?" -k 3

Montevideo is Uruguay's capital [1][3]. Its metropolitan area is home to
1.7 million of the country's 3.3 million people [1].

sources:
* [1] data/rag-mini-wikipedia.jsonl#0  — distance 0.846
  [2] data/rag-mini-wikipedia.jsonl#15 — distance 0.916
* [3] data/rag-mini-wikipedia.jsonl#36 — distance 0.922
```

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

## Retrieval evaluation

The corpus ships with 918 question/answer pairs, so retrieval can be measured
rather than guessed at.

```sh
bun run scripts/fetch-dataset.ts --qa     # once
bun run eval -- --n 100 --seed 1          # vector, k = 1/3/5/10
bun run eval -- --mode hybrid --expand 1
```

Hit-rate on 3,200 Wikipedia passages, 100 questions, seed 1:

| mode | k=1 | k=3 | k=5 | k=10 |
| --- | --- | --- | --- | --- |
| `vector` | 69% | 79% | 82% | **83%** |
| `keyword` (FTS5/BM25) | 60% | 71% | 78% | 82% |
| `hybrid` (RRF fusion) | 67% | 78% | 82% | 83% |

Hybrid does not beat vector here, and a complementarity check says why: at
k=10 the two retrievers agree on 79 of 100 questions and keyword rescues only
2 that vector misses, so perfect fusion would reach 84% against vector's 82%.

Reading the 16 questions neither retriever finds is more informative than the
aggregate — 8 are unanswerable standalone (*"What is the first number on the
page?"*), 3–4 are scoring artifacts, and 4–5 are real failures. Excluding the
unanswerable ones puts retrieval near 93%.

| Flag | Purpose |
| --- | --- |
| `--n <count>` | Questions to sample (default 20; use ≥100 for a usable signal) |
| `--seed <n>` | Deterministic sampling, so runs are comparable |
| `--mode <m>` | `vector`, `keyword`, or `hybrid` |
| `--expand <n>` | Widen each hit by ±n chunks (compare at matched context, not matched k) |
| `--quiet` | Suppress the per-question miss list |

A hit means the answer appears in a retrieved chunk, verbatim or by 80% of its
content words. The dataset gives no gold passage id, so this is a proxy: it
undercounts paraphrases, and it undercounted by 13 points before the scoring
was fixed. The number is worth comparing between runs, not quoting on its own.

## How it fits together

```
ingest:  argv → citty → zod → read → chunk → embed → SQLite + sqlite-vec
query:   argv → citty → zod → embed question → KNN → prompt → stream Claude
```

| Module | Responsibility |
| --- | --- |
| `src/chunk.ts` | Splits text into overlapping windows |
| `src/embed.ts` | Batches text to Voyage or OpenAI |
| `src/db.ts` | SQLite schema, `vec0` KNN, FTS5 keyword search, RRF fusion |
| `src/ingest.ts` | Orchestrates read → chunk → embed → store |
| `src/query.ts` | Retrieval, prompt assembly, streamed answer with citations |
| `src/eval.ts` | Scoring and sampling for the retrieval eval |

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

`bun test` covers the pure logic — chunking, scoring, sampling, citation paths
— without touching the network. The eval scripts do make API calls, so they are
not part of CI.

### Reproducing the eval

`data/` is gitignored, so a fresh clone starts empty:

```sh
bun install
brew install sqlite                              # macOS, for extension loading
bun run fetch-dataset                            # 3,200 passages
bun run scripts/fetch-dataset.ts --qa            # 918 question/answer pairs
bun run index.ts ingest data/rag-mini-wikipedia.jsonl
bun run eval -- --n 100 --seed 1
```

The ingest embeds 3,200 chunks, which costs real money at any provider. The
eval itself embeds only the sampled questions and makes no Claude calls.

## Roadmap

- [x] **Week 1** — CLI skeleton, strict TypeScript, CI
- [x] **Week 2** — chunking, embeddings, SQLite + `sqlite-vec`
- [x] **Week 3** — top-K retrieval, streamed answers from Claude, citations
- [x] **Week 4** — retrieval evals, hybrid search, and [a write-up](writeup.md)

Write-up: **[My RAG evaluation was lying to me, twice](TODO-dev-to-url)**
