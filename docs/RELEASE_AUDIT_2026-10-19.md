# Vibe Monitor 1.0 final release audit (2026-10-19)

**Decision: NO-GO for the stable release until P0 signed OTA and legacy handoff are verified.** This document is not authorization to publish npm or deploy production services.

## Verified
- Mac Codex: five genuine MCP calls passed on an isolated Playground, 178 ms full scan, S3 / 3 findings / 1 attention, signed policy revision 2. Neon matched the returned call IDs and scan IDs. The user's working Git tree was untouched.
- Windows Antigravity: Playground S18 code-change test, findings reduced 3 -> 2 after fixing the encoded-ID time contract; build/lint passed; Neon event match.
- Local updater rehearsal, isolated fake packages: beta.41 -> 1.0.0 -> 1.0.1; successful next-start activation, manual rollback, unhealthy-candidate fallback and preservation of legacy data markers. This does NOT prove signed public OTA delivery.
- Public signed-policy service: official /free/policy returned HTTP 200.
- Source regression tests, build and npm pack dry-run passed; this is an RC, not the stable 1.0.0.

## Beta.41 comparison using the same clean Playground
| Test | Private Beta.41 | Current public RC |
| --- | --- | --- |
| Offline scoring baseline | 3 findings; highest S2 | 1 finding; highest S2 |
| Same signed decision policy revision 2 | 3 findings; highest S2 | 3 findings; highest S3 |
| ActivityLog.tsx, revision 2 | S2 score 42 | S3 score 52 |
| App.tsx, revision 2 | S2 score 50 | S2 score 39 |
| Implicit encoded ID contract, revision 2 | S2 score 40 | S2 score 40 |

Coverage exists for the three detected items under the same live strategy, but numeric/stage parity is NOT proved. The 13 family names exist in Policy V2; this single fixture does not demonstrate actual value-by-value equivalence across all 13 families. The calibration change needs an explicit product decision.

## P0 blockers before release 1.0.0
1. Public OTA signing pins for V1 and V2 remain null. No approved separately-held Ed25519 update signer has been pinned into the shipping binary.
2. Official /free/update-manifest returned HTTP 404. The working signed-policy endpoint is unrelated to executable update authorization.
3. The public signed-only auto-stage + next-restart activation scheduler has been added to RC source. It deliberately fails closed without an approved signer and immutable HTTPS manifest; real OTA is not yet verified.
4. Stable 1.0.0+ now selects a versioned managed runtime and stable launcher, not an ephemeral npx cache. A real signed registry installation, upgrade and rollback on macOS, Windows and Linux is still required.
5. Old Beta Cloud metadata still activates legacy_beta_upgrade_requires_verified_handoff and blocks direct public install/setup. Automatic migration requires a compatible and approved legacy Beta Cloud rollout. Older unmanaged or incompatible Beta versions need a safe fallback migration installer. Neither path is verified end to end.
6. Public CLI disallows telemetry on/off and starts with telemetry ON, but website-to-client settings changes require end-to-end verification.
7. Exact Beta.41/RC field-value parity (all 13 monitor families, evidence quality, outcome, feedback and notice families) is NOT fully evidenced, and live score differences must be approved.

## Required release gates
- Independent custody and fingerprint approval of the production OTA Ed25519 public verification key; the private key is never copied into Git or the client.
- Live signed update manifest with canonical npm artifact URL, digest, revision, expiry, anti-downgrade and controlled rollout, plus negative security tests.
- Real multi-platform trial: supported old Beta -> 1.0.0, 1.0.0 -> later stable, Agent restart, rollback, failure quarantine, preserved project history, no Beta credential reuse and one MCP entry per Agent.
- Explicit safe handoff for unsupported Beta install types, website telemetry-control verification, release CI/source privacy review, and final human GO before npm publication.

No current Mac or Windows installations, legacy credentials, Cloudflare deployment, Neon schema or production cursors were modified in this audit.
