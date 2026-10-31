import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { auditLegacyCode } from "../src/legacy-audit.js";
import { buildAgentResult } from "../src/mcp.js";
import { findingDetail } from "../src/finding-detail.js";

function fixture(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-legacy-audit-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,"src"));
  fs.mkdirSync(path.join(root,"test"));
  fs.writeFileSync(path.join(root,"package.json"),'{"type":"module","name":"fixture"}\n');
  fs.writeFileSync(path.join(root,"src","features.js"),[
    "function unusedHelper(){ return 'unused'; }",
    "function usedHelper(){ return 1; }",
    "export const active = () => usedHelper();",
    "function legacyApiAdapter(value){return value;}",
    "if (/legacy/.test('test string')) console.log('regex only');",
    "const compatibility = 3;",
    "if (compatibility < 5) console.log('counter only');",
    "if (false) { console.log('retired'); }",
    "// @deprecated old public surface",
    "export function oldFunction(){return 9;}",
    "const response = fetch('/api');"
  ].join("\n")+"\n");
  fs.writeFileSync(path.join(root,"test","usage.test.js"),
    "import {active} from '../src/features.js';\nactive();\n");
  execFileSync("git",["init","-q"],{cwd:root,stdio:"ignore"});
  return root;
}

test("P1: inventory includes line-level legacy, disabled, deprecated and orphan candidates",t=>{
  const root=fixture(t);
  const result=auditLegacyCode(root,{productIntent:{explicit:{audience:"personal"}}});
  assert.equal(result.assessmentAvailable,true);
  assert.equal(result.context.personalProjectDeclared,true);
  assert.equal(result.context.consumersVerified,false);
  assert.equal(result.conclusion,"review-only-no-automatic-removal");
  const kinds=result.candidates.map(c=>c.kind);
  assert.ok(kinds.includes("legacy-implementation"));
  assert.ok(kinds.includes("statically-disabled-branch"));
  assert.ok(kinds.includes("retired-feature-marker"));
  assert.ok(kinds.includes("possibly-unreferenced-private-function"));
  assert.ok(result.candidates.some(c=>c.symbol==="unusedHelper"));
  assert.equal(result.candidates.some(c=>c.symbol==="usedHelper"),false);
  assert.equal(result.candidates.some(c=>c.path.startsWith("test/")),false);
  assert.equal(result.candidates.some(c=>/\/legacy\/|compatibility = 3|compatibility < 5/.test(c.excerpt||"")),false,
    "a metrics variable is not a compatibility implementation");
  for(const candidate of result.candidates) {
    assert.equal(candidate.deletionAuthorized,false);
    assert.equal(candidate.usage,"not-verified");
    assert.ok(candidate.path && candidate.line>0 && candidate.basis);
  }
});

test("P0: alerts retain source values, explainability status and incomplete coverage",t=>{
  const root=fixture(t);
  const finding={
    id:"VM-SYNTH",family:"code-structure",stage:"S3",target:"src/features.js",
    requiresAttention:true,evidenceQuality:"direct+heuristic",
    signals:[{name:"size",value:1200,bucket:"medium",evidence:"Direct LOC observation",
      independenceGroup:"size"}],
    boundaryAssessment:{status:"insufficient-semantic-evidence",semanticEvidenceAvailable:false},
    userFacing:{title:"Observation only",doNow:"Review evidence first"}
  };
  const payload=buildAgentResult({
    project:{id:"fixture",root},capturedAt:"2026-10-30T12:00:00Z",summary:{
      structuralScan:{candidateFiles:10,analyzedFiles:5,skippedByBudget:5}},
    findings:[finding],transitions:[],status:{assessmentAvailable:true},
    monitoring:{mode:"full"}
  },{sessionStart:true});
  assert.equal(payload.attentionFindings.length,1);
  const notice=payload.attentionFindings[0];
  assert.equal(notice.signals[0].value,1200);
  assert.equal(notice.signals[0].evidence,"Direct LOC observation");
  assert.equal(notice.evidenceSummary.assessment,"insufficient-semantic-evidence");
  assert.equal(notice.evidenceSummary.verificationRequired,true);
  assert.equal(notice.evidenceSummary.structuralCoverage.skippedByBudget,5);
  assert.ok(notice.evidenceSummary.sourceEvidence.some(item=>item.path==="src/features.js"&&item.line>0));
});

test("P0: project-level source contributors survive finding explanation",t=>{
  const root=fixture(t);
  const finding={id:"VM-PROJECT",family:"api-contract",target:"project",stage:"S3",
    signals:[],sourceEvidence:[{kind:"api-contract-source-contributor",
      path:"src/features.js",counts:{compatibility:1,versions:0,endpoints:0}}]};
  const detail=findingDetail(root,finding);
  assert.deepEqual(detail.explanation.sourceEvidence,finding.sourceEvidence);
});

test("P1: explicit compatibility note is found without requiring unverified deletion",t=>{
  const root=fixture(t);
  fs.appendFileSync(path.join(root,"src","features.js"),
    '\nconst ignored = "Ignored; kept for compatibility.";\n');
  const result=auditLegacyCode(root);
  assert.ok(result.candidates.some(x=>x.kind==="ignored-compatibility-parameter"));
  assert.equal(result.candidates.every(x=>x.deletionAuthorized===false),true);
});
