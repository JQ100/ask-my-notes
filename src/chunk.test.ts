import { expect, test } from "bun:test";

import { chunkText } from "./chunk.ts";

const words = (count: number): string =>
  Array.from({ length: count }, (_, index) => `w${index}`).join(" ");

test("returns nothing for empty input", () => {
  expect(chunkText("")).toEqual([]);
  expect(chunkText("   \n  ")).toEqual([]);
});

test("keeps a short document as a single chunk", () => {
  const chunks = chunkText("one two three", { size: 10, overlap: 2 });
  expect(chunks).toEqual([{ index: 0, text: "one two three" }]);
});

test("splits with the requested overlap", () => {
  const chunks = chunkText(words(25), { size: 10, overlap: 2 });

  expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
  expect(chunks[0]?.text.split(" ")).toHaveLength(10);
  // Chunk 1 starts at stride = size - overlap = 8.
  expect(chunks[1]?.text.split(" ")[0]).toBe("w8");
  // The last two words of chunk 0 reappear at the head of chunk 1.
  expect(chunks[1]?.text.split(" ").slice(0, 2)).toEqual(["w8", "w9"]);
});

test("covers every word", () => {
  const chunks = chunkText(words(100), { size: 30, overlap: 5 });
  const seen = new Set(chunks.flatMap((chunk) => chunk.text.split(" ")));
  expect(seen.size).toBe(100);
});

test("rejects impossible options", () => {
  expect(() => chunkText("a b c", { size: 0 })).toThrow(RangeError);
  expect(() => chunkText("a b c", { size: 10, overlap: 10 })).toThrow(RangeError);
  expect(() => chunkText("a b c", { overlap: -1 })).toThrow(RangeError);
});
