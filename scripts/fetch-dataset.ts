#!/usr/bin/env bun
/**
 * Downloads rag-datasets/rag-mini-wikipedia to data/.
 *
 * Uses the Hugging Face datasets-server rows API, which returns JSON — no
 * parquet reader, no auth, no `datasets` library.
 *
 *   bun run scripts/fetch-dataset.ts            # the passages (default)
 *   bun run scripts/fetch-dataset.ts --qa       # the question/answer pairs
 */

import { z } from "zod";

const DATASET = "rag-datasets/rag-mini-wikipedia";
const PAGE_SIZE = 100; // the API's maximum

/** The corpus and its questions live in the same dataset under different configs. */
const SETS = {
  passages: {
    config: "text-corpus",
    split: "passages",
    output: "data/rag-mini-wikipedia.jsonl",
    row: z.object({ id: z.number(), passage: z.string() }),
  },
  qa: {
    config: "question-answer",
    split: "test",
    output: "data/rag-mini-wikipedia-qa.jsonl",
    row: z.object({ id: z.number(), question: z.string(), answer: z.string() }),
  },
} as const;

const SET = process.argv.includes("--qa") ? SETS.qa : SETS.passages;
const { config: CONFIG, split: SPLIT, output: OUTPUT } = SET;

const pageSchema = z.object({
  rows: z.array(z.object({ row: SET.row })),
});

async function fetchPage(offset: number): Promise<z.infer<typeof SET.row>[]> {
  const url = new URL("https://datasets-server.huggingface.co/rows");
  url.searchParams.set("dataset", DATASET);
  url.searchParams.set("config", CONFIG);
  url.searchParams.set("split", SPLIT);
  url.searchParams.set("offset", String(offset));
  url.searchParams.set("length", String(PAGE_SIZE));

  const response = await fetch(url);
  if (!response.ok) throw new Error(`HF request failed (${response.status}): ${await response.text()}`);

  return pageSchema.parse(await response.json()).rows.map((entry) => entry.row);
}

const lines: string[] = [];
for (let offset = 0; ; offset += PAGE_SIZE) {
  const rows = await fetchPage(offset);
  if (rows.length === 0) break;

  for (const row of rows) lines.push(JSON.stringify(row));
  process.stdout.write(`\rfetched ${lines.length} rows`);

  if (rows.length < PAGE_SIZE) break;
}
process.stdout.write("\n");

await Bun.write(OUTPUT, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} rows to ${OUTPUT}`);
