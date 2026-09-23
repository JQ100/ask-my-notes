import { describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";

import { displaySource } from "./ingest.ts";

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
