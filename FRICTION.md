# MCP SDK friction log

Anything confusing, wrong, or surprising while building with `@modelcontextprotocol/server`.
One entry per problem, with a repro. Triage happens in Week 2 (see `~/sys/jerry_study/mcp-plan.md`).

## 1. Tutorial shows a validation error message that the SDK no longer produces

- **Date:** 2026-10-05
- **Where:** `docs/get-started/first-server.md`, the tip under "Register a tool"
- **Versions:** `@modelcontextprotocol/server` 2.3.0, `zod` 4.6.5, Node 24
- **Expected (per docs):** `Input validation error: Invalid arguments for tool get-alerts: state: Too big: expected string to have <=2 characters`
- **Actual:** `Input validation error: Invalid arguments for tool get-alerts: state: Too big: expected string to have exactly 2 characters`
- **Repro:** follow the tutorial as written, then call `get-alerts` with `{ "state": "California" }` (via the Inspector, or raw JSON-RPC over stdin).
- **Likely cause:** zod changed its wording for `.length()` failures; the doc text was written against an older zod.
- **Triage (Week 2):** check whether the docs snippet is generated or synced (the repo has a `sync:snippets` script), and search issues/PRs for it.
