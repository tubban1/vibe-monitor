import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {freeTelemetryWireBatch,observedFindingFilter,sourceLanguageBuckets} from "../src/telemetry.js";

const tmpFile=()=>path.join(fs.mkdtempSync(path.join(os.tmpdir(),"vm-observed-")),"state.json");
const finding=(id,patch={})=>({id,family:"code-structure",stage:"S3",requiresAttention:true,...patch});
const scanEvent=payload=>({schemaVersion:4,eventId:crypto.randomUUID(),installationId:crypto.randomUUID(),
 at:new Date().toISOString(),event:"scan.observed",projectId:"a".repeat(32),scanId:crypto.randomUUID(),agent:"codex",payload});

test("language counts become fixed buckets, unknown languages and zero counts are dropped",()=>{
 assert.deepEqual(sourceLanguageBuckets({typescript:120,go:12,python:3,cobol:9,rust:0}),[
  {language:"go",files:"10-49"},{language:"python",files:"1-9"},{language:"typescript",files:"50-199"}]);
 assert.deepEqual(sourceLanguageBuckets({java:5000}),[{language:"java",files:"1000+"}]);
 assert.deepEqual(sourceLanguageBuckets(null),[]);
});

test("wire projection forwards valid language buckets on scan events only",()=>{
 const langs=[{language:"go",files:"10-49"},{language:"go",files:"1-9"},{language:"cobol",files:"1-9"},
  {language:"rust",files:"7",path:"/private"}];
 const out=freeTelemetryWireBatch([scanEvent({mode:"full",sourceLanguages:langs})])[0];
 assert.deepEqual(out.payload.sourceLanguages,[{language:"go",files:"10-49"}]);
 assert.doesNotMatch(JSON.stringify(out),/private|cobol/);
 const finding=freeTelemetryWireBatch([{...scanEvent({sourceLanguages:langs}),event:"finding.observed",findingId:"c".repeat(32)}])[0];
 assert.equal(Object.hasOwn(finding.payload,"sourceLanguages"),false);
});

test("an unchanged finding is sent once per day; any meaningful change is sent at once",()=>{
 const file=tmpFile(),t0=Date.UTC(2026,9,21);
 const at=now=>observedFindingFilter("p".repeat(32),{now,file});
 let f=at(t0);assert.equal(f.shouldEmit(finding("a")),true);f.save();
 f=at(t0+60_000);assert.equal(f.shouldEmit(finding("a")),false,"unchanged within a day");
 assert.equal(f.shouldEmit(finding("a",{stage:"S4"})),true,"stage change");f.save();
 f=at(t0+120_000);
 assert.equal(f.shouldEmit(finding("a",{stage:"S4",requiresAttention:false})),true,"attention change");f.save();
 f=at(t0+25*3600_000);assert.equal(f.shouldEmit(finding("a",{stage:"S4",requiresAttention:false})),true,"daily snapshot");
 assert.equal(f.shouldEmit(finding("b")),true,"new finding");
});

test("state keeps pseudonymous IDs only and forgets projects idle for 30 days",()=>{
 const file=tmpFile(),t0=Date.UTC(2026,9,1);
 let f=observedFindingFilter("old".padEnd(32,"0"),{now:t0,file});f.shouldEmit(finding("x"));f.save();
 f=observedFindingFilter("new".padEnd(32,"0"),{now:t0+31*86400_000,file});f.shouldEmit(finding("y"));f.save();
 const state=JSON.parse(fs.readFileSync(file,"utf8"));
 assert.deepEqual(Object.keys(state.projects),["new".padEnd(32,"0")]);
 assert.deepEqual(Object.keys(state.projects["new".padEnd(32,"0")].y).sort(),["at","fp"]);
});

test("a corrupt state file never blocks telemetry",()=>{
 const file=tmpFile();fs.writeFileSync(file,"{not json");
 const f=observedFindingFilter("p".repeat(32),{file});
 assert.equal(f.shouldEmit(finding("a")),true);
 f.save();
 assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).schemaVersion,1);
});
