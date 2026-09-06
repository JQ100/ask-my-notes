# Ask My Notes

A CLI that ingests documents, embeds them, and answers questions about them
with citations — built on [Bun](https://bun.sh), TypeScript, and Claude.

> **Status: Week 1 of 4.** The CLI skeleton is wired up and type-checked in CI.
> Both commands parse and validate their input, then stop at a stub — ingestion
> lands in Week 2, retrieval and answering in Week 3.

## Install

```sh
bun install
```

## Usage

```sh
bun run index.ts ingest ./notes
bun run index.ts query "what did I decide about X?"
bun run index.ts query "what did I decide about X?" -k 12
```

Quote multi-word questions — the question is a single positional argument.

| Command | Argument | Description |
| --- | --- | --- |
| `ingest` | `<path>` | Chunk and embed a file or directory |
| `query` | `<question>` | Answer a question with citations |

`query` also takes `-k, --topK <n>` (1–50, default 5) for how many chunks to
retrieve.

## How it fits together

```
argv  →  citty (parse + help)  →  zod (validate + coerce)  →  command
```

- **[citty](https://github.com/unjs/citty)** turns `argv` into subcommands and
  generates `--help` from the command definitions.
- **[zod](https://zod.dev)** validates what citty produced at runtime, coercing
  `-k 12` to a number and rejecting anything out of range. TypeScript's types
  are erased before the program runs; zod is what actually guards the boundary.

## Development

```sh
bun run typecheck   # tsc --noEmit, strict
```

CI runs the same typecheck on every push and pull request.

## Roadmap

- [x] **Week 1** — CLI skeleton, strict TypeScript, CI
- [ ] **Week 2** — chunking (~500 tokens, 50-token overlap), embeddings, SQLite + `sqlite-vec`
- [ ] **Week 3** — top-K retrieval, streamed answers from Claude, citations
- [ ] **Week 4** — one of: web UI, tool use, or retrieval evals
