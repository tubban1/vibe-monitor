import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {DISTRIBUTION_MODE} from "../src/distribution.js";
import {COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM,COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM,createCommunityPolicyClient} from "../src/community-cloud-policy.js";
import {fetchVerifiedNode,nodeDownloadSources,stableReleaseUsesManagedRuntime} from "../src/install.js";
import {readBoundedUpdateArtifact} from "../src/update.js";
import {buildAgentResult,applyMonitoringPolicy,initializeMcpTelemetry,createMcpProjectContext,isSafeImplicitProjectCwd,isFilesystemRoot,projectPathRequiredPayload} from "../src/mcp.js";
import {detectorRuleId,monitorFamilyForDetector} from "../src/rule-identity.js";
import {POLICY_V2_FAMILIES} from "../src/decision-policy.js";
import {updateStatus,compareVersions,shouldAutoStageUpdate,scheduleAutomaticUpdate,AUTO_UPDATE_RECHECK_MS,FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM} from "../src/update.js";
import {CLIENT_VERSION} from "../src/constants.js";
import {freeTelemetryWireBatch,initializeFreeTelemetry,enqueueActivityTelemetry,enqueueOutcomeTelemetry,telemetryStatus,setTelemetryEnabled,readTelemetryBatch} from "../src/telemetry.js";
import os from "node:os";
import crypto from "node:crypto";
test("Windows native archive fallback accepts missing module only, never safety-denied errors",async()=>{
 const {windowsArchiveCommandUnavailable}=await import("../src/platform.js");
 const absent={stderr:"Expand-Archive: Microsoft.PowerShell.Archive",message:"CouldNotAutoloadMatchingModule"};
 assert.equal(windowsArchiveCommandUnavailable(absent),true);
 assert.equal(windowsArchiveCommandUnavailable({stderr:"Expand-Archive: CommandNotFoundException"}),true);
 assert.equal(windowsArchiveCommandUnavailable({stderr:"Expand-Archive: PSSecurityException UnauthorizedAccess"}),false);
 assert.equal(windowsArchiveCommandUnavailable({stderr:"Expand-Archive: CommandNotFoundException PSSecurityException"}),false);
 assert.equal(windowsArchiveCommandUnavailable({stderr:"Expand-Archive archive corrupt"}),false);
 assert.equal(windowsArchiveCommandUnavailable({stderr:"Expand-Archive: PermissionDenied"}),false);
});
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const staged=DISTRIBUTION_MODE==="open-client";
test("Unified open client has Apache-2.0 license, reproducible deps, and safe release-channel contracts",{
 skip:!staged?"only runs after source-only OSS staging":false
},()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
 const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
 const license=fs.readFileSync(path.join(root,"LICENSE"),"utf8");
 assert.equal(pkg.license,"Apache-2.0");
 assert.equal(typeof pkg.private,"boolean");
 if(pkg.private)assert.match(pkg.version,/-beta\./,"unpublished source preview must be labeled prerelease");
 else assert.match(pkg.version,/^\d+\.\d+\.\d+(?:-rc\.\d+)?$/,"publishable client must have stable or release-candidate semver");
 assert.equal(pkg.name,"@vibe-monitor/setup");
 assert.equal(pkg.version,lock.packages[""].version);
 assert.deepEqual(pkg.dependencies,lock.packages[""].dependencies);
 assert.match(license,/Apache License\s+Version 2\.0, January 2004/);
 assert.match(COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM,/^-----BEGIN PUBLIC KEY-----/);
 assert.equal(crypto.createPublicKey(COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM).asymmetricKeyType,"ed25519");
 assert.equal(COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM,null);

});
test("agent MCP fallback pins exact installed version and official registry",async()=>{
 const {runtimeSpec}=await import("../src/setup.js");
 const {CLIENT_VERSION}=await import("../src/constants.js");
 const fallback=runtimeSpec({});
 assert.equal(fallback.command,"npx");
 assert.deepEqual(fallback.args,["-y","--registry=https://registry.npmjs.org",
   "@vibe-monitor/setup@"+CLIENT_VERSION,"mcp"]);
 assert.deepEqual(runtimeSpec({runtimeCommand:"/trusted/stable/launcher"}),
   {command:"/trusted/stable/launcher",args:["mcp"]});
});
test("single client dependency lock has reviewed SPDX license categories",{
 skip:!staged?"OSS-only dependency contract":false
},()=>{
 const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
 const packages=Object.entries(lock.packages).filter(([n])=>n.startsWith("node_modules/"));
 assert.equal(packages.length,130,"dependency count changed: refresh attribution review");
 for(const [name,pkg] of packages){
  assert.ok(["MIT","ISC","BSD-2-Clause","BSD-3-Clause"].includes(pkg.license),
   "Unreviewed dependency license "+name+" : "+String(pkg.license));
  assert.match(pkg.integrity,/^sha(?:256|384|512)-[A-Za-z0-9+/=]+$/,
   "Missing package content-integrity: "+name);
 }
 const manifest=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
 const direct=Object.keys({...manifest.dependencies,...manifest.devDependencies});
 assert.equal(direct.length,8,"Direct dependency review set changed");
 for(const name of direct){
  const folder=path.join(root,"node_modules",name);
  const metadata=JSON.parse(fs.readFileSync(path.join(folder,"package.json"),"utf8"));
  assert.equal(metadata.version,lock.packages["node_modules/"+name]?.version,
   "Installed dependency not lockfile-pinned: "+name);
  assert.ok(fs.readdirSync(folder).some(f=>/^LICEN[CS]E(?:[._-].*)?$/i.test(f)),
   "Direct dependency license text unavailable: "+name);
 }
 const notice=fs.readFileSync(path.join(root,"NOTICE"),"utf8");
 assert.match(notice,/Transitive npm dependencies/i);
 for(const name of direct){
  const locked=lock.packages["node_modules/"+name];
  assert.ok(notice.includes(`${name} ${locked.version} — ${locked.license}`),
   "NOTICE requires direct dependency version/license attribution: "+name);
 }
});
test("Unified signed cloud strategy stays in memory without telemetry",{
 skip:!staged?"only runs after source-only OSS staging":false
},()=>{
 const policy=fs.readFileSync(path.join(root,"src/community-cloud-policy.js"),"utf8");
 const dist=fs.readFileSync(path.join(root,"src/distribution.js"),"utf8");
 const sanitizer=fs.readFileSync(path.join(root,"src/policy-sanitizer.js"),"utf8");
 assert.match(policy,/from "\.\/policy-sanitizer\.js"/);
 assert.doesNotMatch(policy,/from "\.\/cloud\.js"/,
  "Open client must not import legacy Beta Cloud merely to normalize policy");
 assert.doesNotMatch(sanitizer,/\b(?:node:fs|readFileSync|writeFileSync|vibeHome|fetch)\b/,
  "Pure policy normalization must never read or transmit data");
 assert.match(dist,/DISTRIBUTION_MODE = "open-client"/);
 assert.doesNotMatch(policy,/node:fs|writeFileSync|readFileSync|signed-v1\.json|vibeHome/);
 assert.match(policy,/createCommunityPolicyClient/);
 assert.match(dist,/fetchCommunityCloudPolicy/);
});

test("Free signed Monitor flags control enabled detectors; offline default remains 13 ON",async()=>{
 const {generateKeyPairSync,sign}=await import("node:crypto");
 const {verifyCommunityPolicyEnvelope,COMMUNITY_SAFE_POLICY}=await import("../src/community-cloud-policy.js");
 const pair=generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
 const now=Date.UTC(2026,9,15,0);
 const payload={schemaVersion:1,audience:"vibe-monitor-community",revision:1,
  issuedAt:Math.floor(now/1000),expiresAt:Math.floor(now/1000)+3600,
  config:{enabledMonitors:{"ai-drift":false}}};
 const envelope={payload,keyId:"community-ed25519-v1",signature:sign(null,Buffer.from(JSON.stringify(payload)),pair.privateKey).toString("base64url")};
 const verified=verifyCommunityPolicyEnvelope(envelope,{publicKeyPem:pair.publicKey,now:()=>now});
 assert.equal(verified.config.enabledMonitors["ai-drift"],false);
 assert.equal(verified.config.enabledMonitors["code-structure"],true);
 assert.ok(Object.values(COMMUNITY_SAFE_POLICY.config.enabledMonitors).every(Boolean));
});
test("independent signed stable update manifest accepts only pinned release metadata",async()=>{
 const {verifyFreeUpdateEnvelope,FREE_UPDATE_KEY_ID,FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM}=await import("../src/update.js");
 const keys=crypto.generateKeyPairSync("ed25519",{publicKeyEncoding:{type:"spki",format:"pem"},
  privateKeyEncoding:{type:"pkcs8",format:"pem"}});
 const now=Date.UTC(2026,9,16,12),issuedAt=Math.floor(now/1000);
 const payload={schemaVersion:1,audience:"vibe-monitor-free-update-v1",revision:7,
  issuedAt,expiresAt:issuedAt+3600,version:"1.0.0",rolloutPercent:100,
  rolloutSalt:"stable-20261016",artifact:{
   url:"https://registry.npmjs.org/@vibe-monitor/setup/-/setup-1.0.0.tgz",sha256:"a".repeat(64)}};
 const sign=pl=>({keyId:FREE_UPDATE_KEY_ID,payload:pl,
  signature:crypto.sign(null,Buffer.from(JSON.stringify(pl)),keys.privateKey).toString("base64url")});
 const verify=(e)=>verifyFreeUpdateEnvelope(e,{keys:{[FREE_UPDATE_KEY_ID]:keys.publicKey},now:()=>now});
 assert.match(FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM,/^-----BEGIN PUBLIC KEY-----/);
 assert.equal(verifyFreeUpdateEnvelope(sign(payload),{now:()=>now}),null);
 assert.equal(verify(sign(payload)).version,"1.0.0");
 const forged=sign(payload);forged.payload={...payload,artifact:{...payload.artifact,sha256:"b".repeat(64)}};
 assert.equal(verify(forged),null);
 assert.equal(verify(sign({...payload,artifact:{...payload.artifact,url:"https://other.example/evil.tgz"}})),null);
});
test("offline preload uses a file URL, never a Windows drive path",()=>{
 const smoke=fs.readFileSync(path.join(root,"test/oss-community-public-smoke.test.js"),"utf8");
 assert.match(smoke,/pathToFileURL\(block\)\.href/);
 assert.doesNotMatch(smoke,/\["--import",block,cli/);
});
test("signed strategy response cannot read beyond stream limit",async()=>{
 const client=createCommunityPolicyClient();
 let fullReads=0;
 const out=await client({publicKeyPem:"synthetic-test-public-key",now:()=>Date.UTC(2026,9,14),
  fetchImpl:async()=>({ok:true,headers:{get:()=>null},
   body:{async *[Symbol.asyncIterator](){yield {byteLength:16385};}},
   text:async()=>{fullReads++;throw Error("no unbounded text");}})});
 assert.equal(out.source,"local-baseline");
 assert.equal(fullReads,0);
});
test("signed strategy stream fails closed on excess zero-byte fragments",async()=>{
 const client=createCommunityPolicyClient();
 let chunks=0;
 const result=await client({publicKeyPem:"synthetic-test-public-key",now:()=>Date.UTC(2026,9,15),
  fetchImpl:async()=>({ok:true,headers:{get:()=>null},
   body:{async *[Symbol.asyncIterator](){
    for(let i=0;i<6000;i++){chunks++;yield new Uint8Array(0);}
   }}})});
 assert.equal(result.source,"local-baseline");
 assert.ok(chunks<=4097,"streaming read must stop at the chunk limit");
});
test("update artifact stream accepts normal bytes without relying on Content-Length",async()=>{
 const response=new Response(new Uint8Array([11,22,33]),{headers:{"content-length":"0"}});
 assert.deepEqual([...await readBoundedUpdateArtifact(response)],[11,22,33]);
});
test("update artifact downloader rejects dishonest oversized length and excessive fragments",async()=>{
 let reads=0,cancels=0,unlocks=0;
 const makeResponse=(contentLength)=>({
  headers:{get:()=>contentLength},
  body:{getReader:()=>({
   async read(){reads++;return {done:false,value:new Uint8Array(0)};},
   async cancel(){cancels++;},
   releaseLock(){unlocks++;}
  })}
 });
 await assert.rejects(readBoundedUpdateArtifact(makeResponse(String(25*1024*1024+1))),/update_artifact_too_large/);
 assert.equal(reads,0);
 await assert.rejects(readBoundedUpdateArtifact(makeResponse(null)),/update_download_failed:too_many_chunks/);
 assert.equal(reads,4097);
 assert.equal(cancels,2);
 assert.equal(unlocks,2);
});
test("Incomplete architecture coverage is disclosed once, never reported healthy",()=>{
 const input={schemaVersion:1,project:{id:"synthetic"},capturedAt:null,
  durationMs:0,status:{assessmentAvailable:false,highestStage:"unknown",findingCount:null},
  findings:[],transitions:[],monitoring:{mode:"deferred",assessmentAvailable:false,
    evidenceIncomplete:true,deferReason:"evidence_budget_exceeded",budgetPhase:"source_files"}};
 const first=buildAgentResult(input,{sessionStart:true});
 assert.equal(first.userNoticeRequired,true);
 assert.equal(first.status.highestStage,"unknown");
 assert.equal(first.assessmentNotice.code,"architecture_assessment_incomplete");
 assert.equal(first.assessmentNotice.reason,"source_files");
 assert.equal(first.attentionFindings.length,0);
 assert.ok(first.userFacing.includes("架构检查"));
 const checkpoint=buildAgentResult(input,{sessionStart:false});
 assert.equal(checkpoint.userNoticeRequired,false);
 assert.equal(checkpoint.assessmentNotice.code,"architecture_assessment_incomplete");
});
test("Node source is pinned to the official artifact URL",()=>{
 const spec={filename:"node-v22.23.3-win-x64.zip",archiveUrl:"https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip"};
 assert.equal(nodeDownloadSources(spec).length,2);
 assert.throws(()=>nodeDownloadSources({...spec,archiveUrl:"https://example.invalid/archive"}),/runtime_archive_source_untrusted/);
});

test("Node archive response rejects excessive Content-Length before reading",async()=>{
 const spec={filename:"node-v22.23.3-win-x64.zip",archiveUrl:"https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip"};
 const original=globalThis.fetch;
 let calls=0,read=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,headers:{get:()=>String(161*1024*1024)},arrayBuffer:async()=>{read++;return new ArrayBuffer(0)}};};
 try{await assert.rejects(fetchVerifiedNode(spec),/runtime_download_failed/);assert.equal(calls,2);assert.equal(read,0);}
 finally{globalThis.fetch=original;}
});

test("Node archive streaming bytes are bounded even without Content-Length",async()=>{
 const spec={filename:"node-v22.23.3-win-x64.zip",archiveUrl:"https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip"};
 const original=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,headers:{get:()=>null},body:{async *[Symbol.asyncIterator](){yield {byteLength:161*1024*1024};}}};};
 try{await assert.rejects(fetchVerifiedNode(spec),/runtime_download_failed/);assert.equal(calls,2);}
 finally{globalThis.fetch=original;}
});

test("Free V4 wire never forwards raw project, prompt, token or nested intelligence",{skip:!staged?"OSS-only client test":false},()=>{
 const event={schemaVersion:4,eventId:crypto.randomUUID(),
  installationId:crypto.randomUUID(),event:"scan.observed",at:new Date().toISOString(),
  projectId:"b".repeat(32),agent:"codex",stage:"S4",
  payload:{sourceFilesBucket:"21-50",totalLocBucket:"501-1000",
   prompt:"raw user message",token:"placeholder",architectureProfile:{raw:"private"},
   source:"const secret=1",path:"/Users/private/source"}};
 const rows=freeTelemetryWireBatch([event]);
 assert.equal(rows.length,1);
 assert.deepEqual(rows[0].payload,{sourceFilesBucket:"21-50",totalLocBucket:"501-1000"});
 assert.doesNotMatch(JSON.stringify(rows),/raw user message|placeholder|const secret|private\/source|architectureProfile/);
});
test("Free scan-derived product/stack/architecture profile is useful and remains categorical",{skip:!staged?"OSS-only profile":false},()=>{
 const profile={version:1,provenance:"scan_inferred",
  product:{type:"saas_candidate",confidence:"medium",projectName:"do-not-upload"},
  stack:{technologyGroups:["http","orm"],deploymentClasses:["web_hosting"],
   integrationDomains:["ai","payments"],customerId:"private"},
  architecture:{workspace:"multi_package_signal",apiEndpoints:"3-5",
   tenantConcepts:"1-2",backgroundJobs:"none",statePersistence:"1-2",asyncPaths:"3-5"},
  engineering:{duplicationGroups:"1-2",testsPresent:true,testLoc:"11-50",assertionSignals:"3-5"},
  rawPath:"/private/customer-repo",source:"do_not_upload"};
 const e={schemaVersion:4,eventId:crypto.randomUUID(),installationId:crypto.randomUUID(),
  event:"scan.observed",at:new Date().toISOString(),projectId:"a".repeat(32),
  agent:"codex",stage:"S4",payload:{architectureProfile:profile,sourceFilesBucket:"21-50",
   graph:{edgeCountBucket:"51-100",cycleCountBucket:"lt1",maxFanInBucket:"11-20",
    maxFanOutBucket:"3-5",rawGraph:"private"}}};
 const [wire]=freeTelemetryWireBatch([e]);
 assert.equal(wire.payload.architectureProfile.product.type,"saas_candidate");
 assert.deepEqual(wire.payload.architectureProfile.stack.technologyGroups,["http","orm"]);
 assert.deepEqual(wire.payload.architectureProfile.stack.integrationDomains,["ai","payments"]);
 assert.equal(wire.payload.architectureProfile.engineering.testsPresent,true);
 assert.equal(wire.payload.graph.edgeCountBucket,"51-100");
 assert.ok(Buffer.byteLength(JSON.stringify(wire))<=4096);
 assert.doesNotMatch(JSON.stringify(wire),/do-not-upload|private\/customer|do_not_upload|customerId|rawGraph|rawPath/);
 const bad=structuredClone(e);bad.payload.architectureProfile.product.type="customer_secret_name";
 const [clean]=freeTelemetryWireBatch([bad]);
 assert.equal(clean.payload.architectureProfile,undefined);
});
test("Free commercial signal retains HMAC join keys but strips notes, paths and source",{skip:!staged?"OSS-only linked wire":false},()=>{
 const sessionId=crypto.randomUUID(),callId=crypto.randomUUID(),scanId=crypto.randomUUID();
 const input={schemaVersion:4,eventId:crypto.randomUUID(),installationId:crypto.randomUUID(),
  event:"outcome.action",at:new Date().toISOString(),projectId:"a".repeat(32),
  findingId:"b".repeat(32),family:"code-structure",sessionId,callId,scanId,
  evidenceVersion:7,policyRevision:2,agent:"codex",stage:"S4",
  payload:{outcomeRef:"c".repeat(32),disposition:"applied",actor:"user",
   outcomeStatus:"waiting_followup",note:"private note",rawSource:"const PASSWORD=secret",
   changeRef:"abcdef012345"}};
 const [projected]=freeTelemetryWireBatch([input]);
 assert.equal(projected.findingId,"b".repeat(32));
 assert.equal(projected.family,"code-structure");
 assert.equal(projected.sessionId,sessionId);
 assert.equal(projected.callId,callId);
 assert.equal(projected.scanId,scanId);
 assert.equal(projected.evidenceVersion,7);
 assert.equal(projected.policyRevision,2);
 assert.equal(projected.payload.outcomeRef,"c".repeat(32));
 assert.equal(projected.payload.actor,"user");
 assert.equal(projected.payload.disposition,"applied");
 assert.doesNotMatch(JSON.stringify(projected),/private note|PASSWORD|abcdef012345|rawSource|changeRef/);
});
test("Free explicit outcome action and verification queue stable anonymous links with no additional scan",{skip:!staged?"OSS-only HMAC outcome":false},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-free-outcome-"));
 const keys=["VIBE_MONITOR_HOME","VIBE_MONITOR_TEST_SECRET_DIR"],prior=keys.map(k=>process.env[k]);
 process.env.VIBE_MONITOR_HOME=root;
 process.env.VIBE_MONITOR_TEST_SECRET_DIR=path.join(root,"secrets");
 t.after(()=>{keys.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});
   fs.rmSync(root,{recursive:true,force:true});});
 assert.equal(initializeFreeTelemetry().enabled,true);
 assert.equal(setTelemetryEnabled(true).enabled,true);
 const record={outcomeId:crypto.randomUUID(),findingId:"VM-SECRET123",family:"code-structure",
  baseline:{stage:"S4",evidenceVersion:7},action:{disposition:"applied",actor:"user",changeRef:"private-sha"},
  verification:{verdict:"confirmed",evidenceType:"independent_review",actor:"user"},
  status:"user_confirmed_with_observed_improvement"};
 const input={projectId:"private/project",record,agent:"codex",sessionId:crypto.randomUUID(),policyRevision:2};
 assert.equal(enqueueOutcomeTelemetry({...input,kind:"action"}),true);
 assert.equal(enqueueOutcomeTelemetry({...input,kind:"action"}),true);
 assert.equal(enqueueOutcomeTelemetry({...input,kind:"verification"}),true);
 assert.equal(enqueueOutcomeTelemetry({...input,kind:"verification"}),true);
 const projected=freeTelemetryWireBatch(readTelemetryBatch({limit:12}));
 assert.equal(projected.length,4);
 assert.deepEqual(projected.map(e=>e.event),["outcome.action","outcome.action","outcome.verification","outcome.verification"]);
 assert.equal(projected[0].eventId,projected[1].eventId);
 assert.equal(projected[2].eventId,projected[3].eventId);
 assert.notEqual(projected[0].eventId,record.outcomeId);
 assert.notEqual(projected[0].eventId,projected[2].eventId);
 assert.equal(projected[0].findingId,projected[2].findingId);
 assert.equal(projected[0].payload.outcomeRef,projected[2].payload.outcomeRef);
 assert.equal(projected[2].payload.verificationVerdict,"confirmed");
 const sent=JSON.stringify(projected);
 assert.doesNotMatch(sent,/private\/project|VM-SECRET123|private-sha|source|rawSource|notes/);
 assert.equal(setTelemetryEnabled(false).enabled,false);
 assert.equal(readTelemetryBatch({limit:12}).length,0);
 assert.equal(enqueueOutcomeTelemetry({...input,kind:"action"}),false);
});
test("Free tiny offline queue expires at seven days and opt-out blocks later events",{
 skip:!staged?"OSS-only queue expiry contract":false
},t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-free-expiry-"));
 const previous=process.env.VIBE_MONITOR_HOME;
 process.env.VIBE_MONITOR_HOME=root;
 t.after(()=>{
  if(previous===undefined)delete process.env.VIBE_MONITOR_HOME;
  else process.env.VIBE_MONITOR_HOME=previous;
  fs.rmSync(root,{recursive:true,force:true});
 });
 const legacy=path.join(root,"telemetry");
 fs.mkdirSync(legacy,{recursive:true});
 const state='{"enabled":true,"consentVersion":"private-beta-v4"}';
 fs.writeFileSync(path.join(legacy,"config.json"),state);
 assert.equal(initializeFreeTelemetry().enabled,true);
 assert.equal(setTelemetryEnabled(true).enabled,true);
 const file=path.join(root,"free-telemetry","queue.jsonl");
 const stale={eventId:crypto.randomUUID(),at:new Date(Date.now()-9*86400_000).toISOString(),event:"checkpoint"};
 const fresh={eventId:crypto.randomUUID(),at:new Date().toISOString(),event:"checkpoint"};
 fs.writeFileSync(file,JSON.stringify(stale)+"\n"+JSON.stringify(fresh)+"\n");
 assert.ok(fs.statSync(file).size<256*1024);
 assert.deepEqual(readTelemetryBatch({limit:10}).map(e=>e.eventId),[fresh.eventId]);
 assert.doesNotMatch(fs.readFileSync(file,"utf8"),new RegExp(stale.eventId));
 const segment=path.join(root,"free-telemetry","queue-segment-1730000000000-abcdef123456.jsonl");
 fs.writeFileSync(segment,JSON.stringify({eventId:crypto.randomUUID(),event:"checkpoint"})+"\n");
 assert.equal(setTelemetryEnabled(false).enabled,false);
 assert.equal(fs.existsSync(file),false);
 assert.equal(fs.existsSync(segment),false,"opt-out erases all pending Free queue segments");
 enqueueActivityTelemetry({event:"checkpoint",sessionId:crypto.randomUUID(),agent:"codex"});
 assert.equal(fs.existsSync(file),false);
 assert.equal(fs.readFileSync(path.join(legacy,"config.json"),"utf8"),state);
});

test("Free explicit-consent queue is separate from old Beta, bounded and opt-out purges",{skip:!staged?"OSS-only client test":false},t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-free-telemetry-v4-"));
 const vars=["VIBE_MONITOR_HOME","VIBE_MONITOR_TEST_SECRET_DIR"];
 const prior=vars.map(k=>process.env[k]);
 process.env.VIBE_MONITOR_HOME=tmp;
 process.env.VIBE_MONITOR_TEST_SECRET_DIR=path.join(tmp,"secrets");
 t.after(()=>{
  vars.forEach((k,i)=>{if(prior[i]===undefined)delete process.env[k];else process.env[k]=prior[i];});
  fs.rmSync(tmp,{force:true,recursive:true});
 });
 const betaDir=path.join(tmp,"telemetry");
 fs.mkdirSync(betaDir,{recursive:true});
 const old=JSON.stringify({enabled:true,consentVersion:"private-beta-v4"});
 fs.writeFileSync(path.join(betaDir,"config.json"),old);
 assert.equal(initializeFreeTelemetry().enabled,true);
 assert.equal(setTelemetryEnabled(true).enabled,true);
 assert.equal(telemetryStatus().consentVersion,"telemetry-v1");
 for(let i=0;i<1500;i++)
  enqueueActivityTelemetry({event:"checkpoint",projectId:"test-project",agent:"codex",
   sessionId:crypto.randomUUID(),durationMs:i});
 const freePath=path.join(tmp,"free-telemetry","queue.jsonl");
 assert.ok(fs.existsSync(freePath));
 assert.ok(fs.statSync(freePath).size<=256*1024);
 assert.equal(fs.readFileSync(path.join(betaDir,"config.json"),"utf8"),old);
 assert.equal(setTelemetryEnabled(false).enabled,false);
 assert.equal(fs.existsSync(freePath),false);
 assert.equal(initializeFreeTelemetry().enabled,false,"explicit Free opt-out survives restart");
 assert.equal(fs.readFileSync(path.join(betaDir,"config.json"),"utf8"),old);
});

test("Future open client preserves Beta telemetry intelligence as bounded data",{
 skip:!staged?"OSS-only wire":false
},()=>{
 const item={schemaVersion:4,eventId:crypto.randomUUID(),installationId:crypto.randomUUID(),
  event:"scan.observed",at:new Date().toISOString(),projectId:"a".repeat(32),
  repoId:"b".repeat(32),projectInstanceId:"c".repeat(32),findingId:"d".repeat(32),
  family:"code-structure",agent:"codex",stage:"S4",fromStage:"S5",toStage:"S4",
  attentionRequired:true,findingCount:11,attentionCount:4,durationMs:140,
  monitoringMode:"full",monitoringWallTimeMs:142,scannerOverheadPct:0.3,
  policyRevision:2,actionMode:"next-change-watch",
  payload:{sourceFilesBucket:"21-50",phaseTimings:{engineMs:77,identityMs:5},
   intent:{delivery:"hosted",audience:"public"},
   inferredIntent:{delivery:"hybrid"},
   intentProvenance:{delivery:"explicit",audience:"inferred"},
   structural:{mode:"full",candidateFiles:30,analyzedFiles:28,languages:["javascript"]},
   signals:[{name:"dependency_cycle",bucket:"1-2",independenceGroup:"imports"}],
   supportingSignalCount:1,semanticReviewRecommended:false,
   source:"const secret='no'",prompt:"private",path:"/Users/private/project"}};
 const [wire]=freeTelemetryWireBatch([item]);
 assert.equal(wire.stage,"S4");assert.equal(wire.fromStage,"S5");
 assert.equal(wire.toStage,"S4");assert.equal(wire.attentionRequired,true);
 assert.equal(wire.findingCount,11);assert.equal(wire.attentionCount,4);
 assert.equal(wire.monitoringWallTimeMs,142);assert.equal(wire.scannerOverheadPct,0.3);
 assert.equal(wire.repoId,"b".repeat(32));assert.equal(wire.projectInstanceId,"c".repeat(32));
 assert.equal(wire.payload.phaseTimings.identityMs,5);
 assert.equal(wire.payload.intentProvenance.audience,"inferred");
 assert.equal(wire.payload.structural.analyzedFiles,28);
 assert.equal(wire.payload.signals[0].name,"dependency_cycle");
 assert.ok(Buffer.byteLength(JSON.stringify(wire))<=4096);
 assert.doesNotMatch(JSON.stringify(wire),/secret|private|\/Users\//);
});

test("MCP binds a project only after successful assessment; other servers stay isolated",()=>{
 const a="/qa/repo-A",b="/qa/repo-B";
 const context=createMcpProjectContext(()=>"/qa/host-cwd");
 const unavailable=context.resolve();
 assert.equal(unavailable.path,"/qa/host-cwd");
 context.confirm(unavailable,{status:{assessmentAvailable:false},project:{root:"/qa/host-cwd"}});
 assert.equal(context.resolve().path,"/qa/host-cwd");
 const start=context.resolve(a);
 context.confirm(start,{status:{assessmentAvailable:true},project:{root:a}});
 assert.equal(context.resolve().path,a);
 const invalid=context.resolve("/qa/not-a-repo");
 context.confirm(invalid,{status:{assessmentAvailable:false},project:{root:"/qa/not-a-repo"}});
 assert.equal(context.resolve().path,a);
 const change=context.resolve(b);
 context.confirm(change,{status:{assessmentAvailable:true},project:{root:b}});
 assert.equal(context.resolve().path,b);
 assert.equal(context.resolve(a).path,a,"explicit path overrides session default");
 const other=createMcpProjectContext(()=>"/qa/other-host");
 assert.equal(other.resolve().path,"/qa/other-host");
});
test("MCP concurrent explicit project selection ignores late older results",()=>{
 const context=createMcpProjectContext(()=>"/qa/host");
 const first=context.resolve("/qa/older"),second=context.resolve("/qa/newer");
 context.confirm(second,{status:{assessmentAvailable:true},project:{root:"/qa/newer"}});
 context.confirm(first,{status:{assessmentAvailable:true},project:{root:"/qa/older"}});
 assert.equal(context.resolve().path,"/qa/newer");
});

test("Implicit MCP workspace rejects IDE install directory, filesystem root and unknown cwd",()=>{
 assert.equal(isFilesystemRoot("/"),true);
 assert.equal(isSafeImplicitProjectCwd("/"),false);
 assert.equal(isSafeImplicitProjectCwd("C:\\\\"),false);
 assert.equal(isSafeImplicitProjectCwd("C:\\\\Users\\\\i95i\\\\AppData\\\\Local\\\\Programs\\\\antigravity"),false);
 assert.equal(isSafeImplicitProjectCwd("C:\\\\Program Files\\\\Antigravity"),false);
 assert.equal(isSafeImplicitProjectCwd("/a/nonexistent/project"),false);
 const rootCtx=createMcpProjectContext(()=>"/");
 const rootSel=rootCtx.resolve();
 assert.equal(isFilesystemRoot(rootSel.path),true);
 assert.equal(isSafeImplicitProjectCwd(rootSel.path),false);
 const repo=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-implicit-git-"));
 try {
  fs.mkdirSync(path.join(repo,".git"));
  assert.equal(isSafeImplicitProjectCwd(repo),true);
  const selected=createMcpProjectContext(()=>repo);
  assert.equal(selected.resolve().fallbackToHostCwd,true);
  const explicit=selected.resolve(repo);
  assert.equal(explicit.fallbackToHostCwd,false);
  selected.confirm(explicit,{status:{assessmentAvailable:true},project:{root:repo}});
  assert.equal(selected.resolve().fallbackToHostCwd,false);
 } finally {fs.rmSync(repo,{recursive:true,force:true});}
 const denied=projectPathRequiredPayload();
 assert.equal(denied.status.assessmentAvailable,false);
 assert.equal(denied.monitoring.reason,"project_path_required");
 assert.notEqual(denied.status.findingCount,0);
});

test("Open client ignores orphaned private Beta runtime pointer without hiding live pointer",async()=>{
 const prev=process.env.VIBE_MONITOR_HOME;
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-orphan-pointer-"));
 try {
  process.env.VIBE_MONITOR_HOME=home;
  const runtime=path.join(home,"runtime");
  fs.mkdirSync(runtime,{recursive:true});
  const pointer={schemaVersion:1,type:"version",version:"0.3.0-beta.26"};
  fs.writeFileSync(path.join(runtime,"current.json"),JSON.stringify(pointer));
  let status=await updateStatus({refresh:false});
  assert.equal(status.currentVersion,CLIENT_VERSION,"stale Beta registration must not be reported as installed RC");
  const bundle=path.join(runtime,"versions","0.3.0-beta.26","node_modules","@vibe-monitor","setup","dist","vibe-monitor.mjs");
  fs.mkdirSync(path.dirname(bundle),{recursive:true});
  fs.writeFileSync(bundle,"// test-only existing runtime");
  status=await updateStatus({refresh:false});
  assert.equal(status.currentVersion,"0.3.0-beta.26","existing managed runtime should still surface version mismatch");
 } finally {
  if(prev===undefined)delete process.env.VIBE_MONITOR_HOME;
  else process.env.VIBE_MONITOR_HOME=prev;
  fs.rmSync(home,{recursive:true,force:true});
 }
});

test("Stable local ruleId is distinct from Cloud policy and data-contract respects api-contract mask",()=>{
 for(const family of POLICY_V2_FAMILIES) assert.match(detectorRuleId(family), /^vm[.][a-z0-9.-]+[.]v1$/);
 assert.equal(detectorRuleId("data-contract"),"vm.api-contract.encoded-id-contract.v1");
 assert.equal(monitorFamilyForDetector("data-contract"),"api-contract");
 assert.equal(detectorRuleId("future-unregistered"),null);
 const raw={
   project:{root:"/synthetic-playground"},
   status:{assessmentAvailable:true},
   findings:[
    {id:"VM-A",family:"code-structure",stage:"S3",score:52,requiresAttention:true,signals:[]},
    {id:"VM-B",family:"data-contract",stage:"S2",score:40,requiresAttention:false,signals:[]}
   ],transitions:[],monitoring:{mode:"full"}
 };
 const enabled=applyMonitoringPolicy(raw,{enabledMonitors:{"api-contract":true}});
 assert.equal(enabled.findings.length,2);
 assert.equal(enabled.findings[0].ruleId,detectorRuleId("code-structure"));
 assert.equal(enabled.findings[1].ruleId,"vm.api-contract.encoded-id-contract.v1");
 assert.equal(enabled.status.findingCount,2);
 const payload=buildAgentResult(enabled,{sessionStart:true});
 assert.equal(payload.attentionFindings[0].ruleId,detectorRuleId("code-structure"));
 const disabled=applyMonitoringPolicy(raw,{enabledMonitors:{"api-contract":false}});
 assert.equal(disabled.findings.length,1,"Cloud api-contract monitor must mask specialized encoded ID detector");
 assert.equal(disabled.status.findingCount,1);
 assert.equal(raw.findings[0].ruleId,undefined,"raw finding must not be mutated by presentation mapping");
});

test("Direct MCP boot defaults telemetry ON and preserves opt-out",()=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-mcp-telemetry-boot-"));
 const vars=["VIBE_MONITOR_HOME","VIBE_MONITOR_TEST_SECRET_DIR"];
 const prev=vars.map(x=>process.env[x]);
 try{
  process.env.VIBE_MONITOR_HOME=tmp;
  process.env.VIBE_MONITOR_TEST_SECRET_DIR=path.join(tmp,"secrets");
  assert.equal(fs.existsSync(path.join(tmp,"free-telemetry","config.json")),false);
  const first=initializeMcpTelemetry();
  assert.equal(first.enabled,true,"first MCP boot enables default service telemetry");
  assert.equal(fs.existsSync(path.join(tmp,"free-telemetry","config.json")),true);
  assert.equal(initializeMcpTelemetry().enabled,true);
  assert.equal(setTelemetryEnabled(true).enabled,true);
  assert.equal(initializeMcpTelemetry().enabled,true,"explicit consent must survive restart");
  assert.equal(setTelemetryEnabled(false).enabled,false);
  assert.equal(initializeMcpTelemetry().enabled,false,"an explicit prior opt-out must remain off");
 }finally{
  vars.forEach((k,i)=>{if(prev[i]===undefined)delete process.env[k];else process.env[k]=prev[i];});
  fs.rmSync(tmp,{recursive:true,force:true});
 }
});

test("Signed automatic upgrade handles pre-1.0 Beta to 1.0.0 and future stable semver ordering",()=>{
 assert.equal(AUTO_UPDATE_RECHECK_MS,3600000,"long-lived MCP must have a bounded, nonblocking update recheck");
 assert.equal(compareVersions("0.3.0-beta.41","1.0.0"),-1);
 assert.equal(compareVersions("0.9.9","1.0.0"),-1);
 assert.equal(compareVersions("1.0.0","1.0.1"),-1);
 assert.equal(compareVersions("1.0.1-rc.0","1.0.1"),-1);
 assert.equal(compareVersions("1.0.1-rc.0","1.0.0"),1,
  "RC 1.0.1-rc.0 is GREATER than 1.0.0; a downgrade must not be called OTA");
 assert.equal(compareVersions("1.1.0","1.0.0"),1);
 const manifest={source:"signed-free-update",updateEnabled:true,eligible:true,
    available:true,artifactReady:true,latestVersion:"1.0.1",autoStage:false};
 assert.equal(shouldAutoStageUpdate(manifest,{}, {signedPublic:true}),true);
 assert.equal(shouldAutoStageUpdate({...manifest,eligible:false},{},{signedPublic:true}),false);
 assert.equal(shouldAutoStageUpdate({...manifest,source:"open-client"},{},{signedPublic:true}),false);
 assert.equal(shouldAutoStageUpdate({...manifest,available:false},{},{signedPublic:true}),false);
 assert.equal(shouldAutoStageUpdate({...manifest,artifactReady:false},{},{signedPublic:true}),false);
 assert.equal(shouldAutoStageUpdate(manifest,{quarantinedVersions:["1.0.1"]},{signedPublic:true}),false);
 assert.equal(shouldAutoStageUpdate(manifest,{lastFailureReason:"update_download_failed",
    lastFailureAt:new Date().toISOString()},{signedPublic:true}),false);
 // Pinned key alone cannot authorize a remote update without a signed manifest.
 if (FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM===null)assert.equal(scheduleAutomaticUpdate(),false);
});
test("Stable publication is blocked when a signed public updater cannot operate",()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
 const stableFormat=/^[0-9]+[.][0-9]+[.][0-9]+$/;
 assert.equal(stableFormat.test("1.0.0"),true);
 assert.equal(stableFormat.test("1.0.1"),true);
 assert.equal(stableFormat.test("1.0.1-rc.0"),false);
 assert.equal(stableFormat.test("1.0.0-rc.0"),false);
 if (stableFormat.test(pkg.version)) {
   assert.match(FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM,/^-----BEGIN PUBLIC KEY-----/,
    "Do not publish stable 1.0.0 without a pinned update signer");
 }
});

test("Stable official releases use managed immutable slots, never the npx ephemeral entry",()=>{
 assert.equal(stableReleaseUsesManagedRuntime("0.3.0-beta.41"),false);
 assert.equal(stableReleaseUsesManagedRuntime("1.0.1-rc.0"),false);
 assert.equal(stableReleaseUsesManagedRuntime("1.0.0"),true);
 assert.equal(stableReleaseUsesManagedRuntime("1.0.1"),true);
 assert.equal(stableReleaseUsesManagedRuntime("2.0.0"),true);
 assert.equal(stableReleaseUsesManagedRuntime("1.0.1-beta.0"),false);
});

test("Production OTA trust root is pinned independently of Cloud architecture policy",()=>{
 const pem=FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM;
 assert.match(pem,/^-----BEGIN PUBLIC KEY-----/);
 const key=crypto.createPublicKey(pem);
 assert.equal(key.asymmetricKeyType,"ed25519");
 assert.equal(crypto.createHash("sha256").update(
  key.export({format:"der",type:"spki"})).digest("hex"),
  "955e683e0326b93df68a0356d8e8bbace67eb588251f81af63c28b1d9f0ab5a2");
 assert.notEqual(pem,COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM);
});
