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

## 2. e2e test `protocol:timeout:max-total` is flaky on macOS over SSE (races real I/O against fake timers); passes on Linux CI

- **Date:** 2026-10-14
- **Where:** `test/e2e/scenarios/protocol.test.ts:662` (the `verifies('protocol:timeout:max-total', ...)` scenario), in a fresh clone of `main`
- **Versions:** `main` @ `9bc40e90`, macOS (Darwin 27), Node 24.16.0, pnpm 10.26.1
- **Expected:** `pnpm test:all` passes on a clean clone, as it does in upstream CI (main.yml green on the same commit, Node 20/22/24, ubuntu)
- **Actual:** the `[sse 2025-11-25]` and `[sse 2026-07-28]` variants fail with `expected 0 to be greater than or equal to 3` at line 713 (no progress ticks arrived), plus an unhandled `SdkError: Request timed out`. All other transports pass. Reproduced on 3 of 3 isolated reruns (`pnpm vitest run scenarios/protocol.test.ts -t "timeout:max-total"` in `test/e2e`).
- **Cause (confirmed 2026-10-16 by experiment):** the test advances *fake* timers in 200ms steps, but over SSE the `tools/call` **request** travels to the server on a *real* localhost HTTP connection that fake timers don't control. On macOS the request reaches the server only after the fake clock has passed ~600ms, so the ordinary per-request `timeout: 500` fires first (`Request timed out`), before the server sends any progress. The test never exercises `maxTotalTimeout` on this platform.
  - *Correction to the first hypothesis:* I first guessed the progress notifications were delayed on the way **back**. Instrumented logs showed the server hadn't sent any yet; the delay is on the way **in**.
- **Evidence:** temporary instrumentation logging server-sent / client-received / fake-clock events (reverted afterwards):
  - **No drain:** both SSE variants fail 3/3. Rejection is `Request timed out` (per-request timeout), 0 ticks, first `server SENT progress 1` logged after `fake clock now 600ms`.
  - **10ms of real time after each `advanceTimersByTimeAsync`:** 12/12 variants pass on 3/3 runs. SSE rejection becomes `Maximum total timeout exceeded`, 4 ticks, the same as the other transports.
  - Streamable HTTP passes without the drain: its request lands within the first 200ms step.
- **Fix direction (for the issue/PR):** a fixed real-time sleep would just move the timing assumption. Better to wait for an *event*: don't start advancing the fake clock until the server has received the call (e.g., `vi.waitFor` on a flag set at the start of the tool handler, or on the first progress tick). The same pattern may apply to other fake-timer tests that run over SSE.
- **Searched:** issues/PRs for "protocol.test.ts", "timeout:max-total", "fake timers sse", "advanceTimersByTimeAsync", "e2e macOS". Nothing matching. #2695 (`maxTotalTimeout` not enforced without progress) is a different bug. #2661 (SSE tests assume events share one fetch chunk) is the same *family* — tests that assume transport timing — but a different assumption.
- **Flaky, not deterministic (2026-10-16 correction):** the first runs (Oct 14 full suite; 3/3 isolated reruns) all failed, so I first called it "fails every time." Wider testing on Oct 16 showed it is intermittent and the rate drifts: alone 0/6 failed; after one warm-up SSE test 3/6; in the 5-run fake-timer subset 0/10; that subset with all 12 cores loaded 1/6. Cold-start and CPU-load explanations were tested and **not** supported. It's a race whose outcome depends on machine state.
- **Scope check (2026-10-16):** 10 e2e scenarios use fake timers; over 5 runs + extra runs, only `max-total` [sse] ever failed. Reading the siblings: `timeout:basic` and `timeout:sends-cancellation` never need the server to receive anything (safe). **`timeout:reset-on-progress` already guards against this race** with `await vi.waitFor(() => expect(received.length).toBeGreaterThanOrEqual(i))` after each `advanceTimersByTimeAsync`. `max-total` has no such wait. So it's **one test missing its sibling's safeguard**, not a suite-wide pattern.
  - Caution for the fix: under fake timers `vi.waitFor` advances the fake clock while polling, so copying the sibling's pattern into a timeout-budget test needs care (it could push past `maxTotalTimeout` by itself).
- **Upstream CI:** no failures of these tests on `main`. Four failed PR runs touched them, but each was a different commit, never re-run, on PRs that change progress delivery (#3023, #2967, and one that failed all transports). That can't be attributed to this race, so don't cite it as evidence.
- **Triage:** ✅ cause confirmed. **Best contribution candidate so far.** Self-found, intermittently reproducible, unreported. Scope settled: one test. Next: file an issue (in your own words) with the repro, the drain experiment, and the pointer to `reset-on-progress`'s `vi.waitFor` guard; offer a small test-only PR.
- **Status (2026-11-09):** filed as [#3045](https://github.com/modelcontextprotocol/typescript-sdk/issues/3045); fix in [PR #3130](https://github.com/modelcontextprotocol/typescript-sdk/pull/3130) (CI green, community review answered with a fail-fast guard, awaiting maintainer review).

## 3. e2e `protocol:timeout:reset-on-progress` leaves unhandled `Request timed out` rejections (vitest exits 1 on macOS)

- **Date:** 2026-10-27
- **Where:** `test/e2e/scenarios/protocol.test.ts`, `verifies('protocol:timeout:reset-on-progress', ...)` (uses `const timeout = 200`)
- **Versions:** `main` @ `39ae8e61`, macOS, Node 24.16.0
- **What happens:** every run, 1–2 `Unhandled Rejection: SdkError: Request timed out` with `data: { timeout: 200 }`. All tests pass, but vitest reports unhandled errors and `pnpm test:all` exits 1. Same on `main` with and without the #3045 fix (5/5 runs each).
- **Stack:** `timeoutHandler` (core-internal protocol.ts:1583) ← `advanceTimersByTime` ← vitest `checkCallback`, i.e. `vi.waitFor` advancing the fake clock while it polls.
- **Not yet known:** which request is rejected. The test's own `call` resolves, so it's another request; maybe a stateless/per-request transport. Needs instrumentation like #2.
  - *Answered (2026-11-09):* it **is** the test's own `call`, on the two SSE variants. `requirements.ts` lists SSE under `knownFailures` for this test, so those variants fail at `vi.waitFor` as expected. While it polls, the fake clock passes the 200ms timeout, `call` rejects, and nothing handles it. SSE-only runs: 1–2 unhandled every time; all other transports: none. Adding `call.catch(() => {})` (like max-total) removes them, and the full e2e suite exits 0. Linux CI reports no unhandled errors; not investigated why. Filed as [#3170](https://github.com/modelcontextprotocol/typescript-sdk/issues/3170).
- **Correction to #3045:** that issue says the max-total failure is "followed by an unhandled `SdkError: Request timed out`." `max-total` attaches `call.catch(() => {})`, so that unhandled rejection most likely came from *this* test, not max-total. Mention it in the PR description.
- **Triage:** separate from #3045. Don't fold into that PR. Candidate for a follow-up issue after the PR.
- **Status (2026-11-09):** filed as [#3170](https://github.com/modelcontextprotocol/typescript-sdk/issues/3170), offering a one-line PR once #3130 is settled.
