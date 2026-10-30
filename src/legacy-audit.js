// Local, read-only legacy and dead-feature candidate inventory. Never delete automatically.
import fs from "node:fs";
import path from "node:path";
import { scanProject, ScanBudgetExceededError } from "./scanner.js";

const MAX_FILE_BYTES = 512 * 1024;
const MAX_READ_BYTES = 8 * 1024 * 1024;
const SOURCE_CODE = /\.(?:[cm]?[jt]sx?|py)$/i;
const TEST_FILE = /(?:^|\/)(?:test|tests|__tests__|fixtures|__fixtures__)(?:\/|$)|(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/i;

function signalAt(line, previous = "") {
  const text = line.trim();
  const before = previous.trim();
  if (!text || text.length > 500 || /^\s*(?:import|from)\s/.test(text)) return null;
  // A regex *testing for* legacy syntax is not itself a legacy branch.
  if (/^\s*if\s*\(\s*\/(?!\/)/.test(text)) return null;
  // Ordinary comments and regex definitions must not count as live compatibility logic.
  if (/^\s*(?:\/\/|\*|#)/.test(text)) {
    if (/@deprecated\b|\bTODO\s*[:(-]?\s*(?:remove|retire)\b/i.test(text))
      return {kind:"retired-feature-marker",basis:"explicit-source-marker"};
    return null;
  }
  if (/\bif\s*\(\s*(?:false|0)\s*\)/.test(text))
    return {kind:"statically-disabled-branch",basis:"literal-disabled-condition"};
  if (/\bif\s*\([^)]{0,180}\b(?:legacy\w*|compat(?:Layer|Adapter|Branch|Version|Mode)\w*|deprecated\w*|oldVersion|previousVersion)\b/i.test(text) ||
      /\b(?:case\s*["']legacy["']|\.type\s*===?\s*["']legacy["'])/i.test(text))
    return {kind:"compatibility-branch",basis:"source-branch-pattern"};
  if (/\b(?:function|class|const|let|var|def)\s+(?:legacy\w*|compat(?:Layer|Adapter|Branch|Version|Mode)\w*|deprecated\w*|migrateOld\w*|migrateLegacy\w*)\b/i.test(text))
    return {kind:"legacy-implementation",basis:"named-declaration"};
  if (/Ignored; kept for compatibility|ignored.*for backward compatibility/i.test(text))
    return {kind:"ignored-compatibility-parameter",basis:"explicit-compatibility-note"};
  if (/@deprecated\b/i.test(before) && /^\s*(?:export\s+)?(?:function|class|const|let|var|def)\b/.test(text))
    return {kind:"retired-feature-marker",basis:"adjacent-deprecation-marker"};
  return null;
}

function tokenOccurrences(code, name) {
  // Names are parsed as identifiers, not arbitrary regex input.
  return (code.match(new RegExp("\\b" + name + "\\b", "g")) || []).length;
}

function candidate(file, line, kind, basis, extra = {}) {
  return {kind,path:file,line,basis,...extra,verdict:"candidate-needs-review",
    usage:"not-verified",deletionAuthorized:false,
    limitation:"Static source matching cannot establish all runtime, remote, dynamic or stored-data consumers."};
}

/** Source evidence is advisory; no match is proof that code is safe to remove. */
export function auditLegacyCode(root, {productIntent=null,maxCandidates=80}={}) {
  const projectRoot = fs.realpathSync(root);
  let scan;
  try { scan = scanProject(projectRoot); }
  catch (error) {
    if (!(error instanceof ScanBudgetExceededError)) throw error;
    return {schemaVersion:1,assessmentAvailable:false,reason:error.code,
      candidates:[],conclusion:"unknown-not-clean"};
  }
  const allText=[];
  let totalBytes=0,skippedFiles=0;
  for (const file of scan.files || []) {
    if (!SOURCE_CODE.test(file.path)) continue;
    const full=path.resolve(projectRoot,file.path);
    if (!full.startsWith(projectRoot+path.sep)) continue;
    try {
      const size=fs.statSync(full).size;
      if (size>MAX_FILE_BYTES || totalBytes+size>MAX_READ_BYTES) {skippedFiles++;continue;}
      if (!fs.realpathSync(full).startsWith(projectRoot+path.sep)) continue;
      allText.push({path:file.path,text:fs.readFileSync(full,"utf8"),
        isTest:TEST_FILE.test(file.path)||file.isTestFile||file.isToolingFile});
      totalBytes+=size;
    } catch {skippedFiles++;}
  }
  const candidates=[];
  const limit=Math.max(1,Math.min(150,Math.trunc(maxCandidates)||80));
  for (const file of allText) {
    if (file.isTest) continue;
    const lines=file.text.split(/\r?\n/);
    let perFile=0;
    for (let i=0;i<lines.length && candidates.length<limit && perFile<8;i++) {
      const hit=signalAt(lines[i],lines[i-1]||"");
      if (!hit) continue;
      candidates.push(candidate(file.path,i+1,hit.kind,hit.basis,
        {excerpt:lines[i].trim().slice(0,160)}));
      perFile++;
    }
    if (candidates.length>=limit) break;
    if (!/\.[cm]?[jt]sx?$/.test(file.path)) continue;
    // Narrow indication: only non-exported named function declarations, and
    // only when no references exist in *any* scanned source, including tests.
    const declarations=/(?:^|\n)\s*(?!export\b)(?:async\s+)?function\s+([A-Za-z_$][\w$]*)\s*\(/g;
    for (const match of file.text.matchAll(declarations)) {
      if (candidates.length>=limit || perFile>=8) break;
      const name=match[1];
      if (allText.some(item=>tokenOccurrences(item.text,name)>(item.path===file.path?1:0)))continue;
      const line=file.text.slice(0,match.index).split("\n").length;
      candidates.push(candidate(file.path,line,"possibly-unreferenced-private-function",
        "static-lexical-reference-check",{symbol:name,observedSourceReferences:0}));
      perFile++;
    }
  }
  return {schemaVersion:1,assessmentAvailable:skippedFiles===0,
    status:skippedFiles?"partial":"candidate-inventory",
    sourceFilesInspected:allText.length,filesSkippedBySizeOrBudget:skippedFiles,
    candidates,truncated:candidates.length>=limit,
    context:{personalProjectDeclared:productIntent?.explicit?.audience==="personal"||
      productIntent?.explicit?.tenancy==="single",consumersVerified:false},
    conclusion:"review-only-no-automatic-removal",
    nextAction:"Verify deployment entrypoints, remote and dynamic clients, persisted-data dependencies and owner approval before removal."};
}
