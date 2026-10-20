# Agent-led device binding v1 — one human approval

Status: source staged for a subsequent audited Free client release. Published `@vibe-monitor/setup@1.0.3` is unchanged. Production disabled unless `ACCOUNT_AGENT_LINK_ENABLED=1`, migration 023 applied, and GitHub pilot allowlist active.

## Goal

The person tells their local coding Agent: "Connect this Vibe Monitor device to my account." On public clients the first-party MCP tool `vibe_account_connect` or `vibe-monitor account connect` reads existing installation proof from the local OS secure store, sends a short-lived request to the official account service, and opens the browser. The person signs in to GitHub if necessary and clicks **Allow linking this device** exactly once. The account backend consumes the request and links historical events. No copied codes, terminal login confirmation, or follow-up check button. The existing code-based pairing remains as a fallback.

## Protocol

1. Agent start (`POST /api/account?action=agent-start`) verifies an existing active installation. Historical Beta41 installations authenticate by their OS-vault `vmb_` secret; legacy Free installations use an HMAC pseudonym matched against an event received before the immutable migration cutoff. A UUID alone never suffices. The agent never receives a GitHub session cookie.
2. Server rate limits starts (5 per installation per hour), stores only the SHA-256 of a 256-bit random ticket, binds it to the proven installation, and expires it after ten minutes. Requires `ACCOUNT_AGENT_LINK_ENABLED`.
3. Client opens `https://vibe.fde.fan/app/#connect=<ticket>` using an exact allowlisted HTTPS origin and an OS browser opener **without a shell**. The token is in the fragment, not in the HTTP request path or Referer. The SPA transfers it into tab-local session storage across a GitHub OAuth login redirect, then immediately removes the fragment from browser history.
4. Browser (`POST /api/account?action=agent-preview`) requires an authenticated GitHub session, allowlisted pilot login, same-origin POST and valid ticket; displays masked device suffix and server-side Agent/version metadata.
5. Human clicks Allow once; `agent-complete` transaction atomically consumes ticket and binds the installation to the current GitHub account. Unique device ownership constraints enforce replay safety. Every read of linked statistics is scoped to account ID. A stolen ticket alone cannot silently link a device; explicit authenticated approval remains necessary.
6. `agent-status` optionally supports the initiating Agent checking only `pending`, `linked`, or `expired` with the secret ticket. No account ID or bearer credentials returned.

## Release gates

- Keep published 1.0.3 installations and account association unchanged until a distinct signed and vetted client package release.
- Apply additive private Neon migration `023_account_agent_link_v1.sql` only after SQL/security tests and before enabling the agent-link flag.
- Verify macOS and Windows browsers, GitHub signed-out redirect, wrong account and token replay/expiry, vault proof, response URL validation, two-account uniqueness and Dashboard metrics.
- Pilot is limited to GitHub account allowlist; keep legacy manual pairing as fallback.
- If browser opening is unavailable, Agent returns the official authorization link for the user to open. Never paste installation keys.
