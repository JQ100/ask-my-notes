/**
 * Splitting documents into overlapping windows.
 *
 * Chunk sizes are measured in whitespace-separated words, not real tokens.
 * That is deliberate for now — a proper tokenizer is a dependency and a speed
 * hit, and retrieval quality barely moves at this scale. Swap in tiktoken later
 * if the numbers start mattering.
 */

export interface Chunk {
  /** Position of this chunk within its document, starting at 0. */
  index: number;
  text: string;
}

export interface ChunkOptions {
  /** Approximate tokens per chunk. */
  size?: number;
  /** Approximate tokens repeated from the end of the previous chunk. */
  overlap?: number;
}

export const DEFAULT_CHUNK_SIZE = 500;
export const DEFAULT_CHUNK_OVERLAP = 50;

export function chunkText(text: string, options: ChunkOptions = {}): Chunk[] {
  const size = options.size ?? DEFAULT_CHUNK_SIZE;
  const overlap = options.overlap ?? DEFAULT_CHUNK_OVERLAP;

  if (size <= 0) throw new RangeError("chunk size must be positive");
  if (overlap < 0) throw new RangeError("chunk overlap must not be negative");
  if (overlap >= size) throw new RangeError("chunk overlap must be smaller than chunk size");

  const words = text.split(/\s+/).filter((word) => word.length > 0);
  if (words.length === 0) return [];

  const stride = size - overlap;
  const chunks: Chunk[] = [];

  for (let start = 0; start < words.length; start += stride) {
    chunks.push({ index: chunks.length, text: words.slice(start, start + size).join(" ") });
    // The final window is short; stop rather than emitting ever-shorter tails.
    if (start + size >= words.length) break;
  }

  return chunks;
}
