import test from "node:test";
import assert from "node:assert/strict";
import {
  DEFAULT_DEMOTION_MARGIN,
  resolveDemotionMargin,
  sanitizeDecisionPolicy,
  evaluateScoringStage
} from "../src/decision-policy.js";
import { stageFromScore } from "../src/utils.js";
import { freeTelemetryWireBatch, enqueueActivityTelemetry } from "../src/telemetry.js";

test("demotion margin resolution and policy sanitization", () => {
  assert.equal(DEFAULT_DEMOTION_MARGIN, 5);
  assert.equal(resolveDemotionMargin(null), 5);
  assert.equal(resolveDemotionMargin({}), 5);
  assert.equal(resolveDemotionMargin({ demotionMargin: 0 }), 0);
  assert.equal(resolveDemotionMargin({ demotionMargin: 10 }), 10);
  assert.equal(resolveDemotionMargin({ demotionMargin: 15 }), 15);
  // Out of range or invalid falls back to 5
  assert.equal(resolveDemotionMargin({ demotionMargin: -1 }), 5);
  assert.equal(resolveDemotionMargin({ demotionMargin: 20 }), 5);
  assert.equal(resolveDemotionMargin({ demotionMargin: "invalid" }), 5);

  const basePolicy = {
    schemaVersion: 2,
    policyId: "custom-policy",
    revision: 1,
    stageThresholds: { S2: 35, S3: 50, S4: 70, S5: 85 },
    minSupportingSignals: { S3: 3, S4: 4, S5: 4 },
    familyScoreWeights: {},
    signalWeights: {},
    adviceRules: {}
  };

  const validPolicy = sanitizeDecisionPolicy({ ...basePolicy, demotionMargin: 10 });
  assert.ok(validPolicy);
  assert.equal(validPolicy.demotionMargin, 10);
  assert.equal(resolveDemotionMargin(validPolicy), 10);

  const invalidMarginPolicy = sanitizeDecisionPolicy({ ...basePolicy, demotionMargin: 99 });
  assert.ok(invalidMarginPolicy);
  assert.equal(invalidMarginPolicy.demotionMargin, 5); // clamped/fallback to 5
});

test("positive case: S3 finding score drops 50 -> 47 stays S3 (no demotion)", () => {
  // Score 47 is below S3 threshold 50, but >= (50 - 5 = 45), supporting signals 3
  const stage = evaluateScoringStage(47, 3, null, "code-structure", "S3");
  assert.equal(stage, "S3");

  const viaUtils = stageFromScore(47, 3, null, "code-structure", "S3");
  assert.equal(viaUtils, "S3");
});

test("negative case: S3 finding score drops 50 -> 44 demotes to S2", () => {
  // Score 44 is below 45 (threshold 50 - margin 5), so it demotes to S2
  const stage = evaluateScoringStage(44, 3, null, "code-structure", "S3");
  assert.equal(stage, "S2");

  const viaUtils = stageFromScore(44, 3, null, "code-structure", "S3");
  assert.equal(viaUtils, "S2");
});

test("insufficient supporting signals causes immediate demotion even if score >= 45", () => {
  // Score 48 >= 45, but supporting signals = 2 < minSupportingSignals.S3 (3)
  const stage = evaluateScoringStage(48, 2, null, "code-structure", "S3");
  assert.equal(stage, "S2");
});

test("promotion rule remains unchanged: S2 rises 48 -> 51 promotes to S3", () => {
  // Rising from S2 to S3 requires score >= 50 and signals >= 3
  const stageBefore = evaluateScoringStage(48, 3, null, "code-structure", "S2");
  assert.equal(stageBefore, "S2");

  const stageAfter = evaluateScoringStage(51, 3, null, "code-structure", "S2");
  assert.equal(stageAfter, "S3");
});

test("first scan has no previous stage (previousStage = null) and is unaffected by buffer", () => {
  // Score 47 without previous stage falls into S2 (47 < 50)
  const stage = evaluateScoringStage(47, 3, null, "code-structure", null);
  assert.equal(stage, "S2");

  const stageUndefined = evaluateScoringStage(47, 3, null, "code-structure", undefined);
  assert.equal(stageUndefined, "S2");
});

test("S4 and S5 demotion hysteresis", () => {
  // S4 threshold is 70, margin 5 -> buffer 65-70
  assert.equal(evaluateScoringStage(68, 4, null, "code-structure", "S4"), "S4");
  assert.equal(evaluateScoringStage(64, 4, null, "code-structure", "S4"), "S3");
  // S4 with insufficient signals (3 < 4) demotes immediately
  assert.equal(evaluateScoringStage(68, 3, null, "code-structure", "S4"), "S3");

  // S5 threshold is 85, margin 5 -> buffer 80-85
  assert.equal(evaluateScoringStage(82, 4, null, "code-structure", "S5"), "S5");
  assert.equal(evaluateScoringStage(79, 4, null, "code-structure", "S5"), "S4");
  // S5 with insufficient signals (3 < 4) demotes immediately to S3 (since S4 also requires 4 signals)
  assert.equal(evaluateScoringStage(82, 3, null, "code-structure", "S5"), "S3");
});

test("custom policy demotionMargin behaviors", () => {
  const policyZeroMargin = {
    schemaVersion: 2, policyId: "zero-margin", revision: 1,
    stageThresholds: { S2: 35, S3: 50, S4: 70, S5: 85 },
    minSupportingSignals: { S3: 3, S4: 4, S5: 4 },
    familyScoreWeights: {}, signalWeights: {}, adviceRules: {},
    demotionMargin: 0
  };
  // With margin = 0, no buffer: 49 drops immediately to S2
  assert.equal(evaluateScoringStage(49, 3, policyZeroMargin, "code-structure", "S3"), "S2");

  const policyWideMargin = {
    schemaVersion: 2, policyId: "wide-margin", revision: 1,
    stageThresholds: { S2: 35, S3: 50, S4: 70, S5: 85 },
    minSupportingSignals: { S3: 3, S4: 4, S5: 4 },
    familyScoreWeights: {}, signalWeights: {}, adviceRules: {},
    demotionMargin: 10
  };
  // With margin = 10, buffer is 40-50: 42 remains S3, 39 drops to S2
  assert.equal(evaluateScoringStage(42, 3, policyWideMargin, "code-structure", "S3"), "S3");
  assert.equal(evaluateScoringStage(39, 3, policyWideMargin, "code-structure", "S3"), "S2");
});

test("oscillation sequence 50 -> 48 -> 51 -> 47 -> 52 maintains stable S3 stage", () => {
  const scores = [50, 48, 51, 47, 52];
  let currentStage = "S2";
  const stages = [];

  for (const score of scores) {
    currentStage = evaluateScoringStage(score, 3, null, "code-structure", currentStage);
    stages.push(currentStage);
  }

  // Initial 50 promotes S2 -> S3. Subsequent scores 48, 51, 47, 52 all remain S3!
  assert.deepEqual(stages, ["S3", "S3", "S3", "S3", "S3"]);
});

test("telemetry payload includes demotionMargin and wire projection preserves it", () => {
  const sampleEvent = {
    schemaVersion: 4,
    eventId: "11111111-2222-3333-4444-555555555555",
    installationId: "66666666-7777-8888-9999-000000000000",
    at: new Date().toISOString(),
    event: "finding.improved",
    projectId: "a".repeat(32),
    repoId: "b".repeat(32),
    projectInstanceId: "a".repeat(32),
    findingId: "c".repeat(32),
    sessionId: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
    callId: "11111111-aaaa-bbbb-cccc-222222222222",
    scanId: "33333333-dddd-eeee-ffff-444444444444",
    evidenceVersion: 7,
    policyRevision: 2,
    agent: "antigravity",
    family: "code-structure",
    fromStage: "S3",
    toStage: "S2",
    actionMode: "observe-only",
    payload: {
      transitionType: "improved",
      currentActionMode: "observe-only",
      demotionMargin: 5
    }
  };

  const wireBatch = freeTelemetryWireBatch([sampleEvent]);
  assert.equal(wireBatch.length, 1);
  const projected = wireBatch[0];
  assert.equal(projected.payload.demotionMargin, 5);
  assert.equal(projected.payload.transitionType, "improved");
  assert.equal(projected.payload.currentActionMode, "observe-only");
  // Ensure no spurious fields are added
  assert.deepEqual(
    Object.keys(projected.payload).sort(),
    ["currentActionMode", "demotionMargin", "transitionType"].sort()
  );
});

test("integration: analyzeProject end-to-end stage hysteresis and transitions", async () => {
  const fs = await import("node:fs");
  const path = await import("node:path");
  const os = await import("node:os");
  const { analyzeProject } = await import("../src/engine.js");
  const { POLICY_V2_FAMILIES } = await import("../src/decision-policy.js");

  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-hysteresis-test-"));
  const tempHome = fs.mkdtempSync(path.join(os.tmpdir(), "vibe-home-"));
  const origVibeHome = process.env.VIBE_HOME;
  process.env.VIBE_HOME = tempHome;

  try {
    fs.mkdirSync(path.join(tempRoot, ".git"));
    fs.writeFileSync(path.join(tempRoot, ".git", "HEAD"), "ref: refs/heads/main\n");

    const policy = {
      schemaVersion: 2,
      policyId: "hysteresis-test-policy",
      revision: 1,
      stageThresholds: { S2: 35, S3: 50, S4: 70, S5: 85 },
      minSupportingSignals: { S3: 3, S4: 4, S5: 4 },
      familyScoreWeights: {},
      signalWeights: Object.fromEntries(
        POLICY_V2_FAMILIES.map(f => [f, {
          size: 20,
          function_concentration: 14,
          dependency_fan_out_proxy: 10,
          responsibility_concentration: 6
        }])
      ),
      adviceRules: {}
    };

    function makeFile(withResp) {
      const imports = Array.from({ length: 12 }, (_, i) => `import { mod_${i} } from "./mod_${i}.js";`).join("\n");
      const functions = Array.from({ length: 35 }, (_, i) => `export function helper_${i}() { return ${i}; }`).join("\n");
      const respWords = withResp ? "database sql router auth socket useState cron" : "";
      const fillers = Array.from({ length: 1200 }, (_, i) => `export const val_${i} = ${i};`).join("\n");
      fs.writeFileSync(path.join(tempRoot, "app-module.js"), `${imports}\n\n// ${respWords}\n\n${functions}\n\n${fillers}\n`);
    }

    // Scan 1: size(20) + fn(14) + dep(10) + resp(6) = 50 -> enters S3 (promotion)
    makeFile(true);
    const res1 = analyzeProject(tempRoot, { persist: true, decisionPolicy: policy });
    assert.equal(res1.demotionMargin, 5);
    const f1 = res1.findings.find(f => f.family === "code-structure");
    assert.ok(f1);
    assert.equal(f1.score, 50);
    assert.equal(f1.stage, "S3");

    // Scan 2: score drops to 20 + 14 + 10 = 44 (< 45 demotion threshold) -> demotes to S2 with improved transition
    makeFile(false);
    const res2 = analyzeProject(tempRoot, { persist: true, decisionPolicy: policy });
    assert.equal(res2.demotionMargin, 5);
    const f2 = res2.findings.find(f => f.family === "code-structure");
    assert.ok(f2);
    assert.equal(f2.score, 44);
    assert.equal(f2.stage, "S2");

    const improvedTrans = res2.transitions.find(t => t.id === f2.id && t.type === "improved");
    assert.ok(improvedTrans, "score 44 below margin must trigger improved transition");
    assert.equal(improvedTrans.fromStage, "S3");
    assert.equal(improvedTrans.toStage, "S2");
  } finally {
    if (origVibeHome !== undefined) process.env.VIBE_HOME = origVibeHome;
    else delete process.env.VIBE_HOME;
    fs.rmSync(tempRoot, { recursive: true, force: true });
    fs.rmSync(tempHome, { recursive: true, force: true });
  }
});

