import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {ensureStableLauncher,writeRuntimePointer,readRuntimePointer,
  runtimeVersionEntry} from "../src/install.js";
import {rollbackUpdate,updateStateFile} from "../src/update.js";

test("isolated old Beta -> 1.0.0 -> 1.0.1 activation, health fallback and rollback",()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vm-release-upgrade-"));
 const oldHome=process.env.VIBE_MONITOR_HOME;
 const oldPreflight=process.env.VIBE_MONITOR_UPDATE_PREFLIGHT;
 try{
  process.env.VIBE_MONITOR_HOME=temp;
  delete process.env.VIBE_MONITOR_UPDATE_PREFLIGHT;
  const marker=path.join(temp,"projects","history-marker.txt");
  fs.mkdirSync(path.dirname(marker),{recursive:true});
  fs.writeFileSync(marker,"preserve-private-project-history");
  const betaCloud=path.join(temp,"cloud","client.json");
  fs.mkdirSync(path.dirname(betaCloud),{recursive:true});
  fs.writeFileSync(betaCloud,JSON.stringify({schemaVersion:1,oldBetaMetadata:"preserved"}));
  const legacyTelemetry=path.join(temp,"telemetry","config.json");
  fs.mkdirSync(path.dirname(legacyTelemetry),{recursive:true});
  fs.writeFileSync(legacyTelemetry,JSON.stringify({enabled:true,consentVersion:"private-beta-v4"}));

  function slot(version,healthy=true){
   const dest=runtimeVersionEntry(version);
   fs.mkdirSync(path.dirname(dest),{recursive:true});
   const source=[
    'if (process.argv.includes("doctor")) process.exit('+(healthy?'0':'1')+');',
    'if (process.argv.includes("--version")) console.log("Vibe Monitor '+version+'");'
   ].join("\n");
   fs.writeFileSync(dest,source);
  }
  function stage(version){
   fs.mkdirSync(path.dirname(updateStateFile()),{recursive:true});
   fs.writeFileSync(updateStateFile(),JSON.stringify({
    schemaVersion:1,stagedVersion:version,stagedArtifactSha256:"a".repeat(64),
    activateOnNextStart:true,quarantinedVersions:[]
   }));
  }
  function invoke(){
   // Node cannot execute a .cmd directly on Windows. Invoke the existing
   // stable launcher via the platform command shell only for this QA fixture.
   const res=spawnSync(launcher,["--version"],{
    env:{...process.env},encoding:"utf8",timeout:15000,
    shell:process.platform==="win32"
   });
   assert.equal(res.error,undefined,"launcher failed to start: "+res.error?.message);
   assert.equal(res.status,0,"stable launcher must exit cleanly: "+(res.stderr||""));
   return res.stdout.trim();
  }
  const launcher=ensureStableLauncher(process.execPath);
  slot("0.3.0-beta.41");
  writeRuntimePointer("current",{schemaVersion:1,type:"version",version:"0.3.0-beta.41"});
  assert.match(invoke(),/0[.]3[.]0-beta[.]41/);
  slot("1.0.0");
  stage("1.0.0");
  assert.match(invoke(),/Vibe Monitor 1[.]0[.]0/);
  assert.equal(readRuntimePointer("current").version,"1.0.0");
  assert.equal(readRuntimePointer("previous").version,"0.3.0-beta.41");
  slot("1.0.1");
  stage("1.0.1");
  assert.match(invoke(),/Vibe Monitor 1[.]0[.]1/);
  assert.equal(readRuntimePointer("current").version,"1.0.1");
  assert.equal(readRuntimePointer("previous").version,"1.0.0");
  assert.equal(rollbackUpdate().currentVersion,"1.0.0");
  assert.match(invoke(),/Vibe Monitor 1[.]0[.]0/);
  slot("1.0.2",false);
  stage("1.0.2");
  assert.match(invoke(),/Vibe Monitor 1[.]0[.]0/);
  assert.equal(readRuntimePointer("current").version,"1.0.0");
  assert.equal(fs.readFileSync(marker,"utf8"),"preserve-private-project-history");
  assert.match(fs.readFileSync(betaCloud,"utf8"),/oldBetaMetadata/);
  assert.match(fs.readFileSync(legacyTelemetry,"utf8"),/private-beta-v4/);
 }finally{
  if(oldHome===undefined)delete process.env.VIBE_MONITOR_HOME;
  else process.env.VIBE_MONITOR_HOME=oldHome;
  if(oldPreflight===undefined)delete process.env.VIBE_MONITOR_UPDATE_PREFLIGHT;
  else process.env.VIBE_MONITOR_UPDATE_PREFLIGHT=oldPreflight;
  fs.rmSync(temp,{recursive:true,force:true});
 }
});
