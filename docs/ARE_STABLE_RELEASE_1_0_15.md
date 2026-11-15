# Vibe Monitor public stable 1.0.15 — ARE engineering remediation

Date: 2026-11-15. This release concerns the PUBLIC, Apache-2.0 open-client source, NOT the separate private Beta distribution. This is engineering evidence, not formal ARE L0–L4 certification.

## What changed

The prior stable 1.0.14 source is pinned to commit 010ffe3304d3840bafeee7ea30f07a3abd69126d. The 1.0.15 candidate preserves all 19 public MCP tools, including account linking, legacy/evolution audit, and active session cancellation. It preserves public signed Cloud policy, client telemetry defaults, free-client access contract, user history, and the npm stable release workflow.

- Project status: default project/metrics/risk/evidence summary, with explicit full result and locally computed, paginated file metrics on demand.
- Findings: five concise results by default; paginated IDs plus full-on-request findings, complete recommendation groups and high-severity review queue.
- Finding explanation: remove exactly matching nested advice/decision duplication only; full evidence and standards remain available.
- MCP registration: all 19 tools have correct per-operation annotations. Most project analysis calls are NOT read-only, because they record state, fetch policy or may queue telemetry.
- Real tool failures return structured code/message/retryable/next with isError=true. Normal empty, disabled, skipped and needs_input responses remain non-errors.
- Explicit product intent: dry_run without Cloud request, persistence, telemetry or legacy key migration, plus explicit missing-fields response. Normal write still persists.

## Pinned public 1.0.14 vs patched 1.0.15 — real stdio A/B

A clean Git clone pinned to the identical source SHA was scanned by both versions with MCP SDK StdioClientTransport. Three independent calls per version, with a disposable HOME and a fetch-blocking preloader.

| MCP operation | 1.0.14 median text bytes | 1.0.15 candidate median text bytes |
|---|---:|---:|
| vibe_project_status | 80,738 | 2,255 |
| vibe_findings | 77,103 | 4,304 |
| vibe_explain_finding for valid Finding ID | 8,142 | 7,576 |
| tools/list JSON | 15,608 | 18,129 |
| tools and annotations | 19 / 0 | 19 / 19 |

These are response TEXT bytes, NOT actual Agent host token savings. Tools-list grew to reflect new truthful annotations/schema. Project status wall-time medians were 507.37ms vs 439.92ms; 3 trials do not establish a significant performance improvement.

Full machine-readable 3-by-2 A/B: docs/are/2026-11-15-stable-are-ab.json.
Reproduce with node scripts/are-stable-stdio-probe.mjs --project PATH --output /tmp/are.json. Pass --entry BASELINE/src/cli.js to compare previous source.

## Regressions, privacy and cancellation

- On macOS/Node 22: npm test PASSED 139/139, zero failures/skips. Real MCP SDK stdio tests included three independent task checks: project risk/drilldown, product intent preview/write, and Finding explanation.
- npm run build and npm pack --dry-run succeeded; public package allowlist is enforced by official stable release workflow.
- Live stdio cancellation: synthetic 650-source-file scan reached analysis, vibe_skip_current cancelled 1 active scan, session returned normal skipped result, and later project_status recovered with assessmentAvailable=true. Reproduce via node scripts/are-stable-cancel-probe.mjs.
- Dry run made no intent.json or activity entry, while actual writes still persisted. Missing legacy encryption key did not generate new secrets or mutate encrypted data.
- Bad Finding IDs and actual scan failure results use MCP isError=true; real user skip is not an error.
- Network requests during the reproducible probe were blocked with a local test preloader, so no production Cloud or telemetry upload occurred.
- Run live Windows, macOS, Linux CI before publishing. Real commercial Agent Host auto-approval and observed model token costs remain UNTESTED.
- Stable publication must be verified by the official protected workflow and npm registry latest tag, not inferred from this report.
