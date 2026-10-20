# Account linking for existing Free installations — not yet released

This feature is **staged in source only**. Published `@vibe-monitor/setup@1.0.2` does not support Free account linking. Do not ask users to use the new command until a separately reviewed package version is published.

## Planned consent-based flow

1. Sign into the Vibe Monitor Account Center at https://vibe.fde.fan/app/ with GitHub.
2. When Free pairing is officially enabled, click Generate pairing code (10-minute lifetime).
3. On the original machine, from a real project workspace that the Free client **already analyzed**, run the future `vibe-monitor account link` CLI and paste the one-time code in its hidden interactive terminal prompt. Do not put codes on a command line, issue tracker or chat.
4. The local client reads the installation ID and a non-exported secret from the local secure store, computes a bounded project pseudonym and sends only the pseudonym, installation ID and one-time code to the official service.
5. The server checks the proof against pre-existing anonymous events received before October 20, 2026 00:00 UTC. If it matches, the signed-in browser must separately confirm ownership; only then may the Dashboard show historical aggregate statistics.

Never upload local source, repo paths, raw secure-store secrets, project reports, prompts or full telemetry data as part of pairing.

## Limits

- This legacy migration method works **only** where historical Free telemetry contains a matching project pseudonym from the same unchanged local identity and project root.
- Newly created installations must use a future independently authenticated registration scheme; they cannot invent historical evidence.
- A UUID, GitHub login or optional Agent assessment receipt alone does not prove installation ownership.
- If no local secure store, workspace or matching historic scan exists, the service must reject and keep the account unlinked.
- Free continues to operate without login; client 1.0.2 and current anonymous telemetry remain unchanged until the future release.

## Release gates

Complete a real macOS and Windows native acceptance test, validate owner/non-owner binding on an isolated Neon branch, publish the audited updated npm package, then and only then set `ACCOUNT_FREE_PAIRING_ENABLED=1` on Vercel. Private-Beta `ACCOUNT_DEVICE_PAIRING_ENABLED` must remain separately disabled.
