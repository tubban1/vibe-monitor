import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { CLIENT_VERSION } from "./constants.js";
import { isOpenClientDistribution } from "./distribution.js";
import { telemetryStatus, enqueueLifecycleStageTelemetry } from "./telemetry.js";
import {
  cloudStatus,
  fetchRemotePolicy,
  sanitizeUpdatePolicy,
  updateEligibility
} from "./cloud.js";
import {
  ensureBundledNode,
  installRuntimeVersion,
  readRuntimePointer,
  runtimeRecordEntry,
  runtimeVersionEntry,
  runtimeVersionRoot,
  writeRuntimePointer
} from "./install.js";
import { atomicJsonWrite, ensureDir, safeJsonRead, vibeHome } from "./utils.js";

// Separate public-client artifact signing trust: architecture policy signature
// never authorizes executable updates. Keys must be independently audited/pinned.
export const FREE_UPDATE_MANIFEST_URL="https://vibe-api.fde.fan/free/update-manifest";
export const FREE_TARGETED_UPDATE_MANIFEST_URL="https://vibe-api.fde.fan/free/update-manifest?targeted=1";
export const FREE_UPDATE_KEY_ID="free-update-ed25519-v1";
export const FREE_UPDATE_NEXT_KEY_ID="free-update-ed25519-v2";
export const FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM="-----BEGIN PUBLIC KEY-----\nMCowBQYDK2VwAyEAqyVComzhk1MeD77dSfr+ec86w7YSjxBSs3nA2NpktYU=\n-----END PUBLIC KEY-----\n";
export const FREE_UPDATE_TRUSTED_NEXT_PUBLIC_KEY_PEM=null;
const stableVersion=/^\d+\.\d+\.\d+$/;
const digestRegex=/^[a-f0-9]{64}$/;
const plain=x=>x!==null&&typeof x==="object"&&!Array.isArray(x)&&Object.getPrototypeOf(x)===Object.prototype;
const exactKeys=(x,keys)=>plain(x)&&Object.keys(x).every(k=>keys.includes(k));
export function verifyFreeUpdateEnvelope(e,{keys=null,now=Date.now,minRevision=0}={}){
 const trusted=keys||{[FREE_UPDATE_KEY_ID]:FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM,
  [FREE_UPDATE_NEXT_KEY_ID]:FREE_UPDATE_TRUSTED_NEXT_PUBLIC_KEY_PEM};
 const p=e?.payload,artifact=p?.artifact,n=Math.floor(now()/1000);
 if(!exactKeys(e,["payload","keyId","signature"])||
    ![FREE_UPDATE_KEY_ID,FREE_UPDATE_NEXT_KEY_ID].includes(e.keyId)||
    !exactKeys(trusted,[FREE_UPDATE_KEY_ID,FREE_UPDATE_NEXT_KEY_ID])||
    typeof trusted[e.keyId]!=="string"||
    ![1,2].includes(p?.schemaVersion)||
    !exactKeys(p,["schemaVersion","audience","revision","issuedAt","expiresAt",
      "version","rolloutPercent","rolloutSalt","artifact",
      ...(p?.schemaVersion===2?["targeting"]:[])])||
    !exactKeys(artifact,["url","sha256"])||
    p.audience!=="vibe-monitor-free-update-v1"||
    (p.schemaVersion===2&&(
      p.rolloutPercent!==0||
      !exactKeys(p.targeting,["mode","salt","digests"])||
      p.targeting?.mode!=="installation-digests"||
      typeof p.targeting?.salt!=="string"||
      !/^[a-z0-9-]{12,64}$/i.test(p.targeting.salt)||
      !Array.isArray(p.targeting?.digests)||
      p.targeting.digests.length<1||p.targeting.digests.length>128||
      p.targeting.digests.some(x=>typeof x!=="string"||!digestRegex.test(x))||
      new Set(p.targeting.digests).size!==p.targeting.digests.length
    ))||
    !Number.isSafeInteger(p.revision)||p.revision<Math.max(1,minRevision)||
    !Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||
    p.issuedAt>n+60||p.issuedAt<n-86460||
    p.expiresAt<=n||p.expiresAt-p.issuedAt>86400||
    !stableVersion.test(p.version||"")||
    !Number.isInteger(p.rolloutPercent)||p.rolloutPercent<0||p.rolloutPercent>100||
    typeof p.rolloutSalt!=="string"||!/^[a-z0-9-]{8,64}$/i.test(p.rolloutSalt)||
    typeof artifact.sha256!=="string"||!/^[a-f0-9]{64}$/.test(artifact.sha256)||
    typeof artifact.url!=="string"||typeof e.signature!=="string"||
    !/^[A-Za-z0-9_-]{86}$/.test(e.signature))return null;
 try{
  const u=new URL(artifact.url);
  // Registry-owned immutable package tarball only, never an arbitrary CDN URL.
  if(u.protocol!=="https:"||u.hostname!=="registry.npmjs.org"||u.port||
     u.username||u.password||u.search||u.hash||
     !["/@vibe-monitor/setup/-/setup-"+p.version+".tgz",
       "/@vibe-monitor%2fsetup/-/setup-"+p.version+".tgz"].includes(u.pathname))
   return null;
  const key=crypto.createPublicKey(trusted[e.keyId]);
  if(key.asymmetricKeyType!=="ed25519"||
     !crypto.verify(null,Buffer.from(JSON.stringify(p)),key,Buffer.from(e.signature,"base64url")))return null;
  return Object.freeze({...p,keyId:e.keyId});
 }catch{return null;}
}

const MAX_SIGNED_MANIFEST_BYTES=16384;
const MAX_SIGNED_MANIFEST_CHUNKS=512;
const publicUpdateTrustReady=()=>[
 FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM,FREE_UPDATE_TRUSTED_NEXT_PUBLIC_KEY_PEM
].some(x=>typeof x==="string");
export async function fetchVerifiedFreeUpdateManifest({
 fetchImpl=globalThis.fetch,now=Date.now,publicKeysById=null,minRevision=0,
 url=FREE_UPDATE_MANIFEST_URL
}={}){
 const keys=publicKeysById||{
  [FREE_UPDATE_KEY_ID]:FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM,
  [FREE_UPDATE_NEXT_KEY_ID]:FREE_UPDATE_TRUSTED_NEXT_PUBLIC_KEY_PEM
 };
 if(typeof fetchImpl!=="function"||!Object.values(keys).some(x=>typeof x==="string"))
  return {manifest:null,reason:"signed_update_channel_not_configured"};
 try{
  if(![FREE_UPDATE_MANIFEST_URL,FREE_TARGETED_UPDATE_MANIFEST_URL].includes(url))
   return {manifest:null,reason:"signed_update_manifest_url_not_allowed"};
  const response=await fetchImpl(url,{
   method:"GET",headers:{accept:"application/json"},redirect:"error",
   cache:"no-store",signal:AbortSignal.timeout(5000)
  });
  if(!response?.ok||response.redirected)return {manifest:null,reason:"signed_update_manifest_unavailable"};
  const declared=Number(response.headers?.get?.("content-length")||0);
  if(!Number.isSafeInteger(declared)||declared>MAX_SIGNED_MANIFEST_BYTES)
   return {manifest:null,reason:"signed_update_manifest_invalid"};
  let raw;
  if(response.body&&typeof response.body.getReader==="function"){
   const reader=response.body.getReader();let count=0,chunks=0,parts=[];
   try{
    while(true){
     const {done,value}=await reader.read();if(done)break;
     if(!(value instanceof Uint8Array)||++chunks>MAX_SIGNED_MANIFEST_CHUNKS||
        count+value.byteLength>MAX_SIGNED_MANIFEST_BYTES)
      throw Error("signed_update_manifest_invalid");
     count+=value.byteLength;parts.push(Buffer.from(value));
    }
    raw=Buffer.concat(parts,count).toString("utf8");
   }finally{await reader.cancel().catch(()=>{});reader.releaseLock();}
  }else{
   raw=await response.text();
   if(Buffer.byteLength(raw)>MAX_SIGNED_MANIFEST_BYTES)
    throw Error("signed_update_manifest_invalid");
  }
  const manifest=verifyFreeUpdateEnvelope(JSON.parse(raw),{keys,now,minRevision});
  return manifest?{manifest,reason:null}:{manifest:null,reason:"signed_update_manifest_invalid"};
 }catch{return {manifest:null,reason:"signed_update_manifest_unavailable"};}
}
export function signedUpdateEligibleForInstallation(manifest,installationId){
 if(!manifest||typeof installationId!=="string"||!installationId)return false;
 if(manifest.schemaVersion===2){
  if(manifest.targeting?.mode!=="installation-digests"||
     !Array.isArray(manifest.targeting.digests))return false;
  const digest=crypto.createHash("sha256")
   .update(manifest.targeting.salt+":"+installationId.toLowerCase()).digest("hex");
  return manifest.targeting.digests.includes(digest);
 }
 return manifest.schemaVersion===1&&updateEligibility({
  enabled:true,rolloutPercent:manifest.rolloutPercent,
  rolloutSalt:manifest.rolloutSalt
 },installationId);
}
function freeUpdateEligible(manifest){
 return signedUpdateEligibleForInstallation(manifest,telemetryStatus().installationId);
}
// Do not delay each short-lived Agent call on a Cloud request.
// Staging always forces a fresh signature verification.
const FREE_MANIFEST_CHECK_COOLDOWN_MS=15*60_000;
let freeManifestMemory=null;
async function currentSignedFreeUpdate({refresh=false}={}){
 if(!publicUpdateTrustReady())return {manifest:null,reason:"signed_update_channel_not_configured"};
 const now=Date.now();
 const state=readUpdateState();
 if(!refresh&&freeManifestMemory&&
    now-freeManifestMemory.checkedAt<FREE_MANIFEST_CHECK_COOLDOWN_MS&&
    freeManifestMemory.manifest.expiresAt*1000>now)
  return {manifest:freeManifestMemory.manifest,reason:null};
 const previousAttempt=Date.parse(state.freeManifestLastAttemptAt||"");
 if(!refresh&&Number.isFinite(previousAttempt)&&
    previousAttempt<=now&&now-previousAttempt<FREE_MANIFEST_CHECK_COOLDOWN_MS)
  return {manifest:null,reason:"signed_update_check_deferred"};
 writeUpdateState({freeManifestLastAttemptAt:new Date(now).toISOString()});
 const publicFloor=Number.isSafeInteger(state.freeManifestRevision)?state.freeManifestRevision:0;
 const targetedFloor=Number.isSafeInteger(state.targetedManifestRevision)?state.targetedManifestRevision:0;
 // Keep separate revision floors: a discontinued pilot must not prevent
 // falling back to the still-signed public stable manifest.
 const targeted=await fetchVerifiedFreeUpdateManifest({
  minRevision:targetedFloor,url:FREE_TARGETED_UPDATE_MANIFEST_URL
 });
 const selectedTarget=targeted.manifest?.schemaVersion===2&&
  freeUpdateEligible(targeted.manifest);
 const got=selectedTarget?targeted:await fetchVerifiedFreeUpdateManifest({minRevision:publicFloor});
 if(!got.manifest)return got;
 const previousVersion=selectedTarget?state.targetedManifestVersion:state.freeManifestVersion;
 if(previousVersion&&compareVersions(got.manifest.version,previousVersion)<0)
  return {manifest:null,reason:"signed_update_rollback_rejected"};
 writeUpdateState(selectedTarget?{
  targetedManifestRevision:got.manifest.revision,targetedManifestVersion:got.manifest.version,
  lastCheckAt:new Date().toISOString()
 }:{
  freeManifestRevision:got.manifest.revision,freeManifestVersion:got.manifest.version,
  lastCheckAt:new Date().toISOString()
 });
 freeManifestMemory={manifest:got.manifest,checkedAt:now};
 return got;
}

const MAX_UPDATE_ARTIFACT_BYTES = 25 * 1024 * 1024;
const MAX_UPDATE_STREAM_CHUNKS = 4096;
const UPDATE_LOCK_STALE_MS = 30 * 60 * 1000;
let autoUpdateScheduled = false;
// Hourly, non-blocking rechecks ensure long-lived MCP sessions eventually
// discover releases; avoid per-request polling and never keep a process alive.
export const AUTO_UPDATE_RECHECK_MS = 60 * 60 * 1000;

export function updatesRoot() {
  return path.join(vibeHome(), "updates");
}

export function updateStateFile() {
  return path.join(updatesRoot(), "state.json");
}

export function updateNoticeStateFile() {
  return path.join(updatesRoot(), "notice-state.json");
}

function updateLockFile(name) {
  return path.join(updatesRoot(), name + ".lock");
}

function acquireUpdateLock(name, { staleMs = UPDATE_LOCK_STALE_MS } = {}) {
  ensureDir(updatesRoot());
  const file = updateLockFile(name);

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(file, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        }) + "\n", "utf8");
      } finally {
        fs.closeSync(fd);
      }

      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.rmSync(file, { force: true }); } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(file);
        if (Date.now() - stat.mtimeMs > staleMs) {
          fs.rmSync(file, { force: true });
          continue;
        }
      } catch {}
      throw new Error("update_" + name + "_in_progress");
    }
  }

  throw new Error("update_" + name + "_in_progress");
}

export function readUpdateState() {
  return safeJsonRead(updateStateFile(), {
    schemaVersion: 1,
    currentVersion: null,
    stagedVersion: null,
    stagedArtifactSha256: null,
    lastStagedVersion: null,
    activateOnNextStart: false,
    lastCheckAt: null,
    lastStageAt: null,
    lastActivationAttemptAt: null,
    lastRollbackAt: null,
    lastRollbackReason: null,
    lastFailureAt: null,
    lastFailureReason: null,
    quarantinedVersions: []
  });
}

function writeUpdateState(patch) {
  const current = readUpdateState();
  const next = {
    schemaVersion: 1,
    ...current,
    ...patch,
    updatedAt: new Date().toISOString()
  };
  atomicJsonWrite(updateStateFile(), next);
  return next;
}

function parseVersion(value) {
  const match = String(value || "").match(
    /^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/
  );
  if (!match) return null;
  return {
    core: [Number(match[1]), Number(match[2]), Number(match[3])],
    pre: match[4] ? match[4].split(".") : []
  };
}

function compareIdentifier(a, b) {
  const aNumeric = /^\d+$/.test(a);
  const bNumeric = /^\d+$/.test(b);
  if (aNumeric && bNumeric) return Number(a) === Number(b) ? 0 : (Number(a) > Number(b) ? 1 : -1);
  if (aNumeric !== bNumeric) return aNumeric ? -1 : 1;
  return a === b ? 0 : (a > b ? 1 : -1);
}

export function compareVersions(a, b) {
  const left = parseVersion(a);
  const right = parseVersion(b);
  if (!left || !right) throw new Error("invalid_update_version");

  for (let i = 0; i < 3; i++) {
    if (left.core[i] !== right.core[i]) return left.core[i] > right.core[i] ? 1 : -1;
  }

  if (!left.pre.length && !right.pre.length) return 0;
  if (!left.pre.length) return 1;
  if (!right.pre.length) return -1;

  const count = Math.max(left.pre.length, right.pre.length);
  for (let i = 0; i < count; i++) {
    if (left.pre[i] == null) return -1;
    if (right.pre[i] == null) return 1;
    const compared = compareIdentifier(left.pre[i], right.pre[i]);
    if (compared) return compared;
  }
  return 0;
}

function currentRuntimeVersion() {
  const pointer = readRuntimePointer("current");
  // A previous private-Beta runtime can leave current.json behind after its
  // managed binaries were removed. An orphan pointer is not an installation.
  // Never report the orphan Beta version as the current open-client package.
  if (isOpenClientDistribution() && pointer) {
    const entry = runtimeRecordEntry(pointer);
    if (!entry || !fs.existsSync(entry)) return CLIENT_VERSION;
  }
  return pointer?.version || CLIENT_VERSION;
}

function failureCode(error) {
  const value = String(error?.message || "update_failed");
  const known = [
    "update_not_enabled",
    "update_not_eligible",
    "update_version_missing",
    "update_artifact_missing",
    "update_artifact_too_large",
    "update_artifact_checksum_mismatch",
    "update_download_failed",
    "update_candidate_preflight_failed",
    "runtime_install_verification_failed",
    "runtime_npm_missing",
    "update_stage_in_progress",
    "update_activation_in_progress",
    "update_version_quarantined",
    "no_staged_update",
    "no_previous_runtime",
    "invalid_update_version"
  ];
  return known.find(code => value.startsWith(code)) || "update_failed";
}

async function fetchArtifact(url,{requireNoRedirect=false}={}) {
  const response = await fetch(url, { redirect: requireNoRedirect?"error":"follow", signal: AbortSignal.timeout(60_000) });
  if (!response.ok) throw new Error("update_download_failed:" + response.status);
  const declared = Number(response.headers.get("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_UPDATE_ARTIFACT_BYTES) {
    throw new Error("update_artifact_too_large");
  }
  return readBoundedUpdateArtifact(response);
}

/**
 * Read update archives with a hard in-memory cap, even if Content-Length is
 * absent or dishonest. A single fixed allocation avoids retaining unbounded
 * arrays of tiny streamed chunks.
 */
export async function readBoundedUpdateArtifact(response) {
  const reader = response.body?.getReader?.();
  if (!reader) throw new Error("update_download_failed:missing_stream");
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_UPDATE_ARTIFACT_BYTES) {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
    throw new Error("update_artifact_too_large");
  }

  let bytes = null;
  let length = 0;
  let chunks = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      if (++chunks > MAX_UPDATE_STREAM_CHUNKS) throw new Error("update_download_failed:too_many_chunks");
      if (!(value instanceof Uint8Array)) throw new Error("update_download_failed:invalid_chunk");
      if (value.byteLength > MAX_UPDATE_ARTIFACT_BYTES - length) {
        throw new Error("update_artifact_too_large");
      }
      if (!bytes) bytes = Buffer.allocUnsafe(MAX_UPDATE_ARTIFACT_BYTES);
      bytes.set(value, length);
      length += value.byteLength;
    }
    return bytes ? Buffer.from(bytes.subarray(0, length)) : Buffer.alloc(0);
  } catch (error) {
    await reader.cancel().catch(() => {});
    throw error;
  } finally {
    reader.releaseLock();
  }
}

export async function updateStatus({ refresh = false } = {}) {
  // The public client has no signed artifact-release trust root yet. Never query
  // the legacy private-Beta update endpoint or advertise its candidates.
  if(isOpenClientDistribution()){
    const {manifest:m,reason}=await currentSignedFreeUpdate({refresh});
    const state=readUpdateState(),current=currentRuntimeVersion();
    const eligible=m?freeUpdateEligible(m):false;
    return {
      currentVersion:current,previousVersion:readRuntimePointer("previous")?.version||null,
      stagedVersion:state.stagedVersion||null,activateOnNextStart:state.activateOnNextStart===true,
      channel:m?"stable":"unconfigured",updateEnabled:!!m,eligible,
      latestVersion:m?.version||null,minimumVersion:null,
      available:!!m&&eligible&&compareVersions(m.version,current)>0,
      belowMinimum:false,critical:false,autoStage:!!m,autoActivate:m?"next-start":"disabled",
      artifactReady:!!m,lastCheckAt:state.lastCheckAt||null,lastStageAt:state.lastStageAt||null,
      lastRollbackAt:state.lastRollbackAt||null,lastRollbackReason:state.lastRollbackReason||null,
      lastFailureAt:state.lastFailureAt||null,lastFailureReason:state.lastFailureReason||null,
      quarantined:!!m&&(state.quarantinedVersions||[]).includes(m.version),
      source:m?"signed-free-update":"open-client",reason
    };
  }
  const remote = await fetchRemotePolicy({ force: refresh });
  const cloud = cloudStatus();
  const rawUpdate = remote?.update || cloud.update || {};
  const update = sanitizeUpdatePolicy(rawUpdate);
  const eligible = rawUpdate?.eligible === true ||
    updateEligibility(update, cloud.installationId || null);
  const state = readUpdateState();
  const currentVersion = currentRuntimeVersion();
  const latestComparison = update.latestVersion
    ? compareVersions(update.latestVersion, currentVersion)
    : null;
  const minimumComparison = update.minimumVersion
    ? compareVersions(currentVersion, update.minimumVersion)
    : null;

  return {
    currentVersion,
    previousVersion: readRuntimePointer("previous")?.version || null,
    stagedVersion: state.stagedVersion || null,
    activateOnNextStart: state.activateOnNextStart === true,
    channel: update.channel,
    updateEnabled: update.enabled === true,
    eligible,
    latestVersion: update.latestVersion,
    minimumVersion: update.minimumVersion,
    available: update.enabled === true && eligible && latestComparison > 0,
    belowMinimum: minimumComparison != null && minimumComparison < 0,
    critical: update.critical === true,
    autoStage: update.autoStage === true,
    autoActivate: update.autoActivate,
    artifactReady: Boolean(update.artifact?.url && update.artifact?.sha256),
    lastCheckAt: state.lastCheckAt || null,
    lastStageAt: state.lastStageAt || null,
    lastRollbackAt: state.lastRollbackAt || null,
    lastRollbackReason: state.lastRollbackReason || null,
    lastFailureAt: state.lastFailureAt || null,
    lastFailureReason: state.lastFailureReason || null,
    quarantined: Boolean(
      update.latestVersion &&
      state.quarantinedVersions?.includes(update.latestVersion)
    ),
    source: remote?.source || null
  };
}

export async function stageUpdate({
  policy = null,
  force = false,
  nodeRuntime = null
} = {}) {
  const attemptId=crypto.randomUUID();
  const emit=stage=>{
    if(isOpenClientDistribution())enqueueLifecycleStageTelemetry("update",
      {attemptId,stage,mode:"upgrade"});
  };
  emit("manifest_check_started");
  // A checksum alone cannot authorize code execution: never accept a supplied
  // policy, legacy Beta token or update URL in the unsigned public client.
  if(isOpenClientDistribution()&&(policy||force))
    throw new Error("signed_update_override_forbidden");
  const signed=isOpenClientDistribution()?await currentSignedFreeUpdate({refresh:true}):null;
  if(isOpenClientDistribution()&&!signed.manifest)
    throw new Error(signed.reason||"signed_update_manifest_invalid");
  const m=signed?.manifest||null;
  if(m)emit("manifest_validated");
  const remote = m?{
    source:"signed-free-update",
    update:{enabled:true,channel:"stable",latestVersion:m.version,
      rolloutPercent:m.rolloutPercent,rolloutSalt:m.rolloutSalt,
      autoStage:false,autoActivate:"disabled",artifact:m.artifact}
  }:policy
    ? {
        source: "provided",
        update: {
          ...sanitizeUpdatePolicy(policy),
          eligible: policy?.eligible === true
        }
      }
    : await fetchRemotePolicy({ force: true });
  const rawUpdate = remote?.update || {};
  const update = sanitizeUpdatePolicy(rawUpdate);
  const cloud=m?null:cloudStatus();
  const eligible=m?freeUpdateEligible(m):rawUpdate?.eligible===true||
    updateEligibility(update,cloud.installationId||null);
  const currentVersion = currentRuntimeVersion();
  const checkedAt = new Date().toISOString();

  writeUpdateState({ currentVersion, lastCheckAt: checkedAt });

  if (!update.enabled) throw new Error("update_not_enabled");
  if (!eligible && !force) throw new Error("update_not_eligible");
  if (!update.latestVersion) throw new Error("update_version_missing");
  if (!update.artifact?.url || !update.artifact?.sha256) throw new Error("update_artifact_missing");

  const relation = compareVersions(update.latestVersion, currentVersion);
  if (relation <= 0 && !force) {
    return {
      staged: false,
      reason: relation === 0 ? "already_current" : "downgrade_rejected",
      currentVersion,
      latestVersion: update.latestVersion
    };
  }

  const before = readUpdateState();
  const quarantined = new Set(before.quarantinedVersions || []);
  if (quarantined.has(update.latestVersion) && !force) {
    throw new Error("update_version_quarantined");
  }

  if (
    !force &&
    before.stagedVersion === update.latestVersion &&
    before.stagedArtifactSha256 === update.artifact.sha256 &&
    fs.existsSync(runtimeVersionEntry(update.latestVersion))
  ) {
    return {
      staged: true,
      reused: true,
      currentVersion,
      stagedVersion: update.latestVersion,
      artifactSha256: update.artifact.sha256,
      activateOnNextStart: before.activateOnNextStart === true,
      slot: runtimeVersionRoot(update.latestVersion)
    };
  }

  const releaseLock = acquireUpdateLock("stage");
  const stagingDir = path.join(updatesRoot(), "staging");
  let tempDir = null;

  try {
    ensureDir(stagingDir);
    tempDir = fs.mkdtempSync(path.join(stagingDir, "download-"));
    const artifactFile = path.join(tempDir, "vibe-monitor-" + update.latestVersion + ".tgz");

    emit("download_started");
    const artifact = await fetchArtifact(update.artifact.url,{requireNoRedirect:Boolean(m)});
    const actualSha256 = crypto.createHash("sha256").update(artifact).digest("hex");
    if (actualSha256 !== update.artifact.sha256) {
      throw new Error("update_artifact_checksum_mismatch");
    }
    emit("checksum_verified");
    fs.writeFileSync(artifactFile, artifact, { mode: 0o600 });

    const runtime = nodeRuntime || await ensureBundledNode();
    const installed = await installRuntimeVersion({
      version: update.latestVersion,
      packageSpec: artifactFile,
      nodeRuntime: runtime,
      force: true
    });

    try {
      execFileSync(runtime.binary, [installed.entry, "doctor", "--json"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "pipe"],
        timeout: 30_000,
        env: { ...process.env, VIBE_MONITOR_UPDATE_PREFLIGHT: "1" }
      });
    } catch {
      throw new Error("update_candidate_preflight_failed");
    }

    emit("candidate_preflight_passed");
    const stagedAt = new Date().toISOString();
    const state = writeUpdateState({
      currentVersion,
      stagedVersion: update.latestVersion,
      stagedArtifactSha256: actualSha256,
      lastStagedVersion: update.latestVersion,
      stagedChannel: update.channel,
      stagedAt,
      lastStageAt: stagedAt,
      activateOnNextStart: update.autoActivate === "next-start",
      lastFailureAt: null,
      lastFailureReason: null,
      quarantinedVersions: (readUpdateState().quarantinedVersions || [])
        .filter(version => version !== update.latestVersion)
    });

    emit("staged");
    return {
      staged: true,
      reused: false,
      currentVersion,
      stagedVersion: update.latestVersion,
      artifactSha256: actualSha256,
      activateOnNextStart: state.activateOnNextStart,
      slot: runtimeVersionRoot(update.latestVersion)
    };
  } catch (error) {
    const code = failureCode(error);
    if(isOpenClientDistribution())enqueueLifecycleStageTelemetry("update",{
      attemptId,stage:"failed",mode:"upgrade",reason:code});
    const state = readUpdateState();
    const nextQuarantined = new Set(state.quarantinedVersions || []);
    const quarantineCandidate = new Set([
      "update_artifact_too_large",
      "update_artifact_checksum_mismatch",
      "update_candidate_preflight_failed",
      "runtime_install_verification_failed"
    ]);
    if (update.latestVersion && quarantineCandidate.has(code)) {
      nextQuarantined.add(update.latestVersion);
    }

    writeUpdateState({
      currentVersion,
      lastFailureAt: new Date().toISOString(),
      lastFailureReason: code,
      activateOnNextStart: state.stagedVersion === update.latestVersion
        ? false
        : state.activateOnNextStart === true,
      quarantinedVersions: [...nextQuarantined].slice(-20)
    });
    throw error;
  } finally {
    if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
    releaseLock();
  }
}

function transientFailureBackoffActive(state, now = Date.now()) {
  const transient = new Set([
    "update_download_failed",
    "update_failed",
    "runtime_npm_missing"
  ]);
  if (!transient.has(state?.lastFailureReason)) return false;
  const at = Date.parse(state?.lastFailureAt || "");
  return Number.isFinite(at) && now - at < 5 * 60 * 1000;
}

export function observeAvailableUpdate(rawUpdate = {}) {
  if (isOpenClientDistribution()) return false;
  const update = sanitizeUpdatePolicy(rawUpdate);
  const cloud = cloudStatus();
  const eligible = rawUpdate?.eligible === true || updateEligibility(update, cloud.installationId || null);
  const available = update.enabled === true && eligible && Boolean(update.latestVersion) &&
    compareVersions(update.latestVersion, currentRuntimeVersion()) > 0;
  const state = readUpdateState();
  if (available && state.availableVersion !== update.latestVersion) {
    writeUpdateState({ availableVersion: update.latestVersion, availableDetectedAt: new Date().toISOString() });
  } else if (!available && state.availableVersion) {
    writeUpdateState({ availableVersion: null, availableDetectedAt: null });
  }
  return available;
}

export function consumeUpdateNotice() {
  if (isOpenClientDistribution()) return null;
  const state = readUpdateState();
  const candidates = [];

  if (state.availableVersion && state.availableDetectedAt && compareVersions(state.availableVersion, currentRuntimeVersion()) > 0) {
    candidates.push({
      type: "update_available",
      version: state.availableVersion,
      at: state.availableDetectedAt,
      message: "Vibe Monitor " + state.availableVersion +
        " is available. The current runtime remains active until an update is verified and activated."
    });
  }

  if (state.lastStageAt && state.stagedVersion && state.activateOnNextStart === true) {
    candidates.push({
      type: "update_staged",
      version: state.stagedVersion,
      at: state.lastStageAt,
      message: "Vibe Monitor " + state.stagedVersion +
        " is staged and will activate the next time the coding agent restarts."
    });
  }

  if (state.lastFailureAt && state.lastFailureReason) {
    candidates.push({
      type: "update_failed",
      version: state.lastStagedVersion || state.stagedVersion || null,
      reason: state.lastFailureReason,
      at: state.lastFailureAt,
      message: "Vibe Monitor could not stage an update (" + state.lastFailureReason +
        "). The current verified runtime remains active."
    });
  }

  if (state.lastRollbackAt && state.lastRollbackReason) {
    candidates.push({
      type: "update_rolled_back",
      version: state.currentVersion || null,
      reason: state.lastRollbackReason,
      at: state.lastRollbackAt,
      message: "Vibe Monitor rolled back to the previous verified runtime after an update problem."
    });
  }

  candidates.sort((a, b) => Date.parse(b.at || "") - Date.parse(a.at || ""));
  const candidate = candidates[0] || null;
  if (!candidate) return null;

  const fingerprint = [
    candidate.type,
    candidate.version || "",
    candidate.reason || "",
    candidate.at || ""
  ].join(":");
  const prior = safeJsonRead(updateNoticeStateFile(), {});
  if (prior.lastFingerprint === fingerprint) return null;

  atomicJsonWrite(updateNoticeStateFile(), {
    schemaVersion: 1,
    lastFingerprint: fingerprint,
    lastType: candidate.type,
    lastVersion: candidate.version || null,
    surfacedAt: new Date().toISOString()
  });
  return candidate;
}

// Only a verified signed public manifest may authorize an automatic update.
// Availability, eligibility, quarantine, transport and backoff remain separate
// decisions. This helper is pure so release tests can exercise these gates.
export function shouldAutoStageUpdate(status, state = {}, { signedPublic = false } = {}) {
  return Boolean(
    status?.updateEnabled === true &&
    status?.eligible === true &&
    status?.available === true &&
    status?.artifactReady === true &&
    (signedPublic ? status.source === "signed-free-update" : status.autoStage === true) &&
    !(state.quarantinedVersions || []).includes(status.latestVersion) &&
    !transientFailureBackoffActive(state)
  );
}

export function scheduleAutomaticUpdate({ delayMs = 2500 } = {}) {
  const signedPublic = isOpenClientDistribution();
  // A stable pinned trust root is mandatory. Never query or stage unsigned
  // executable artifacts, including when a legacy Beta registry is present.
  if (signedPublic && !publicUpdateTrustReady()) return false;
  if (autoUpdateScheduled || process.env.VIBE_MONITOR_UPDATE_PREFLIGHT === "1") return false;
  const current = readRuntimePointer("current");
  const entry = runtimeRecordEntry(current);
  if (!current || !["version", "legacy"].includes(current.type) ||
      !entry || !fs.existsSync(entry)) return false;

  autoUpdateScheduled = true;
  // Poll once at startup and hourly thereafter, even after a transient
  // network failure. Each pass has a single in-flight check.
  const poll = async () => {
    try {
      reconcileUpdateLifecycleOutcome();
      const status = await updateStatus({ refresh: false });
      if (!signedPublic) observeAvailableUpdate((await fetchRemotePolicy({ force: false }))?.update || {});
      if (!shouldAutoStageUpdate(status, readUpdateState(), { signedPublic })) return;
      const staged = await stageUpdate();
      if (signedPublic && staged.staged && staged.activateOnNextStart !== true) {
        // Atomic activation occurs in the stable launcher on the NEXT Agent
        // restart. Never switch or interrupt an in-flight MCP session.
        activateStagedUpdate();
      }
    } catch (error) {
      const code = failureCode(error);
      if (code === "update_stage_in_progress" || code === "update_version_quarantined") return;
      // Staging records its own failure state; keep the active version intact.
    } finally {
      const next = setTimeout(poll, AUTO_UPDATE_RECHECK_MS);
      next.unref?.();
    }
  };
  const first = setTimeout(poll, Math.max(0, delayMs));
  first.unref?.();
  return true;
}

export function activateStagedUpdate() {
  const state = readUpdateState();
  if (!state.stagedVersion) throw new Error("no_staged_update");
  if(isOpenClientDistribution()&&(!state.stagedArtifactSha256||
     !fs.existsSync(runtimeVersionEntry(state.stagedVersion))))
   throw new Error("signed_staged_runtime_missing");
  const updated=writeUpdateState({
    activateOnNextStart: true,
    activationRequestedAt: new Date().toISOString()
  });
  if(isOpenClientDistribution())enqueueLifecycleStageTelemetry("update",{
    attemptId:crypto.randomUUID(),stage:"activation_started",mode:"upgrade"});
  return updated;
}

export function rollbackUpdate() {
  // An unconfigured Free client must never create updater state simply because
  // an Agent invoked rollback without a previous verified runtime.
  if(isOpenClientDistribution()&&!readRuntimePointer("previous"))
    throw new Error("no_previous_runtime");
  const releaseLock = acquireUpdateLock("activation");
  try {
    const current = readRuntimePointer("current");
    const previous = readRuntimePointer("previous");
    if (!previous) throw new Error("no_previous_runtime");

    writeRuntimePointer("current", previous);
    if (current) writeRuntimePointer("previous", current);

    return writeUpdateState({
      currentVersion: previous.version || null,
      stagedVersion: null,
      stagedArtifactSha256: null,
      activateOnNextStart: false,
      lastRollbackAt: new Date().toISOString(),
      lastRollbackReason: "manual"
    });
  } finally {
    releaseLock();
  }
}

// Observe verified launch outcome, never mistake an activation request for a
// completed upgrade. Queue an event before recording the observation cursor.
export function reconcileUpdateLifecycleOutcome({now=()=>Date.now()}={}){
  if(!isOpenClientDistribution())return {observed:0};
  const state=readUpdateState();
  const file=path.join(updatesRoot(),"lifecycle-observed.json");
  const before=safeJsonRead(file,{});
  const outcomes=[
    {field:"lastActivatedAt",stage:"activated"},
    {field:"lastRollbackAt",stage:"rollback_completed"}
  ];
  const next={...before};
  let observed=0;
  for(const outcome of outcomes){
    const at=state[outcome.field];
    if(typeof at!=="string"||!Number.isFinite(Date.parse(at))||at===before[outcome.field])continue;
    // Prevent converting ancient pre-telemetry outcomes into apparent new use.
    const age=now()-Date.parse(at);
    if(age<0||age>7*86400_000){next[outcome.field]=at;continue;}
    const recorded=enqueueLifecycleStageTelemetry("update",{
      attemptId:crypto.randomUUID(),stage:outcome.stage,mode:"upgrade"});
    if(recorded){next[outcome.field]=at;observed++;}
  }
  if(JSON.stringify(next)!==JSON.stringify(before))try{atomicJsonWrite(file,next);}catch{}
  return {observed};
}
