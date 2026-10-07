#!/usr/bin/env bun
/**
 * Ask My Notes as an MCP server: one tool, `search_notes`, over stdio.
 *
 *   claude mcp add ask-my-notes -- bun run --cwd ~/work/ask-my-notes mcp.ts
 *
 * Unlike the `query` command, this never calls Claude. The MCP client is
 * already a model, so the server only retrieves and the client answers.
 *
 * stdout is the protocol channel: nothing reachable from here may write to it.
 * `--cwd` matters too — Bun reads `.env` and resolves `data/...` from the
 * working directory, and a client launches servers from wherever it runs.
 */

import { McpServer } from "@modelcontextprotocol/server";
import { serveStdio } from "@modelcontextprotocol/server/stdio";
import { z } from "zod";

import { openDatabase, searchChunks, type SearchHit } from "./src/db.ts";
import { createEmbedder } from "./src/embed.ts";

/** Personal notes, not the Wikipedia eval corpus. Override with NOTES_DB. */
const DB_PATH = process.env.NOTES_DB ?? "data/mine.db";

/**
 * The model reads this to decide when to call the tool, so naming what the
 * notes actually cover makes it fire on the right questions. That list is
 * personal, so set NOTES_DESCRIPTION in `.env` (gitignored) rather than here.
 */
const DESCRIPTION =
  process.env.NOTES_DESCRIPTION ||
  "Semantic search over the user's personal notes. Use it when a question depends on " +
    "what the user wrote down or decided. Returns the closest excerpts with their source " +
    "file; cite the source when you use one.";

function formatHits(hits: SearchHit[]): string {
  return hits
    .map((hit, index) => {
      const where = hit.chunkIndex > 0 ? ` (chunk ${hit.chunkIndex})` : "";
      return `[${index + 1}] ${hit.source}${where} — distance ${hit.distance.toFixed(3)}\n${hit.text}`;
    })
    .join("\n\n");
}

function createServer(): McpServer {
  const server = new McpServer({ name: "ask-my-notes", version: "0.1.0" });

  server.registerTool(
    "search_notes",
    {
      description: DESCRIPTION,
      inputSchema: z.object({
        query: z.string().min(1).describe("What to look for, phrased as a question or topic"),
        k: z.number().int().min(1).max(20).default(5).describe("How many excerpts to return"),
      }),
    },
    async ({ query, k }) => {
      const embedder = createEmbedder();
      const [embedding] = await embedder.embed([query], "query");
      if (!embedding) {
        return { content: [{ type: "text", text: "embedding provider returned no vectors" }], isError: true };
      }

      const db = openDatabase(DB_PATH);
      let hits: SearchHit[];
      try {
        hits = searchChunks(db, embedding, k);
      } finally {
        db.close();
      }

      if (hits.length === 0) {
        return { content: [{ type: "text", text: "No matching notes — is anything ingested?" }] };
      }
      return { content: [{ type: "text", text: formatHits(hits) }] };
    },
  );

  return server;
}

void serveStdio(createServer);
console.error(`ask-my-notes MCP server running on stdio (db: ${DB_PATH})`);
