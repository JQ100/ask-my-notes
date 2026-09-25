import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { displaySource, isExcluded } from "./ingest.ts";

describe("displaySource", () => {
  test("keeps project files project-relative", () => {
    expect(displaySource(join(process.cwd(), "data/corpus.jsonl"))).toBe("data/corpus.jsonl");
  });

  test("writes files elsewhere in home against ~", () => {
    expect(displaySource(join(homedir(), "notes/ideas.md"))).toBe("~/notes/ideas.md");
  });

  test("never emits a ../ path for a file outside the project", () => {
    expect(displaySource(join(homedir(), "sys/jerry_study/plan.md"))).not.toContain("..");
  });

  test("leaves paths outside home absolute", () => {
    expect(displaySource("/etc/hosts")).toBe("/etc/hosts");
  });
});

describe("isExcluded", () => {
  test("matches a bare filename glob at any depth", () => {
    expect(isExcluded("caiwu/onlineAccts.txt", ["*.txt"])).toBe(true);
    expect(isExcluded("notes.md", ["*.txt"])).toBe(false);
  });

  test("scopes a subtree with **", () => {
    expect(isExcluded("caiwu/heloc_2023/application.txt", ["caiwu/**"])).toBe(true);
    expect(isExcluded("cars/corolla.txt", ["caiwu/**"])).toBe(false);
  });

  test("matches an exact relative path", () => {
    expect(isExcluded("refi_2021/w2/w2_lime_2020.txt", ["refi_2021/w2/w2_lime_2020.txt"])).toBe(true);
  });

  test("excludes nothing when no patterns are given", () => {
    expect(isExcluded("anything.txt", [])).toBe(false);
  });

  test("honours any one of several patterns", () => {
    const patterns = ["onlineAccts.txt", "**/w2/**"];
    expect(isExcluded("caiwu/onlineAccts.txt", patterns)).toBe(true);
    expect(isExcluded("refi_2021/w2/w2_lime_2020.txt", patterns)).toBe(true);
    expect(isExcluded("faucet.txt", patterns)).toBe(false);
  });
});
