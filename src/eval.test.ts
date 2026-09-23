import { describe, expect, test } from "bun:test";

import { answerFound, hitRates, isScorable, normalize, sample } from "./eval.ts";

describe("normalize", () => {
  test("strips punctuation and case", () => {
    expect(normalize("John Wilkes Booth.")).toBe("john wilkes booth");
  });

  test("collapses whitespace", () => {
    expect(normalize("  Hardin   County\n")).toBe("hardin county");
  });
});

describe("isScorable", () => {
  test("rejects yes/no answers", () => {
    expect(isScorable({ id: 1, question: "q", answer: "yes" })).toBe(false);
    expect(isScorable({ id: 2, question: "q", answer: "No." })).toBe(false);
  });

  test("accepts substantive answers", () => {
    expect(isScorable({ id: 3, question: "q", answer: "18 months" })).toBe(true);
  });
});

describe("answerFound", () => {
  test("matches across punctuation and case", () => {
    expect(answerFound("John Wilkes Booth", ["...shot by John Wilkes Booth, an actor."])).toBe(true);
  });

  test("does not match when absent", () => {
    expect(answerFound("1832", ["Lincoln was born in 1809."])).toBe(false);
  });
});

describe("hitRates", () => {
  const results = [
    { answer: "booth", ranked: ["nothing", "booth was here", "x"] },
    { answer: "1832", ranked: ["1832 it was", "x", "y"] },
  ];

  test("rewards deeper cut-offs", () => {
    const rates = hitRates(results, [1, 3]);
    expect(rates.get(1)).toBe(0.5);
    expect(rates.get(3)).toBe(1);
  });

  test("handles an empty set without dividing by zero", () => {
    expect(hitRates([], [1]).size).toBe(0);
  });
});

describe("sample", () => {
  test("is deterministic for a seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(sample(items, 4, 42)).toEqual(sample(items, 4, 42));
  });

  test("changes with the seed", () => {
    const items = [1, 2, 3, 4, 5, 6, 7, 8];
    expect(sample(items, 4, 42)).not.toEqual(sample(items, 4, 7));
  });
});
