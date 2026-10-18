// Stable LOCAL detector IDs, independent of signed Cloud policyId/revision.
// A finding ID identifies a project instance; ruleId identifies a detector.
const RULE_IDS = Object.freeze({
  "code-structure": "vm.code-structure.component-pressure.v1",
  "dependency-coupling": "vm.dependency-coupling.primary.v1",
  "platform-portability": "vm.platform-portability.primary.v1",
  "security-surface": "vm.security-surface.primary.v1",
  "state-data": "vm.state-data.primary.v1",
  "async-concurrency": "vm.async-concurrency.primary.v1",
  "reliability-recovery": "vm.reliability-recovery.primary.v1",
  "testing-verification": "vm.testing-verification.primary.v1",
  "observability": "vm.observability.primary.v1",
  "distribution-scaling": "vm.distribution-scaling.primary.v1",
  "api-contract": "vm.api-contract.primary.v1",
  "provider-integration": "vm.provider-integration.primary.v1",
  "ai-drift": "vm.ai-drift.primary.v1",
  "data-contract": "vm.api-contract.encoded-id-contract.v1"
});
export function detectorRuleId(family) {
  return Object.hasOwn(RULE_IDS,family) ? RULE_IDS[family] : null;
}
export function monitorFamilyForDetector(family) {
  return family === "data-contract" ? "api-contract" : family;
}
