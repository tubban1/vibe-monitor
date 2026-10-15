import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {DISTRIBUTION_MODE} from "../src/distribution.js";
import {COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM,COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM,createCommunityPolicyClient} from "../src/community-cloud-policy.js";
import {fetchVerifiedNode,nodeDownloadSources} from "../src/install.js";
import {readBoundedUpdateArtifact} from "../src/update.js";
import {freeTelemetryWireBatch,initializeFreeTelemetry,enqueueActivityTelemetry,telemetryStatus,setTelemetryEnabled} from "../src/telemetry.js";
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
test("Unified open client has Apache-2.0 license, reproducible deps, and no publish rights",{
 skip:!staged?"only runs after source-only OSS staging":false
},()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
 const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
 const license=fs.readFileSync(path.join(root,"LICENSE"),"utf8");
 assert.equal(pkg.license,"Apache-2.0");
 assert.equal(pkg.private,true);
 assert.equal(pkg.name,"@vibe-monitor/setup");
 assert.equal(pkg.version,lock.packages[""].version);
 assert.deepEqual(pkg.dependencies,lock.packages[""].dependencies);
 assert.match(license,/Apache License\s+Version 2\.0, January 2004/);
 assert.equal(COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM,null,
  "stage must remain unreleasable until real signed QA policy has been verified");
 assert.equal(COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM,null,
  "new signing verification root must not ship before Cloud security sign-off");
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

test("Free V4 wire never forwards raw project, prompt, token or nested intelligence",()=>{
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
test("Free on-by-default queue is separate from old Beta, bounded and opt-out purges",t=>{
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
 assert.equal(telemetryStatus().consentVersion,"free-v1");
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
