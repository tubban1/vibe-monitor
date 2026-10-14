import { execFileSync } from "node:child_process";

function run(root, args) {
  try {
    return execFileSync("git", args, {
      cwd: root,
      encoding: "utf8",
      maxBuffer: 8 * 1024 * 1024,
      timeout: 2000,
      stdio: ["ignore", "pipe", "ignore"]
    }).trim();
  } catch {
    return "";
  }
}

export function collectGitEvidence(root, maxCommits = 50) {
  const raw = run(root, ["log", "--format=@@%H", "--name-only", "-n", String(maxCommits)]);
  if (!raw) return { available: false, commitCount: 0, fileCommitCounts: {}, cochange: {} };

  const commits = [];
  let current = null;
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith("@@")) {
      if (current) commits.push(current);
      current = { hash: line.slice(2), files: [] };
    } else if (current && line.trim()) {
      current.files.push(line.trim());
    }
  }
  if (current) commits.push(current);

  const fileCommitCounts = {};
  const pairs = new Map();
  for (const commit of commits) {
    const unique = [...new Set(commit.files)].slice(0, 80);
    for (const file of unique) fileCommitCounts[file] = (fileCommitCounts[file] || 0) + 1;
    for (let i = 0; i < unique.length; i++) {
      for (let j = i + 1; j < unique.length; j++) {
        const key = unique[i] < unique[j] ? unique[i] + "|" + unique[j] : unique[j] + "|" + unique[i];
        pairs.set(key, (pairs.get(key) || 0) + 1);
      }
    }
  }

  const cochange = {};
  for (const [pair, count] of pairs) {
    if (count < 2) continue;
    const [a, b] = pair.split("|");
    (cochange[a] ||= []).push({ file: b, count });
    (cochange[b] ||= []).push({ file: a, count });
  }
  for (const values of Object.values(cochange)) values.sort((a, b) => b.count - a.count);

  return {
    available: true,
    commitCount: commits.length,
    fileCommitCounts,
    cochange
  };
}
