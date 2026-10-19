# Vibe Monitor — Coding Agent project-fit assessment

> **This is an instruction for a coding Agent.** When a user shares this Markdown file or the corresponding website prompt, evaluate now and **return the results in the current conversation**. Do not send reports, files, code or chat content to Vibe Monitor servers.

## Product facts to verify

- The published product is the **open-source stable Vibe Monitor client**: `@vibe-monitor/setup@latest`, currently `1.0.2` (verify npm latest when necessary). One client supports the Free/Pro/Team product model; planned premium services are not implied to be available.
- Vibe Monitor is a local, read-only architecture analyzer for AI coding workflows. It identifies structural pressure and evolution trends; it is not a vulnerability certification tool and does not automatically refactor code.
- **Vibe Monitor does not upload source code.** Its bounded pseudonymous telemetry may upload derived architectural and usage measurements, but **not source files, diffs, prompts, project paths or secrets**. You can inspect the open-source implementation: [telemetry projection](../src/telemetry.js), [allowlisted event checks](../src/telemetry-quality.js), [Cloud upload path](../src/cloud.js) and [security policy](../SECURITY.md).
- Installation is separate from assessment. A standard install changes supported Agent MCP/rule settings; the fit assessment must not install anything.

## Execute the assessment now

1. **Discover code projects already accessible to this Agent:** use the active IDE workspace, already-open repositories, existing attached workspace roots, or the projects explicitly identified in the current conversation. Inspect only roots for which this session already has filesystem read access. Do not browse arbitrary home directories, unrelated personal files, other users' repos, secrets or hidden credentials. **Do not ask 'Which project?'** when a code project is already in the authorized context.
2. **Identify which are code projects:** use existing file metadata and a bounded, read-only sample of manifests, module layout, tests and local Git metadata. Ignore ordinary documents, downloads, system folders and non-code directories. Never read `.env`, private keys, credential files or other secrets. Do not install tools, run unknown scripts, edit files, launch tests or upload project data.
3. **Classify each accessible code project:** `Recommend installing` / `Not needed yet` / `Insufficient evidence`. Consider size, module boundaries, coupling, rate of change, test structure and need for ongoing architecture oversight. A one-file script or abandoned sample generally does not justify installation. Explain differences among projects.
4. **Choose one concise recommendation:** list the project(s) where Vibe Monitor would add the most value, if any, and why. If **no code projects can be confirmed as accessible**, the overall verdict is **Insufficient evidence**. Do not invent a scan or turn that into a repetitive permission questionnaire. Only request further access if a real tool/OS permission gate requires it.
5. **Report back to the user in this chat, not to a website endpoint.** Cite actual observed evidence (e.g. module names/aggregate counts without revealing secret material). Prefer a short project comparison table and no more than three project-specific findings per recommended project. State whether source inspection was possible; distinguish observed facts from assumptions. **Do not ask permission to install or perform installation** during this task.

## Required response format

```text
Vibe Monitor — project fit assessment
Scope: [active accessible workspace(s) / code repositories reviewed, or no accessible code project]
Project decisions:
- [Project name] — [Recommend installing / Not needed yet / Insufficient evidence]
  Evidence: [up to three verified architecture or workflow signals]
  Expected value: [one sentence, or why not useful]
Recommendation: [Which code project(s), if any, benefit most / None currently / Insufficient evidence]
Next step: [one practical action]
Caveats: [permission or evidence limitations, if any]
```

By default no website ping or external report submission is part of this assessment. Only when the user explicitly opts into an optional one-time completion receipt on the website, the copied prompt may include a short-lived token authorizing a bounded, self-reported completion POST. Send only the permitted aggregate counts, agent family and completion status; never send source, paths, project names or the report. Without a token, do not submit anything. An ordinary coding Agent may have separate model-provider data processing policies; the no-source-upload promise above applies to **Vibe Monitor's product upload path**, not a separate provider used by the Agent to examine code.
