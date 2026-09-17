/**
 * The query pipeline: embed question → nearest chunks → prompt → stream Claude.
 *
 * Claude only ever sees the retrieved excerpts, so a wrong answer is usually a
 * retrieval problem rather than a generation one. The source list printed after
 * the answer is there to make that visible.
 */

import Anthropic from "@anthropic-ai/sdk";

import { openDatabase, searchChunks, type SearchHit } from "./db.ts";
import { createEmbedder } from "./embed.ts";

/** Override with ANSWER_MODEL to try a cheaper or larger model. */
export const DEFAULT_MODEL = process.env.ANSWER_MODEL ?? "claude-opus-5";

/**
 * Low effort: answering from excerpts already in the prompt is a grounded
 * lookup, not a reasoning problem, and a CLI wants the first token quickly.
 * Raise it if answers come back shallow.
 */
const EFFORT = "low" as const;

/** Enough for a cited answer; thinking tokens count against this too. */
const MAX_TOKENS = 8192;

const SYSTEM_PROMPT = [
  "You answer questions using only the numbered excerpts the user provides.",
  "Cite every claim with its excerpt number in square brackets, like [2].",
  "If the excerpts do not contain the answer, say so plainly instead of guessing.",
  "Be concise — a few sentences unless the question needs more.",
].join(" ");

function buildPrompt(question: string, hits: SearchHit[]): string {
  const excerpts = hits
    .map((hit, index) => `[${index + 1}] source: ${hit.source}\n${hit.text}`)
    .join("\n\n");

  return `Excerpts:\n\n${excerpts}\n\nQuestion: ${question}`;
}

/** Which excerpt numbers the answer actually leaned on. */
function citedNumbers(answer: string): Set<number> {
  const cited = new Set<number>();
  for (const match of answer.matchAll(/\[(\d+)\]/g)) cited.add(Number(match[1]));
  return cited;
}

export interface QueryOptions {
  dbPath?: string;
  topK?: number;
  model?: string;
}

export async function answerQuestion(question: string, options: QueryOptions = {}): Promise<void> {
  const topK = options.topK ?? 5;
  const embedder = createEmbedder();
  const db = openDatabase(options.dbPath);

  let hits: SearchHit[];
  try {
    const [embedding] = await embedder.embed([question], "query");
    if (!embedding) throw new Error("embedding provider returned no vectors");
    hits = searchChunks(db, embedding, topK);
  } finally {
    db.close();
  }

  if (hits.length === 0) {
    console.error("no matching chunks — is anything ingested?");
    return;
  }

  const client = new Anthropic();

  // Beta namespace for `fallbacks`: if a safety classifier declines the request,
  // the server retries on another model instead of handing back an empty answer.
  const stream = client.beta.messages.stream({
    model: options.model ?? DEFAULT_MODEL,
    max_tokens: MAX_TOKENS,
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildPrompt(question, hits) }],
    output_config: { effort: EFFORT },
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
  });

  for await (const event of stream) {
    if (event.type === "content_block_delta" && event.delta.type === "text_delta") {
      process.stdout.write(event.delta.text);
    }
  }
  process.stdout.write("\n");

  const final = await stream.finalMessage();

  if (final.stop_reason === "refusal") {
    console.error("\nthe request was declined by a safety classifier");
    return;
  }

  let answer = "";
  for (const block of final.content) {
    if (block.type === "text") answer += block.text;
  }

  const cited = citedNumbers(answer);
  console.log("\nsources:");
  for (const [index, hit] of hits.entries()) {
    const number = index + 1;
    const mark = cited.has(number) ? "*" : " ";
    const where = hit.chunkIndex > 0 ? ` (chunk ${hit.chunkIndex})` : "";
    console.log(`${mark} [${number}] ${hit.source}${where} — distance ${hit.distance.toFixed(3)}`);
  }

  if (final.stop_reason === "max_tokens") {
    console.error("answer hit the token cap and was cut off");
  }
}
