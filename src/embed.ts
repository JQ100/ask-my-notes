/**
 * Embedding text via whichever provider has a key in the environment.
 *
 * Claude does not expose an embeddings endpoint, so generation (Week 3) and
 * embedding (here) come from different vendors. Voyage is Anthropic's
 * recommended partner; OpenAI is the fallback named in the plan.
 */

import { z } from "zod";

export interface Embedder {
  readonly provider: "voyage" | "openai";
  readonly model: string;
  /** Embeds a batch of texts, returning one vector per input, in order. */
  embed(texts: string[]): Promise<number[][]>;
}

/** Providers cap inputs per request; stay well under the lowest cap. */
const BATCH_SIZE = 96;

const responseSchema = z.object({
  data: z.array(z.object({ embedding: z.array(z.number()) })),
});

/** Both providers expose the same path, so one base URL covers mocks and proxies. */
function endpoint(base: string, env: Record<string, string | undefined>): string {
  return `${env.EMBED_BASE_URL ?? base}/v1/embeddings`;
}

async function post(url: string, key: string, body: unknown): Promise<number[][]> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "content-type": "application/json", authorization: `Bearer ${key}` },
    body: JSON.stringify(body),
  });

  if (!response.ok) {
    throw new Error(`embedding request failed (${response.status}): ${await response.text()}`);
  }

  const parsed = responseSchema.safeParse(await response.json());
  if (!parsed.success) throw new Error("embedding response did not match the expected shape");

  return parsed.data.data.map((item) => item.embedding);
}

/**
 * Picks a provider from the environment. Prefers Voyage when both keys are set.
 * Override the model with EMBED_MODEL.
 */
export function createEmbedder(env: Record<string, string | undefined> = process.env): Embedder {
  const voyageKey = env.VOYAGE_API_KEY;
  if (voyageKey) {
    const model = env.EMBED_MODEL ?? "voyage-3.5";
    return {
      provider: "voyage",
      model,
      embed: (texts) =>
        post(endpoint("https://api.voyageai.com", env), voyageKey, {
          model,
          input: texts,
          input_type: "document",
        }),
    };
  }

  const openaiKey = env.OPENAI_API_KEY;
  if (openaiKey) {
    const model = env.EMBED_MODEL ?? "text-embedding-3-small";
    return {
      provider: "openai",
      model,
      embed: (texts) =>
        post(endpoint("https://api.openai.com", env), openaiKey, { model, input: texts }),
    };
  }

  throw new Error(
    "no embedding API key found — set VOYAGE_API_KEY or OPENAI_API_KEY (a .env file works)",
  );
}

/** Embeds any number of texts, batching to respect per-request limits. */
export async function embedAll(
  embedder: Embedder,
  texts: string[],
  onProgress?: (done: number, total: number) => void,
): Promise<number[][]> {
  const vectors: number[][] = [];

  for (let start = 0; start < texts.length; start += BATCH_SIZE) {
    vectors.push(...(await embedder.embed(texts.slice(start, start + BATCH_SIZE))));
    onProgress?.(Math.min(start + BATCH_SIZE, texts.length), texts.length);
  }

  return vectors;
}
