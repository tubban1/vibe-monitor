import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {analyzeImplementationOverlap,summarizeEvolution} from "../src/evolution-audit.js";
import {auditLegacyCode} from "../src/legacy-audit.js";

function fixture(t){
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-evolution-"));
  t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
  fs.mkdirSync(path.join(root,"src"));
  const a=[
    "export function transformPayload(input){",
    "  const items = input.map(item => {",
    "    if (!item.active) return null;",
    "    const value = item.value * 2;",
    "    if (value > 50) return {value, status:'large'};",
    "    return {value, status:'small'};",
    "  });",
    "  return items.filter(Boolean);",
    "}"
  ].join("\n");
  const b=[
    "export function processRecords(records){",
    "  const rows = records.map(row => {",
    "    if (!row.active) return null;",
    "    const number = row.value * 2;",
    "    if (number > 50) return {number, status:'large'};",
    "    return {number, status:'small'};",
    "  });",
    "  return rows.filter(Boolean);",
    "}"
  ].join("\n");
  fs.writeFileSync(path.join(root,"src","a.js"),a+"\n");
  fs.writeFileSync(path.join(root,"src","b.js"),b+"\n");
  fs.writeFileSync(path.join(root,"src","legacy.js"),"function legacyAdapter(x){return x}\nexport const actual = legacyAdapter(3);\n");
  execFileSync("git",["init","-q"],{cwd:root});
  execFileSync("git",["add","."],{cwd:root});
  execFileSync("git",["-c","user.name=Test","-c","user.email=test@example.invalid","-c","commit.gpgsign=false","commit","-qm","initial"],{cwd:root});
  return root;
}
test("function AST shingle overlap finds structurally similar renamed implementation candidates",t=>{
  const root=fixture(t);
  const r=analyzeImplementationOverlap(root,{files:["src/a.js","src/b.js","src/legacy.js"]});
  assert.equal(r.assessmentAvailable,true);
  assert.ok(r.functionsInspected>=2);
  assert.ok(r.pairs.some(p=>p.left.path==="src/a.js"&&p.right.path==="src/b.js"),JSON.stringify(r.pairs));
  assert.ok(r.pairs.every(p=>p.deletionAuthorized===false&&p.confidence==="heuristic-only"));
});
test("legacy reference evidence reports known uses, never grants deletion",t=>{
  const root=fixture(t);
  const r=auditLegacyCode(root);
  const c=r.candidates.find(c=>c.symbol==="legacyAdapter");
  assert.ok(c);
  assert.equal(c.referenceAssessment,"references-observed");
  assert.ok(c.observedReferences.length>0);
  assert.equal(c.deletionAuthorized,false);
});
test("evolution uses observed Git churn and snapshot deltas, not causal attribution",t=>{
  const root=fixture(t);
  const snapshots=[
    {capturedAt:"2026-01-01",summary:{totalLoc:100,sourceFiles:2,duplicateBlockGroups:0,totalDecisions:10}},
    {capturedAt:"2026-02-01",summary:{totalLoc:170,sourceFiles:3,duplicateBlockGroups:2,totalDecisions:18}}
  ];
  const r=summarizeEvolution(root,snapshots.at(-1).summary,snapshots);
  assert.equal(r.structuralDelta.loc,70);
  assert.equal(r.structuralDelta.duplicateBlockGroups,2);
  assert.ok(r.recentGit.commits>=1);
  assert.equal(r.causalAttribution,"not-established");
  assert.equal(r.businessValue,"not-measured");
});
