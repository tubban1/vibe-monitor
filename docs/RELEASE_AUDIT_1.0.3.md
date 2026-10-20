# Vibe Monitor 1.0.3 — Account Center legacy binding release candidate

Scope: ONE official Free/Pro/Team open-source npm package. No new edition, policy change, or release-channel expansion.

## Included
- User-initiated account link on an existing Beta41→1.0.2 installation: one-time code, GitHub target preview, local typed consent, OS-vault Beta credential proof against existing installation record, separate authenticated web confirmation.
- Existing Free historical-HMAC proof remains supported where older server-received events qualify.
- No source files, paths, prompts, API key or project reports are sent as ownership proof. The legacy Beta install credential travels only to the exact HTTPS account endpoint, protected as Authorization Bearer; no client log or browser token.
- No original installation changes until the user executes an explicit account-link CLI command. 1.0.2 remains an immutable published version.
- Account Center service change and authorized GitHub login allowlist are separate, independently controlled server-side release gates.

## Verification and rollout guardrails
- Public 87/87 tests, source/build/6-file npm pack, production dependency security audit zero vulnerabilities.
- macOS and Windows owner-owned Beta41→1.0.2 installations verified for presence of original installation credential in local secure store. No secret values logged.
- Requires PR merge & official stable release workflow with exact reviewed main SHA and owner approval, no direct npm publish from local machine.
- The website pairing flag is OFF until the client release is live, and any initial production pilot must be limited to an explicit GitHub account allowlist. Direct database/device linking without proper proof and browser confirmation is prohibited.
- Do not claim new Free installations without historic proof are supported: their separately authenticated enrollment is not part of this patch.

Status: candidate. Mark released only after npm Trusted Publishing and end-to-end Account Center confirmation.
