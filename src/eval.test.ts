import { describe, expect, test } from "bun:test";

import { answerFound, contentTokens, hitRates, isScorable, normalize, sample, tokenRecall } from "./eval.ts";

describe("normalize", () => {
  test("strips punctuation and case", () => {
    expect(normalize("John Wilkes Booth.")).toBe("john wilkes booth");
  });

  test("collapses whitespace", () => {
    expect(normalize("  Hardin   County\n")).toBe("hardin county");
  });

  test("joins digit groups so 60,000 matches 60000", () => {
    expect(normalize("around 60,000,")).toBe("around 60000");
    expect(normalize("60000")).toBe("60000");
  });

  test("leaves non-numeric commas alone", () => {
    expect(normalize("Turin, Italy")).toBe("turin italy");
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

describe("contentTokens", () => {
  test("drops stopwords", () => {
    expect(contentTokens("Switzerland and Austria.")).toEqual(["switzerland", "austria"]);
  });
});

describe("tokenRecall", () => {
  test("is 1 when every content word is present", () => {
    expect(tokenRecall("Switzerland and Austria", "bordered by Switzerland and Austria")).toBe(1);
  });

  test("is partial when some are missing", () => {
    expect(tokenRecall("Hardin County Kentucky", "born in Hardin County")).toBeCloseTo(2 / 3);
  });
});

describe("answerFound", () => {
  test("matches across punctuation and case", () => {
    expect(answerFound("John Wilkes Booth", ["...shot by John Wilkes Booth, an actor."])).toBe(true);
  });

  test("does not match when absent", () => {
    expect(answerFound("1832", ["Lincoln was born in 1809."])).toBe(false);
  });

  // The case that motivated token overlap: correct retrieval, non-contiguous answer.
  test("matches when the answer is split across the sentence", () => {
    const chunk = "a tiny alpine country, bordered by Switzerland to its west and by Austria to its east";
    expect(answerFound("Switzerland and Austria.", [chunk])).toBe(true);
  });

  test("still rejects a chunk holding only part of the answer", () => {
    expect(answerFound("Switzerland and Austria", ["bordered by Switzerland to its west"])).toBe(false);
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
