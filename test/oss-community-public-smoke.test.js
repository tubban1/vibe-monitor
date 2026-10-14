import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {DISTRIBUTION_MODE} from "../src/distribution.js";
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
 fs.writeFileSync(block,'globalThis.fetch=async()=>{throw Error("UNEXPECTED_CLOUD");};\n');
 const env={...process.env,HOME:home,USERPROFILE:home,
  VIBE_MONITOR_HOME:app,VIBE_MONITOR_SETUP_HOME:home,
  VIBE_CLOUD_URL:"http://127.0.0.1:1",
  VIBE_MONITOR_TEST_SECRET_DIR:path.join(temp,"secrets"),
  VIBE_MONITOR_TEST_MASTER_KEY:"f".repeat(64)};
 const cli=path.join(root,"src","cli.js");
 const run=(...args)=>spawnSync(process.execPath,["--import",block,cli,...args],
  {cwd:temp,env,encoding:"utf8",timeout:30000,maxBuffer:3e6});
 const help=run("--help");
 assert.equal(help.status,0,help.stderr?.slice(0,600));
 assert.match(help.stdout,/vibe-monitor cloud status\|config/);
 assert.match(help.stdout,/signed Cloud policy stays in process memory only/);
 assert.doesNotMatch(help.stdout,/vibe-monitor cloud register|vibe-monitor cloud status\|config\|sync|vibe-monitor telemetry intelligence|vibe-monitor telemetry status\|inspect\|on/,
  "The one open client must not advertise unavailable legacy Beta upload commands");
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
 assert.equal(result.telemetry.enabled,false);
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
 const setup=run("setup","--codex","--no-telemetry","--json");
 assert.equal(setup.status,0,setup.stderr?.slice(0,600));
 const configured=JSON.parse(setup.stdout);
 assert.equal(configured.telemetry.enabled,false);
 assert.equal(configured.telemetry.requiredDuringPrivateBeta,false);
 const optIn=run("telemetry","on");
 assert.equal(optIn.status,2,"Unified client must refuse legacy telemetry upload activation");
 const intelligence=run("telemetry","intelligence","on");
 assert.equal(intelligence.status,2,"Unified client must refuse legacy intelligence upload activation");
 assert.equal(run("cloud","sync","--json").status,2,"Beta Cloud telemetry sync must be blocked");
 assert.equal(run("cloud","register","--json").status,2,"Beta Cloud registration must be blocked");
 const strategy=run("cloud","config","--json");
 assert.equal(strategy.status,0);
 assert.equal(JSON.parse(strategy.stdout).source,"local-baseline");
 assert.equal(fs.existsSync(path.join(app,"telemetry","queue.jsonl")),false);
 const uninstall=run("uninstall","--codex","--json");
 assert.equal(uninstall.status,0,uninstall.stderr?.slice(0,600));
 assert.doesNotMatch(fs.readFileSync(config,"utf8"),/mcp_servers\.vibe-monitor/);
 assert.equal(fs.existsSync(path.join(app,"telemetry","queue.jsonl")),false);
 // The one installer supports local lifecycle opt-out; it never invokes Beta tracking.
 const off=spawnSync(process.execPath,["--import",block,cli,"install","--codex","--json"],
  {cwd:temp,env:{...env,VIBE_MONITOR_LOCAL_LIFECYCLE:"off"},encoding:"utf8",timeout:30000,maxBuffer:3e6});
 assert.equal(off.status,0,off.stderr?.slice(0,600));
 const offResult=JSON.parse(off.stdout);
 assert.equal(offResult.distribution,"open-client");
 assert.equal(offResult.lifecycle.storage,"disabled");
 assert.equal(offResult.lifecycle.uploaded,false);
 assert.deepEqual(fs.readdirSync(lifecycleDir),attempts);
 assert.equal(fs.existsSync(path.join(app,"installation-attempts")),false);
 assert.equal(fs.existsSync(path.join(app,"telemetry","queue.jsonl")),false);
});
