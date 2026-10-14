import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import readline from "node:readline/promises";
import { stdin as input, stdout as output } from "node:process";
import { checkCloudHealth, registerCloud, cloudStatus, syncCloudDevice, loadCloudClient } from "./cloud.js";
import { installSetup } from "./setup.js";
import { migrateProjectStateTree, securityStatus, verifyCredentialStore } from "./secure-store.js";
import { setTelemetryEnabled } from "./telemetry.js";
import { atomicJsonWrite, ensureDir, safeJsonRead, vibeHome } from "./utils.js";
import { CLIENT_VERSION, DEFAULT_CLOUD_URL } from "./constants.js";
import { resolveInstallEndpoint } from "./install-network.js";
import { getOrCreateDeviceIdentity, deviceStatus } from "./device.js";
import { BUNDLED_NODE_VERSION, getPlatformAdapter, hardwareArch, nodeDistributionSpec } from "./platform.js";

export function runtimeRoot() {
  return path.join(vibeHome(), "runtime");
}

export function runtimeVersionsRoot() {
  return path.join(runtimeRoot(), "versions");
}

export function runtimeVersionRoot(version) {
  const value = String(version || "");
  if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(value)) {
    throw new Error("invalid_runtime_version");
  }
  return path.join(runtimeVersionsRoot(), value);
}

// Direct immutable npm tarball bypasses stale beta dist-tag and package-metadata
// caches. npm still verifies HTTPS certificates and installs dependencies normally.
export function verifiedPackageTarballUrl(version) {
  const value = String(version || "");
  if (!/^\d+\.\d+\.\d+-beta\.\d+$/.test(value)) throw new Error("invalid_runtime_version");
  return "https://registry.npmjs.org/@vibe-monitor/setup/-/setup-" + value + ".tgz";
}

export function runtimeVersionEntry(version) {
  return path.join(
    runtimeVersionRoot(version),
    "node_modules",
    "@vibe-monitor",
    "setup",
    "dist",
    "vibe-monitor.mjs"
  );
}

export function runtimeVersionPackage(version) {
  return path.join(
    runtimeVersionRoot(version),
    "node_modules",
    "@vibe-monitor",
    "setup",
    "package.json"
  );
}

export function launcherFile() {
  return path.join(vibeHome(), "bin", process.platform === "win32" ? "vibe-monitor.cmd" : "vibe-monitor");
}

export function bootstrapFile() {
  return path.join(runtimeRoot(), "launcher.mjs");
}

export function currentPointerFile() {
  return path.join(runtimeRoot(), "current.json");
}

export function previousPointerFile() {
  return path.join(runtimeRoot(), "previous.json");
}

function bundledNodeRoot() {
  return path.join(runtimeRoot(), "node");
}

export function bundledNodeBinary() {
  return getPlatformAdapter().nodeBinary(bundledNodeRoot());
}

function legacyRuntimeRecord() {
  const root = runtimeRoot();
  const entry = path.join(root, "node_modules", "@vibe-monitor", "setup", "dist", "vibe-monitor.mjs");
  const packageFile = path.join(root, "node_modules", "@vibe-monitor", "setup", "package.json");
  if (!fs.existsSync(entry)) return null;
  const pkg = safeJsonRead(packageFile, null);
  return {
    schemaVersion: 1,
    type: "legacy",
    version: typeof pkg?.version === "string" ? pkg.version : null,
    entry
  };
}

export function readRuntimePointer(kind = "current") {
  const file = kind === "previous" ? previousPointerFile() : currentPointerFile();
  return safeJsonRead(file, null);
}

export function runtimeRecordEntry(record) {
  if (!record || typeof record !== "object") return null;
  if (record.type === "version" && record.version) {
    try { return runtimeVersionEntry(record.version); } catch { return null; }
  }
  if ((record.type === "local" || record.type === "legacy") && typeof record.entry === "string") {
    return path.resolve(record.entry);
  }
  return null;
}

export function writeRuntimePointer(kind, record) {
  const file = kind === "previous" ? previousPointerFile() : currentPointerFile();
  atomicJsonWrite(file, record);
  return file;
}

function stableBootstrapSource() {
  return `import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { fileURLToPath, pathToFileURL } from "node:url";

const runtimeRoot = path.dirname(fileURLToPath(import.meta.url));
const vibeHome = path.dirname(runtimeRoot);
const currentFile = path.join(runtimeRoot, "current.json");
const previousFile = path.join(runtimeRoot, "previous.json");
const updatesRoot = path.join(vibeHome, "updates");
const updateStateFile = path.join(updatesRoot, "state.json");
const activationLockFile = path.join(updatesRoot, "activation.lock");
const ACTIVATION_LOCK_STALE_MS = 60_000;
const EARLY_BOOT_FAILURE_MS = 10_000;

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, "utf8")); } catch { return fallback; }
}
function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const temp = file + ".tmp-" + process.pid;
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + "\\n", { encoding: "utf8", mode: 0o600 });
  fs.renameSync(temp, file);
  try { fs.chmodSync(file, 0o600); } catch {}
}
function validVersion(value) {
  return /^\\d+\\.\\d+\\.\\d+(?:-[0-9A-Za-z.-]+)?(?:\\+[0-9A-Za-z.-]+)?$/.test(String(value || ""));
}
function entryFor(record) {
  if (!record || typeof record !== "object") return null;
  if (record.type === "version" && validVersion(record.version)) {
    return path.join(runtimeRoot, "versions", record.version, "node_modules", "@vibe-monitor", "setup", "dist", "vibe-monitor.mjs");
  }
  if ((record.type === "local" || record.type === "legacy") && typeof record.entry === "string") {
    return path.resolve(record.entry);
  }
  return null;
}
function markState(patch) {
  const state = readJson(updateStateFile, {});
  writeJson(updateStateFile, { schemaVersion: 1, ...state, ...patch, updatedAt: new Date().toISOString() });
}
function addQuarantine(state, version) {
  const values = new Set(Array.isArray(state?.quarantinedVersions) ? state.quarantinedVersions : []);
  if (version) values.add(version);
  return [...values].slice(-20);
}
function sameRecord(a, b) {
  return Boolean(a && b && a.type === b.type && a.version === b.version && a.entry === b.entry);
}
function tryAcquireActivationLock() {
  fs.mkdirSync(updatesRoot, { recursive: true, mode: 0o700 });
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const fd = fs.openSync(activationLockFile, "wx", 0o600);
      try {
        fs.writeFileSync(fd, JSON.stringify({
          pid: process.pid,
          acquiredAt: new Date().toISOString()
        }) + "\\n", "utf8");
      } finally {
        fs.closeSync(fd);
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        try { fs.rmSync(activationLockFile, { force: true }); } catch {}
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      try {
        const stat = fs.statSync(activationLockFile);
        if (Date.now() - stat.mtimeMs > ACTIVATION_LOCK_STALE_MS) {
          fs.rmSync(activationLockFile, { force: true });
          continue;
        }
      } catch {}
      return null;
    }
  }
  return null;
}
function candidateVersionFrom(update) {
  if (validVersion(update?.activationInProgress)) return update.activationInProgress;
  if (update?.activateOnNextStart === true && validVersion(update?.stagedVersion)) {
    return update.stagedVersion;
  }
  return null;
}
function candidateHealth(entry) {
  const result = spawnSync(process.execPath, [entry, "doctor", "--json"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    timeout: 30_000,
    env: { ...process.env, VIBE_MONITOR_UPDATE_PREFLIGHT: "1" }
  });
  return result.status === 0 && !result.error;
}

let activatedThisStart = false;
let activatedVersion = null;
let activationStartedAt = 0;

let update = readJson(updateStateFile, {});
let candidateVersion = candidateVersionFrom(update);

if (candidateVersion) {
  const releaseActivationLock = tryAcquireActivationLock();
  if (releaseActivationLock) {
    try {
      update = readJson(updateStateFile, {});
      candidateVersion = candidateVersionFrom(update);
      let current = readJson(currentFile, null);

      if (candidateVersion) {
        const candidate = { schemaVersion: 1, type: "version", version: candidateVersion };
        const candidateEntry = entryFor(candidate);

        if (!candidateEntry || !fs.existsSync(candidateEntry)) {
          markState({
            activationInProgress: null,
            activateOnNextStart: false,
            lastFailureAt: new Date().toISOString(),
            lastFailureReason: "staged_runtime_missing"
          });
        } else if (!candidateHealth(candidateEntry)) {
          const previous = readJson(previousFile, null);
          const currentIsCandidate = sameRecord(current, candidate);
          if (currentIsCandidate && previous && entryFor(previous) && fs.existsSync(entryFor(previous))) {
            writeJson(currentFile, previous);
            markState({
              currentVersion: previous.version || null,
              activationInProgress: null,
              stagedVersion: null,
              stagedArtifactSha256: null,
              activateOnNextStart: false,
              lastRollbackAt: new Date().toISOString(),
              lastRollbackReason: "activation_health_failed",
              lastFailureAt: new Date().toISOString(),
              lastFailureReason: "update_candidate_startup_failed",
              quarantinedVersions: addQuarantine(update, candidateVersion)
            });
          } else {
            markState({
              activationInProgress: null,
              activateOnNextStart: false,
              lastFailureAt: new Date().toISOString(),
              lastFailureReason: "update_candidate_startup_failed",
              quarantinedVersions: addQuarantine(update, candidateVersion)
            });
          }
        } else {
          if (!sameRecord(current, candidate)) {
            markState({
              activationInProgress: candidateVersion,
              activateOnNextStart: false,
              lastActivationAttemptAt: new Date().toISOString()
            });
            if (current) writeJson(previousFile, current);
            writeJson(currentFile, candidate);
          }

          markState({
            currentVersion: candidateVersion,
            activationInProgress: null,
            stagedVersion: null,
            stagedArtifactSha256: null,
            activateOnNextStart: false,
            lastActivationAttemptAt: new Date().toISOString(),
            lastActivatedAt: new Date().toISOString(),
            lastFailureAt: null,
            lastFailureReason: null,
            lastRollbackReason: null
          });
          activatedThisStart = true;
          activatedVersion = candidateVersion;
          activationStartedAt = Date.now();
        }
      }
    } finally {
      releaseActivationLock();
    }
  }
}

let current = readJson(currentFile, null);
let entry = entryFor(current);
if (!entry || !fs.existsSync(entry)) {
  throw new Error("vibe_runtime_current_missing");
}

try {
  await import(pathToFileURL(entry).href);
} catch (error) {
  const earlyFailure =
    activatedThisStart &&
    activatedVersion &&
    Date.now() - activationStartedAt <= EARLY_BOOT_FAILURE_MS;

  if (!earlyFailure) throw error;

  const releaseActivationLock = tryAcquireActivationLock();
  if (!releaseActivationLock) throw error;

  let previous = null;
  let previousEntry = null;
  try {
    current = readJson(currentFile, null);
    previous = readJson(previousFile, null);
    previousEntry = entryFor(previous);
    if (
      current?.type !== "version" ||
      current.version !== activatedVersion ||
      !previousEntry ||
      !fs.existsSync(previousEntry)
    ) {
      throw error;
    }

    writeJson(currentFile, previous);
    const state = readJson(updateStateFile, {});
    markState({
      currentVersion: previous.version || null,
      activationInProgress: null,
      stagedVersion: null,
      stagedArtifactSha256: null,
      activateOnNextStart: false,
      lastRollbackAt: new Date().toISOString(),
      lastRollbackReason: "runtime_bootstrap_failed",
      lastFailureAt: new Date().toISOString(),
      lastFailureReason: "runtime_bootstrap_failed",
      quarantinedVersions: addQuarantine(state, activatedVersion)
    });
  } finally {
    releaseActivationLock();
  }

  await import(pathToFileURL(previousEntry).href);
}
`;
}

export function ensureStableLauncher(nodeBinary = bundledNodeBinary()) {
  ensureDir(runtimeRoot());
  ensureDir(path.join(vibeHome(), "bin"));
  fs.writeFileSync(bootstrapFile(), stableBootstrapSource(), { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(bootstrapFile(), 0o600); } catch {}

  const launcher = launcherFile();
  const script = process.platform === "win32"
    ? "@echo off\r\n\"" + nodeBinary + "\" \"" + bootstrapFile() + "\" %*\r\n"
    : [
        "#!/bin/sh",
        "exec " + JSON.stringify(nodeBinary) + " " + JSON.stringify(bootstrapFile()) + " \"$@\"",
        ""
      ].join("\n");
  fs.writeFileSync(launcher, script, { encoding: "utf8", mode: 0o700 });
  try { fs.chmodSync(launcher, 0o700); } catch {}
  return launcher;
}

async function promptInviteCode() {
  if (!input.isTTY || !output.isTTY) throw new Error("activation_code_required");
  const rl = readline.createInterface({ input, output });
  try {
    const value = await rl.question("Activation code: ");
    return value.trim();
  } finally {
    rl.close();
  }
}

// SHA-256 values obtained from the official Node.js v22.23.3 SHASUMS256.txt.
// The mirror is never trusted to supply the expected digest.
const TRUSTED_NODE_SHA256 = Object.freeze({
  "node-v22.23.3-win-x64.zip": "2b0ff57b049cda1bbcea2240eec20467018713c1efe1f7360c2681859b90ed71",
  "node-v22.23.3-win-arm64.zip": "33dad22e4cef5ee8f9fbb1b0d037fdacd0e56d12a4580f0d63f68b894deab535",
  "node-v22.23.3-darwin-arm64.tar.gz": "23b25245dcfb9af7262f8ff142e9e2e0af025368117329e7a7458a51e5922f53",
  "node-v22.23.3-darwin-x64.tar.gz": "8a677b0219178efd6eb0e475457c4afb452b521a92f6e67845a73bd85727f2a8",
  "node-v22.23.3-linux-arm64.tar.xz": "a44aeb94849a299b22df10b9e622ec2f605c2183501bc40590705131de7c740f",
  "node-v22.23.3-linux-x64.tar.xz": "df450af89261115ef9f9e3830c3eeb2cc9213b63c720b1af623cb5dcbe2e02de"
});
export function nodeDownloadSources(spec) {
  const official = "https://nodejs.org/dist/v" + BUNDLED_NODE_VERSION + "/" + spec.filename;
  // Only an exact official artifact can select the pinned China mirror fallback.
  if (spec.archiveUrl !== official) throw new Error("runtime_archive_source_untrusted");
  const mirror = "https://mirrors.nju.edu.cn/nodejs-release/v" + BUNDLED_NODE_VERSION + "/" + spec.filename;
  return [official, mirror];
}

const MAX_RUNTIME_ARCHIVE_BYTES = 160 * 1024 * 1024;
async function readBoundedRuntimeArchive(response) {
  const declared = Number(response.headers?.get?.("content-length") || 0);
  if (Number.isFinite(declared) && declared > MAX_RUNTIME_ARCHIVE_BYTES) {
    throw new Error("runtime_archive_too_large");
  }
  // Streaming prevents an unbounded allocation when Content-Length is absent.
  if (response.body && typeof response.body[Symbol.asyncIterator] === "function") {
    const chunks = [];
    let total = 0;
    for await (const chunk of response.body) {
      const incoming = Number(chunk?.byteLength);
      if (Number.isFinite(incoming) && incoming >= 0 && total + incoming > MAX_RUNTIME_ARCHIVE_BYTES) {
        throw new Error("runtime_archive_too_large");
      }
      const bytes = Buffer.from(chunk);
      total += bytes.length;
      if (total > MAX_RUNTIME_ARCHIVE_BYTES) throw new Error("runtime_archive_too_large");
      chunks.push(bytes);
    }
    return Buffer.concat(chunks, total);
  }
  // Support minimal, deterministic test doubles with arrayBuffer only.
  const bytes = Buffer.from(await response.arrayBuffer());
  if (bytes.length > MAX_RUNTIME_ARCHIVE_BYTES) throw new Error("runtime_archive_too_large");
  return bytes;
}

export async function fetchVerifiedNode(spec) {
  const expected = TRUSTED_NODE_SHA256[spec.filename];
  if (!expected) throw new Error("runtime_checksum_not_pinned:" + spec.filename);
  const errors = [];
  for (const [index, url] of nodeDownloadSources(spec).entries()) {
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(index === 0 ? 8000 : 90000) });
      if (!response.ok) throw new Error("HTTP_" + response.status);
      const archive = await readBoundedRuntimeArchive(response);
      const actual = crypto.createHash("sha256").update(archive).digest("hex");
      if (actual !== expected) throw new Error("SHA256_MISMATCH");
      return archive;
    } catch (error) {
      const cause = error?.cause?.code || error?.code || error?.name || "network_error";
      errors.push(new URL(url).hostname + ":" + (error?.message === "SHA256_MISMATCH" ? "SHA256_MISMATCH" : cause));
    }
  }
  throw new Error("runtime_download_failed:" + errors.join(","));
}

export async function ensureBundledNode() {
  const adapter = getPlatformAdapter();
  const root = bundledNodeRoot();
  const binary = adapter.nodeBinary(root);
  const npmCli = adapter.npmCli(root);
  try {
    if (fs.existsSync(binary)) {
      const current = execFileSync(binary, ["--version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
      const currentArch = execFileSync(binary, ["-p", "process.arch"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      const expectedArch = hardwareArch();
      if (
        current === "v" + BUNDLED_NODE_VERSION &&
        currentArch === expectedArch &&
        fs.existsSync(npmCli)
      ) {
        return {
          version: BUNDLED_NODE_VERSION,
          root,
          binary,
          npmCli,
          arch: currentArch,
          reused: true,
          platform: adapter.id
        };
      }
    }
  } catch {}

  ensureDir(runtimeRoot());
  const spec = nodeDistributionSpec(BUNDLED_NODE_VERSION);
  const tempRoot = fs.mkdtempSync(path.join(runtimeRoot(), ".node-install-"));
  const extractDir = path.join(tempRoot, "extract");
  fs.mkdirSync(extractDir, { recursive: true });
  const archiveFile = path.join(tempRoot, spec.filename);
  try {
    const archive = await fetchVerifiedNode(spec);
    fs.writeFileSync(archiveFile, archive, { mode: 0o600 });
    spec.adapter.extractNodeArchive(archiveFile, extractDir, root, BUNDLED_NODE_VERSION);
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true });
  }

  const installed = execFileSync(binary, ["--version"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  const installedArch = execFileSync(binary, ["-p", "process.arch"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"]
  }).trim();
  if (installed !== "v" + BUNDLED_NODE_VERSION || installedArch !== hardwareArch()) {
    throw new Error("runtime_node_verification_failed");
  }
  if (!fs.existsSync(npmCli)) throw new Error("runtime_npm_missing");
  return {
    version: BUNDLED_NODE_VERSION,
    root,
    binary,
    npmCli,
    arch: installedArch,
    reused: false,
    platform: adapter.id
  };
}

export async function installRuntimeVersion({
  version = CLIENT_VERSION,
  packageSpec = verifiedPackageTarballUrl(version),
  nodeRuntime = null,
  force = false
} = {}) {
  const slot = runtimeVersionRoot(version);
  const entry = runtimeVersionEntry(version);
  const packageFile = runtimeVersionPackage(version);
  const existing = safeJsonRead(packageFile, null);
  if (!force && existing?.name === "@vibe-monitor/setup" && existing?.version === version && fs.existsSync(entry)) {
    return { version, root: slot, entry, packageFile, reused: true };
  }

  const runtime = nodeRuntime || await ensureBundledNode();
  const adapter = getPlatformAdapter();
  const npmCli = runtime.npmCli || adapter.npmCli(runtime.root);
  if (!npmCli || !fs.existsSync(npmCli)) throw new Error("runtime_npm_missing");

  ensureDir(runtimeVersionsRoot());
  const tempSlot = path.join(runtimeVersionsRoot(), ".install-" + version + "-" + process.pid);
  fs.rmSync(tempSlot, { recursive: true, force: true });
  ensureDir(tempSlot);
  try {
    execFileSync(runtime.binary, [
      npmCli,
      "install",
      "--prefix", tempSlot,
      "--registry=https://registry.npmjs.org",
      "--no-audit",
      "--no-fund",
      packageSpec
    ], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

    const tempPackage = path.join(tempSlot, "node_modules", "@vibe-monitor", "setup", "package.json");
    const tempEntry = path.join(tempSlot, "node_modules", "@vibe-monitor", "setup", "dist", "vibe-monitor.mjs");
    const pkg = safeJsonRead(tempPackage, null);
    if (pkg?.name !== "@vibe-monitor/setup" || pkg?.version !== version || !fs.existsSync(tempEntry)) {
      throw new Error("runtime_install_verification_failed");
    }

    fs.rmSync(slot, { recursive: true, force: true });
    fs.renameSync(tempSlot, slot);
  } catch (error) {
    fs.rmSync(tempSlot, { recursive: true, force: true });
    throw error;
  }

  return { version, root: slot, entry, packageFile, reused: false };
}

export async function installRuntime({
  local = false,
  cliPath,
  packageSpec = verifiedPackageTarballUrl(CLIENT_VERSION)
} = {}) {
  ensureDir(runtimeRoot());
  let record;
  let entry;
  let nodeRuntime;

  const existingCurrent = readRuntimePointer("current");
  const fallbackPrevious = existingCurrent || legacyRuntimeRecord();

  if (local) {
    entry = path.resolve(cliPath);
    nodeRuntime = {
      version: process.version.replace(/^v/, ""),
      root: null,
      binary: process.execPath,
      reused: true,
      platform: process.platform,
      development: true
    };
    record = { schemaVersion: 1, type: "local", version: CLIENT_VERSION, entry };
  } else {
    nodeRuntime = await ensureBundledNode();
    const installed = await installRuntimeVersion({
      version: CLIENT_VERSION,
      packageSpec,
      nodeRuntime
    });
    entry = installed.entry;
    record = { schemaVersion: 1, type: "version", version: CLIENT_VERSION };
  }

  if (fallbackPrevious && JSON.stringify(fallbackPrevious) !== JSON.stringify(record)) {
    writeRuntimePointer("previous", fallbackPrevious);
  }
  writeRuntimePointer("current", record);
  const launcher = ensureStableLauncher(nodeRuntime.binary);

  return {
    launcher,
    bootstrap: bootstrapFile(),
    runtimeRoot: runtimeRoot(),
    entry,
    record,
    previous: readRuntimePointer("previous"),
    local,
    node: nodeRuntime
  };
}

// Transitional open-client install is shared by Free/Pro/Team; only legacy Beta retains different consent terms.
// This initial path is for a source checkout or a verified installed CLI entry;
// a public npm stable/package upgrade contract is gated on release CI.
export async function installOpenClientProduct({agents,local=true,cliPath,onStage=()=>{}}={}){
  if(!local||typeof cliPath!=="string"||!cliPath)
    throw new Error("community_local_entry_required");
  const runtime=await installRuntime({local:true,cliPath});
  onStage("runtime_installed");
  const setup=installSetup({agents,runtimeCommand:runtime.launcher});
  onStage("mcp_configured");
  const telemetry=setTelemetryEnabled(false);
  return {
    installed:true,version:CLIENT_VERSION,distribution:"open-client",
    runtime,activation:{registered:false,reusedExisting:false,
      serviceEnabled:true},
    setup,security:securityStatus(),
    telemetry:{...telemetry,requiredDuringPrivateBeta:false,defaultEnabled:false},
    next:["Restart your coding agent if necessary.",
      "Open a project and ask for a local architecture review.",
      "Local architecture scanning needs no account. Paid Cloud access requires server-verified grants."]
  };
}

export async function installProduct({
  inviteCode = null,
  baseUrl = DEFAULT_CLOUD_URL,
  telemetryDefaultOn = true,
  agents,
  local = false,
  cliPath,
  tracking = null
} = {}) {
  verifyCredentialStore();
  tracking?.mark("credentials_checked");
  void tracking?.flush();
  const device = getOrCreateDeviceIdentity();
  const requestedCode = String(inviteCode || "").trim();
  let registration = null;
  let reusedExistingActivation = false;

  if (!requestedCode && cloudStatus().registered) {
    const deviceSync = await syncCloudDevice({ device });
    if (deviceSync.synced) {
      registration = cloudStatus();
      reusedExistingActivation = true;
      tracking?.setToken(loadCloudClient()?.token);
      tracking?.mark("activated");
      void tracking?.flush();
    }
  }

  if (!registration) {
    const preflight = await resolveInstallEndpoint({
      baseUrl, probe: checkCloudHealth, timeoutMs: 6500, attempts: 2
    });
    if (!preflight.ok) {
      const error = new Error("cloud_preflight_failed");
      error.status = preflight.status;
      error.cloudReason = preflight.reason;
      error.networkCode = preflight.networkCode || null;
      error.responseKind = preflight.responseKind || null;
      error.requestId = preflight.requestId || null;
      error.installPhase = "cloud_preflight";
      error.networkCategory = preflight.category || null;
      throw error;
    }

    baseUrl = preflight.baseUrl;
    tracking?.setBaseUrl(baseUrl);
    tracking?.mark("cloud_reachable");
    tracking?.mark("awaiting_activation");
    void tracking?.flush();
    const code = requestedCode || await promptInviteCode();
    tracking?.setInvite(code);
    if (!code) throw new Error("activation_code_required");
    try {
      registration = await registerCloud({
        baseUrl,
        inviteCode: code,
        agent: "installer",
        clientVersion: CLIENT_VERSION,
        device
      });
    } catch (error) {
      error.installPhase = "activation";
      throw error;
    }
    tracking?.setToken(loadCloudClient()?.token);
    tracking?.mark("activated");
    void tracking?.flush();
  }

  const runtime = await installRuntime({ local, cliPath });
  tracking?.mark("runtime_installed");
  void tracking?.flush();

  const setup = installSetup({
    agents,
    runtimeCommand: runtime.launcher
  });
  tracking?.mark("mcp_configured");
  void tracking?.flush();

  const migration = migrateProjectStateTree();
  const telemetry = setTelemetryEnabled(true);
  const { installationId: telemetryIdentityId, ...telemetryStatus } = telemetry;

  return {
    installed: true,
    version: CLIENT_VERSION,
    runtime,
    activation: {
      registered: registration.registered,
      reusedExisting: reusedExistingActivation,
      installationId: registration.installationId,
      deviceId: registration.deviceId || device.deviceId,
      registeredAt: registration.registeredAt,
      serviceEnabled: registration.serviceEnabled
    },
    setup,
    security: {
      migration,
      ...securityStatus()
    },
    telemetry: {
      ...telemetryStatus,
      telemetryIdentityId,
      defaultEnabled: true,
      requiredDuringPrivateBeta: true
    },
    next: [
      "Restart your coding client if it was already open.",
      "Open a project and continue coding normally.",
      "Run vibe-monitor projects to see monitored projects."
    ]
  };
}

export function installStatus() {
  const launcher = launcherFile();
  const current = readRuntimePointer("current");
  const previous = readRuntimePointer("previous");
  const currentEntry = runtimeRecordEntry(current);
  return {
    version: CLIENT_VERSION,
    launcher,
    launcherPresent: fs.existsSync(launcher),
    bootstrap: bootstrapFile(),
    bootstrapPresent: fs.existsSync(bootstrapFile()),
    current,
    previous,
    runtimeEntry: currentEntry,
    runtimePresent: Boolean(currentEntry && fs.existsSync(currentEntry)),
    bundledNode: {
      version: BUNDLED_NODE_VERSION,
      arch: hardwareArch(),
      binary: bundledNodeBinary(),
      present: fs.existsSync(bundledNodeBinary())
    },
    cloud: cloudStatus(),
    device: deviceStatus()
  };
}
