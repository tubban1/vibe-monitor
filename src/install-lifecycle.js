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

const STAGES=new Set(["started","runtime_installed","mcp_configured","completed","failed","interrupted"]);
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
export function createLocalInstallLifecycle({directory=localInstallLifecycleDirectory(),now=()=>Date.now()}={}){
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
  },
  summary(){
   return {storage:enabled?"local-only":"disabled",uploaded:false,
    stages:record.events.map(e=>e.stage),errorCode:record.events.at(-1)?.errorCode||null};
  }
 };
}
