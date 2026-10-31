import fs from 'node:fs';
import path from 'node:path';

const METRIC_MEANINGS = {
  size: 'Physical source lines in the target file, not complexity by itself.',
  responsibility_concentration: 'Number of responsibility categories matched by heuristic source vocabulary; not independent domains.',
  mixed_layer_work: 'Heuristic co-occurrence of presentation and infrastructure patterns; requires human verification.',
  function_concentration: 'Count of function-like constructs, including callbacks and nested functions; not a count of distinct responsibilities.',
  hotspot_frequency: 'Share of the recent Git commit sample touching this file; not a probability of failure.',
  change_coupling: 'Repeated co-changes with other files in Git history, not proven runtime coupling.'
};
const INDICATORS = [
  ['state', /\b(?:useState|useReducer|createContext|setState)\s*\(/],
  ['network', /\b(?:fetch|axios|XMLHttpRequest|WebSocket)\s*\(/],
  ['storage', /\b(?:localStorage|sessionStorage|indexedDB|database)\b/],
  ['browser-side-effect', /\b(?:document\.|window\.|navigator\.|URL\.createObjectURL)\b/],
  ['async', /\b(?:async|await|setTimeout|setInterval)\b/],
  ['presentation', /\b(?:return\s*\(|className=|<div|<button)\b/]
];

export function findingDetail(root, finding, summary = {}) {
  if (!finding) return null;
  const result = {
    ...finding,
    explanation: {
      signalDefinitions: (finding.signals || []).map(signal => ({
        name: signal.name, value: signal.value, meaning: METRIC_MEANINGS[signal.name] || signal.evidence,
        evidenceKind: signal.evidence, limitations: 'A measured signal is not proof that a refactor is needed.'
      })),
      evidenceClassification: {
        observed: (finding.signals || []).filter(signal => !/heuristic|derived/i.test(String(signal.evidence || ""))).map(signal => signal.name),
        inferred: (finding.signals || []).filter(signal => /heuristic|derived/i.test(String(signal.evidence || ""))).map(signal => signal.name),
        recommendation: {
          doNow: finding.doNow || [],
          prepare: finding.prepare || [],
          doNotDoYet: finding.doNotDoYet || [],
          nextTrigger: finding.nextTrigger || null,
          decisionQuestions: finding.decisionQuestions || []
        }
      },
      sourceEvidence: [],
      verificationContext: {
        testFiles: summary.testFiles ?? null,
        advice: summary.testFiles === 0 ? 'No repository-visible tests: add focused characterization tests before moving behavior; external tests may exist.' : null
      },
      decisionAssessment: finding.boundaryAssessment || {
        status: finding.stage === "S3" || finding.stage === "S4" || finding.stage === "S5"
          ? "human-verification-required"
          : "observe",
        semanticEvidenceAvailable: Boolean(finding.structuralEvidence?.boundaryCandidateCount),
        recommendation: finding.structuralEvidence?.boundaryCandidateCount
          ? "verify-small-boundary"
          : "human-verification-before-change"
      },
      architecturalContext: finding.architectureContext || null,
      caveat: 'Source excerpts are indicators, not a semantic proof of a module boundary.'
    }
  };
  if (finding.sourceEvidence?.length) result.explanation.sourceEvidence = finding.sourceEvidence;
  if (finding.relatedEvidence) result.explanation.relatedEvidence = finding.relatedEvidence;
  if (finding.target === 'project') return result;
  const rootPath = fs.realpathSync(root);
  const filePath = path.resolve(rootPath, finding.target);
  if (!filePath.startsWith(rootPath + path.sep)) return result;
  try {
    if (!fs.statSync(filePath).isFile() || fs.statSync(filePath).size > 1024 * 1024 || !fs.realpathSync(filePath).startsWith(rootPath + path.sep)) return result;
    const lines = fs.readFileSync(filePath, 'utf8').split(/\r?\n/);
    const hits = [];
    const role = finding.architectureContext?.role || "unclassified";
    const rolePatterns = role === "composition-root"
      ? [["composition-wiring", /\b(?:whenReady|BrowserWindow|ipcMain\.(?:handle|on)|registerTool|createWindow|bootstrap)\b/]]
      : role === "external-runtime-integration"
        ? [["runtime-boundary", /\b(?:runtime|spawn|child_process|executeTask|recoverTask|abortSignal)\b/i]]
        : role === "cloud-bridge"
          ? [["cloud-bridge", /\b(?:cloud|fetch|request|response|credential|token)\b/i]]
          : [];
    for (const [kind, regex] of rolePatterns) {
      for (let i = 0; i < lines.length; i++) {
        const line = lines[i];
        if (line.length <= 400 && !/^\s*(?:\/\/|\*|#)/.test(line) && regex.test(line)) {
          hits.push({ kind, path: finding.target, line: i + 1, excerpt: line.trim().slice(0, 180), supports: "architectural role indicator; human verification required" });
          break;
        }
      }
    }
    for (const candidate of finding.structuralEvidence?.boundaryCandidates || []) {
      hits.push({
        kind: "structural-boundary-candidate",
        path: finding.target,
        group: candidate.group,
        functionCount: candidate.functionCount,
        internalCalls: candidate.internalCalls,
        crossCalls: candidate.crossCalls,
        members: (candidate.members || []).slice(0, 5),
        supports: "Tree-sitter cluster and local-call-graph evidence; does not prove semantic ownership"
      });
    }
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line.length > 400 || /^\s*(?:\/\/|\*|#)/.test(line)) continue;
      for (const [kind, regex] of INDICATORS) {
        if (regex.test(line) && !hits.some(hit => hit.kind === kind)) {
          hits.push({ kind, path: finding.target, line: i + 1, excerpt: line.trim().slice(0, 180) });
        }
      }
      if (hits.length >= INDICATORS.length) break;
    }
    result.explanation.sourceEvidence = [...result.explanation.sourceEvidence, ...hits].slice(0, 8);
  } catch { /* source may have disappeared since scan */ }
  return result;
}
