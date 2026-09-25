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

import { DEFAULT_CHUNK_OVERLAP, DEFAULT_CHUNK_SIZE } from "./src/chunk.ts";
import { DEFAULT_DB_PATH } from "./src/db.ts";
import { ingestPath } from "./src/ingest.ts";
import { answerQuestion } from "./src/query.ts";

/** Repeatable flag, or one comma-separated value — citty hands back either shape. */
const excludeSchema = z
  .union([z.string(), z.array(z.string())])
  .optional()
  .transform((value) =>
    (Array.isArray(value) ? value : value === undefined ? [] : [value])
      .flatMap((entry) => entry.split(","))
      .map((entry) => entry.trim())
      .filter((entry) => entry.length > 0),
  );

const ingestSchema = z
  .object({
    source: z.string().min(1, "path is required"),
    db: z.string().min(1).default(DEFAULT_DB_PATH),
    exclude: excludeSchema,
    size: z.coerce.number().int().min(1).max(8000).default(DEFAULT_CHUNK_SIZE),
    overlap: z.coerce.number().int().min(0).max(8000).default(DEFAULT_CHUNK_OVERLAP),
  })
  .refine((value) => value.overlap < value.size, {
    error: "overlap must be smaller than size",
    path: ["overlap"],
  });

const querySchema = z.object({
  question: z.string().min(1, "question is required"),
  db: z.string().min(1).default(DEFAULT_DB_PATH),
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

/** Turns a thrown error into a one-line message rather than a stack trace. */
async function withFriendlyErrors(action: () => Promise<void>): Promise<void> {
  try {
    await action();
  } catch (error) {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
  }
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
    db: {
      type: "string",
      description: "where to write the database",
      valueHint: "path",
    },
    size: {
      type: "string",
      description: "approximate tokens per chunk",
      valueHint: "n",
    },
    overlap: {
      type: "string",
      description: "approximate tokens shared between neighbouring chunks",
      valueHint: "n",
    },
    exclude: {
      type: "string",
      description: "skip files matching this glob (repeatable, or comma-separated)",
      valueHint: "glob",
    },
  },
  async run({ args }) {
    const { source, db, size, overlap, exclude } = validate(ingestSchema, {
      source: args.source,
      db: args.db,
      size: args.size,
      overlap: args.overlap,
      exclude: args.exclude,
    });

    await withFriendlyErrors(() => ingestPath(source, { dbPath: db, size, overlap, exclude }));
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
    db: {
      type: "string",
      description: "which database to read",
      valueHint: "path",
    },
  },
  async run({ args }) {
    const { question, topK, db } = validate(querySchema, {
      question: args.question,
      topK: args.topK,
      db: args.db,
    });

    await withFriendlyErrors(() => answerQuestion(question, { dbPath: db, topK }));
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
