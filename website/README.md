# Vibe Monitor official website

The product landing page is public, bilingual (English / 简体中文), responsive, and a standalone static site with **zero build dependencies**.

## Serve locally

From the `website/` directory:

```sh
python3 -m http.server 8000
```

Open http://localhost:8000. No Node, API keys, database or Vibe Cloud access is required.

## Deployment

Recommended Vercel project: `vibe-monitor-site`, Git provider GitHub `tubban1/vibe-monitor`, root directory `website`, framework **Other** (none), no install or build command and no output directory override. The `website/vercel.json` headers limit external requests and enable basic browser protections.

Deploy only this public website tree. **Never point the Vercel site at `tubban1/vibe-monitor-internal`.**

## Release and truthfulness rules

- `Community`, `Pro`, `Team` are a future one-client model, **not current paid plans**. The source release is not yet published.
- The existing `@vibe-monitor/setup@beta` needs a private-beta invitation/activation. Do not silently use the stale npm `latest` tag.
- The terminal install command remains the existing official Beta command, which requires Node/npm; success depends on private-beta activation.
- The illustrative architecture display is **not actual project data**. It is labeled accordingly.
- Privacy notice links to the existing public Telemetry V4 document. Current Beta telemetry is required under disclosed Beta terms.
- No analytics, cookies, newsletter collection, API submission or external JS dependencies are added. Language selection only stores a local preference.
- The GitHub Beta request issue form is public; visitors should never publish email, passwords, source code or activation codes there.
- For a custom domain, configure an owned domain later; no domain was purchased or assigned by this change.
