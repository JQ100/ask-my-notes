#!/usr/bin/env bun
/**
 * Ask My Notes — a CLI that ingests documents, embeds them, and answers
 * questions with citations via Claude.
 *
 *   bun run index.ts ingest ./notes
 *   bun run index.ts query "what did I decide about X?"
 *
 * citty parses argv and renders usage; zod validates what came back, so the
 * command bodies below only ever see values they can trust.
 */

import { defineCommand, runMain } from "citty";
import { z } from "zod";

const ingestSchema = z.object({
  source: z.string().min(1, "path is required"),
});

const querySchema = z.object({
  question: z.string().min(1, "question is required"),
  topK: z.coerce
    .number("top-k must be a number")
    .int("top-k must be a whole number")
    .min(1, "top-k must be at least 1")
    .max(50, "top-k must be at most 50")
    .default(5),
});

/** Validate citty's output, or print each issue and exit non-zero. */
function validate<T extends z.ZodType>(schema: T, input: unknown): z.infer<T> {
  const result = schema.safeParse(input);
  if (!result.success) {
    for (const issue of result.error.issues) {
      const where = issue.path.join(".");
      console.error(where ? `${where}: ${issue.message}` : issue.message);
    }
    process.exit(1);
  }
  return result.data;
}

const ingest = defineCommand({
  meta: {
    name: "ingest",
    description: "chunk and embed documents",
  },
  args: {
    source: {
      type: "positional",
      description: "file or directory to ingest",
      required: true,
    },
  },
  run({ args }) {
    const { source } = validate(ingestSchema, { source: args.source });

    // Week 2: walk the path, chunk at ~500 tokens with 50-token overlap,
    // embed each chunk, write to SQLite + sqlite-vec.
    console.log(`ingest: ${source}`);
    console.error("not implemented (Week 2)");
  },
});

const query = defineCommand({
  meta: {
    name: "query",
    description: "answer a question with citations",
  },
  args: {
    question: {
      type: "positional",
      description: "the question to answer",
      required: true,
    },
    topK: {
      type: "string",
      alias: "k",
      description: "how many chunks to retrieve (1-50)",
      valueHint: "n",
    },
  },
  run({ args }) {
    const { question, topK } = validate(querySchema, {
      question: args.question,
      topK: args.topK,
    });

    // Week 3: embed the question, top-K vector search, build the prompt,
    // stream Claude's answer, print which chunks were cited.
    console.log(`query: ${question} (top ${topK})`);
    console.error("not implemented (Week 3)");
  },
});

const main = defineCommand({
  meta: {
    name: "ask-my-notes",
    version: "0.1.0",
    description: "ask questions of your notes, with citations",
  },
  subCommands: { ingest, query },
});

runMain(main);
