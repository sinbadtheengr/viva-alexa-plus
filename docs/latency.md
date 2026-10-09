# Viva latency evidence (A8)

- **Date:** 2026-10-09T03:21:59.976Z
- **Machine:** Windows_NT 10.0.26300 (Windows 11 Pro), x64; 12th Gen Intel(R) Core(TM) i7-12700K (20 logical cores); 31.8 GiB RAM
- **Runtime:** Node v24.3.0
- **Run:** 200 recorded exams per scenario after 10 unrecorded warm-up exams; 5 submit_response turns per exam; simulated model latency 3000ms. Refresh this file with `npm run bench:report` (200 exams); a plain `npm run bench` writes to untracked bench-output/latency.md instead (`BENCH_ITERATIONS`, `BENCH_WARMUP`, `BENCH_TURNS`, `BENCH_SCORER_DELAY_MS`).
- **Verdict:** PASS. The gate is client-observed p95 <= the F-4 budget for every row in every scenario.

**Read this first.** This is a local-loopback run with fakes: the app, OAuth 2.1 + PKCE flow, bearer middleware and Streamable HTTP transport are the real ones, but the grader and the follow-up probe generator are fakes (no Bedrock), and there is no Alexa+ and no network between client and server. It proves **server-side budget compliance** (what this process costs per call). It does **not** prove end-to-end Alexa+ latency, which adds the Internet path, TLS, Alexa+'s own orchestration, speech recognition and synthesis.

All times in milliseconds. Client columns are the full HTTP round trip (request sent to response body fully read) from a Node `fetch` client over a keep-alive loopback connection. *Server* columns are the server's own per-tool duration from its F-1 log (`event:"tool"`), i.e. the handler only; the gap between the two is transport, JSON-RPC/SSE framing, auth and HTTP. Percentiles are nearest-rank.

## Scenario: baseline

Probes off (seed follow-ups only); fake scorer takes 3000ms to finish.

| Tool | n | min | p50 | p95 | p99 | max | Budget | Server p50 | Server p95 | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| start_exam | 200 | 0.43 | 0.51 | 0.79 | 1.66 | 2.08 | 100 | 0.01 | 0.02 | PASS |
| get_status | 400 | 0.41 | 0.49 | 0.77 | 1.17 | 4.11 | 50 | 0.00 | 0.01 | PASS |
| advance_phase | 400 | 0.42 | 0.49 | 0.75 | 2.09 | 4.03 | 50 | 0.01 | 0.01 | PASS |
| submit_response | 1000 | 0.41 | 0.49 | 0.75 | 1.06 | 3.81 | 150 | 0.00 | 0.01 | PASS |
| score_session | 200 | 0.40 | 0.49 | 0.77 | 0.85 | 1.23 | 100 | 0.01 | 0.01 | PASS |
| get_results (pending) | 200 | 0.42 | 0.48 | 0.76 | 0.93 | 1.65 | 100 | 0.00 | 0.01 | PASS |
| get_results (complete) | 200 | 0.40 | 0.46 | 0.65 | 0.94 | 4.33 | 100 | 0.01 | 0.01 | PASS |
| get_progress | 200 | 0.43 | 0.48 | 0.63 | 0.78 | 2.88 | 100 | 0.03 | 0.04 | PASS |

Server-side `/mcp` POST handler time (all calls): p50 0.17, p95 0.26, max 0.68 (n=2800). `initialize`: 13.23 ms (one-off, includes session setup). Calls the server itself logged as `overBudget`: 0. get_progress was read with 210 sessions on file. Follow-up sources: seed=1000.

## Scenario: hung-probe

Follow-up probes ENABLED with a generator whose promise never resolves, plus the same slow fake scorer. Every submit_response fires a probe call that hangs forever; none may delay a turn, and every follow-up must still be a seed.

| Tool | n | min | p50 | p95 | p99 | max | Budget | Server p50 | Server p95 | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| start_exam | 200 | 0.45 | 0.51 | 0.75 | 1.03 | 1.27 | 100 | 0.01 | 0.02 | PASS |
| get_status | 400 | 0.41 | 0.48 | 0.75 | 1.21 | 3.40 | 50 | 0.00 | 0.01 | PASS |
| advance_phase | 400 | 0.43 | 0.49 | 0.71 | 1.21 | 4.02 | 50 | 0.00 | 0.01 | PASS |
| submit_response | 1000 | 0.42 | 0.49 | 0.74 | 1.91 | 4.52 | 150 | 0.01 | 0.02 | PASS |
| score_session | 200 | 0.42 | 0.49 | 0.69 | 0.80 | 0.97 | 100 | 0.01 | 0.01 | PASS |
| get_results (pending) | 200 | 0.42 | 0.48 | 0.66 | 0.86 | 3.65 | 100 | 0.00 | 0.00 | PASS |
| get_results (complete) | 200 | 0.42 | 0.46 | 0.58 | 0.68 | 0.79 | 100 | 0.01 | 0.01 | PASS |
| get_progress | 200 | 0.42 | 0.46 | 0.67 | 1.57 | 3.98 | 100 | 0.02 | 0.04 | PASS |

Server-side `/mcp` POST handler time (all calls): p50 0.17, p95 0.26, max 1.27 (n=2800). `initialize`: 2.20 ms (one-off, includes session setup). Calls the server itself logged as `overBudget`: 0. get_progress was read with 210 sessions on file. Follow-up sources: seed=1000.

## What the rows show

- **score_session** returns while the simulated model (3000ms) is still working; `get_results (pending)` is read immediately afterwards and is pending, and `get_results (complete)` is read after the model has finished (this is the call that files progress). Neither waits on the model.
- **hung-probe** fires a probe call that never resolves on every turn. `submit_response` stays within budget and every follow-up it returned was a corpus seed (asserted during the run; a mismatch aborts it).
- Worst single client round trip anywhere in this run: 4.52 ms, against the overall 500ms target.

## Caveats

- Loopback only; real deployments add network RTT and TLS on top of every number above.
- The corpus is a single synthetic item sized like the real ones, so corpus lookup cost is not exercised at scale.
- The log sink here is an in-memory function; production writes the same JSON lines to stderr, which costs a little more per call.
- Progress is the in-memory store. The JSON-file store adds a disk write to `get_results (complete)`, which this run does not measure.
- Calls are sequential (one candidate, one session), which matches a voice conversation. Concurrency is not measured.
- The first exams are discarded as warm-up, so cold-start cost (first request after boot) is not in the table.
- Each scenario boots its own app instance so the two runs stay independent; the server itself now supports many concurrent MCP sessions (GAP-015, closed), which this benchmark does not exercise.
