// An isolated scan execution lane. No MCP transport, cloud credentials or
// source contents cross the worker boundary; only derived analysis returns.
import { parentPort, workerData } from "node:worker_threads";
import { createMonitoringBudgetSession } from "./budget.js";

if (parentPort) {
  try {
    parentPort.postMessage({ type: "phase", phase: "analysis" });
    const result = createMonitoringBudgetSession({ scanLimits: workerData.scanLimits || null }).analyze(workerData.inputPath, {
      persist: workerData.persist,
      kind: workerData.kind,
      policy: workerData.policy
    });
    parentPort.postMessage({ type: "result", result });
  } catch (error) {
    parentPort.postMessage({
      type: "error",
      code: error?.code === "scan_budget_exceeded" ? "scan_budget_exceeded" : "scan_failed"
    });
  }
}
