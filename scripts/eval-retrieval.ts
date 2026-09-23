#!/usr/bin/env bun
/**
 * Measures retrieval hit-rate against the dataset's own question/answer pairs.
 *
 *   bun run scripts/fetch-dataset.ts --qa      # once, to get the questions
 *   bun run scripts/eval-retrieval.ts          # 20 questions, k = 1/3/5/10
 *   bun run scripts/eval-retrieval.ts --n 100 --seed 7 --db data/notes.db
 *
 * No Claude calls — this measures retrieval alone, so a run costs one batch of
 * embeddings and a few seconds. Generation quality is a separate question and
 * cannot be judged until the right chunks are reaching the prompt.
 */

import { BATCH_SIZE, createEmbedder } from "../src/embed.ts";
import { DEFAULT_DB_PATH, openDatabase, searchChunks } from "../src/db.ts";
import { answerFound, hitRates, isScorable, sample, type QAPair } from "../src/eval.ts";

const CUTOFFS = [1, 3, 5, 10];
const QA_PATH = "data/rag-mini-wikipedia-qa.jsonl";

function flag(name: string, fallback: string): string {
  const index = process.argv.indexOf(`--${name}`);
  return index >= 0 ? (process.argv[index + 1] ?? fallback) : fallback;
}

const count = Number(flag("n", "20"));
const seed = Number(flag("seed", "1"));
const dbPath = flag("db", DEFAULT_DB_PATH);
const showMisses = !process.argv.includes("--quiet");

const file = Bun.file(QA_PATH);
if (!(await file.exists())) {
  console.error(`${QA_PATH} not found — run: bun run scripts/fetch-dataset.ts --qa`);
  process.exit(1);
}

const all: QAPair[] = (await file.text())
  .split("\n")
  .filter((line) => line.trim())
  .map((line) => JSON.parse(line) as QAPair);

const scorable = all.filter(isScorable);
const chosen = sample(scorable, Math.min(count, scorable.length), seed);

console.log(
  `${all.length} pairs, ${scorable.length} scorable (yes/no dropped), ` +
    `evaluating ${chosen.length} at seed ${seed}`,
);

// One embedding request per batch of questions, rather than one per question.
const embedder = createEmbedder();
const vectors: number[][] = [];
for (let start = 0; start < chosen.length; start += BATCH_SIZE) {
  const batch = chosen.slice(start, start + BATCH_SIZE);
  vectors.push(...(await embedder.embed(batch.map((pair) => pair.question), "query")));
  process.stdout.write(`\rembedded ${vectors.length}/${chosen.length}`);
}
process.stdout.write("\n");

// Search once at the deepest cut-off; every shallower k is a slice of the same ranking.
const maxK = Math.max(...CUTOFFS);
const db = openDatabase(dbPath);
const results = chosen.map((pair, index) => {
  const vector = vectors[index];
  if (!vector) throw new Error(`missing embedding for question ${pair.id}`);
  return { pair, ranked: searchChunks(db, vector, maxK).map((hit) => hit.text) };
});
db.close();

const rates = hitRates(
  results.map(({ pair, ranked }) => ({ answer: pair.answer, ranked })),
  CUTOFFS,
);

console.log(`\nhit-rate on ${dbPath}`);
for (const k of CUTOFFS) {
  const rate = rates.get(k) ?? 0;
  const bar = "█".repeat(Math.round(rate * 30)).padEnd(30, "·");
  console.log(`  k=${String(k).padStart(2)}  ${bar}  ${(rate * 100).toFixed(1)}%`);
}

if (showMisses) {
  const missed = results.filter(({ pair, ranked }) => !answerFound(pair.answer, ranked));
  console.log(`\nmissed at k=${maxK}: ${missed.length}/${results.length}`);
  for (const { pair } of missed.slice(0, 10)) {
    console.log(`  #${pair.id} ${pair.question}`);
    console.log(`     expected: ${pair.answer.slice(0, 70)}`);
  }
}
