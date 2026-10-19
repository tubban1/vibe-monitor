import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {initializeFreeTelemetry,setTelemetryEnabled,enqueueLifecycleTelemetry,
  freeTelemetryWireBatch,readTelemetryBatch} from "../src/telemetry.js";
import {createLocalInstallLifecycle,latestLocalInstallAttempt} from "../src/install-lifecycle.js";

test("install lifecycle stages diagnose a stalled attempt but never call it a confirmed failure",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"vm-lifecycle-test-"));
  try{
    let clock=Date.parse("2026-10-18T13:00:00Z");
    const tracker=createLocalInstallLifecycle({directory:root,now:()=>clock});
    tracker.mark("started");
    clock+=3_000;tracker.mark("node_runtime_check");
    const recent=latestLocalInstallAttempt({directory:root,now:()=>clock+1000});
    assert.equal(recent.status,"in_progress");
    assert.equal(recent.lastStage,"node_runtime_check");
    const stale=latestLocalInstallAttempt({directory:root,now:()=>clock+16*60_000});
    assert.equal(stale.status,"suspected_stalled");
    tracker.mark("failed","runtime_download_failed");
    assert.equal(latestLocalInstallAttempt({directory:root,now:()=>clock+16*60_000}).status,"failed");
  }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test("anonymous install/integration lifecycle obeys opt-out and sanitizes payload",()=>{
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"vm-telemetry-lifecycle-test-"));
  const variables=["VIBE_MONITOR_HOME","VIBE_MONITOR_TEST_SECRET_DIR"];
  const prior=variables.map(k=>process.env[k]);
  try{
    process.env.VIBE_MONITOR_HOME=root;
    process.env.VIBE_MONITOR_TEST_SECRET_DIR=path.join(root,"secrets");
    assert.equal(initializeFreeTelemetry().enabled,true);
    const event=enqueueLifecycleTelemetry("lifecycle.installed",{
      scope:"full",agents:["codex","antigravity","private/path","codex"],reusedActivation:false});
    assert.equal(event.event,"lifecycle.installed");
    const wire=freeTelemetryWireBatch(readTelemetryBatch({limit:12}));
    assert.equal(wire.length,1);
    assert.equal(wire[0].event,"lifecycle.installed");
    assert.deepEqual(wire[0].payload.lifecycle.agents,["codex","antigravity"]);
    assert.doesNotMatch(JSON.stringify(wire),/private\/path|rawSource|accessToken/);
    assert.equal(setTelemetryEnabled(false).enabled,false);
    assert.equal(enqueueLifecycleTelemetry("lifecycle.integration_removed",{agents:["codex"]}),null);
    assert.equal(initializeFreeTelemetry().enabled,false,"explicit opt-out survives new runtime invocation");
  }finally{
    variables.forEach((key,i)=>{if(prior[i]==null)delete process.env[key];else process.env[key]=prior[i];});
    fs.rmSync(root,{recursive:true,force:true});
  }
});
