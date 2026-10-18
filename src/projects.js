import fs from "node:fs";
import path from "node:path";
import { atomicJsonWrite, safeJsonRead, vibeHome } from "./utils.js";

const STAGE_RANK = Object.freeze({ S1: 1, S2: 2, S3: 3, S4: 4, S5: 5 });

function projectsRoot() {
  return path.join(vibeHome(), "projects");
}

function metadataFile(projectId) {
  return path.join(projectsRoot(), projectId, "project.json");
}

function highestStage(findings = []) {
  return [...findings]
    .map(f => f?.stage)
    .filter(Boolean)
    .sort((a, b) => (STAGE_RANK[b] || 0) - (STAGE_RANK[a] || 0))[0] || "S1";
}

export function recordProjectMetadata(projectId, displayName, capturedAt, findings = []) {
  const file = metadataFile(projectId);
  const existing = safeJsonRead(file, null);
  const now = capturedAt || new Date().toISOString();
  const record = {
    schemaVersion: 1,
    projectId,
    displayName: String(displayName || projectId).trim() || projectId,
    createdAt: existing?.createdAt || now,
    lastSeenAt: now,
    highestStage: highestStage(findings),
    findingCount: findings.length
  };
  atomicJsonWrite(file, record);
  return record;
}

export function listProjects() {
  const root = projectsRoot();
  if (!fs.existsSync(root)) return [];
  const projects = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const dir = path.join(root, entry.name);
    const metadata = safeJsonRead(path.join(dir, "project.json"), null);
    const latest = safeJsonRead(path.join(dir, "latest.json"), null);
    const findingsState = safeJsonRead(path.join(dir, "findings.json"), { items: {} });
    const findings = Object.values(findingsState?.items || {});
    const displayName = metadata?.displayName || latest?.project?.displayName || entry.name;
    projects.push({
      projectId: metadata?.projectId || entry.name,
      displayName,
      createdAt: metadata?.createdAt || latest?.capturedAt || null,
      lastSeenAt: metadata?.lastSeenAt || latest?.capturedAt || null,
      highestStage: metadata?.highestStage || highestStage(findings),
      findingCount: Number.isFinite(metadata?.findingCount) ? metadata.findingCount : findings.length
    });
  }
  return projects.sort((a, b) => String(b.lastSeenAt || "").localeCompare(String(a.lastSeenAt || "")));
}

export function resolveProjectRef(ref) {
  const value = String(ref || "").trim();
  if (!value) throw new Error("project_reference_required");
  const projects = listProjects();

  const at = value.lastIndexOf("@");
  const explicitId = at > 0 ? value.slice(at + 1) : null;
  const name = at > 0 ? value.slice(0, at) : value;

  const idMatches = projects.filter(project => project.projectId === value || project.projectId.startsWith(value));
  if (idMatches.length === 1) return idMatches[0];
  if (idMatches.length > 1) {
    const error = new Error("ambiguous_project_id");
    error.matches = idMatches;
    throw error;
  }

  const candidates = projects.filter(project => {
    if (explicitId && !project.projectId.startsWith(explicitId)) return false;
    return project.displayName === name;
  });
  if (candidates.length === 1) return candidates[0];
  if (!candidates.length) throw new Error("project_not_found");
  const error = new Error("ambiguous_project_name");
  error.matches = candidates;
  throw error;
}

export function inspectProjectRef(ref) {
  const project = resolveProjectRef(ref);
  const dir = path.join(projectsRoot(), project.projectId);
  return {
    project,
    latest: safeJsonRead(path.join(dir, "latest.json"), null),
    findings: Object.values(safeJsonRead(path.join(dir, "findings.json"), { items: {} })?.items || {})
  };
}
