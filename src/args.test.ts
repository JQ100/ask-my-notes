import { describe, expect, test } from "bun:test";

import { collectRepeated } from "./args.ts";

describe("collectRepeated", () => {
  // citty keeps only the last occurrence, which silently dropped patterns.
  test("collects every occurrence of a repeated flag", () => {
    const argv = ["ingest", "./notes", "--exclude", "a.txt", "--exclude", "**/b/**"];
    expect(collectRepeated(argv, "exclude")).toEqual(["a.txt", "**/b/**"]);
  });

  test("handles the --flag=value form", () => {
    expect(collectRepeated(["--exclude=a.txt", "--exclude=b.txt"], "exclude")).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  test("mixes both forms", () => {
    expect(collectRepeated(["--exclude", "a.txt", "--exclude=b.txt"], "exclude")).toEqual([
      "a.txt",
      "b.txt",
    ]);
  });

  test("ignores a valueless occurrence followed by another flag", () => {
    expect(collectRepeated(["--exclude", "--db", "x.db"], "exclude")).toEqual([]);
  });

  test("returns empty when the flag is absent", () => {
    expect(collectRepeated(["ingest", "./notes"], "exclude")).toEqual([]);
  });

  test("does not match a different flag with the same prefix", () => {
    expect(collectRepeated(["--excluded", "a.txt"], "exclude")).toEqual([]);
  });
});
