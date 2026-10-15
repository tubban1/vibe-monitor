import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import { classifyNetworkError, networkErrorCode } from "./install-network.js";
import { atomicJsonWrite, ensureDir, safeJsonRead, vibeHome } from "./utils.js";
import {
  acknowledgeTelemetryEvents,
  readTelemetryBatch,
  enqueueLifecycleTelemetry,
  telemetryStatus,
  freeTelemetryWireBatch
} from "./telemetry.js";
import { readSecret, writeSecret } from "./secure-store.js";
import { CLIENT_VERSION } from "./constants.js";
import { getOrCreateDeviceIdentity } from "./device.js";
import { isOpenClientDistribution } from "./distribution.js";
import {DEFAULT_POLICY, clampNumber, sanitizeRemotePolicy} from "./policy-sanitizer.js";
export {sanitizeRemotePolicy} from "./policy-sanitizer.js";

const DEFAULT_UPDATE_POLICY = Object.freeze({
  enabled: false,
  channel: "beta",
  latestVersion: null,
  minimumVersion: null,
  rolloutPercent: 0,
  rolloutSalt: "v1",
  critical: false,
  autoStage: false,
  autoActivate: "next-start",
  artifact: null,
  updatedAt: null
});

function safeVersion(value) {
  const text = typeof value === "string" ? value.trim() : "";
  return /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(text)
    ? text.slice(0, 80)
    : null;
}

function safeArtifactUrl(value) {
  if (typeof value !== "string" || !value.trim()) return null;
  try {
    const url = new URL(value);
    const local = ["127.0.0.1", "localhost", "::1"].includes(url.hostname);
    if (url.protocol !== "https:" && !(local && url.protocol === "http:")) return null;
    return url.toString();
  } catch {
    return null;
  }
}

export function sanitizeUpdatePolicy(input = {}) {
  const artifactUrl = safeArtifactUrl(input?.artifact?.url);
  const artifactSha = typeof input?.artifact?.sha256 === "string" &&
    /^[a-f0-9]{64}$/i.test(input.artifact.sha256)
      ? input.artifact.sha256.toLowerCase()
      : null;
  return {
    enabled: input.enabled === true,
    channel: ["beta", "stable", "canary"].includes(input.channel) ? input.channel : "beta",
    latestVersion: safeVersion(input.latestVersion),
    minimumVersion: safeVersion(input.minimumVersion),
    rolloutPercent: Math.trunc(clampNumber(input.rolloutPercent, 0, 100, 0)),
    rolloutSalt: typeof input.rolloutSalt === "string" && input.rolloutSalt
      ? input.rolloutSalt.slice(0, 80)
      : "v1",
    critical: input.critical === true,
    autoStage: input.autoStage === true,
    autoActivate: input.autoActivate === "next-start" ? "next-start" : "disabled",
    artifact: artifactUrl && artifactSha
      ? {
          url: artifactUrl,
          sha256: artifactSha,
          signature: typeof input?.artifact?.signature === "string"
            ? input.artifact.signature.slice(0, 512)
            : null
        }
      : null,
    updatedAt: typeof input.updatedAt === "string" ? input.updatedAt : null
  };
}

export function updateEligibility(update, installationId) {
  const policy = sanitizeUpdatePolicy(update);
  if (!policy.enabled || !installationId || policy.rolloutPercent <= 0) return false;
  if (policy.rolloutPercent >= 100) return true;
  const digest = crypto.createHash("sha256")
    .update(String(installationId) + ":" + policy.rolloutSalt)
    .digest();
  const bucket = digest.readUInt32BE(0) % 100;
  return bucket < policy.rolloutPercent;
}

function cloudDir() {
  return path.join(vibeHome(), "cloud");
}

function cloudFile() {
  return path.join(cloudDir(), "client.json");
}

function policyFile() {
  return path.join(cloudDir(), "policy.json");
}

function writePrivateJson(file, value) {
  ensureDir(path.dirname(file));
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}

function normalizeBaseUrl(value) {
  return String(value || "").trim().replace(/\/+$/, "");
}

function timeoutSignal(ms) {
  return AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined;
}

export function defaultPolicy() {
  return sanitizeRemotePolicy(DEFAULT_POLICY);
}

export function loadCloudClient() {
  // The open client never reads, imports or migrates legacy private-Beta tokens.
  if (isOpenClientDistribution()) return null;
  const file = cloudFile();
  const stored = safeJsonRead(file, null);
  if (!stored) return null;

  if (stored.token) {
    try {
      writeSecret("cloud-installation-token", stored.token);
      const scrubbed = { ...stored };
      delete scrubbed.token;
      writePrivateJson(file, scrubbed);
    } catch {}
  }

  const token = readSecret("cloud-installation-token");
  return token ? { ...safeJsonRead(file, stored), token } : safeJsonRead(file, stored);
}

export function cloudStatus() {
  // License/doctor must not reveal stale Beta identity or touch its credentials.
  if (isOpenClientDistribution()) return {
    registered: false,
    baseUrl: null,
    installationId: null,
    deviceId: null,
    registeredAt: null,
    serviceEnabled: false,
    policyProfile: "local-baseline",
    policyVersion: null,
    policyFetchedAt: null,
    update: { ...sanitizeUpdatePolicy(DEFAULT_UPDATE_POLICY), eligible: false }
  };
  const client = loadCloudClient();
  const cached = safeJsonRead(policyFile(), null);
  return {
    registered: Boolean(client?.baseUrl && client?.token),
    baseUrl: client?.baseUrl || null,
    installationId: client?.installationId || null,
    deviceId: client?.deviceId || null,
    registeredAt: client?.registeredAt || null,
    serviceEnabled: cached?.enabled === true,
    policyProfile: cached?.profile || null,
    policyVersion: cached?.version || null,
    policyFetchedAt: cached?.fetchedAt || null,
    update: {
      ...sanitizeUpdatePolicy(cached?.update || DEFAULT_UPDATE_POLICY),
      eligible: updateEligibility(cached?.update || DEFAULT_UPDATE_POLICY, client?.installationId || null)
    }
  };
}

async function fetchJson(url, init = {}, timeoutMs = 2500) {
  if (isOpenClientDistribution()) throw new Error("legacy_beta_cloud_disabled");
  const response = await fetch(url, {
    ...init,
    signal: timeoutSignal(timeoutMs),
    headers: {
      accept: "application/json",
      ...(init.body ? { "content-type": "application/json" } : {}),
      ...(init.headers || {})
    }
  });
  const text = await response.text();
  const contentType = response.headers.get("content-type") || "";
  let body = null;
  try { body = text ? JSON.parse(text) : {}; } catch { body = { raw: text.slice(0, 500) }; }
  if (!response.ok) {
    const cloudCode = typeof body?.error === "string" ? body.error : "cloud_request_failed";
    const error = new Error(cloudCode);
    error.status = response.status;
    error.cloudCode = cloudCode;
    error.responseKind = body?.raw
      ? (contentType.toLowerCase().includes("text/html") ? "html" : "non_json")
      : "json";
    error.requestId =
      response.headers.get("x-request-id") ||
      response.headers.get("x-neon-request-id") ||
      response.headers.get("cf-ray") ||
      null;
    throw error;
  }
  return body;
}

export async function checkCloudHealth({ baseUrl, timeoutMs = 15000, attempts = 2 } = {}) {
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized) return { ok: false, reason: "cloud_url_required", status: null };
  let lastError;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      const body = await fetchJson(normalized + "/health", {}, timeoutMs);
      if(body?.ok !== true || body?.service !== "vibe-monitor-beta") {
        return {ok:false,reason:"invalid_cloud_identity",status:null,networkCode:"INVALID_CLOUD_IDENTITY"};
      }
      return {
        ok: true,
        status: 200,
        service: body?.service || "vibe",
        version: body?.version || null
      };
    } catch (error) {
      lastError = error;
      // Do not retry explicit HTTP errors: only transient transport failures.
      if (error?.status) break;
      if (attempt < attempts) await new Promise(resolve=>setTimeout(resolve,Math.min(1200,250*2**(attempt-1))));
    }
  }
  return {
    ok: false,
    reason: lastError?.message || "cloud_preflight_failed",
    networkCode: networkErrorCode(lastError) || (lastError?.name === "TimeoutError" ? "TIMEOUT" : null),
    status: lastError?.status || null,
    responseKind: lastError?.responseKind || null,
    requestId: lastError?.requestId || null
  };
}

export async function registerCloud({
  baseUrl,
  inviteCode,
  agent = "unknown",
  clientVersion = CLIENT_VERSION,
  device = null
}) {
  // No invite-based registration, device writes or Beta credential migration.
  if (isOpenClientDistribution()) throw new Error("legacy_beta_cloud_disabled");
  const normalized = normalizeBaseUrl(baseUrl);
  if (!normalized || !inviteCode) throw new Error("cloud_url_and_invite_required");

  // All registration entry points, including bare 'cloud register', must
  // present the same persistent device identity used by the installer.
  // Generate locally before registration; never infer a device from network
  // metadata, tester labels, or hardware serial numbers.
  const registrationDevice = device || getOrCreateDeviceIdentity();
  const body = await fetchJson(normalized + "/register", {
    method: "POST",
    body: JSON.stringify({ inviteCode, agent, clientVersion, device: registrationDevice })
  }, 15000);
  if (body.deviceId && body.deviceId !== registrationDevice.deviceId) {
    throw new Error("cloud_device_identity_mismatch");
  }

  writeSecret("cloud-installation-token", body.token);
  const client = {
    schemaVersion: 1,
    baseUrl: normalized,
    installationId: body.installationId,
    deviceId: body.deviceId || registrationDevice.deviceId,
    registeredAt: new Date().toISOString()
  };
  writePrivateJson(cloudFile(), client);

  if (body.policy?.config) {
    writePrivateJson(policyFile(), {
      schemaVersion: 2,
      enabled: body.policy.enabled === true,
      telemetryRequired: body.policy.telemetryRequired === true,
      enabledUpdatedAt: body.policy.enabledUpdatedAt || null,
      profile: body.policy.profile || null,
      version: body.policy.version || null,
      config: sanitizeRemotePolicy(body.policy.config),
      update: sanitizeUpdatePolicy(body.policy.update || DEFAULT_UPDATE_POLICY),
      updatedAt: body.policy.updatedAt || null,
      fetchedAt: new Date().toISOString()
    });
  }

  return cloudStatus();
}

export async function syncCloudDevice({ device = null } = {}) {
  const client = loadCloudClient();
  if (!client?.baseUrl || !client?.token) {
    return { synced: false, reason: "cloud_not_registered" };
  }
  const payload = device || getOrCreateDeviceIdentity();
  try {
    const body = await fetchJson(client.baseUrl + "/device", {
      method: "POST",
      headers: { authorization: "Bearer " + client.token },
      body: JSON.stringify({ device: payload })
    }, 3000);
    const stored = safeJsonRead(cloudFile(), {});
    writePrivateJson(cloudFile(), { ...stored, deviceId: body.deviceId || payload.deviceId });
    return { synced: true, deviceId: body.deviceId || payload.deviceId };
  } catch (error) {
    return { synced: false, reason: error?.message || "device_sync_failed" };
  }
}

export async function createArchitectureReview(request) {
  const client = loadCloudClient();
  if (!client?.baseUrl || !client?.token) {
    return { stored: false, reason: "cloud_not_registered" };
  }
  try {
    const body = await fetchJson(client.baseUrl + "/architecture-reviews", {
      method: "POST",
      headers: { authorization: "Bearer " + client.token },
      body: JSON.stringify({ request })
    }, 3000);
    return {
      stored: body?.stored === true,
      reviewId: body?.reviewId || request?.reviewId || null,
      duplicate: body?.duplicate === true
    };
  } catch (error) {
    return {
      stored: false,
      reason: error?.message || "architecture_review_store_failed"
    };
  }
}

export async function submitArchitectureReviewResponse(reviewId, response) {
  const client = loadCloudClient();
  if (!client?.baseUrl || !client?.token) {
    return { stored: false, reason: "cloud_not_registered" };
  }
  if (!/^[0-9a-f-]{36}$/i.test(String(reviewId || ""))) {
    return { stored: false, reason: "invalid_review_id" };
  }
  try {
    const body = await fetchJson(
      client.baseUrl + "/architecture-reviews/" + reviewId + "/response",
      {
        method: "POST",
        headers: { authorization: "Bearer " + client.token },
        body: JSON.stringify({ response })
      },
      3000
    );
    return {
      stored: body?.stored === true,
      reviewId: body?.reviewId || reviewId
    };
  } catch (error) {
    return {
      stored: false,
      reason: error?.message || "architecture_review_response_store_failed"
    };
  }
}

// Brief transient outages must not look like an administrator's explicit disable.
// A failed refresh still never authorizes scanning with stale cached policy.
const POLICY_FETCH_ATTEMPTS = 2;
const POLICY_FETCH_TIMEOUT_MS = 4000;
const POLICY_RETRY_DELAY_MS = 180;

function policyFailureDiagnostic(error) {
  const status = Number.isInteger(error?.status) ? error.status : null;
  const rawCode = networkErrorCode(error);
  const timedOut = error?.name === "TimeoutError" || error?.name === "AbortError";
  const category = timedOut ? "https_timeout" : classifyNetworkError({ code: rawCode, status });
  const code = (status === 401 || status === 403) ? "service_control_unauthorized"
    : status ? "service_control_http_error"
    : category === "https_timeout" || category === "tcp_timeout" ? "service_control_timeout"
    : category === "tls_failure" || category === "tls_untrusted_ca" ? "service_control_tls_error"
    : "service_control_network_error";
  return {
    code,
    category,
    attempts: error?.policyAttempts || 1,
    ...(status == null ? {} : { httpStatus: status }),
    ...(typeof error?.requestId === "string" && /^[a-zA-Z0-9-]{1,100}$/.test(error.requestId)
      ? { requestId: error.requestId } : {})
  };
}

async function requestPolicyWithRetry(client) {
  for (let attempt = 1; attempt <= POLICY_FETCH_ATTEMPTS; attempt++) {
    try {
      return await fetchJson(client.baseUrl + "/config", {
        headers: { authorization: "Bearer " + client.token }
      }, POLICY_FETCH_TIMEOUT_MS);
    } catch (error) {
      error.policyAttempts = attempt;
      const status = error?.status;
      const category = classifyNetworkError({
        code: networkErrorCode(error),
        status
      });
      // Never retry authorization rejection, certificate failures, or other 4xx.
      const retryable = [429, 502, 503, 504].includes(status) ||
        (status == null && !["tls_failure", "tls_untrusted_ca"].includes(category));
      if (!retryable || attempt === POLICY_FETCH_ATTEMPTS) throw error;
      await new Promise(resolve => setTimeout(resolve, POLICY_RETRY_DELAY_MS));
    }
  }
}

// Coalesce concurrent refreshes without exposing authorization tokens in diagnostics.
const inFlightPolicyRequests = new Map();
async function fetchPolicyConfigOnce(client) {
  const key = `${client.baseUrl}::${client.installationId || ""}::${client.token}`;
  if (inFlightPolicyRequests.has(key)) return inFlightPolicyRequests.get(key);
  const request = requestPolicyWithRetry(client).finally(() => inFlightPolicyRequests.delete(key));
  inFlightPolicyRequests.set(key, request);
  return request;
}

export async function fetchRemotePolicy({ force = false } = {}) {
  const client = loadCloudClient();
  const cached = safeJsonRead(policyFile(), null);
  const cachedConfig = cached?.config ? sanitizeRemotePolicy(cached.config) : defaultPolicy();
  const cachedUpdate = sanitizeUpdatePolicy(cached?.update || DEFAULT_UPDATE_POLICY);

  if (!client?.baseUrl || !client?.token) {
    return {
      source: "fail-closed",
      enabled: false,
      reason: "cloud_not_registered",
      profile: cached?.profile || "beta-high-observation",
      version: cached?.version || 1,
      config: cachedConfig,
      update: { ...cachedUpdate, eligible: false }
    };
  }

  if (!force && cached?.fetchedAt) {
    const fetchedAtMs = Date.parse(cached.fetchedAt);
    const ttlMs = Math.max(60, cachedConfig.configTtlSec || DEFAULT_POLICY.configTtlSec) * 1000;
    if (Number.isFinite(fetchedAtMs) && Date.now() - fetchedAtMs <= ttlMs) {
      const telemetryRequiredButOff = cached.telemetryRequired === true && !telemetryStatus().enabled;
      return {
        source: "cache",
        ...cached,
        config: cachedConfig,
        update: {
          ...cachedUpdate,
          eligible: updateEligibility(cachedUpdate, client.installationId)
        },
        enabled: telemetryRequiredButOff ? false : cached.enabled === true,
        reason: telemetryRequiredButOff
          ? "telemetry_required"
          : (cached.enabled === true ? null : "service_disabled")
      };
    }
  }

  try {
    const body = await fetchPolicyConfigOnce(client);
    const policy = body.policy || {};
    const record = {
      schemaVersion: 2,
      enabled: policy.enabled === true,
      telemetryRequired: policy.telemetryRequired === true,
      enabledUpdatedAt: policy.enabledUpdatedAt || null,
      profile: policy.profile || "beta-high-observation",
      version: policy.version || 1,
      config: sanitizeRemotePolicy(policy.config || {}),
      update: sanitizeUpdatePolicy(policy.update || DEFAULT_UPDATE_POLICY),
      updatedAt: policy.updatedAt || null,
      fetchedAt: new Date().toISOString()
    };
    writePrivateJson(policyFile(), record);
    const telemetryRequiredButOff = record.telemetryRequired && !telemetryStatus().enabled;
    return {
      source: "remote",
      enabled: telemetryRequiredButOff ? false : record.enabled,
      reason: telemetryRequiredButOff ? "telemetry_required" : (record.enabled ? null : "service_disabled"),
      ...record,
      update: {
        ...record.update,
        eligible: updateEligibility(record.update, client.installationId)
      },
      ...(telemetryRequiredButOff ? { enabled: false } : {})
    };
  } catch (error) {
    return {
      source: "fail-closed",
      enabled: false,
      reason: "service_control_unavailable",
      diagnostic: policyFailureDiagnostic(error),
      enabledUpdatedAt: cached?.enabledUpdatedAt || null,
      profile: cached?.profile || "beta-high-observation",
      version: cached?.version || 1,
      config: cachedConfig,
      update: {
        ...cachedUpdate,
        eligible: updateEligibility(cachedUpdate, client.installationId)
      }
    };
  }
}

function deterministicSample(eventId, rate) {
  if (rate >= 1) return true;
  if (rate <= 0) return false;
  const hex = crypto.createHash("sha256").update(String(eventId)).digest("hex").slice(0, 8);
  const value = parseInt(hex, 16) / 0xffffffff;
  return value < rate;
}

function recordTelemetrySync(status, reason = null) {
  try {
    const file = path.join(cloudDir(), "telemetry-sync.json");
    const previous = safeJsonRead(file, {});
    const failures = status === "failed" ? Math.min(100000, (previous.consecutiveFailures || 0) + 1) : 0;
    const nextRetryMs = failures
      ? Math.min(5 * 60_000, 2000 * 2 ** Math.min(failures - 1, 8))
      : 0;
    writePrivateJson(file, {
      status,
      reason: reason && /^[a-z0-9_:-]{1,60}$/i.test(reason) ? reason : null,
      consecutiveFailures: failures,
      lastAttemptAt: new Date().toISOString(),
      lastSuccessAt: status === "ok" ? new Date().toISOString() : previous.lastSuccessAt || null,
      nextRetryAt: nextRetryMs ? new Date(Date.now() + nextRetryMs).toISOString() : null
    });
  } catch { /* diagnostic persistence must not block telemetry */ }
}

// Best-effort, one-shot delivery: 2s maximum, no policy preflight and no new
// background service. A failed event remains in the existing durable FIFO queue.
export async function reportLifecycleEvent(event, details = {}) {
  let item;
  try {
    item = enqueueLifecycleTelemetry(event, details);
    if (!item) return { queued: false, delivered: false, reason: "telemetry_not_enabled" };
  } catch {
    return { queued: false, delivered: false, reason: "queue_unavailable" };
  }
  const client = loadCloudClient();
  if (!client?.baseUrl || !client?.token) {
    return { queued: true, delivered: false, reason: "cloud_not_registered" };
  }
  try {
    const result = await fetchJson(client.baseUrl + "/events", {
      method: "POST",
      headers: { authorization: "Bearer " + client.token },
      body: JSON.stringify({ events: [item] })
    }, 2000);
    // Older cloud versions silently ignore unknown event types.
    if (Number(result.accepted || 0) + Number(result.duplicates || 0) < 1) {
      return { queued: true, delivered: false, reason: "server_not_ready" };
    }
    acknowledgeTelemetryEvents([item.eventId]);
    return { queued: false, delivered: true };
  } catch {
    return { queued: true, delivered: false, reason: "network_or_service_unavailable" };
  }
}

// Account-free transport is an independently approved release switch.
// Keep off until endpoint, region, retention and privacy QA are authorized.
export const FREE_TELEMETRY_UPLOAD_ENABLED = false;
const FREE_TELEMETRY_URL = "https://vibe-api.fde.fan/free/telemetry";
async function syncFreeTelemetryOnce({fetchImpl=globalThis.fetch}={}) {
 if(!isOpenClientDistribution())return {uploaded:0,reason:"private_beta_mode"};
 if(!telemetryStatus().enabled)return {uploaded:0,reason:"telemetry_off"};
 if(!FREE_TELEMETRY_UPLOAD_ENABLED)return {uploaded:0,reason:"free_intake_not_released"};
 const batch=freeTelemetryWireBatch();
 if(!batch.length)return {uploaded:0,reason:"empty"};
 const payload=JSON.stringify({events:batch});
 if(Buffer.byteLength(payload)>24576)return {uploaded:0,reason:"batch_too_large"};
 try {
  const response=await fetchImpl(FREE_TELEMETRY_URL,{
   method:"POST",headers:{"content-type":"application/json","accept":"application/json"},
   body:payload,redirect:"error",signal:AbortSignal.timeout(1500)
  });
  if(!response?.ok)return {uploaded:0,reason:"cloud_unavailable"};
  const size=Number(response.headers?.get?.("content-length")||0);
  if(size>2048)return {uploaded:0,reason:"invalid_ack"};
  const ack=await response.text();
  if(Buffer.byteLength(ack)>2048)return {uploaded:0,reason:"invalid_ack"};
  const data=JSON.parse(ack);
  if(!Number.isSafeInteger(data.accepted)||!Number.isSafeInteger(data.duplicates)||
   data.accepted<0||data.duplicates<0||
   data.accepted+data.duplicates!==batch.length)return {uploaded:0,reason:"invalid_ack"};
  acknowledgeTelemetryEvents(batch.map(e=>e.eventId));
  return {uploaded:data.accepted,duplicates:data.duplicates};
 }catch{return {uploaded:0,reason:"network_or_invalid_response"};}
}

// Free transport follows independent bounded retry diagnostics; never uses Beta credentials.
// Cross-process retry state prevents bursts from short-lived CLI/Agent MCP processes.
const freeSyncPath=()=>path.join(vibeHome(),"free-telemetry","sync-state.json");
let freeSyncInFlight=null;
export function freeSyncBackoffMs(attempt,entropy=0){
 const n=Math.max(1,Math.min(9,Math.trunc(Number(attempt)||1)));
 return Math.min(300000,3000*2**(n-1))+Math.max(0,Math.min(3000,Math.trunc(Number(entropy)||0)));
}
export async function syncFreeTelemetry({fetchImpl=globalThis.fetch,force=false,now=Date.now}={}){
 if(!isOpenClientDistribution())return {uploaded:0,reason:"private_beta_mode"};
 if(!telemetryStatus().enabled)return {uploaded:0,reason:"telemetry_off"};
 if(!FREE_TELEMETRY_UPLOAD_ENABLED)return {uploaded:0,reason:"free_intake_not_released"};
 if(freeSyncInFlight)return freeSyncInFlight;
 const state=safeJsonRead(freeSyncPath(),{attempt:0,nextRetryAt:0});
 const next=Number(state?.nextRetryAt)||0;
 if(!force&&Number.isFinite(next)&&next>now()&&next-now()<=86400_000)return {uploaded:0,reason:"retry_backoff",nextRetryAt:new Date(next).toISOString()};
 freeSyncInFlight=(async()=>{
  const result=await syncFreeTelemetryOnce({fetchImpl});
  const failed=new Set(["cloud_unavailable","network_or_invalid_response","invalid_ack","batch_too_large"]);
  const attempts=failed.has(result.reason)?Math.min(9,(Number(state?.attempt)||0)+1):0;
  const nextRetryAt=attempts?now()+freeSyncBackoffMs(attempts,crypto.randomInt(0,3001)):0;
  try{
   atomicJsonWrite(freeSyncPath(),{attempt:attempts,nextRetryAt,
    lastResult:failed.has(result.reason)?"retry_scheduled":result.reason||"ok",
    lastAttemptAt:new Date(now()).toISOString()});
  }catch{/* transport results remain honest even when diagnostics cannot be persisted */}
  return {...result,...(attempts?{nextRetryAt:new Date(nextRetryAt).toISOString()}:{})};
 })();
 try{return await freeSyncInFlight;}finally{freeSyncInFlight=null;}
}

export async function syncTelemetry({ limit = 100, respectBackoff = false } = {}) {
  const local = telemetryStatus();
  if (!local.enabled) return { uploaded: 0, droppedBySampling: 0, reason: "telemetry_off" };
  // Interactive MCP calls must not retry an unreachable endpoint for every tool call.
  // Explicit/manual sync can override the delay to diagnose recovery immediately.
  const retryAt = Date.parse(local.syncDiagnostics?.nextRetryAt || "");
  if (respectBackoff && Number.isFinite(retryAt) && Date.now() < retryAt) {
    return { uploaded: 0, droppedBySampling: 0, reason: "retry_backoff",
      nextRetryAt: new Date(retryAt).toISOString() };
  }

  const client = loadCloudClient();
  if (!client?.baseUrl || !client?.token) {
    return { uploaded: 0, droppedBySampling: 0, reason: "cloud_not_registered" };
  }

  const policy = await fetchRemotePolicy({ force: false });
  if (policy.enabled === false) {
    return {
      uploaded: 0,
      droppedBySampling: 0,
      reason: policy.reason || "service_disabled"
    };
  }
  const rate = policy.config.telemetrySampleRate;
  const batch = readTelemetryBatch({ limit });
  if (!batch.length) return { uploaded: 0, droppedBySampling: 0, reason: "empty" };

  const send = [];
  const drop = [];
  for (const event of batch) {
    if (event.event?.startsWith("lifecycle.") || deterministicSample(event.eventId, rate)) send.push(event);
    else drop.push(event.eventId);
  }

  if (!send.length) {
    acknowledgeTelemetryEvents(drop);
    return { uploaded: 0, droppedBySampling: drop.length, reason: "sampled_out" };
  }

  try {
    const body = await fetchJson(client.baseUrl + "/events", {
      method: "POST",
      headers: { authorization: "Bearer " + client.token },
      body: JSON.stringify({ events: send })
    }, 15000);

    recordTelemetrySync("ok");
    acknowledgeTelemetryEvents([
      ...drop,
      ...send.map(event => event.eventId)
    ]);

    return {
      uploaded: Number(body.accepted || 0),
      duplicates: Number(body.duplicates || 0),
      droppedBySampling: drop.length,
      remaining: telemetryStatus().queuedEvents
    };
  } catch (error) {
    recordTelemetrySync("failed", error?.status ? `http_${error.status}` : error?.name === "TimeoutError" ? "timeout" : "network_or_transport");
    return {
      uploaded: 0,
      droppedBySampling: 0,
      reason: error?.message || "upload_failed"
    };
  }
}
