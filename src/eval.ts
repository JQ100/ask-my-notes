/**
 * Scoring helpers for the retrieval eval.
 *
 * The dataset gives questions and answers but never says which passage holds
 * the answer, so there is no gold chunk id to compare against. Instead a
 * retrieval counts as a hit when the answer string turns up in one of the
 * retrieved chunks — "answer recall". It is a proxy: it misses paraphrases and
 * it can fire on a chunk that happens to contain the string for another reason.
 * Both kinds of error stay constant as you change k, which is what makes the
 * comparison between runs meaningful even when the absolute number is soft.
 */

export interface QAPair {
  id: number;
  question: string;
  answer: string;
}

/** Lowercase, strip punctuation, collapse whitespace — so "Booth." matches "Booth". */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Yes/no answers carry no string to look for, so they cannot be scored this way. */
export function isScorable(pair: QAPair): boolean {
  const answer = normalize(pair.answer);
  return answer.length > 0 && answer !== "yes" && answer !== "no";
}

/** True when the answer appears in any of the given chunk texts. */
export function answerFound(answer: string, chunks: string[]): boolean {
  const needle = normalize(answer);
  if (!needle) return false;
  return chunks.some((chunk) => normalize(chunk).includes(needle));
}

/**
 * Hit rate at each cut-off, computed from one ranked list per question.
 *
 * Searching once at the largest k and slicing gives every smaller k for free —
 * no extra queries, and each k sees exactly the same ranking.
 */
export function hitRates(
  results: { answer: string; ranked: string[] }[],
  cutoffs: number[],
): Map<number, number> {
  const rates = new Map<number, number>();
  if (results.length === 0) return rates;

  for (const k of cutoffs) {
    const hits = results.filter((r) => answerFound(r.answer, r.ranked.slice(0, k))).length;
    rates.set(k, hits / results.length);
  }

  return rates;
}

/** Deterministic PRNG so a given seed always samples the same questions. */
export function mulberry32(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Fisher-Yates using the seeded PRNG, then take the first `count`. */
export function sample<T>(items: T[], count: number, seed: number): T[] {
  const random = mulberry32(seed);
  const pool = [...items];

  for (let i = pool.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [pool[i], pool[j]] = [pool[j]!, pool[i]!];
  }

  return pool.slice(0, count);
}
