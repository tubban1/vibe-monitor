import { Worker } from "node:worker_threads";

const DEFAULT_TIMEOUT_MS = 10_000;

export class ScanControlError extends Error {
  constructor(code) {
    super(code);
    this.name = "ScanControlError";
    this.code = code;
  }
}

function workerURL() {
  const bundled = import.meta.url.endsWith("/vibe-monitor.mjs");
  return new URL(bundled ? "./vibe-monitor-scan-worker.mjs" : "./scan-worker.js", import.meta.url);
}

export function runInterruptibleScan(data, { signal = null, timeoutMs = DEFAULT_TIMEOUT_MS,
  onPhase = null, workerFile = workerURL() } = {}) {
  if (signal?.aborted) return Promise.reject(new ScanControlError("scan_cancelled"));
  return new Promise((resolve, reject) => {
    let worker;
    try { worker = new Worker(workerFile, { workerData: data }); }
    catch { reject(new ScanControlError("scan_worker_unavailable")); return; }
    let settled = false;
    let timer;
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    const finish = (error, value, terminate = false) => {
      if (settled) return;
      settled = true;
      cleanup();
      if (terminate) void worker.terminate().catch(() => {});
      if (error) reject(error);
      else resolve(value);
    };
    const onAbort = () => finish(new ScanControlError("scan_cancelled"), null, true);
    signal?.addEventListener("abort", onAbort, { once: true });
    if (signal?.aborted) { onAbort(); return; }
    timer = setTimeout(() => finish(new ScanControlError("scan_timeout"), null, true),
      Math.max(1, Math.min(120_000, timeoutMs)));
    timer.unref?.();
    worker.on("message", message => {
      if (settled) return;
      if (message?.type === "phase") { onPhase?.(message.phase); return; }
      if (message?.type === "result") finish(null, message.result);
      else if (message?.type === "error") finish(new ScanControlError(message.code || "scan_failed"));
    });
    worker.on("error", () => finish(new ScanControlError("scan_worker_failed"), null, true));
    worker.on("exit", code => {
      if (!settled) finish(new ScanControlError(code === 0 ? "scan_worker_incomplete" : "scan_worker_exit"));
    });
  });
}
