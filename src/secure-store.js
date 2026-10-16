import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { atomicJsonWrite, ensureDir, vibeHome } from "./utils.js";
import { findProjectRoot, projectIdentity } from "./project.js";

const KEYCHAIN_SERVICE = "Vibe Monitor";
const ENVELOPE_VERSION = 1;

function keyDir() {
  return ensureDir(path.join(vibeHome(), "keystore"));
}

function fileSecretPath(name) {
  const root = process.env.VIBE_MONITOR_TEST_SECRET_DIR
    ? ensureDir(process.env.VIBE_MONITOR_TEST_SECRET_DIR)
    : keyDir();
  return path.join(root, name.replace(/[^A-Za-z0-9_.-]/g, "_") + ".key");
}

function readMacKeychain(name) {
  try {
    return execFileSync(
      "security",
      ["find-generic-password", "-s", KEYCHAIN_SERVICE, "-a", name, "-w"],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim() || null;
  } catch {
    return null;
  }
}

function writeMacKeychain(name, value) {
  execFileSync(
    "security",
    ["add-generic-password", "-U", "-s", KEYCHAIN_SERVICE, "-a", name, "-w", value],
    { stdio: ["ignore", "ignore", "ignore"] }
  );
}

function powershell() {
  return process.env.SystemRoot
    ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
    : "powershell.exe";
}

function windowsBlobPath(name) {
  return path.join(keyDir(), name.replace(/[^A-Za-z0-9_.-]/g, "_") + ".dpapi");
}

export function windowsDpapiCommand(file, value = null) {
  const env = {
    ...process.env,
    VIBE_DPAPI_FILE_B64: Buffer.from(file, "utf8").toString("base64")
  };
  if (value !== null) {
    env.VIBE_DPAPI_VALUE_B64 = Buffer.from(value, "utf8").toString("base64");
  }

  const readScript = [
    "Add-Type -AssemblyName System.Security;",
    "$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VIBE_DPAPI_FILE_B64));",
    "$b=[IO.File]::ReadAllBytes($f);",
    "$p=[Security.Cryptography.ProtectedData]::Unprotect($b,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[Convert]::ToBase64String($p)"
  ].join("");

  const writeScript = [
    "Add-Type -AssemblyName System.Security;",
    "$f=[Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($env:VIBE_DPAPI_FILE_B64));",
    "$p=[Convert]::FromBase64String($env:VIBE_DPAPI_VALUE_B64);",
    "$b=[Security.Cryptography.ProtectedData]::Protect($p,$null,[Security.Cryptography.DataProtectionScope]::CurrentUser);",
    "[IO.File]::WriteAllBytes($f,$b)"
  ].join("");

  return {
    args: ["-NoProfile", "-NonInteractive", "-Command", value === null ? readScript : writeScript],
    env
  };
}

function readWindowsDpapi(name) {
  const file = windowsBlobPath(name);
  if (!fs.existsSync(file)) return null;
  try {
    const command = windowsDpapiCommand(file);
    const encoded = execFileSync(
      powershell(),
      command.args,
      {
        encoding: "utf8",
        env: command.env,
        stdio: ["ignore", "pipe", "ignore"]
      }
    ).trim();
    return encoded ? Buffer.from(encoded, "base64").toString("utf8") : null;
  } catch {
    return null;
  }
}

function writeWindowsDpapi(name, value) {
  const file = windowsBlobPath(name);
  const command = windowsDpapiCommand(file, value);
  execFileSync(
    powershell(),
    command.args,
    {
      env: command.env,
      stdio: ["ignore", "ignore", "ignore"]
    }
  );
  try { fs.chmodSync(file, 0o600); } catch {}
}

function linuxSecretToolAvailable() {
  try {
    execFileSync("sh", ["-lc", "command -v secret-tool >/dev/null 2>&1"], {
      stdio: ["ignore", "ignore", "ignore"]
    });
    return true;
  } catch {
    return false;
  }
}

function readLinuxSecret(name) {
  if (!linuxSecretToolAvailable()) return null;
  try {
    return execFileSync(
      "secret-tool",
      ["lookup", "service", "vibe-monitor", "account", name],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }
    ).trim() || null;
  } catch {
    return null;
  }
}

function writeLinuxSecret(name, value) {
  execFileSync(
    "secret-tool",
    ["store", "--label=Vibe Monitor", "service", "vibe-monitor", "account", name],
    { input: value, encoding: "utf8", stdio: ["pipe", "ignore", "ignore"] }
  );
}

function readFileSecret(name) {
  const file = fileSecretPath(name);
  try {
    return fs.readFileSync(file, "utf8").trim() || null;
  } catch {
    return null;
  }
}

function writeFileSecret(name, value) {
  const file = fileSecretPath(name);
  fs.writeFileSync(file, value + "\n", { encoding: "utf8", mode: 0o600 });
  try { fs.chmodSync(file, 0o600); } catch {}
}

export function secretBackend() {
  if (process.env.VIBE_MONITOR_TEST_SECRET_DIR || process.env.VIBE_MONITOR_TEST_MASTER_KEY) return "test-env";
  if (process.platform === "darwin") return "macos-keychain";
  if (process.platform === "win32") return "windows-dpapi";
  if (process.platform === "linux" && linuxSecretToolAvailable()) return "linux-secret-service";
  return "file-0600";
}

export function readSecret(name) {
  if (process.env.VIBE_MONITOR_TEST_MASTER_KEY && name === "project-state-key") {
    return process.env.VIBE_MONITOR_TEST_MASTER_KEY;
  }
  if (process.env.VIBE_MONITOR_TEST_SECRET_DIR) return readFileSecret(name);
  if (process.platform === "darwin") return readMacKeychain(name);
  if (process.platform === "win32") return readWindowsDpapi(name);
  if (process.platform === "linux" && linuxSecretToolAvailable()) return readLinuxSecret(name);
  return readFileSecret(name);
}

export function writeSecret(name, value) {
  if (process.env.VIBE_MONITOR_TEST_MASTER_KEY && name === "project-state-key") return;
  if (process.env.VIBE_MONITOR_TEST_SECRET_DIR) return writeFileSecret(name, value);
  if (process.platform === "darwin") return writeMacKeychain(name, value);
  if (process.platform === "win32") return writeWindowsDpapi(name, value);
  if (process.platform === "linux" && linuxSecretToolAvailable()) return writeLinuxSecret(name, value);
  return writeFileSecret(name, value);
}

export function verifyCredentialStore() {
  if (process.platform !== "win32" || process.env.VIBE_MONITOR_TEST_SECRET_DIR) {
    return { ok: true, backend: secretBackend(), checked: false };
  }

  const name = "__credential-preflight-" + process.pid + "-" + crypto.randomBytes(6).toString("hex");
  const file = windowsBlobPath(name);
  const expected = "vibe-dpapi-preflight-" + crypto.randomBytes(24).toString("base64url");
  try {
    writeWindowsDpapi(name, expected);
    const actual = readWindowsDpapi(name);
    if (actual !== expected) throw new Error("dpapi_round_trip_mismatch");
    return { ok: true, backend: "windows-dpapi", checked: true };
  } catch (cause) {
    const error = new Error("credential_preflight_failed");
    error.cause = cause;
    error.installPhase = "credential_preflight";
    throw error;
  } finally {
    try { fs.rmSync(file, { force: true }); } catch {}
  }
}

export function getOrCreateSecret(name, bytes = 32) {
  const existing = readSecret(name);
  if (existing) return existing;
  const value = crypto.randomBytes(bytes).toString("base64url");
  writeSecret(name, value);
  return value;
}

function masterKey() {
  const encoded = getOrCreateSecret("project-state-key", 32);
  const raw = Buffer.from(encoded, "base64url");
  if (raw.length !== 32) {
    return crypto.createHash("sha256").update(encoded).digest();
  }
  return raw;
}

function aadFor(file) {
  return Buffer.from("vibe-monitor:" + path.basename(file), "utf8");
}

export function encryptJson(value, fileHint = "state.enc") {
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv("aes-256-gcm", masterKey(), iv);
  cipher.setAAD(aadFor(fileHint));
  const plaintext = Buffer.from(JSON.stringify(value), "utf8");
  const ciphertext = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  const tag = cipher.getAuthTag();
  return {
    v: ENVELOPE_VERSION,
    alg: "A256GCM",
    iv: iv.toString("base64"),
    tag: tag.toString("base64"),
    data: ciphertext.toString("base64")
  };
}

export function decryptJson(envelope, fileHint = "state.enc") {
  if (!envelope || envelope.v !== ENVELOPE_VERSION || envelope.alg !== "A256GCM") {
    throw new Error("unsupported_encrypted_state");
  }
  const decipher = crypto.createDecipheriv(
    "aes-256-gcm",
    masterKey(),
    Buffer.from(envelope.iv, "base64")
  );
  decipher.setAAD(aadFor(fileHint));
  decipher.setAuthTag(Buffer.from(envelope.tag, "base64"));
  const plaintext = Buffer.concat([
    decipher.update(Buffer.from(envelope.data, "base64")),
    decipher.final()
  ]);
  return JSON.parse(plaintext.toString("utf8"));
}

export function securityStatus() {
  const backend = secretBackend();
  const projectRoot = path.join(vibeHome(), "projects");
  let encrypted = 0;
  let plaintext = 0;
  let nonPrivateMode = 0;

  if (fs.existsSync(projectRoot)) {
    const walk = dir => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const absolute = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(absolute);
          continue;
        }
        if (entry.name.endsWith(".enc")) encrypted += 1;
        if (entry.name.endsWith(".json")) {
          plaintext += 1;
          try {
            if ((fs.statSync(absolute).mode & 0o077) !== 0) nonPrivateMode += 1;
          } catch {}
        }
      }
    };
    walk(projectRoot);
  }

  return {
    secretBackend: backend,
    osProtectedSecrets: ["macos-keychain", "windows-dpapi", "linux-secret-service"].includes(backend),
    projectStateStorage: "plaintext-json-0600",
    plaintextProjectJsonFiles: plaintext,
    legacyEncryptedProjectFiles: encrypted,
    nonPrivateProjectFiles: nonPrivateMode,
    projectStateRisk: "Contains derived project structure/evolution metadata, not source code, diffs, prompts, or secret values.",
    fallbackWarning: backend === "file-0600"
      ? "OS secret store unavailable; cloud/telemetry secrets are protected only by user-only filesystem permissions."
      : null
  };
}

function migrateEncryptedFileToJson(encryptedFile, jsonFile) {
  if (!fs.existsSync(encryptedFile)) return false;

  if (fs.existsSync(jsonFile)) {
    try {
      JSON.parse(fs.readFileSync(jsonFile, "utf8"));
      try { fs.chmodSync(jsonFile, 0o600); } catch {}
      fs.unlinkSync(encryptedFile);
      return false;
    } catch {
      // Recover the JSON from the encrypted legacy copy below.
    }
  }

  const envelope = JSON.parse(fs.readFileSync(encryptedFile, "utf8"));
  const value = decryptJson(envelope, encryptedFile);
  atomicJsonWrite(jsonFile, value);
  fs.unlinkSync(encryptedFile);
  return true;
}

export function migrateProjectStateTree() {
  const root = path.join(vibeHome(), "projects");
  if (!fs.existsSync(root)) return { migrated: 0, failed: 0 };
  let migrated = 0;
  let failed = 0;

  const walk = dir => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const absolute = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(absolute);
        continue;
      }

      try {
        if (entry.name.endsWith(".enc")) {
          const json = absolute.replace(/\.enc$/, ".json");
          if (migrateEncryptedFileToJson(absolute, json)) migrated += 1;
          continue;
        }

        if (entry.name.endsWith(".json")) {
          try { fs.chmodSync(absolute, 0o600); } catch {}
        }
      } catch {
        failed += 1;
      }
    }
  };

  walk(root);
  return { migrated, failed };
}

function readJsonStrict(file) {
  if (!fs.existsSync(file)) return null;
  try { fs.chmodSync(file, 0o600); } catch {}
  return JSON.parse(fs.readFileSync(file, "utf8"));
}

export function inspectProjectState(
  inputPath = process.cwd(),
  { section = "all", snapshotLimit = 10 } = {}
) {
  migrateProjectStateTree();
  const root = findProjectRoot(inputPath);
  const identity = projectIdentity(root);
  const dir = path.join(vibeHome(), "projects", identity.id);

  const readers = {
    latest: () => readJsonStrict(path.join(dir, "latest.json")),
    findings: () => readJsonStrict(path.join(dir, "findings.json")),
    intent: () => readJsonStrict(path.join(dir, "intent.json")),
    notice: () => readJsonStrict(path.join(dir, "notice-state.json")),
    snapshots: () => {
      const snapshotsDir = path.join(dir, "snapshots");
      if (!fs.existsSync(snapshotsDir)) return [];
      return fs.readdirSync(snapshotsDir)
        .filter(name => name.endsWith(".json"))
        .sort()
        .slice(-Math.max(1, Math.min(100, Number(snapshotLimit) || 10)))
        .map(name => ({
          file: name,
          value: readJsonStrict(path.join(snapshotsDir, name))
        }));
    }
  };

  if (section !== "all" && !readers[section]) {
    throw new Error("unknown_security_section:" + section);
  }

  const state = section === "all"
    ? Object.fromEntries(Object.entries(readers).map(([name, read]) => [name, read()]))
    : { [section]: readers[section]() };

  return {
    project: {
      id: identity.id,
      root: identity.root
    },
    storage: "plaintext-json-0600",
    state
  };
}

export function exportProjectState(
  inputPath,
  outputFile,
  { section = "all", snapshotLimit = 10 } = {}
) {
  if (!outputFile) throw new Error("output_required");
  const payload = inspectProjectState(inputPath, { section, snapshotLimit });
  const resolved = path.resolve(outputFile);
  ensureDir(path.dirname(resolved));
  fs.writeFileSync(resolved, JSON.stringify(payload, null, 2) + "\n", {
    encoding: "utf8",
    mode: 0o600
  });
  try { fs.chmodSync(resolved, 0o600); } catch {}
  return {
    output: resolved,
    plaintext: true,
    fileMode: "0600",
    warning: "This export contains Vibe project metadata. It does not include source code, diffs, prompts, or secret values by default."
  };
}
