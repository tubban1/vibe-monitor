import { sha256 } from "./utils.js";
const STAGE_RANK = Object.freeze({ S1: 1, S2: 2, S3: 3, S4: 4, S5: 5 });

/** Path-based context only; callers must present this as a hypothesis, not proof.
 * Require a plausible entry or adapter filename, never an arbitrary substring:
 * features/main.tsx and components/cloud-bridge-card.tsx are not boundaries.
 */
export function architectureRoleForTarget(target) {
  const value = String(target || "").replaceAll("\\", "/").replace(/^\.\//, "").toLowerCase();
  if (
    /^(?:(?:apps|packages)\/[^/]+\/)?(?:src\/)?(?:main|bootstrap)\.(?:mjs|cjs|js|mts|cts|ts|tsx)$/.test(value) ||
    /^(?:(?:apps|packages)\/[^/]+\/)?electron\/main\.(?:mjs|cjs|js|mts|cts|ts)$/.test(value)
  ) {
    return { role: "composition-root", source: "path-heuristic" };
  }
  if (/(?:^|\/)(?:owl-runtime|runtime-(?:client|bridge|adapter|integration)|local-runtime-(?:bootstrap|client|bridge))\.(?:mjs|cjs|js|mts|cts|ts)$/.test(value)) {
    return { role: "external-runtime-integration", source: "path-heuristic" };
  }
  if (/(?:^|\/)(?:cloud-(?:bridge|client|adapter)|cloud\/(?:bridge|client|adapter))\.(?:mjs|cjs|js|mts|cts|ts)$/.test(value)) {
    return { role: "cloud-bridge", source: "path-heuristic" };
  }
  return { role: "unclassified", source: "path-heuristic" };
}

export function hasExistingRuntimeBoundary(files = []) {
  return files.some(file => architectureRoleForTarget(file?.path).role === "external-runtime-integration");
}

export function assessBoundaryEvidence({ stage, structuralEvidence, architectureRole } = {}) {
  const rank = STAGE_RANK[stage] || 0;
  const candidates = Number(structuralEvidence?.boundaryCandidateCount || 0);
  if (architectureRole && architectureRole !== "unclassified") {
    return {
      status: candidates > 0 ? "boundary-candidate-needs-context" : "existing-boundary-context",
      architectureRole,
      semanticEvidenceAvailable: candidates > 0,
      recommendation: "preserve-existing-boundary"
    };
  }
  if (rank >= 3 && candidates > 0) {
    return {
      status: "structural-boundary-candidate",
      architectureRole: "unclassified",
      semanticEvidenceAvailable: true,
      recommendation: "verify-small-boundary"
    };
  }
  if (rank >= 3) {
    return {
      status: "insufficient-semantic-evidence",
      architectureRole: "unclassified",
      semanticEvidenceAvailable: false,
      recommendation: "human-verification-before-change"
    };
  }
  return {
    status: "watch",
    architectureRole: "unclassified",
    semanticEvidenceAvailable: candidates > 0,
    recommendation: "observe"
  };
}

/** Consolidates repeated advice while preserving every underlying Finding. */
export function recommendationGroups(findings = []) {
  const structural = findings.filter(finding => finding.family === "code-structure");
  const groups = new Map();
  for (const finding of structural) {
    const guidance = Array.isArray(finding.doNow) ? finding.doNow.join(" ") : finding.userFacing?.doNow;
    if (!guidance) continue;
    const group = groups.get(guidance) || [];
    group.push(finding);
    groups.set(guidance, group);
  }
  return [...groups.entries()]
    .filter(([, group]) => group.length > 1)
    .map(([guidance, group]) => ({
      key: "code-structure-guidance-" + sha256(guidance).slice(0, 12),
      findingIds: group.map(finding => finding.id),
      summary: "这些文件保留为独立 Findings；它们共享同一条建议，可合并阅读并只在下一次实际改动触及时核实职责。"
    }));
}
