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

/**
 * Lowercase, strip punctuation, collapse whitespace — so "Booth." matches "Booth".
 *
 * Digit separators go first: the corpus writes "60,000" and the answer key
 * writes "60000", and stripping punctuation blindly turned the former into two
 * tokens that could never match the latter.
 */
export function normalize(text: string): string {
  return text
    .toLowerCase()
    .replace(/(\d)[,_\u00a0](?=\d)/g, "$1")
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** Yes/no answers carry no string to look for, so they cannot be scored this way. */
export function isScorable(pair: QAPair): boolean {
  const answer = normalize(pair.answer);
  return answer.length > 0 && answer !== "yes" && answer !== "no";
}

/**
 * Words too common to carry evidence. Requiring them made correct retrievals
 * score as misses: the corpus says "bordered by Switzerland to its west and by
 * Austria to its east" while the answer key says "Switzerland and Austria", and
 * exact-substring matching called that wrong.
 */
const STOPWORDS = new Set(
  ("a an and are as at be by for from had has have he her his in is it its of on or per she " +
    "that the their them they this to was were which who with").split(" "),
);

export function contentTokens(text: string): string[] {
  return normalize(text)
    .split(" ")
    .filter((token) => token.length > 0 && !STOPWORDS.has(token));
}

/** Fraction of the answer's content words present in one chunk. */
export function tokenRecall(answer: string, chunk: string): number {
  const wanted = contentTokens(answer);
  if (wanted.length === 0) return 0;

  const present = new Set(contentTokens(chunk));
  return wanted.filter((token) => present.has(token)).length / wanted.length;
}

/** How much of the answer must appear before a chunk counts as containing it. */
export const DEFAULT_THRESHOLD = 0.8;

/**
 * True when a chunk contains the answer verbatim, or holds at least
 * `threshold` of its content words.
 *
 * Known limitation: an answer that reduces to a single common content word
 * ("In the water they are" → "water") will match almost anything. Those come
 * from questions that are unanswerable standalone anyway, and the error is
 * constant across runs, so before/after comparisons still hold.
 */
export function answerFound(
  answer: string,
  chunks: string[],
  threshold: number = DEFAULT_THRESHOLD,
): boolean {
  const needle = normalize(answer);
  if (!needle) return false;

  return chunks.some(
    (chunk) => normalize(chunk).includes(needle) || tokenRecall(answer, chunk) >= threshold,
  );
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
  threshold: number = DEFAULT_THRESHOLD,
): Map<number, number> {
  const rates = new Map<number, number>();
  if (results.length === 0) return rates;

  for (const k of cutoffs) {
    const hits = results.filter((r) => answerFound(r.answer, r.ranked.slice(0, k), threshold)).length;
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
