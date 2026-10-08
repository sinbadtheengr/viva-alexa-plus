# Viva latency evidence (A8)

- **Date:** 2026-10-08T22:54:21.092Z
- **Machine:** Windows_NT 10.0.26300 (Windows 11 Pro), x64; 12th Gen Intel(R) Core(TM) i7-12700K (20 logical cores); 31.8 GiB RAM
- **Runtime:** Node v24.3.0
- **Run:** 200 recorded exams per scenario after 10 unrecorded warm-up exams; 5 submit_response turns per exam; simulated model latency 3000ms. Reproduce with `npm run bench` (`BENCH_ITERATIONS`, `BENCH_WARMUP`, `BENCH_TURNS`, `BENCH_SCORER_DELAY_MS`).
- **Verdict:** PASS. The gate is client-observed p95 <= the F-4 budget for every row in every scenario.

**Read this first.** This is a local-loopback run with fakes: the app, OAuth 2.1 + PKCE flow, bearer middleware and Streamable HTTP transport are the real ones, but the grader and the follow-up probe generator are fakes (no Bedrock), and there is no Alexa+ and no network between client and server. It proves **server-side budget compliance** (what this process costs per call). It does **not** prove end-to-end Alexa+ latency, which adds the Internet path, TLS, Alexa+'s own orchestration, speech recognition and synthesis.

All times in milliseconds. Client columns are the full HTTP round trip (request sent to response body fully read) from a Node `fetch` client over a keep-alive loopback connection. *Server* columns are the server's own per-tool duration from its F-1 log (`event:"tool"`), i.e. the handler only; the gap between the two is transport, JSON-RPC/SSE framing, auth and HTTP. Percentiles are nearest-rank.

## Scenario: baseline

Probes off (seed follow-ups only); fake scorer takes 3000ms to finish.

| Tool | n | min | p50 | p95 | p99 | max | Budget | Server p50 | Server p95 | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| start_exam | 200 | 0.42 | 0.49 | 0.78 | 1.60 | 4.43 | 100 | 0.01 | 0.02 | PASS |
| get_status | 400 | 0.40 | 0.47 | 0.75 | 2.06 | 3.90 | 50 | 0.00 | 0.01 | PASS |
| advance_phase | 400 | 0.41 | 0.48 | 0.76 | 1.15 | 4.32 | 50 | 0.01 | 0.01 | PASS |
| submit_response | 1000 | 0.40 | 0.47 | 0.73 | 0.91 | 2.95 | 150 | 0.00 | 0.01 | PASS |
| score_session | 200 | 0.41 | 0.47 | 0.71 | 0.82 | 1.03 | 100 | 0.01 | 0.01 | PASS |
| get_results (pending) | 200 | 0.39 | 0.46 | 0.74 | 0.90 | 2.32 | 100 | 0.00 | 0.01 | PASS |
| get_results (complete) | 200 | 0.41 | 0.45 | 0.60 | 0.71 | 2.60 | 100 | 0.01 | 0.01 | PASS |
| get_progress | 200 | 0.43 | 0.47 | 0.59 | 0.72 | 2.77 | 100 | 0.03 | 0.04 | PASS |

Server-side `/mcp` POST handler time (all calls): p50 0.17, p95 0.28, max 1.35 (n=2800). `initialize`: 7.62 ms (one-off, includes session setup). Calls the server itself logged as `overBudget`: 0. get_progress was read with 210 sessions on file. Follow-up sources: seed=1000.

## Scenario: hung-probe

Follow-up probes ENABLED with a generator whose promise never resolves, plus the same slow fake scorer. Every submit_response fires a probe call that hangs forever; none may delay a turn, and every follow-up must still be a seed.

| Tool | n | min | p50 | p95 | p99 | max | Budget | Server p50 | Server p95 | Result |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|---|
| start_exam | 200 | 0.44 | 0.48 | 0.62 | 0.68 | 0.73 | 100 | 0.01 | 0.01 | PASS |
| get_status | 400 | 0.40 | 0.47 | 0.61 | 0.78 | 3.60 | 50 | 0.00 | 0.01 | PASS |
| advance_phase | 400 | 0.41 | 0.47 | 0.63 | 0.72 | 3.42 | 50 | 0.00 | 0.01 | PASS |
| submit_response | 1000 | 0.41 | 0.47 | 0.62 | 0.84 | 4.43 | 150 | 0.01 | 0.01 | PASS |
| score_session | 200 | 0.41 | 0.46 | 0.60 | 0.74 | 3.45 | 100 | 0.01 | 0.01 | PASS |
| get_results (pending) | 200 | 0.41 | 0.46 | 0.56 | 0.63 | 0.64 | 100 | 0.00 | 0.00 | PASS |
| get_results (complete) | 200 | 0.41 | 0.45 | 0.68 | 1.56 | 3.97 | 100 | 0.01 | 0.01 | PASS |
| get_progress | 200 | 0.42 | 0.46 | 0.52 | 0.64 | 0.95 | 100 | 0.02 | 0.03 | PASS |

Server-side `/mcp` POST handler time (all calls): p50 0.17, p95 0.23, max 0.44 (n=2800). `initialize`: 1.18 ms (one-off, includes session setup). Calls the server itself logged as `overBudget`: 0. get_progress was read with 210 sessions on file. Follow-up sources: seed=1000.

## What the rows show

- **score_session** returns while the simulated model (3000ms) is still working; `get_results (pending)` is read immediately afterwards and is pending, and `get_results (complete)` is read after the model has finished (this is the call that files progress). Neither waits on the model.
- **hung-probe** fires a probe call that never resolves on every turn. `submit_response` stays within budget and every follow-up it returned was a corpus seed (asserted during the run; a mismatch aborts it).
- Worst single client round trip anywhere in this run: 4.43 ms, against the overall 500ms target.

## Caveats

- Loopback only; real deployments add network RTT and TLS on top of every number above.
- The corpus is a single synthetic item sized like the real ones, so corpus lookup cost is not exercised at scale.
- The log sink here is an in-memory function; production writes the same JSON lines to stderr, which costs a little more per call.
- Progress is the in-memory store. The JSON-file store adds a disk write to `get_results (complete)`, which this run does not measure.
- Calls are sequential (one candidate, one session), which matches a voice conversation. Concurrency is not measured.
- The first exams are discarded as warm-up, so cold-start cost (first request after boot) is not in the table.
- The server accepts one MCP session per process (GAP-015); each scenario therefore boots its own app instance.
