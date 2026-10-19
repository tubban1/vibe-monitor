import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import { createFreeTelemetryDrain, syncFreeTelemetry, freeSyncBackoffMs } from "../src/cloud.js";
import { enqueueActivityTelemetry, initializeFreeTelemetry, setTelemetryEnabled, telemetryStatus } from "../src/telemetry.js";

function isolatedHome(t) {
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-free-auto-drain-"));
  const keys=["VIBE_MONITOR_HOME","VIBE_MONITOR_TEST_SECRET_DIR"];
  const originals=keys.map(k=>process.env[k]);
  process.env.VIBE_MONITOR_HOME=root;
  process.env.VIBE_MONITOR_TEST_SECRET_DIR=path.join(root,"secrets");
  t.after(()=>{
    keys.forEach((k,i)=>{if(originals[i]===undefined)delete process.env[k];else process.env[k]=originals[i]});
    fs.rmSync(root,{recursive:true,force:true});
  });
  assert.equal(initializeFreeTelemetry().enabled,false);
  assert.equal(setTelemetryEnabled(true).enabled,true);
}
const tick=()=>new Promise(resolve=>setTimeout(resolve,20));
async function until(fn,ms=8000) {
  const end=Date.now()+ms;
  while(Date.now()<end) {if(fn())return;await tick()}
  assert.fail("automatic queue drain timeout");
}

test("205 queued events autonomously drain in ACKed batches of at most 12 without another Agent call",async t=>{
  isolatedHome(t);
  for(let i=0;i<205;i++)
    assert.equal(enqueueActivityTelemetry({event:"checkpoint",agent:"codex",
      projectId:"a".repeat(32),sessionId:crypto.randomUUID(),durationMs:i}),1);
  assert.equal(telemetryStatus().queuedEvents,205);
  let requestCount=0;const seen=[];
  const fetchImpl=async(_url,opts)=>{
    const events=JSON.parse(opts.body).events;
    assert.ok(events.length>0 && events.length<=12);
    assert.ok(Buffer.byteLength(opts.body)<=24576);
    seen.push(...events.map(x=>x.eventId));requestCount++;
    return new Response(JSON.stringify({accepted:events.length,duplicates:0}),{status:200});
  };
  const drain=createFreeTelemetryDrain({sync:()=>syncFreeTelemetry({fetchImpl})});
  drain.request();
  await until(()=>telemetryStatus().queuedEvents===0);
  drain.stop();
  assert.equal(seen.length,205);
  assert.equal(new Set(seen).size,205);
  assert.equal(requestCount,18);
  assert.equal(telemetryStatus().syncDiagnostics.lastResult,"ok");
});

test("offline/backoff schedules a later retry and next MCP process can drain persisted queue",async t=>{
  isolatedHome(t);
  for(let i=0;i<25;i++)enqueueActivityTelemetry({
    event:"checkpoint",agent:"codex",projectId:"b".repeat(32),
    sessionId:crypto.randomUUID(),durationMs:i
  });
  let calls=0,delaySeen=null,resolveScheduled;
  const scheduled=new Promise(resolve=>resolveScheduled=resolve);
  const drain=createFreeTelemetryDrain({
    sync:async()=>{
      calls++;
      return {uploaded:0,reason:"retry_backoff",nextRetryAt:new Date(Date.now()+5000).toISOString()};
    },
    schedule(fn,ms){
      if(calls>0){delaySeen=ms;resolveScheduled();return {fn}}
      const timer=setTimeout(fn,0);timer.unref();return timer;
    },
    cancel(){}
  });
  drain.request();
  await Promise.race([scheduled,new Promise((_,reject)=>setTimeout(()=>reject(Error("no delayed retry")),1700))]);
  assert.equal(calls,1);
  assert.ok(delaySeen>=4000 && delaySeen<=5000,delaySeen);
  assert.equal(telemetryStatus().queuedEvents,25);
  drain.stop();
  const received=[];
  const fetchImpl=async(_url,opts)=>{
    const batch=JSON.parse(opts.body).events;
    received.push(...batch.map(e=>e.eventId));
    return new Response(JSON.stringify({accepted:batch.length,duplicates:0}),{status:200});
  };
  const resumed=createFreeTelemetryDrain({sync:()=>syncFreeTelemetry({fetchImpl})});
  resumed.request();await until(()=>telemetryStatus().queuedEvents===0);resumed.stop();
  assert.equal(received.length,25);
  assert.equal(new Set(received).size,25);
  assert.equal(freeSyncBackoffMs(9,0),300000);
});


test("HTTP 503 retains events and schedules exponential backoff",async t=>{
  isolatedHome(t);
  for(let i=0;i<15;i++)enqueueActivityTelemetry({
    event:"checkpoint",agent:"antigravity",projectId:"c".repeat(32),
    sessionId:crypto.randomUUID(),durationMs:i
  });
  let requests=0,delaySeen=null,resolveScheduled;
  const scheduled=new Promise(resolve=>resolveScheduled=resolve);
  const drain=createFreeTelemetryDrain({
    sync:()=>syncFreeTelemetry({
      fetchImpl:async()=>{requests++;return new Response("offline",{status:503})}
    }),
    schedule(fn,ms) {
      if(requests>0){delaySeen=ms;resolveScheduled();return {fn}}
      const timer=setTimeout(fn,0);timer.unref();return timer;
    },
    cancel(){}
  });
  drain.request();
  await Promise.race([scheduled,new Promise((_,reject)=>setTimeout(()=>reject(Error("no backoff")),1800))]);
  drain.stop();
  assert.equal(requests,1);
  assert.equal(telemetryStatus().queuedEvents,15);
  assert.ok(delaySeen>=2500&&delaySeen<=6500,delaySeen);
  assert.equal(telemetryStatus().syncDiagnostics.lastResult,"retry_scheduled");
});

test("duplicate ACKs advance the queue without retransmitting acknowledged events",async t=>{
  isolatedHome(t);
  for(let i=0;i<27;i++)enqueueActivityTelemetry({
    event:"checkpoint",agent:"antigravity",projectId:"d".repeat(32),
    sessionId:crypto.randomUUID(),durationMs:i
  });
  let requests=0;
  const drain=createFreeTelemetryDrain({sync:()=>syncFreeTelemetry({
    fetchImpl:async(_url,opts)=>{
      requests++;
      const count=JSON.parse(opts.body).events.length;
      return new Response(JSON.stringify({accepted:0,duplicates:count}),{status:200});
    }
  })});
  drain.request();
  await until(()=>telemetryStatus().queuedEvents===0);
  drain.stop();
  assert.equal(requests,3);
});


test("one ACKed batch is partial until all queued events are confirmed",async t=>{
  isolatedHome(t);
  for(let i=0;i<14;i++)enqueueActivityTelemetry({
    event:"checkpoint",agent:"codex",projectId:"e".repeat(32),
    sessionId:crypto.randomUUID(),durationMs:i
  });
  const fetchImpl=async(_url,opts)=>{
    const length=JSON.parse(opts.body).events.length;
    return new Response(JSON.stringify({accepted:length,duplicates:0}),{status:200});
  };
  const first=await syncFreeTelemetry({fetchImpl});
  assert.equal(first.uploaded,12);
  assert.equal(first.remaining,2);
  assert.equal(telemetryStatus().syncDiagnostics.lastResult,"partial");
  assert.equal(telemetryStatus().syncDiagnostics.remainingQueued,2);
  const second=await syncFreeTelemetry({fetchImpl});
  assert.equal(second.uploaded,2);
  assert.equal(second.remaining,0);
  assert.equal(telemetryStatus().syncDiagnostics.lastResult,"ok");
});
