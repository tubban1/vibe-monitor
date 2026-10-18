#!/usr/bin/env python3
"""Fail-closed checks for the CURRENT public repo surface.

Distinguish prerelease previews from stable, public open-client source.
Always reject secrets, private website source, and unreviewed public files.
"""
from pathlib import Path
import re
import json
import sys

root = Path(__file__).resolve().parents[1]
errors = []

def require(path):
    p = root / path
    if not p.is_file():
        errors.append(f"required_missing:{path}")
        return ""
    return p.read_text(encoding="utf-8")

readme = require("README.md")
privacy = require("docs/governance/TELEMETRY_PRIVACY_V1.md")
issue = require(".github/ISSUE_TEMPLATE/beta-access.yml")
if "https://vibe.fde.fan" not in readme:
    errors.append("official_website_missing")
manifest=json.loads(require("package.json"))
if manifest.get("private") is False:
    if not re.fullmatch(r"[0-9]+\.[0-9]+\.[0-9]+", manifest.get("version","")):
        errors.append("stable_package_semver_invalid")
    if manifest.get("name") != "@vibe-monitor/setup" or manifest.get("license") != "Apache-2.0":
        errors.append("stable_package_identity_invalid")
    if "@vibe-monitor/setup@" + manifest.get("version","") not in readme:
        errors.append("stable_install_instructions_missing")
else:
    client_source_disclosed = re.search(r"\bclient[\s-]+source\b", readme, re.IGNORECASE)
    unreleased_disclosed = re.search(
        r"\bnot\b(?:[^\w]+been)?[^\w]+(?:merged|published|released|shipped)\b",
        readme,re.IGNORECASE
    )
    if not client_source_disclosed or not unreleased_disclosed:
        errors.append("unreleased_oss_status_disclosure_missing")
if not privacy or "telemetry" not in privacy.lower():
    errors.append("beta_privacy_disclosure_missing")
if not issue or "beta" not in issue.lower():
    errors.append("beta_application_form_missing")
if (root / "website").exists():
    errors.append("marketing_web_source_should_be_private")
for file in root.rglob("*"):
    if not file.is_file():
        continue
    rel = file.relative_to(root).as_posix()
    if any(part in {".git", "node_modules"} for part in file.relative_to(root).parts):
        continue
    if file.name == ".env" or file.name.startswith(".env.") or file.suffix in {".pem", ".p12", ".pfx", ".key"}:
        errors.append(f"prohibited_public_file:{rel}")
    if re.search(r"(?i)(private.?key|secret|credential)", rel) and rel not in {"README.md"}:
        errors.append(f"review_sensitive_filename:{rel}")
# A public CLI/MCP source tree will require a proper multi-OS CI matrix once it exists.
if (root / "src").is_dir():
    if not (root / "package.json").is_file():
        errors.append("client_source_without_package_manifest")
    if not (root / "LICENSE").is_file():
        errors.append("client_source_without_approved_license")
if errors:
    print("PUBLIC SURFACE AUDIT FAILED\n" + "\n".join(errors), file=sys.stderr)
    sys.exit(1)
print("PUBLIC SURFACE AUDIT PASSED: publishable source identity, privacy and repository boundary")
