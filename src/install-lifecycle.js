// Local-only install diagnostics for the ONE Free/Pro/Team client.
// Never transmits events, identities, source code, paths or credentials.
// Cloud upload, if ever added, requires a separate consent and API contract.
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {CLIENT_VERSION} from "./constants.js";
import {vibeHome,ensureDir,atomicJsonWrite} from "./utils.js";
import {safeInstallError} from "./install-error.js";

// Stages are deterministic local evidence, not proof of remote delivery.
const STAGES=new Set(["started","migration_preflight","runtime_install_started",
  "node_runtime_check","node_runtime_ready","npm_runtime_install_started",
  "npm_runtime_verified","launcher_configured","runtime_installed",
  "mcp_configuration_started","mcp_configured","telemetry_initialized",
  "completed","failed","interrupted"]);
const MAX_EVENTS=16;
const MAX_FILES=50;
const MAX_AGE_MS=30*24*60*60*1000;
export function localInstallLifecycleDirectory(){
 return path.join(vibeHome(),"install-lifecycle");
}
function prune(dir,nowMs){
 try{
  const files=fs.readdirSync(dir).filter(n=>/^attempt-[0-9a-f-]{36}\.json$/i.test(n))
   .map(name=>({name,mtime:fs.lstatSync(path.join(dir,name)).mtimeMs}))
   .sort((a,b)=>b.mtime-a.mtime);
  files.forEach(({name,mtime},index)=>{
   if(index<MAX_FILES-1&&nowMs-mtime<=MAX_AGE_MS)return;
   const file=path.join(dir,name);
   if(fs.lstatSync(file).isFile())fs.unlinkSync(file);
  });
 }catch{/* diagnostics must never block installation */}
}
export function createLocalInstallLifecycle({directory=localInstallLifecycleDirectory(),now=()=>Date.now(),onEvent=()=>{}}={}){
 const enabled=process.env.VIBE_MONITOR_LOCAL_LIFECYCLE!=="off";
 const attemptId=crypto.randomUUID();
 const record={
  schemaVersion:1,attemptId,clientVersion:CLIENT_VERSION,
  platform:process.platform,arch:os.arch(),events:[]
 };
 const file=path.join(directory,"attempt-"+attemptId+".json");
 if(enabled){
  try{ensureDir(directory);prune(directory,now());}catch{/* best effort */}
 }
 return {
  mark(stage,errorCode=null){
   if(!STAGES.has(stage)||record.events.length>=MAX_EVENTS)return;
   const event={stage,occurredAt:new Date(now()).toISOString()};
   if(stage==="failed")event.errorCode=safeInstallError({message:errorCode});
   record.events.push(event);
   if(enabled)try{atomicJsonWrite(file,record);}catch{/* installation continues */}
   try{onEvent({...event,attemptId});}catch{/* diagnostics must not block install */}
  },
  summary(){
   return {storage:enabled?"local-only":"disabled",uploaded:false,
    stages:record.events.map(e=>e.stage),errorCode:record.events.at(-1)?.errorCode||null};
  }
 };
}

// Read-only local diagnosis. Never label a missing heartbeat as a confirmed
// process failure; the shell/npm subprocess may still be running.
export function latestLocalInstallAttempt({directory=localInstallLifecycleDirectory(),now=()=>Date.now(),
    stalledAfterMs=15*60_000}={}){
  try{
    const files=fs.readdirSync(directory).filter(n=>/^attempt-[0-9a-f-]{36}\.json$/i.test(n))
      .map(name=>({name,modified:fs.statSync(path.join(directory,name)).mtimeMs}))
      .sort((a,b)=>b.modified-a.modified);
    for(const item of files.slice(0,5)){
      const raw=safeLocalLifecycleRead(path.join(directory,item.name));
      if(!raw || !Array.isArray(raw.events)||raw.events.length===0)continue;
      const last=raw.events.at(-1),lastAt=Date.parse(last.occurredAt);
      const terminal=new Set(["completed","failed","interrupted"]);
      const status=terminal.has(last.stage) ? last.stage :
        Number.isFinite(lastAt) && now()-lastAt>=stalledAfterMs ?
          "suspected_stalled" : "in_progress";
      return {attemptId:raw.attemptId,clientVersion:raw.clientVersion,
        platform:raw.platform,lastStage:last.stage,lastEventAt:last.occurredAt,
        stageCount:raw.events.length,status,
        ...(last.errorCode?{errorCode:last.errorCode}:{})};
    }
  }catch{/* diagnostics should never crash doctor */}
  return null;
}
function safeLocalLifecycleRead(file){
 try{
   const item=JSON.parse(fs.readFileSync(file,"utf8"));
   if(typeof item.attemptId!=="string"||!Array.isArray(item.events))return null;
   return item;
 }catch{return null;}
}
