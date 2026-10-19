import test from "node:test";
import assert from "node:assert/strict";
import os from "node:os";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { createMonitoringBudgetSession } from "../src/budget.js";

test("full-scan cooldown must not restart checkpoint cooldown on a deferred project change", () => {
  const originalNow = Date.now;
  const originalHome = process.env.VIBE_MONITOR_HOME;
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "vm-cooldown-"));
  const repo = path.join(base, "playground");
  const policy = { checkpointMinIntervalSec: 180, fullScanMinIntervalSec: 300 };
  const clockStart = Date.parse("2026-10-18T12:00:00Z");
  let offsetSec = 0;
  try {
    process.env.VIBE_MONITOR_HOME = path.join(base, "vibe-state");
    fs.mkdirSync(repo);
    fs.writeFileSync(path.join(repo, "package.json"),
      JSON.stringify({ name: "test-playground", version: "1.0.0", type: "module" }));
    fs.mkdirSync(path.join(repo, "src"));
    const source = path.join(repo, "src", "index.js");
    fs.writeFileSync(source, "export const answer = 42;\n");
    const git = args => execFileSync("git", args, { cwd: repo, stdio: "ignore" });
    git(["init", "-q"]);
    git(["add", "."]);
    git(["-c", "user.name=QA", "-c", "user.email=qa@example.invalid",
      "commit", "-qm", "baseline"]);
    Date.now = () => clockStart + offsetSec * 1000;
    const session = createMonitoringBudgetSession();
    const initial = session.analyze(repo, { kind: "session_start", persist: false, policy });
    assert.equal(initial.monitoring.mode, "full");
    fs.appendFileSync(source, "export const updated = true;\n");
    offsetSec = 200;
    const cooldown = session.analyze(repo, { kind: "checkpoint", persist: false, policy });
    assert.equal(cooldown.monitoring.mode, "deferred");
    assert.equal(cooldown.monitoring.deferReason, "full_scan_interval");
    assert.equal(cooldown.monitoring.projectChanged, true);
    offsetSec = 310;
    const after = session.analyze(repo, { kind: "checkpoint", persist: false, policy });
    assert.equal(after.monitoring.mode, "full");
    assert.equal(after.monitoring.fullScanCount, 2);
  } finally {
    Date.now = originalNow;
    if (originalHome === undefined) delete process.env.VIBE_MONITOR_HOME;
    else process.env.VIBE_MONITOR_HOME = originalHome;
    fs.rmSync(base, { recursive: true, force: true });
  }
});
