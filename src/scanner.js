import fs from "node:fs";
import path from "node:path";
import {
  EVIDENCE_VERSION, SOURCE_EXTENSIONS, SOURCE_LANGUAGE_BY_EXTENSION, IGNORED_DIRS, RESPONSIBILITY_PATTERNS,
  PLATFORM_PATTERNS, CREDENTIAL_PATTERNS, PUBLIC_ENDPOINT_PATTERNS, TEST_SCOPE_PATTERN
} from "./constants.js";
import { countMatches, normalizeRel, sha256 } from "./utils.js";
import { collectGitEvidence } from "./git-evidence.js";
import {
  analyzeStructuralFile,
  supportsStructuralEvidence
} from "./structural-evidence.js";

const MAX_SOURCE_BYTES = 1024 * 1024;

// Never score a partial repository as healthy when the evidence budget expires.
export class ScanBudgetExceededError extends Error {
  constructor(phase) {
    super("scan_budget_exceeded");
    this.name = "ScanBudgetExceededError";
    this.code = "scan_budget_exceeded";
    this.phase = phase;
  }
}
const DEFAULT_SCAN_LIMITS = Object.freeze({
  maxElapsedMs: 5000, maxEntries: 20000, maxSourceFiles: 3500
});
function scanGuard(context, phase) {
  if (Date.now() - context.startedAt > context.limits.maxElapsedMs)
    throw new ScanBudgetExceededError(phase + "_timeout");
}

const PROVIDER_PATTERNS = {
  openai: /(^|[/@-])openai($|[/@-])/i,
  anthropic: /anthropic/i,
  stripe: /stripe/i,
  supabase: /supabase/i,
  firebase: /firebase/i,
  aws: /(?:^|[/@-])aws(?:-sdk|$|[/@-])|@aws-sdk/i,
  google: /googleapis|@google-cloud|google-auth/i,
  azure: /@azure|azure-/i,
  cloudflare: /cloudflare|wrangler/i,
  vercel: /@vercel|vercel/i,
  github: /@octokit|github/i,
  twilio: /twilio/i,
  sendgrid: /sendgrid/i
};

const TECHNOLOGY_GROUPS = {
  state: [/redux/i, /zustand/i, /mobx/i, /pinia/i, /recoil/i, /jotai/i],
  http: [/axios/i, /^got$/i, /^ky$/i, /superagent/i, /undici/i],
  validation: [/^zod$/i, /^joi$/i, /^yup$/i, /^ajv$/i, /typebox/i, /io-ts/i],
  orm: [/prisma/i, /sequelize/i, /mongoose/i, /drizzle/i, /typeorm/i, /mikro-orm/i],
  logging: [/^pino$/i, /^winston$/i, /bunyan/i, /log4js/i]
};

function walk(root, current = root, out = [], context = null, depth = 0) {
  if (context) {
    scanGuard(context, "walk");
    if (depth > 80) throw new ScanBudgetExceededError("walk_depth");
  }
  let entries = [];
  try { entries = fs.readdirSync(current, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    if (context) {
      if (++context.entries > context.limits.maxEntries)
        throw new ScanBudgetExceededError("walk_entries");
      if ((context.entries & 31) === 0) scanGuard(context, "walk");
    }
    if (entry.isSymbolicLink()) continue;
    if (entry.isDirectory()) {
      if (IGNORED_DIRS.has(entry.name) || entry.name.startsWith(".vibe-monitor")) continue;
      const child = path.join(current, entry.name);
      // Nested Git repositories/worktrees have separate ownership and
      // must never contribute their code or dependencies to the parent scan.
      if (fs.existsSync(path.join(child, ".git"))) continue;
      walk(root, child, out, context, depth + 1);
      continue;
    }
    if (!entry.isFile()) continue;
    const ext = path.extname(entry.name).toLowerCase();
    if (SOURCE_EXTENSIONS.has(ext)) {
      if (context && ++context.sourceFiles > context.limits.maxSourceFiles)
        throw new ScanBudgetExceededError("source_files");
      out.push(path.join(current, entry.name));
    }
  }
  return out;
}

function importSpecifiers(text) {
  const specs = [];
  const patterns = [
    /\bimport\s+(?:[^"'\n]+?\s+from\s+)?["']([^"']+)["']/g,
    /\brequire\s*\(\s*["']([^"']+)["']\s*\)/g,
    /\bfrom\s+([A-Za-z0-9_.]+)\s+import\b/g,
    /^\s*use\s+([A-Za-z0-9_:]+)/gm
  ];
  for (const regex of patterns) {
    for (const match of text.matchAll(regex)) specs.push(match[1]);
  }
  return [...new Set(specs)];
}

function packageRoot(spec) {
  if (!spec || spec.startsWith(".")) return null;
  if (spec.startsWith("@")) return spec.split("/").slice(0, 2).join("/");
  return spec.split("/")[0];
}

function providerNamesFromImports(imports) {
  const providers = new Set();
  for (const spec of imports) {
    const root = packageRoot(spec);
    if (!root) continue;
    for (const [name, regex] of Object.entries(PROVIDER_PATTERNS)) {
      if (regex.test(root)) providers.add(name);
    }
  }
  return [...providers].sort();
}

function resolveRelativeImport(root, relFile, spec, known) {
  if (!spec.startsWith(".")) return null;
  const from = path.posix.dirname(relFile);
  const base = path.posix.normalize(path.posix.join(from, spec));
  const candidates = [
    base,
    ...[...SOURCE_EXTENSIONS].map(ext => base + ext),
    ...[...SOURCE_EXTENSIONS].map(ext => path.posix.join(base, "index" + ext))
  ];
  return candidates.find(candidate => known.has(candidate)) || null;
}

function responsibilities(text) {
  return Object.entries(RESPONSIBILITY_PATTERNS)
    .filter(([, regex]) => regex.test(text))
    .map(([name]) => name);
}

function duplicateBlockHashes(text, windowSize = 10) {
  const lines = text.split(/\r?\n/)
    .map(line => line.trim())
    .filter(line =>
      line.length >= 4 &&
      !line.startsWith("//") &&
      !line.startsWith("#") &&
      !line.startsWith("/*") &&
      !line.startsWith("*") &&
      !/^import\b/.test(line) &&
      !/^from\s+\S+\s+import\b/.test(line)
    );
  if (lines.length < windowSize) return [];

  const hashes = new Set();
  for (let i = 0; i <= lines.length - windowSize; i++) {
    const block = lines.slice(i, i + windowSize).join("\n").replace(/\s+/g, " ");
    if (block.length < 240) continue;
    hashes.add(sha256(block).slice(0, 24));
    if (hashes.size >= 1200) break;
  }
  return [...hashes];
}

function analyzeFile(root, absolutePath, gitEvidence) {
  const stat = fs.statSync(absolutePath);
  if (stat.size > MAX_SOURCE_BYTES) return null;
  let text;
  try { text = fs.readFileSync(absolutePath, "utf8"); } catch { return null; }
  const rel = normalizeRel(root, absolutePath);
  const lines = text.split(/\r?\n/);
  const imports = importSpecifiers(text);
  const functionCount =
    countMatches(text, /\bfunction\s+[A-Za-z_$][\w$]*\s*\(/g) +
    countMatches(text, /(?:^|\n)\s*(?:export\s+)?(?:async\s+)?(?:const|let|var)\s+[A-Za-z_$][\w$]*\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/g) +
    countMatches(text, /\bdef\s+[A-Za-z_]\w*\s*\(/g) +
    countMatches(text, /\bfn\s+[A-Za-z_]\w*\s*\(/g);
  const classCount =
    countMatches(text, /\bclass\s+[A-Za-z_$][\w$]*/g) +
    countMatches(text, /\bstruct\s+[A-Za-z_]\w*/g);
  const platformAssumptions = PLATFORM_PATTERNS.reduce((n, regex) => n + countMatches(text, regex), 0);
  const credentialSurface = CREDENTIAL_PATTERNS.reduce((n, regex) => n + countMatches(text, regex), 0);
  const publicEndpoints = PUBLIC_ENDPOINT_PATTERNS.reduce((n, regex) => n + countMatches(text, regex), 0);
  const providerNames = providerNamesFromImports(imports);
  const apiContractSignals =
    countMatches(text, /openapi|swagger|json\s*schema|protobuf|\.proto\b|z\.object\s*\(|Type\.Object\s*\(|BaseModel\b|interface\s+\w*(?:Request|Response|Dto|DTO)\b|type\s+\w*(?:Request|Response|Dto|DTO)\b/gi);
  const apiVersionSignals =
    countMatches(text, /\/v[1-9]\d*\/|api[_-]?version|x-api-version|accept-version/gi);
  const compatibilitySignals =
    countMatches(text, /backward[-_ ]compat(?:ible|ibility)?|deprecated(?:Route|Field|Version|Endpoint)?|legacy(?:Route|Api|API|Client|Adapter|Schema|Endpoint)|compat(?:ibility)?(?:Layer|Adapter|Branch|Version)/g);
  const tenantSignals =
    countMatches(text, /tenantId|tenant_id|workspaceId|workspace_id|organizationId|organization_id|orgId|org_id|membership|multi[-_ ]tenant/gi);
  const commercialSignals =
    countMatches(text, /stripe|checkout|subscription|billing|invoice|payment|priceId|price_id|planId|plan_id/gi);
  const providerBranchSignals = providerNames.length
    ? countMatches(text, /\bprovider\b\s*(?:===?|!==?|:)|switch\s*\([^)]*provider|case\s+["'][^"']+["']/gi)
    : 0;
  const fileResponsibilities = responsibilities(text);
  const decisionCount =
    countMatches(text, /\bif\s*[\s(]/g) +
    countMatches(text, /\belse\s+if\b/g) +
    countMatches(text, /\bswitch\s*\(/g) +
    countMatches(text, /\bcase\s+[^:]+:/g) +
    countMatches(text, /\bfor\s*[\s(]/g) +
    countMatches(text, /\bwhile\s*[\s(]/g) +
    countMatches(text, /\bcatch\s*[\s(]/g) +
    countMatches(text, /\bexcept\b/g);
  const presentationResponsibilities = fileResponsibilities.filter(name => ["ui", "rendering"].includes(name)).length;
  const infrastructureResponsibilities = fileResponsibilities.filter(name =>
    ["data", "api", "auth", "filesystem", "process", "network", "scheduling"].includes(name)
  ).length;
  const mixedLayerWork = presentationResponsibilities > 0 && infrastructureResponsibilities > 0;
  const asyncPaths =
    countMatches(text, /\basync\b/g) +
    countMatches(text, /\bawait\b/g) +
    countMatches(text, /\.then\s*\(/g);
  const processSignals =
    countMatches(text, /child_process|spawn\s*\(|exec\s*\(|worker_threads|multiprocessing|subprocess/g);
  const globalStateSignals =
    countMatches(text, /globalThis|\bglobal\.|\bsingleton\b|createGlobal|globalStore/gi);
  const sharedStateSignals =
    countMatches(text, /createContext|useContext|redux|zustand|mobx|pinia|globalThis|\bsingleton\b|globalStore|sharedState/gi);
  const persistenceSignals =
    countMatches(text, /localStorage|sessionStorage|indexedDB|sqlite|prisma|sequelize|mongoose|\bdatabase\b|\bsql\b|redis|supabase|firebase|postgres|mysql/gi);
  const schemaSignals =
    countMatches(text, /\bmigration\b|\bmigrate\b|CREATE\s+TABLE|ALTER\s+TABLE|prisma\s+migrate|\balembic\b/gi);
  const backgroundJobSignals =
    countMatches(text, /\bcron\b|scheduleJob\s*\(|setInterval\s*\(|queue\.(?:add|push|enqueue)\s*\(|new\s+Worker\s*\(|worker_threads|\bbullmq\b|\bcelery\b|\bsidekiq\b|\bagenda\b|BackgroundTasks\s*\(/gi);
  const retrySignals =
    countMatches(text, /\bretry\b|backoff|maxAttempts|max_retries|retryCount|attempts/gi);
  const timeoutSignals =
    countMatches(text, /\btimeout\b|AbortController|AbortSignal|\bcancel(?:led|lation)?\b/gi);
  const idempotencySignals =
    countMatches(text, /idempotent|idempotency|dedup(?:e|licate|lication)|exactly[-_ ]once/gi);
  const coordinationSignals =
    countMatches(text, /\bmutex\b|\bsemaphore\b|\block\b|\blease\b|flock|advisory[_ -]?lock/gi);
  const recoverySignals =
    countMatches(text, /checkpoint|resume|reconcile|replay|\bdurable\b|recovery|recoverable|orphan/gi);
  const structuredLogSignals =
    countMatches(text, /logger\.(?:info|warn|error|debug)|pino\b|winston\b|structlog\b|loguru\b/gi);
  const telemetrySignals =
    countMatches(text, /opentelemetry|@opentelemetry|\botel\b|\btelemetry\b|RuntimeEvent|runtimeEvent|publicEvent|eventJournal|traceparent|startSpan\s*\(|createCounter\s*\(|createHistogram\s*\(|prom-client|prometheus-client|sentry\.|@sentry|datadog/gi);
  const correlationSignals =
    countMatches(text, /correlation[_-]?id|request[_-]?id|trace[_-]?id|span[_-]?id/gi);
  const isTestFile = TEST_SCOPE_PATTERN.test(rel);
  const isToolingFile = /^(scripts?|docs?|fixtures?|benchmarks?|examples?|dev)(\/|$)/i.test(rel);
  const assertionSignals = isTestFile
    ? countMatches(text, /\bexpect\s*\(|\bassert(?:Equal|True|False|Raises)?\s*\(|\bassert\s+|should\.|toEqual\s*\(|toBe\s*\(/g)
    : 0;

  return {
    path: rel,
    loc: lines.length,
    nonBlankLoc: lines.filter(line => line.trim()).length,
    bytes: stat.size,
    importCount: imports.length,
    imports,
    functionCount,
    classCount,
    responsibilities: fileResponsibilities,
    decisionCount,
    mixedLayerWork,
    duplicateBlockCount: 0,
    _duplicateBlockHashes: duplicateBlockHashes(text),
    platformAssumptions,
    credentialSurface,
    publicEndpoints,
    providerNames,
    apiContractSignals,
    apiVersionSignals,
    compatibilitySignals,
    tenantSignals,
    commercialSignals,
    providerBranchSignals,
    asyncPaths,
    processSignals,
    globalStateSignals,
    sharedStateSignals,
    persistenceSignals,
    schemaSignals,
    backgroundJobSignals,
    retrySignals,
    timeoutSignals,
    idempotencySignals,
    coordinationSignals,
    recoverySignals,
    structuredLogSignals,
    telemetrySignals,
    correlationSignals,
    isTestFile,
    isToolingFile,
    assertionSignals,
    gitCommits: gitEvidence.fileCommitCounts[rel] || 0,
    cochangePartners: (gitEvidence.cochange[rel] || []).slice(0, 10)
  };
}

function applyDuplicationEvidence(files) {
  const byHash = new Map();
  const byPath = new Map(files.map(file => [file.path, file]));
  for (const file of files) {
    for (const hash of file._duplicateBlockHashes || []) {
      let owners = byHash.get(hash);
      if (!owners) {
        owners = new Set();
        byHash.set(hash, owners);
      }
      owners.add(file.path);
    }
  }

  let groupCount = 0;
  const affected = new Set();
  for (const owners of byHash.values()) {
    if (owners.size < 2) continue;
    groupCount += 1;
    for (const filePath of owners) {
      affected.add(filePath);
      const file = byPath.get(filePath);
      if (file) file.duplicateBlockCount += 1;
    }
  }

  for (const file of files) delete file._duplicateBlockHashes;
  return {
    duplicateBlockGroups: groupCount,
    duplicateAffectedFiles: affected.size
  };
}

function dependencyManifests(root) {
  const result = {
    production: 0,
    development: 0,
    manifests: [],
    technologyGroups: {},
    providerPackages: [],
    workspacePackages: 0
  };
  const dependencyNames = new Set();
  const pkg = path.join(root, "package.json");
  if (fs.existsSync(pkg)) {
    try {
      const json = JSON.parse(fs.readFileSync(pkg, "utf8"));
      const production = Object.keys(json.dependencies || {});
      const development = Object.keys(json.devDependencies || {});
      result.production += production.length;
      result.development += development.length;
      result.manifests.push("package.json");
      for (const name of [...production, ...development]) dependencyNames.add(name);

      const workspaces = json.workspaces;
      if (Array.isArray(workspaces)) result.workspacePackages = workspaces.length;
      else if (Array.isArray(workspaces?.packages)) result.workspacePackages = workspaces.packages.length;
    } catch {}
  }

  for (const name of ["pyproject.toml", "requirements.txt", "Cargo.toml", "go.mod", "Gemfile"]) {
    if (fs.existsSync(path.join(root, name))) result.manifests.push(name);
  }

  for (const [group, patterns] of Object.entries(TECHNOLOGY_GROUPS)) {
    const matches = [...dependencyNames].filter(name => patterns.some(regex => regex.test(name)));
    if (matches.length) result.technologyGroups[group] = matches.sort();
  }

  const providers = new Set();
  for (const name of dependencyNames) {
    for (const [provider, regex] of Object.entries(PROVIDER_PATTERNS)) {
      if (regex.test(name)) providers.add(provider);
    }
  }
  result.providerPackages = [...providers].sort();
  return result;
}

function deploymentProfile(root) {
  const candidates = [
    ["vercel", ["vercel.json"]],
    ["netlify", ["netlify.toml"]],
    ["fly", ["fly.toml"]],
    ["cloudflare", ["wrangler.toml", "wrangler.json", "wrangler.jsonc"]],
    ["docker", ["Dockerfile", "docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]],
    ["serverless", ["serverless.yml", "serverless.yaml"]],
    ["railway", ["railway.json", "railway.toml"]],
    ["render", ["render.yaml", "render.yml"]],
    ["procfile", ["Procfile"]]
  ];
  const targets = [];
  for (const [name, files] of candidates) {
    if (files.some(file => fs.existsSync(path.join(root, file)))) targets.push(name);
  }
  if (fs.existsSync(path.join(root, "k8s")) || fs.existsSync(path.join(root, "kubernetes"))) {
    targets.push("kubernetes");
  }
  return { targets, targetCount: targets.length };
}

function buildGraph(files) {
  const known = new Set(files.map(file => file.path));
  const outgoing = {};
  const incoming = {};
  for (const file of files) {
    outgoing[file.path] = [];
    incoming[file.path] ||= [];
  }
  for (const file of files) {
    for (const spec of file.imports) {
      const target = resolveRelativeImport("", file.path, spec, known);
      if (!target) continue;
      outgoing[file.path].push(target);
      (incoming[target] ||= []).push(file.path);
    }
  }

  const cycles = [];
  const visiting = new Set();
  const visited = new Set();
  const stack = [];
  function dfs(node) {
    if (visiting.has(node)) {
      const index = stack.indexOf(node);
      if (index >= 0) cycles.push([...stack.slice(index), node]);
      return;
    }
    if (visited.has(node)) return;
    visiting.add(node);
    stack.push(node);
    for (const next of outgoing[node] || []) dfs(next);
    stack.pop();
    visiting.delete(node);
    visited.add(node);
  }
  for (const node of known) dfs(node);

  return {
    edgeCount: Object.values(outgoing).reduce((n, arr) => n + arr.length, 0),
    maxFanOut: Math.max(0, ...Object.values(outgoing).map(arr => arr.length)),
    maxFanIn: Math.max(0, ...Object.values(incoming).map(arr => arr.length)),
    cycleCount: cycles.length,
    cycles: cycles.slice(0, 10),
    outgoing,
    incoming
  };
}

function structuralPriority(file) {
  const cochangeCount = file.cochangePartners.filter(item => item.count >= 2).length;
  return (
    Math.min(file.loc, 2500) / 25 +
    file.responsibilities.length * 12 +
    Math.min(file.functionCount, 100) * 1.5 +
    Math.min(file.importCount, 30) * 2 +
    Math.min(file.gitCommits, 20) * 3 +
    Math.min(cochangeCount, 10) * 6 +
    (file.mixedLayerWork ? 30 : 0)
  );
}

function shouldRunStructuralScan(file) {
  if (!supportsStructuralEvidence(file.path) || file.isTestFile || file.isToolingFile) return false;
  const cochangeCount = file.cochangePartners.filter(item => item.count >= 2).length;
  if (file.loc >= 450 && (
    file.responsibilities.length >= 3 ||
    file.functionCount >= 15 ||
    file.importCount >= 8 ||
    file.mixedLayerWork
  )) return true;
  return file.loc >= 200 && (file.gitCommits >= 4 || cochangeCount >= 3);
}

function applyStructuralEvidence(root, files, {
  maxFiles = 5,
  maxBytes = 1.5 * 1024 * 1024
} = {}) {
  const startedAt = Date.now();
  const candidates = files
    .filter(shouldRunStructuralScan)
    .sort((a, b) => structuralPriority(b) - structuralPriority(a));

  let analyzedFiles = 0;
  let analyzedBytes = 0;
  let parserErrors = 0;
  const languages = new Set();

  for (const file of candidates) {
    if (analyzedFiles >= maxFiles) break;
    if (analyzedBytes + file.bytes > maxBytes && analyzedFiles > 0) break;
    try {
      const structural = analyzeStructuralFile(path.join(root, file.path), file.path);
      if (!structural) continue;
      file.structuralEvidence = structural;
      analyzedFiles += 1;
      analyzedBytes += file.bytes;
      parserErrors += structural.parseErrors || 0;
      if (structural.language) languages.add(structural.language);
    } catch {
      file.structuralEvidence = {
        parser: "tree-sitter",
        language: null,
        unavailable: true
      };
    }
  }

  return {
    mode: "adaptive",
    candidateFiles: candidates.length,
    analyzedFiles,
    skippedByBudget: Math.max(0, candidates.length - analyzedFiles),
    analyzedBytes,
    parserErrors,
    languages: [...languages].sort(),
    maxFiles,
    maxBytes,
    durationMs: Date.now() - startedAt
  };
}

// Non-test source files per language, including languages without
// structural parsing. Counts only; telemetry reduces them to buckets.
function sourceLanguageCounts(files) {
  const counts = {};
  for (const file of files) {
    if (file.isTestFile) continue;
    const language = SOURCE_LANGUAGE_BY_EXTENSION[path.extname(file.path).toLowerCase()];
    if (language) counts[language] = (counts[language] || 0) + 1;
  }
  return counts;
}

export function scanProject(root, { limits = {} } = {}) {
  const startedAt = Date.now();
  const selectedLimits = { ...DEFAULT_SCAN_LIMITS };
  for (const key of Object.keys(selectedLimits)) {
    if (Number.isSafeInteger(limits?.[key]) && limits[key] > 0)
      selectedLimits[key] = limits[key];
  }
  const context = { startedAt, limits: selectedLimits, entries: 0, sourceFiles: 0 };

  const gitStartedAt = Date.now();
  const git = collectGitEvidence(root);
  const gitEvidenceMs = Date.now() - gitStartedAt;

  const evidenceStartedAt = Date.now();
  scanGuard(context, "git_evidence");
  const files = [];
  for (const file of walk(root, root, [], context)) {
    scanGuard(context, "file_analysis");
    const analyzed = analyzeFile(root, file, git);
    if (analyzed) files.push(analyzed);
  }
  scanGuard(context, "file_analysis");
  const duplication = applyDuplicationEvidence(files);
  scanGuard(context, "duplication");
  const graph = buildGraph(files);
  scanGuard(context, "graph");
  const deps = dependencyManifests(root);
  const deployment = deploymentProfile(root);
  scanGuard(context, "evidence");
  const evidenceMs = Date.now() - evidenceStartedAt;

  const structuralScan = applyStructuralEvidence(root, files);

  return {
    schemaVersion: 1,
    evidenceVersion: EVIDENCE_VERSION,
    capturedAt: new Date().toISOString(),
    durationMs: Date.now() - startedAt,
    timings: {
      gitEvidenceMs,
      evidenceMs,
      structuralMs: structuralScan.durationMs
    },
    summary: {
      sourceFiles: files.length,
      sourceLanguages: sourceLanguageCounts(files),
      totalLoc: files.reduce((n, file) => n + file.loc, 0),
      totalFunctions: files.reduce((n, file) => n + file.functionCount, 0),
      totalImports: files.reduce((n, file) => n + file.importCount, 0),
      totalDecisions: files.reduce((n, file) => n + file.decisionCount, 0),
      duplicateBlockGroups: duplication.duplicateBlockGroups,
      duplicateAffectedFiles: duplication.duplicateAffectedFiles,
      productionDependencies: deps.production,
      developmentDependencies: deps.development,
      dependencyManifests: deps.manifests,
      technologyGroups: deps.technologyGroups,
      providerPackages: deps.providerPackages,
      workspacePackages: deps.workspacePackages,
      deploymentTargets: deployment.targets,
      deploymentTargetCount: deployment.targetCount,
      platformAssumptions: files.reduce((n, file) => n + file.platformAssumptions, 0),
      credentialSurface: files.reduce((n, file) => n + file.credentialSurface, 0),
      publicEndpoints: files.reduce((n, file) => n + file.publicEndpoints, 0),
      apiContractSignals: files.reduce((n, file) => n + file.apiContractSignals, 0),
      apiVersionSignals: files.reduce((n, file) => n + file.apiVersionSignals, 0),
      compatibilitySignals: files.reduce((n, file) => n + file.compatibilitySignals, 0),
      tenantSignals: files.reduce((n, file) => n + file.tenantSignals, 0),
      commercialSignals: files.reduce((n, file) => n + file.commercialSignals, 0),
      providerBranchSignals: files.reduce((n, file) => n + file.providerBranchSignals, 0),
      providerFiles: files.filter(file => file.providerNames.length > 0).length,
      providerNames: [...new Set(files.flatMap(file => file.providerNames))].sort(),
      asyncPaths: files.reduce((n, file) => n + file.asyncPaths, 0),
      processSignals: files.reduce((n, file) => n + file.processSignals, 0),
      globalStateSignals: files.reduce((n, file) => n + file.globalStateSignals, 0),
      sharedStateSignals: files.reduce((n, file) => n + file.sharedStateSignals, 0),
      persistenceSignals: files.reduce((n, file) => n + file.persistenceSignals, 0),
      schemaSignals: files.reduce((n, file) => n + file.schemaSignals, 0),
      backgroundJobSignals: files.reduce((n, file) => n + file.backgroundJobSignals, 0),
      retrySignals: files.reduce((n, file) => n + file.retrySignals, 0),
      timeoutSignals: files.reduce((n, file) => n + file.timeoutSignals, 0),
      idempotencySignals: files.reduce((n, file) => n + file.idempotencySignals, 0),
      coordinationSignals: files.reduce((n, file) => n + file.coordinationSignals, 0),
      recoverySignals: files.reduce((n, file) => n + file.recoverySignals, 0),
      structuredLogSignals: files.reduce((n, file) => n + file.structuredLogSignals, 0),
      telemetrySignals: files.reduce((n, file) => n + file.telemetrySignals, 0),
      correlationSignals: files.reduce((n, file) => n + file.correlationSignals, 0),
      testFiles: files.filter(file => file.isTestFile).length,
      testLoc: files.filter(file => file.isTestFile).reduce((n, file) => n + file.loc, 0),
      assertionSignals: files.reduce((n, file) => n + file.assertionSignals, 0),
      structuralScan
    },
    graph: {
      edgeCount: graph.edgeCount,
      maxFanOut: graph.maxFanOut,
      maxFanIn: graph.maxFanIn,
      cycleCount: graph.cycleCount,
      cycles: graph.cycles
    },
    git: {
      available: git.available,
      commitCount: git.commitCount
    },
    files
  };
}
