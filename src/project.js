import fs from "node:fs";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { sha256 } from "./utils.js";

function git(root, args) {
  try {
    return execFileSync("git", args, { cwd: root, encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
  } catch {
    return "";
  }
}

function gitRaw(root, args) {
  try {
    return {
      ok: true,
      output: execFileSync("git", args, {
        cwd: root,
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      })
    };
  } catch {
    return { ok: false, output: "" };
  }
}

function assertSingleProjectScope(root) {
  // A parent directory containing many independent Git roots is not a
  // single software product. Fail with a recoverable, actionable error
  // rather than reporting aggregate third-party S5 architecture pressure.
  let independent = 0;
  try {
    for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
      if (!entry.isDirectory() || entry.name.startsWith(".")) continue;
      if (fs.existsSync(path.join(root, entry.name, ".git")) && ++independent >= 4) {
        throw new Error("ambiguous_multi_repo_workspace: select one project Git repository, not its parent workspace");
      }
    }
  } catch (error) {
    if (error?.message?.startsWith("ambiguous_multi_repo_workspace:")) throw error;
  }
}

export function findProjectRoot(start = process.cwd()) {
  const absolute = path.resolve(start);
  const gitRoot = git(absolute, ["rev-parse", "--show-toplevel"]);
  if (gitRoot) {
    const root = fs.realpathSync(gitRoot);
    assertSingleProjectScope(root);
    return root;
  }
  let current = absolute;
  while (true) {
    if (fs.existsSync(path.join(current, "package.json")) ||
        fs.existsSync(path.join(current, "pyproject.toml")) ||
        fs.existsSync(path.join(current, "Cargo.toml") ) ||
        fs.existsSync(path.join(current, "go.mod"))) return fs.realpathSync(current);
    const parent = path.dirname(current);
    if (parent === current) return fs.realpathSync(absolute);
    current = parent;
  }
}

function normalizeRemote(remote) {
  let value = String(remote || "")
    .trim()
    .replace(/\\/g, "/")
    .replace(/^git@([^:]+):/, "ssh://git@$1/")
    .replace(/\.git\/?$/, "");

  try {
    const parsed = new URL(value);
    if (parsed.hostname) {
      return (parsed.hostname.toLowerCase() + parsed.pathname)
        .replace(/\/+/g, "/")
        .replace(/\/$/, "");
    }
  } catch {}

  return value.replace(/\/$/, "");
}

export function projectIdentity(root) {
  const realRoot = fs.realpathSync(root);
  const remote = git(root, ["config", "--get", "remote.origin.url"]);
  const normalizedRemote = normalizeRemote(remote);
  const repoBasis = normalizedRemote || "local:" + realRoot;
  const repoId = sha256(repoBasis).slice(0, 16);

  let gitDir = git(root, ["rev-parse", "--git-dir"]);
  if (gitDir) {
    gitDir = path.resolve(root, gitDir);
    try { gitDir = fs.realpathSync(gitDir); } catch {}
  }

  const instanceBasis = JSON.stringify({
    repoId,
    realRoot,
    gitDir: gitDir || null
  });
  const projectInstanceId = sha256(instanceBasis).slice(0, 16);

  return {
    id: projectInstanceId,
    repoId,
    projectInstanceId,
    legacyId: repoId,
    identityVersion: 2,
    root: realRoot,
    displayName: path.basename(realRoot),
    remotePresent: Boolean(remote),
    branch: git(root, ["branch", "--show-current"]) || null,
    head: git(root, ["rev-parse", "HEAD"]) || null
  };
}

export function projectChangeFingerprint(root) {
  const status = gitRaw(root, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  if (!status.ok) return null;

  const head = git(root, ["rev-parse", "HEAD"]) || "no-head";
  const changed = new Set();
  const entries = status.output.split("\0").filter(Boolean);

  for (let index = 0; index < entries.length; index++) {
    const entry = entries[index];
    if (entry.length < 4) continue;
    const statusCode = entry.slice(0, 2);
    const rel = entry.slice(3);
    if (rel) changed.add(rel);

    if (/[RC]/.test(statusCode) && index + 1 < entries.length) {
      const previousRel = entries[index + 1];
      if (previousRel) changed.add(previousRel);
      index += 1;
    }
  }

  const state = [...changed].sort().map(rel => {
    const absolute = path.join(root, rel);
    try {
      const stat = fs.statSync(absolute);
      return [rel, stat.size, Math.trunc(stat.mtimeMs)];
    } catch {
      return [rel, "deleted", 0];
    }
  });

  return sha256(JSON.stringify({
    head,
    status: sha256(status.output),
    state
  })).slice(0, 24);
}
