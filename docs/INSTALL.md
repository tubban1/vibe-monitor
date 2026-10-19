# Install, verify and disconnect Vibe Monitor

Vibe Monitor has **one public client for Free, Pro and Team**. Use the official stable npm release, **never** the historic private Beta unless explicitly reproducing an authorized Beta test.

Before installation, the Agent should check Node.js/npm and the supported OS and explain that installation changes coding Agent MCP/instruction configurations. The user must authorize installation separately from a read-only project fit check.

## Official stable installation

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest install
```

This no-flag command uses **default-on, bounded pseudonymous product telemetry starting with 1.0.2**. It does **not** upload source code, prompts, project paths or credentials. The installer discloses this before setup. To install without telemetry:

```bash
npx -y --registry=https://registry.npmjs.org @vibe-monitor/setup@latest install --no-telemetry
```

Disabling telemetry pauses Free architecture analysis under the present service contract. Preferences survive reinstall. The installed CLI also provides `vibe-monitor telemetry off` and `vibe-monitor telemetry on` until authenticated website/device controls become available.

**Version safeguard:** the published `1.0.1` still requires explicit `--accept-telemetry`; the no-flag default-on behavior begins at `1.0.2`. Do not claim the `1.0.2` behavior is live until `npm view @vibe-monitor/setup dist-tags.latest` confirms that version or later. Agents should verify the version before proceeding, and never silently downgrade to @beta.

For a **legacy Beta.41 to Stable** migration, preserve old installation data and use the verified migration flag `--migrate-beta`. Legacy Beta activation credentials must not be reused as stable credentials. Stable first installs require **no Beta activation code**.

## Verify

Restart the supported Agent if necessary, then verify the actual installed version, `vibe-monitor doctor --json`, `vibe-monitor telemetry status`, and one read-only architecture review. Do not claim success based only on an installer's exit status.

## Disconnect

Run `vibe-monitor uninstall` (or a scoped `--cursor` / `--codex` / `--antigravity` flag) to remove managed Agent integration. This **does not** necessarily delete all runtime files, local history, caches or backups. An explicit local data removal action is separate; never infer that disappearing network events mean the user uninstalled.

[Agent fit check](AGENT_EVALUATION.md) · [Security](../SECURITY.md) · [Privacy and data contract](governance/TELEMETRY_PRIVACY_V1.md).
