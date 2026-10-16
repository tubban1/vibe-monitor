import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath,pathToFileURL} from "node:url";
import {DISTRIBUTION_MODE} from "../src/distribution.js";
import {InstallTracker,createInstallTracker,retryPendingInstallAttempts} from "../src/install-tracking.js";
import {acceptAccountPairing} from "../src/pairing.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
test("unified open client performs offline scan, install and uninstall with no upload",{
 skip:DISTRIBUTION_MODE!=="open-client"?"private Beta remains separately tested":false
},t=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-community-public-"));
 t.after(()=>fs.rmSync(temp,{recursive:true,force:true}));
 const home=path.join(temp,"user"),app=path.join(temp,"app"),project=path.join(temp,"project");
 fs.mkdirSync(path.join(project,"src"),{recursive:true});
 fs.mkdirSync(home,{recursive:true});
 fs.writeFileSync(path.join(project,"package.json"),JSON.stringify({name:"oss-test",type:"module"}));
 fs.writeFileSync(path.join(project,"src","index.js"),
  Array.from({length:75},(_,i)=>"export function helper"+i+"(x){return x+"+i+";}").join("\n"));
 const block=path.join(temp,"block-fetch.mjs");
 const blockUrl=pathToFileURL(block).href;
 fs.writeFileSync(block,'globalThis.fetch=async()=>{throw Error("UNEXPECTED_CLOUD");};\n');
 const env={...process.env,HOME:home,USERPROFILE:home,
  VIBE_MONITOR_HOME:app,VIBE_MONITOR_SETUP_HOME:home,
  VIBE_CLOUD_URL:"http://127.0.0.1:1",
  VIBE_MONITOR_TEST_SECRET_DIR:path.join(temp,"secrets"),
  VIBE_MONITOR_TEST_MASTER_KEY:"f".repeat(64)};
 const cli=path.join(root,"src","cli.js");
 const run=(...args)=>spawnSync(process.execPath,["--import",blockUrl,cli,...args],
  {cwd:temp,env,encoding:"utf8",timeout:30000,maxBuffer:3e6});
 const help=run("--help");
 assert.equal(help.status,0,help.stderr?.slice(0,600));
 assert.match(help.stdout,/vibe-monitor cloud status\|config/);
 assert.match(help.stdout,/signed Cloud policy stays in process memory only/);
 assert.doesNotMatch(help.stdout,/vibe-monitor cloud register|vibe-monitor cloud status\|config\|sync|vibe-monitor telemetry intelligence|vibe-monitor update status\|check\|stage/,
  "The one open client must not advertise unavailable legacy Beta upload or unsigned updater commands");
 const blockedBeforeInstall=run("scan",project,"--json");
 assert.equal(blockedBeforeInstall.status,2,"Free analysis must not run before required telemetry is active");
 assert.equal(JSON.parse(blockedBeforeInstall.stdout).monitoring.reason,"telemetry_required");
 assert.equal(run("telemetry","on","--json").status,0);
 const scan=run("scan",project,"--json");
 assert.equal(scan.status,0,scan.stderr?.slice(0,600));
 const scanned=JSON.parse(scan.stdout);
 assert.equal(Array.isArray(scanned.findings),true);
 const brief=run("brief",project,"--json");
 assert.equal(brief.status,0,brief.stderr?.slice(0,600));
 const questions=JSON.parse(brief.stdout);
 assert.deepEqual(Object.keys(questions.questions),["health","trajectory","nextAction","economics","readiness"]);
 assert.equal(questions.questions.economics.status,"not-assessed");
 assert.equal(questions.questions.readiness.certification,false);
 assert.equal(questions.standardsBasis.complianceAssessed,false);
 assert.deepEqual(questions.presentationBudget,{maxPriorities:2,extraScans:0,modelCalls:0});
 const install=run("install","--codex","--json");
 assert.equal(install.status,0,install.stderr?.slice(0,600));
 const result=JSON.parse(install.stdout);
 assert.equal(result.distribution,"open-client");
 assert.equal(result.activation.registered,false);
 assert.equal(result.telemetry.enabled,true);
 assert.equal(result.telemetry.consentVersion,"free-v1");
 assert.equal(result.telemetry.cloudTransportConfigured,false);
 assert.deepEqual(result.lifecycle,{storage:"local-only",uploaded:false,
  stages:["started","runtime_installed","mcp_configured","completed"],errorCode:null});
 const lifecycleDir=path.join(app,"install-lifecycle");
 const attempts=fs.readdirSync(lifecycleDir);
 assert.equal(attempts.length,1);
 const lifecycleRecord=JSON.parse(fs.readFileSync(path.join(lifecycleDir,attempts[0]),"utf8"));
 assert.deepEqual(lifecycleRecord.events.map(e=>e.stage),result.lifecycle.stages);
 assert.deepEqual(Object.keys(lifecycleRecord).sort(),
  ["schemaVersion","attemptId","clientVersion","platform","arch","events"].sort());
 if(process.platform!=="win32")
  assert.equal(fs.statSync(path.join(lifecycleDir,attempts[0])).mode&0o777,0o600);
 assert.doesNotMatch(JSON.stringify(lifecycleRecord),/Bearer|token|inviteCode|sourceCode|filePath|projectPath/i);
 const config=path.join(home,".codex","config.toml");
 assert.match(fs.readFileSync(config,"utf8"),/mcp_servers\.vibe-monitor/);
 assert.equal(fs.existsSync(path.join(app,"cloud","client.json")),false);
 assert.equal(fs.existsSync(path.join(app,"installation-attempts")),false,
  "Unified client must not persist Beta install tracking events");
 assert.equal(fs.existsSync(path.join(app,"telemetry","queue.jsonl")),false);
 const refused=run("setup","--codex","--no-telemetry","--json");
 assert.equal(refused.status,2,"Free setup cannot bypass the telemetry-service contract");
 const refusedInstall=run("install","--codex","--no-telemetry","--json");
 assert.equal(refusedInstall.status,2,"Free install cannot bypass the contract");
 const setup=run("setup","--codex","--json");
 assert.equal(setup.status,0,setup.stderr?.slice(0,600));
 const configured=JSON.parse(setup.stdout);
 assert.equal(configured.telemetry.enabled,true);
 assert.equal(configured.telemetry.telemetryRequiredForFree,true);
 assert.equal(configured.telemetry.analysisStopsWhenDisabled,true);
 assert.equal(configured.telemetry.requiredDuringPrivateBeta,false);
 const optIn=run("telemetry","on");
 assert.equal(optIn.status,0,"Free telemetry activation is separate from legacy Beta upload");
 assert.equal(JSON.parse(optIn.stdout).enabled,true);
 const intelligence=run("telemetry","intelligence","on");
 assert.equal(intelligence.status,0,"Independent Free architecture profiling can be enabled locally");
 const disabledTelemetry=run("telemetry","off","--json");
 assert.equal(disabledTelemetry.status,0);
 assert.equal(JSON.parse(disabledTelemetry.stdout).serviceEnabled,false);
 const blockedScan=run("scan",project,"--json");
 assert.equal(blockedScan.status,2,"Free service cannot analyze after telemetry off");
 const denial=JSON.parse(blockedScan.stdout);
 assert.equal(denial.monitoring.reason,"telemetry_required");
 assert.equal(denial.status.assessmentAvailable,false);
 for(const blocked of ["projects","activity"]){
   const result=run(blocked,"--json");assert.equal(result.status,2);
   assert.equal(JSON.parse(result.stdout).serviceEnabled,false);
 }
 assert.equal(run("telemetry","intelligence","off","--json").status,2,
   "Core Free architecture profiling cannot be disabled separately while analysis remains available");
 const resumed=run("telemetry","on","--json");
 assert.equal(resumed.status,0);
 assert.equal(JSON.parse(resumed.stdout).serviceEnabled,true);
 assert.equal(run("scan",project,"--json").status,0);
 assert.equal(run("cloud","sync","--json").status,2,"Beta Cloud telemetry sync must be blocked");
 assert.equal(run("cloud","register","--json").status,2,"Beta Cloud registration must be blocked");
 const qaPairing=spawnSync(process.execPath,["--import",blockUrl,cli,"account","link","--qa"],
  {cwd:temp,env:{...env,VIBE_PORTAL_PAIRING_QA:"1"},encoding:"utf8",timeout:30000,maxBuffer:3e6});
 assert.equal(qaPairing.status,2,"Beta QA-only account pairing must be blocked in the open client even with QA env enabled");
 assert.match(qaPairing.stderr,/not released for the open client/);
 assert.equal(fs.existsSync(path.join(app,"cloud","client.json")),false);
 // Before a signed OSS artifact root ships, the old Beta update system is inert.
 for(const action of ["status","check"]){
  const query=run("update",action,"--json");
  assert.equal(query.status,0,query.stderr?.slice(0,600));
  const status=JSON.parse(query.stdout);
  assert.equal(status.updateEnabled,false);
  assert.equal(status.available,false);
  assert.equal(status.source,"open-client");
  assert.equal(status.reason,"signed_update_channel_not_configured");
 }
 const unsignedUpdateErrors={
  stage:"signed_update_channel_not_configured",
  activate:"no_staged_update",
  rollback:"no_previous_runtime"
 };
 for(const [action,reason] of Object.entries(unsignedUpdateErrors)){
  const mutation=run("update",action,"--json");
  assert.equal(mutation.status,2,"Unsigned open-client update "+action+" must fail closed");
  assert.match(mutation.stderr,new RegExp(reason));
 }
 assert.equal(fs.existsSync(path.join(app,"updates")),false,
  "Open-client legacy updater must not persist update state");
 const strategy=run("cloud","config","--json");
 assert.equal(strategy.status,0);
 assert.equal(JSON.parse(strategy.stdout).source,"local-baseline");
 assert.equal(fs.existsSync(path.join(app,"telemetry","queue.jsonl")),false);
 const uninstall=run("uninstall","--codex","--json");
 assert.equal(uninstall.status,0,uninstall.stderr?.slice(0,600));
 assert.doesNotMatch(fs.readFileSync(config,"utf8"),/mcp_servers\.vibe-monitor/);
 assert.equal(fs.existsSync(path.join(app,"telemetry","queue.jsonl")),false);
 // The one installer supports local lifecycle opt-out; it never invokes Beta tracking.
 const off=spawnSync(process.execPath,["--import",blockUrl,cli,"install","--codex","--json"],
  {cwd:temp,env:{...env,VIBE_MONITOR_LOCAL_LIFECYCLE:"off"},encoding:"utf8",timeout:30000,maxBuffer:3e6});
 assert.equal(off.status,0,off.stderr?.slice(0,600));
 const offResult=JSON.parse(off.stdout);
 assert.equal(offResult.distribution,"open-client");
 assert.equal(offResult.lifecycle.storage,"disabled");
 assert.equal(offResult.lifecycle.uploaded,false);
 assert.deepEqual(fs.readdirSync(lifecycleDir),attempts);
 assert.equal(fs.existsSync(path.join(app,"installation-attempts")),false);
 assert.equal(fs.existsSync(path.join(app,"telemetry","queue.jsonl")),false);
 const inherited=path.join(app,"cloud","client.json");
 fs.mkdirSync(path.dirname(inherited),{recursive:true});
 const oldConfig=JSON.stringify({baseUrl:"https://example.invalid",installationId:"old-qa",token:"test-fixture-value"});
 fs.writeFileSync(inherited,oldConfig);
 const resultLegacy=run("license","--json");
 assert.equal(resultLegacy.status,0,resultLegacy.stderr?.slice(0,400));
 assert.equal(JSON.parse(resultLegacy.stdout).registered,false);
 assert.equal(fs.readFileSync(inherited,"utf8"),oldConfig);
 const legacyTelemetry=path.join(app,"telemetry","config.json");
 fs.mkdirSync(path.dirname(legacyTelemetry),{recursive:true});
 const previousConsent=JSON.stringify({enabled:true,consentVersion:"private-beta-v4"});
 fs.writeFileSync(legacyTelemetry,previousConsent);
 const optOut=run("telemetry","off","--json");
 assert.equal(optOut.status,0,optOut.stderr?.slice(0,400));
 assert.equal(JSON.parse(optOut.stdout).enabled,false);
 assert.equal(fs.readFileSync(legacyTelemetry,"utf8"),previousConsent,
  "Open-client must not mutate legacy Beta consent");
 const status=run("telemetry","status","--json");
 assert.equal(status.status,0,status.stderr?.slice(0,400));
 assert.equal(JSON.parse(status.stdout).cloudTransportConfigured,false);
 assert.equal(fs.readFileSync(inherited,"utf8"),oldConfig);
});

test("open client lower-level Beta pairing and installer tracker cannot upload or write",{skip:DISTRIBUTION_MODE!=="open-client"?"Beta API remains separately tested":false},async t=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-open-no-beta-"));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 let attempted=0;
 const neverFetch=async()=>{attempted++;throw Error("legacy_upload_attempted");};
 assert.equal(createInstallTracker({baseUrl:"https://vibe-api.fde.fan",home:root,fetchImpl:neverFetch}),null);
 const tracker=new InstallTracker({baseUrl:"https://vibe-api.fde.fan",home:root,fetchImpl:neverFetch});
 tracker.mark("started");
 assert.deepEqual(fs.readdirSync(root),[]);
 assert.equal(await tracker.flush(),false);
 assert.deepEqual(await retryPendingInstallAttempts({baseUrl:"https://vibe-api.fde.fan"}),{retried:0});
 const pair=await acceptAccountPairing({client:{baseUrl:"https://vibe-api.fde.fan",token:"fixture"},code:"a".repeat(64),fetchImpl:neverFetch});
 assert.deepEqual(pair,{accepted:false,reason:"legacy_beta_pairing_disabled"});
 assert.equal(attempted,0);
});
