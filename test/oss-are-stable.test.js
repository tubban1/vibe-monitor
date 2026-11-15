import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {execFileSync} from "node:child_process";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
import {mcpErrorResult,sessionFailureMcpResult} from "../src/mcp.js";
import {previewExplicitIntent} from "../src/intent.js";
import {buildProjectStatusView,buildFindingsPage,compactFindingDetail} from "../src/mcp-projections.js";

const source=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const expected=[
 "vibe_version","vibe_account_connect","vibe_session_start","vibe_skip_current","vibe_checkpoint",
 "vibe_project_status","vibe_findings","vibe_legacy_audit","vibe_evolution_audit",
 "vibe_finding_intelligence","vibe_explain_finding","vibe_product_intent","vibe_set_product_intent",
 "vibe_get_architecture_review_request","vibe_submit_architecture_review",
 "vibe_outcome_record_action","vibe_outcome_verify","vibe_outcome_status","vibe_feedback"
];
function unpack(value){return JSON.parse(value.content.find(x=>x.type==="text").text)}
function bytes(value){return Buffer.byteLength(value.content.find(x=>x.type==="text").text,"utf8")}
function fixture(){
 const p=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-are-project-"));
 execFileSync("git",["init","-q"],{cwd:p});
 fs.writeFileSync(path.join(p,"package.json"),JSON.stringify({name:"vibe-are-synthetic",type:"module"}));
 fs.writeFileSync(path.join(p,"index.ts"),"export function hello(a:number){return a+1;}\n");
 return p;
}
async function connect(t){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-are-stdio-"));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const mock=path.join(home,"network-block.mjs");
 fs.writeFileSync(mock,"globalThis.fetch=async()=>{throw Error('NETWORK_DISALLOWED_IN_ARE_TEST');};\n");
 const env={...process.env,HOME:home,USERPROFILE:home,VIBE_MONITOR_HOME:path.join(home,"app"),
  VIBE_MONITOR_SETUP_HOME:home,VIBE_CLOUD_URL:"http://127.0.0.1:1",
  VIBE_MONITOR_TEST_SOURCE_INSTALL:"1",
  VIBE_MONITOR_TEST_MASTER_KEY:"f".repeat(64),
  VIBE_MONITOR_TEST_SECRET_DIR:path.join(home,"secrets")};
 const transport=new StdioClientTransport({command:process.execPath,
  args:["--import",mock,path.join(source,"src/cli.js"),"mcp","--agent","antigravity"],
  cwd:source,env});
 const client=new Client({name:"vibe-public-stable-are-contract",version:"1.0.0"});
 await client.connect(transport);
 t.after(async()=>{try{await client.close()}catch{}});
 return {client,home};
}
test("pure stable ARE projections preserve full source evidence and pagination",()=>{
 const findings=Array.from({length:12},(_,i)=>({
  id:"VM-"+i,stage:i%2?"S3":"S4",family:"structure",target:"src/a"+i+".ts",
  title:"review "+i,score:82-i,requiresAttention:true,doNow:["inspect "+i],
  doNotDoYet:["do not rewrite"],nextTrigger:"needs consumer evidence",
  intelligence:{priority:10-i,trend:"rising"}
 }));
 const full={schemaVersion:1,evidenceVersion:7,project:{id:"demo"},
  status:{assessmentAvailable:true,findingCount:12},capturedAt:"2026-11-15T00:00:00Z",
  summary:{sourceFiles:36,totalLoc:2400,structuralScan:{
   candidateFiles:20,analyzedFiles:12,skippedByBudget:8,parserErrors:0}},
  findings,monitoring:{mode:"full"}};
 const small=buildProjectStatusView(full);
 assert.equal(small.status.findingCount,12);
 assert.equal(small.summary.sourceFiles,36);
 assert.equal(small.summary.structuralCoverage.skippedByBudget,8);
 assert.equal(small.evidenceCount,12);
 assert.equal(small.risks.top.length,2);
 assert.equal(buildProjectStatusView(full,{detail:"full"}),full);
 const ids=[0,5,10].flatMap(offset=>buildFindingsPage(full,{limit:5,offset}).findings.map(x=>x.id));
 assert.deepEqual(ids,findings.map(x=>x.id));
 assert.deepEqual(buildFindingsPage(full,{limit:50,detail:"full"}).findings,findings);
 const detail={...findings[0],doNow:["inspect 0"],prepare:[],decisionQuestions:[],
  boundaryAssessment:{status:"human-review"},
  explanation:{sourceEvidence:[{line:12,excerpt:"return value;"}],
   decisionAssessment:{status:"human-review"},evidenceClassification:{
    recommendation:{doNow:["inspect 0"],prepare:[],doNotDoYet:["do not rewrite"],
     nextTrigger:"needs consumer evidence",decisionQuestions:[]}
   }}};
 const compact=compactFindingDetail(detail);
 assert.deepEqual(compact.explanation.sourceEvidence,detail.explanation.sourceEvidence);
 assert.equal(compact.explanation.decisionAssessmentRef,"$.boundaryAssessment");
 assert.equal(compact.explanation.evidenceClassification.recommendationRef.startsWith("$.doNow"),true);
 assert.equal(compactFindingDetail(detail,{format:"full"}),detail);
});
test("session execution failures are isError but explicit Skip is not",()=>{
 const timed=sessionFailureMcpResult("scan_timeout","test-scan",10000);
 assert.equal(timed.isError,true);
 assert.equal(unpack(timed).code,"scan_timeout");
 assert.equal(unpack(timed).status.assessmentAvailable,false);
 assert.equal(unpack(timed).retryable,true);
 const failed=sessionFailureMcpResult("scan_worker_failed","test-scan",120);
 assert.equal(failed.isError,true);
 assert.equal(unpack(failed).retryable,true);
 const skipped=sessionFailureMcpResult("user_skipped","test-scan",200);
 assert.notEqual(skipped.isError,true);
 assert.equal(unpack(skipped).monitoring.mode,"skipped");
 const notFound=mcpErrorResult("finding_not_found",{message:"Unknown ID",next:"Call vibe_findings"});
 assert.equal(notFound.isError,true);
 assert.equal(unpack(notFound).retryable,false);
});
test("real MCP stdio preserves 19 tools, full drilldown, three tasks, privacy and dry_run",async t=>{
 const project=fixture();t.after(()=>fs.rmSync(project,{recursive:true,force:true}));
 const {client,home}=await connect(t);
 const listed=(await client.listTools()).tools;
 assert.deepEqual(listed.map(x=>x.name),expected);
 for(const tool of listed){
  assert.ok(tool.annotations,"unannotated "+tool.name);
  for(const key of ["readOnlyHint","destructiveHint","idempotentHint","openWorldHint"])
   assert.equal(typeof tool.annotations[key],"boolean",tool.name+"."+key);
 }
 assert.equal(listed.find(x=>x.name==="vibe_account_connect").annotations.readOnlyHint,true);
 for(const name of ["vibe_project_status","vibe_findings","vibe_legacy_audit","vibe_evolution_audit",
  "vibe_set_product_intent"])
  assert.equal(listed.find(x=>x.name===name).annotations.readOnlyHint,false);
 assert.equal(listed.find(x=>x.name==="vibe_skip_current").annotations.destructiveHint,true);

 // Task 1: find project risk and drill into exactly the same source results.
 const status=await client.callTool({name:"vibe_project_status",arguments:{path:source}});
 const brief=unpack(status);
 assert.notEqual(status.isError,true);
 assert.equal(brief.view,"summary");
 assert.ok(brief.status.assessmentAvailable===true);
 assert.ok(brief.summary.sourceFiles>10);
 assert.ok(brief.evidenceIndex.length>0);
 assert.ok(bytes(status)<6000);
 const complete=unpack(await client.callTool({name:"vibe_project_status",arguments:{path:source,detail:"full"}}));
 assert.equal(complete.status.findingCount,brief.status.findingCount);
 assert.equal(complete.summary.sourceFiles,brief.summary.sourceFiles);
 assert.ok(complete.findings.length>10);
 const files=unpack(await client.callTool({name:"vibe_project_status",arguments:{path:source,detail:"files",limit:3,offset:0}}));
 assert.equal(files.view,"files");
 assert.equal(files.files.length,3);
 assert.ok(files.pagination.total>3);
 assert.equal(files.files[0].source,undefined);
 const page1=unpack(await client.callTool({name:"vibe_findings",arguments:{path:source,limit:5}}));
 const page2=unpack(await client.callTool({name:"vibe_findings",arguments:{path:source,limit:5,offset:5}}));
 assert.equal(page1.pagination.total,complete.findings.length);
 assert.equal(page1.findings.length,5);
 assert.equal(new Set([...page1.findings,...page2.findings].map(x=>x.id)).size,10);
 const fullPage=unpack(await client.callTool({name:"vibe_findings",arguments:{path:source,detail:"full",limit:2}}));
 assert.equal(fullPage.findings.length,2);
 assert.ok(fullPage.recommendationGroups!==null);
 assert.ok(fullPage.highSeverityReviewQueue!==null);
 assert.equal(fullPage.legacySummaryIncluded,true);

 // Task 2: non-persisting user-intent preview, followed by real isolated persistence.
 const missing=await client.callTool({name:"vibe_set_product_intent",arguments:{path:project}});
 assert.notEqual(missing.isError,true);
 assert.equal(unpack(missing).status,"needs_input");
 assert.ok(unpack(missing).missingFields.includes("delivery"));
 const activity=path.join(home,"app","activity.jsonl");
 const before=fs.existsSync(activity)?fs.readFileSync(activity):Buffer.alloc(0);
 const dry=await client.callTool({name:"vibe_set_product_intent",
  arguments:{path:project,delivery:"local",tenancy:"single",dry_run:true}});
 const preview=unpack(dry);
 assert.equal(preview.dryRun,true);
 assert.equal(preview.persisted,false);
 assert.equal(preview.cloudRequests,0);
 assert.deepEqual(preview.changes.map(x=>x.field).sort(),["delivery","tenancy"]);
 const intentFile=path.join(home,"app","projects",preview.project.id,"intent.json");
 assert.equal(fs.existsSync(intentFile),false);
 const after=fs.existsSync(activity)?fs.readFileSync(activity):Buffer.alloc(0);
 assert.deepEqual(after,before,"dry_run must not queue activity");
 const saved=await client.callTool({name:"vibe_set_product_intent",
  arguments:{path:project,delivery:"local",tenancy:"single"}});
 assert.notEqual(saved.isError,true);
 assert.deepEqual(JSON.parse(fs.readFileSync(intentFile)).values,{delivery:"local",tenancy:"single"});

 // Task 3: explanation must retain source evidence and actionable advice.
 const validId=page1.findings[0].id;
 const small=unpack(await client.callTool({name:"vibe_explain_finding",
  arguments:{path:source,id:validId}}));
 const raw=unpack(await client.callTool({name:"vibe_explain_finding",
  arguments:{path:source,id:validId,format:"full"}}));
 assert.equal(small.id,validId);
 assert.deepEqual(small.explanation.sourceEvidence,raw.explanation.sourceEvidence);
 assert.deepEqual(small.explanation.signalDefinitions,raw.explanation.signalDefinitions);
 assert.deepEqual(small.standards,raw.standards);
 assert.deepEqual(small.doNow,raw.doNow);
 for(const name of ["vibe_explain_finding","vibe_finding_intelligence"]){
  const answer=await client.callTool({name,arguments:{path:source,id:"VM-ARE-UNKNOWN-ID"}});
  const body=unpack(answer);
  assert.equal(answer.isError,true,name);
  assert.equal(body.code,"finding_not_found");
  assert.equal(body.retryable,false);
  assert.ok(body.next);
 }
 const idle=unpack(await client.callTool({name:"vibe_skip_current",arguments:{}}));
 assert.equal(idle.activeCancelled,0);
 const acct=unpack(await client.callTool({name:"vibe_account_connect",arguments:{}}));
 assert.equal(acct.status,"start_on_website");
});
test("direct intent preview never changes local state or creates missing encryption keys",t=>{
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-are-preview-"));
 t.after(()=>fs.rmSync(home,{recursive:true,force:true}));
 const oldHome=process.env.VIBE_MONITOR_HOME;
 process.env.VIBE_MONITOR_HOME=home;
 t.after(()=>{if(oldHome===undefined)delete process.env.VIBE_MONITOR_HOME;
  else process.env.VIBE_MONITOR_HOME=oldHome});
 const first=previewExplicitIntent("test-preview",{delivery:"local"});
 assert.deepEqual(first.after,{delivery:"local"});
 assert.equal(first.changed,true);
 assert.equal(fs.existsSync(path.join(home,"projects","test-preview","intent.json")),false);
 const dir=path.join(home,"projects","encrypted-preview");
 fs.mkdirSync(dir,{recursive:true});
 const enc=path.join(dir,"intent.enc");
 const original=JSON.stringify({schemaVersion:1,encrypted:true,salt:"test"});
 fs.writeFileSync(enc,original);
 const oldKey=process.env.VIBE_MONITOR_TEST_MASTER_KEY;
 const oldSecretDir=process.env.VIBE_MONITOR_TEST_SECRET_DIR;
 const secretDir=path.join(home,"secrets");
 fs.mkdirSync(secretDir,{recursive:true});
 delete process.env.VIBE_MONITOR_TEST_MASTER_KEY;
 process.env.VIBE_MONITOR_TEST_SECRET_DIR=secretDir;
 t.after(()=>{
   if(oldKey===undefined)delete process.env.VIBE_MONITOR_TEST_MASTER_KEY;
   else process.env.VIBE_MONITOR_TEST_MASTER_KEY=oldKey;
   if(oldSecretDir===undefined)delete process.env.VIBE_MONITOR_TEST_SECRET_DIR;
   else process.env.VIBE_MONITOR_TEST_SECRET_DIR=oldSecretDir;
 });
 const before=fs.readdirSync(secretDir);
 assert.throws(()=>previewExplicitIntent("encrypted-preview",{delivery:"local"}),
   /intent_encryption_key_unavailable/);
 assert.deepEqual(fs.readdirSync(secretDir),before,
  "preview never creates an encryption master key");
 assert.equal(fs.readFileSync(enc,"utf8"),original,"legacy data must remain untouched");
 assert.equal(fs.existsSync(path.join(dir,"intent.json")),false);
});
