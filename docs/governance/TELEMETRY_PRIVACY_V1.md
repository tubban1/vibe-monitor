# Telemetry & Privacy Contract v4

Status: Production policy and telemetry intake verified; npm stable 1.0.1 not yet published
Date: 2026-10-18

## At a glance

Vibe Monitor analyzes source code locally. The unified client collects bounded product-operation, architectural, usage, performance and outcome signals. Default telemetry does **not** upload source code, diffs, prompts, secrets, filenames, repository names or raw project paths. The data includes stable installation IDs and pseudonymous project/finding identifiers; linkable pseudonyms may still count as personal data. `vibe-monitor telemetry status` and `vibe-monitor telemetry inspect` are read-only ways to check what is queued.

For the upcoming stable 1.0.1 client, telemetry is enabled by default at installation and is required for architecture analysis. CLI mutation commands are intentionally disabled. **An authenticated website control for an individual installation is not yet available.** Do not claim that per-user website opt-out is available; stopping use or uninstalling the client stops new collection, but does not erase previously received records. The official stable package is not yet published.

## Single client, separate policy and telemetry interfaces

- `GET /free/policy`: live Cloud-to-client declarative architecture policy, signed with Ed25519 and verified against a pinned client public key. `community` and `free` are internal compatibility identifiers, **not** distinct client products.
- `POST /free/telemetry`: live client-to-Cloud product telemetry, rate-limited by Cloudflare, validated again in Neon and previously persisted in the now-obsolete `public.telemetry_events` table. The replacement under QA will store sanitized events in the existing `public.events` table while retaining independent Beta `/events` authentication. No replacement package has been published.

Both production interfaces passed live checks on 2026-10-18, including one synthetic database write subsequently removed. Live endpoint availability does not itself mean the npm 1.0.1 package has been published.

## Storage and privacy limits

Accepted product history (pseudonymous usage, architecture evolution, recommendations, feedback and outcome verification) has **no automatic age-based Cloud TTL, scheduled deletion or purge**. Local queues and caches have separate cleanup policies. An installation identifier and linkable pseudonyms are not guaranteed to be anonymous. Legally required targeted erasure needs an authorized, auditable procedure.

The Neon production database is hosted in **AWS Singapore (`aws-ap-southeast-1`)**. International-transfer compliance, lawful basis, notices, security/access controls, storage retention, and the not-yet-implemented individual website controls require product-owner/privacy review before a public stable release is authorized. This document is a factual technical disclosure, **not** a legal compliance certification.

The client is currently one open-source product; separate Pro or Team client variants are not released. A future commercial plan is not an existing user entitlement.

## Purpose

Private beta needs enough evidence to improve Vibe Monitor's decisions without turning Vibe into a source-code or conversation collection system.

Telemetry V4 is built around this observation chain:

```text
session
  → call
  → scan
  → finding
  → notice
  → outcome / feedback
```

It is:

- required during the current private beta and explicitly disclosed during setup/install;
- inspectable before and during use;
- rejected if the user attempts `--no-telemetry` or `telemetry off` while the private-beta policy requires telemetry;
- pseudonymized before it enters the telemetry queue;
- best-effort for transport and never allowed to block coding on a network upload;
- structured around derived architectural evidence rather than source contents.

Mandatory telemetry is a private-beta participation condition used for calibration and outcome measurement. It is not a statement that future public/stable plans must require telemetry. If the local telemetry state is tampered off while Cloud policy requires it, monitoring fails closed instead of silently running outside the beta contract.

## Never collected by default telemetry

- source code;
- diffs;
- prompts or chat content;
- repository name or URL;
- project path;
- file names or finding target paths;
- environment-variable values;
- API keys/secrets/tokens;
- raw terminal output/logs;
- free-text feedback notes;
- raw local project IDs;
- raw finding IDs;
- natural-language agent instructions or finding explanation text.

The Neon ingestion layer also strips payload keys such as `path`, `root`, `target`, `source`, `code`, `diff`, `prompt`, `note`, `message`, `instruction`, `secret`, `token`, `url`, `remote`, `branch`, and `head` before persisting JSONB payloads.

## Identity model

Cloud-side correlation is:

```text
tester
  → device
  → installation
  → session
  → repo pseudonym
  → project-instance pseudonym
  → events
```

- tester identity exists only in the beta administration database;
- device ID is a random stable UUID generated locally;
- installation ID is the revocable Cloud registration;
- session ID is a random UUID created per MCP process/session;
- local repo, project-instance and finding IDs are HMAC-pseudonymized before queueing.

No hostname is required for default device identity. Default labels are coarse values such as `macOS arm64`.

## Collected when enabled

Common event fields may include:

- event type and timestamp;
- session ID;
- call ID for one Vibe tool invocation;
- scan ID for one monitoring pass;
- current Vibe client version;
- evidence version;
- HMAC-pseudonymized project/finding IDs;
- coding-agent family;
- monitor family;
- S-stage and stage transitions;
- attention/finding counts;
- scan duration and wall time;
- scanner-overhead percentage;
- full/cached/deferred monitoring mode;
- structured feedback verdict.

Telemetry V4 additionally sends privacy-minimized JSONB payloads.

### Scan observation payload

May include:

- whether the project changed;
- full/cached/deferred reason;
- full/cached/deferred counters;
- source-file, LOC, dependency and test-file **buckets**;
- dependency graph count buckets;
- bounded Tree-sitter structural scan counts, parser errors, languages and duration;
- product-intent enum values in separate bounded fields: `intent` is the confirmed effective value, `inferredIntent` is unconfirmed code-derived context, and `intentProvenance` is `explicit|inferred|unknown`; missing or invalid values remain `unknown` (never silently promote inference to an explicit user requirement);
- phase timings such as remote-policy, Git fingerprint/evidence, evidence scan, structural parsing, monitor evaluation and history read/write durations.

### Data Intelligence V1 profile (included in Beta telemetry)

Vibe adds a bounded, <1 KiB `architectureProfile` to an existing **full**
`scan.observed` event as part of the enabled beta telemetry stream.
It uses already computed scan signals and no extra scan, LLM, event, or network
request. Fields are coarse product candidates, technology/deployment/integration
classes and architectural/test signals. Raw code, prompts, provider/package
names, project paths and repositories are excluded.

Data Intelligence is included with beta telemetry by default. Previously declined collection stays off. Use telemetry intelligence off to exclude new profiles.

See `docs/product/DATA_INTELLIGENCE_V1.md` for full data and privacy contract.

### Finding observation payload

May include:

- score;
- confidence;
- evidence-quality class;
- number of supporting signals;
- signal names;
- signal buckets / numeric value buckets;
- independence groups;
- agent-action mode such as `next-change-guidance`;
- whether semantic review was recommended.

It does **not** include finding target paths, natural-language evidence strings, recommendation text or code snippets.

### Notice observation payload

May include:

- whether a finding was surfaced;
- action mode;
- whether semantic review was recommended;
- aggregate suppressed-notice count;
- current notice budget.

This distinguishes “Vibe observed a problem” from “the user actually saw a warning”.

### Call / scan correlation

Each Vibe tool invocation receives a random `call_id`. Each monitoring pass receives a random `scan_id`.

This allows one session to distinguish repeated calls such as:

```text
session_start
  → full scan
project_status
  → cached scan
checkpoint
  → deferred/full scan
```

Repeated observations of the same finding are therefore not treated as new unique problems.

### Outcome and feedback

Finding transitions retain:

- new attention;
- worsened;
- improved;
- from/to stages.

Explicit user feedback uploads only the structured verdict:

- useful;
- false_positive;
- too_early;
- too_late;
- confusing.

A local free-text feedback note is never copied to the telemetry queue.

Surfaced notices retain a coarse action mode such as `next-change-guidance`, `semantic-review`, `staged-remediation`, `next-change-watch` or `observe-only`. Outcome analysis can link a later improvement/worsening or structured feedback verdict to the most recent surfaced action for the same pseudonymized finding and calculate time-to-outcome.

## Pseudonymization

A random telemetry HMAC secret is stored in the OS secret store. Before queueing:

```text
cloudProjectId = HMAC-SHA256(telemetrySecret, localProjectId)
cloudFindingId = HMAC-SHA256(telemetrySecret, localFindingId)
```

Only shortened HMAC outputs enter the queue. This permits longitudinal analysis within one installation without exposing raw repository or finding identifiers.

## Local files

```text
~/.vibe-monitor/telemetry/
├── config.json
├── identity.json
└── queue.jsonl
```

- `config.json`: telemetry state + consent version;
- `identity.json`: random telemetry identity metadata, no HMAC secret;
- `queue.jsonl`: exact upload payload.

Sensitive HMAC and Cloud installation credentials remain in the OS secret store.

## Cloud storage

Neon stores indexed common columns plus a bounded `payload JSONB`.

Separate `sessions`, `calls` and `scans` tables summarize the hierarchy. A session records:

- installation;
- session ID;
- pseudonymized project;
- agent;
- client version;
- evidence version;
- start / last-event timestamps;
- event count.

A call records the Vibe tool invocation, its scan ID, total tool time and local telemetry-queue time. A scan records full/cached/deferred mode plus bounded phase timings. Views expose per-scan unique finding counts and link surfaced actions to later outcomes.

JSONB is intentionally used for evolving observation details so adding a new derived signal does not require a schema migration every time. Stable/high-value dimensions can later be promoted to indexed columns or materialized views.

## Architecture Review Protocol data

ARP v1 architecture-review data is a separate analysis flow from default telemetry.

When the current host agent explicitly performs a Vibe semantic architecture review, the Cloud review record may contain:

- pseudonymized repo, project-instance and finding IDs;
- review/protocol/session identifiers;
- monitor family and candidate stage;
- evidence digest;
- normalized signal names, buckets/counts and structural evidence;
- bounded Product Intent enums;
- agent family;
- submitted verdict, recommended stage and confidence;
- references to evidence keys used as supporting/counter evidence;
- counts of local response fields;
- a later linked `finding.improved` or `finding.worsened` observation.

The default ARP Cloud record does **not** contain:

- source code or diffs;
- repository URL, branch, absolute project path or finding target path;
- prompts/chat transcripts;
- hidden chain-of-thought;
- the model-generated review summary;
- model-generated `doNow`, `doNotDoYet`, assumption or next-trigger text.

The full ARP response envelope is stored locally under Vibe state so the coding agent can use it without turning free-form architecture reasoning into telemetry.

## Failure behavior

Telemetry must never block:

- session start;
- checkpoint;
- status/findings;
- feedback capture;
- normal coding.

Upload uses a local queue with acknowledgement/removal. Errors are best-effort and remain outside the coding path.

## User control

Commands:

```bash
vibe-monitor telemetry status
vibe-monitor telemetry inspect
vibe-monitor telemetry on
```

During the current private beta, `telemetry off` and installation/setup with `--no-telemetry` are rejected. The user can always inspect the exact queued payload and can stop participating by uninstalling/disconnecting Vibe Monitor.

The required-telemetry policy is explicit and versioned. A future public/stable plan may define optional telemetry, but that would be a product-policy change rather than an implicit relaxation of this private-beta contract.

A separate global `service_control.enabled` kill switch can stop Vibe Monitor entirely. When disabled, project scans, findings/notices and telemetry upload stop; only the lightweight control-plane check remains so a later reactivation can be discovered.

If telemetry is locally forced off while the current Cloud policy requires it, service control fails closed: scans/notices are not allowed to continue as if the installation were compliant.


### Explicit lifecycle (Beta V1)

Official install/uninstall sends a small event through existing required beta telemetry with known agent IDs, remaining known agents, scope and credential reuse. No paths, code, prompts, device serials, IP or reasons are collected. A 2s bounded upload preserves offline records; inactivity uses existing cloud contact timestamps only and does not prove uninstall. See `docs/product/LIFECYCLE_V1.md`.
