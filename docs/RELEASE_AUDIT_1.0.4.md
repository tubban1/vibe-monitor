# Vibe Monitor 1.0.4 — Agent-led Account Center binding release candidate

Status: **release candidate only**. Not published to npm; no production Agent binding enablement or rollout has occurred.

## Scope
- The public Free/Pro/Team package stays single and open-source; only Agent-led Account Center linking changes.
- Users ask their coding Agent to connect Vibe Monitor. MCP tool `vibe_account_connect` or `vibe-monitor account connect` verifies existing installation ownership locally, initiates a 256-bit ten-minute authorization and opens the official browser page.
- Optional GitHub sign-in then **one** explicit human approval links device. No code copy, typed GitHub username, or second check/confirmation. Code-based pairing remains a compatible fallback.
- Original Beta41 secure-store bearer used only in backend Authorization header, never browser, logs, reports or URLs. New Free legacy HMAC proof uses the immutable historical telemetry cutoff. No source code or project path uploads.
- Web service uses separate `ACCOUNT_AGENT_LINK_ENABLED` feature flag (default OFF), allowlisted GitHub account, and additive private Neon migration 023. Requests limited 5/hour per installation; replay/expiry handled atomically.

## Evidence already gathered
- Public full local: 91/91 tests PASS, packaging/build PASS; macOS, Linux and Windows GitHub CI all PASS on feature PR #29.
- MCP native stdio initialize + tools/list includes `vibe_account_connect` as tool 17. CLI/browser opener checks fixed official HTTPS URL and no shell execution.
- Private backend local 39/39 focused tests PASS; full suite 443 total (436 passed, 7 skipped, zero failed), AWS CI PASS on PR #103.
- Real Chrome local browser smoke: link fragment → one approval → device statistics updated; signed-out GitHub redirect retains pending request; same-tab hash navigation detected and recovered.
- Mac live installation is already associated to GitHub `tubban1` using old verified process; Windows is still unlinked, and neither is modified by preparing this release.

## Blocking launch gates
1. **Documented owner approval** must be supplied to the existing GitHub Trusted Publishing workflow; never invoke that workflow with fabricated approval.
2. Finish distinct version 1.0.4 cross-platform CI and npm pack audit, verify there are no source files accidentally bundled.
3. Apply additive private Neon migration 023, then validate actual SQL atomicity/replay/owner isolation using a controlled pilot before enabling the flag.
4. Publish 1.0.4 via GitHub Trusted Publishing with exact reviewed SHA, approved version, privacy flags and provenance; no local direct npm publish.
5. Enable `ACCOUNT_AGENT_LINK_ENABLED=1` only for allowlisted pilot `tubban1`, verify Windows native `vibe_account_connect` → GitHub browser → one approval → Neon ownership and accurate Dashboard.
6. Preserve old manual binding and 1.0.3 until failure/rollback plan is verified. Do not broaden deployment until explicit review.

This audit is **not** a claim that 1.0.4 is released or that production one-click binding is enabled.
