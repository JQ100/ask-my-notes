#!/usr/bin/env bun
/**
 * Downloads rag-datasets/rag-mini-wikipedia to data/rag-mini-wikipedia.jsonl.
 *
 * Uses the Hugging Face datasets-server rows API, which returns JSON — no
 * parquet reader, no auth, no `datasets` library.
 *
 *   bun run scripts/fetch-dataset.ts
 */

import { z } from "zod";

const DATASET = "rag-datasets/rag-mini-wikipedia";
const CONFIG = "text-corpus";
const SPLIT = "passages";
const PAGE_SIZE = 100; // the API's maximum
const OUTPUT = "data/rag-mini-wikipedia.jsonl";

const pageSchema = z.object({
  rows: z.array(z.object({ row: z.object({ id: z.number(), passage: z.string() }) })),
});

async function fetchPage(offset: number): Promise<{ id: number; passage: string }[]> {
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
  process.stdout.write(`\rfetched ${lines.length} passages`);

  if (rows.length < PAGE_SIZE) break;
}
process.stdout.write("\n");

await Bun.write(OUTPUT, lines.join("\n") + "\n");
console.log(`wrote ${lines.length} passages to ${OUTPUT}`);
