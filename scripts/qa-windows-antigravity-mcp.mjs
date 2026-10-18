#!/usr/bin/env node
// Independent Windows Antigravity RC MCP smoke. No production app config is modified here.
// Uses only the synthetic Git project and isolated HOME/telemetry directories.
import assert from "node:assert/strict";
import {spawn, execFileSync} from "node:child_process";
import {createInterface} from "node:readline";
import fs from "node:fs";
import path from "node:path";
import crypto from "node:crypto";
import {initializeFreeTelemetry} from "../src/telemetry.js";

const [entry, base] = process.argv.slice(2);
if (!entry || !base) throw new Error("Usage: node qa-windows-antigravity-mcp.mjs <dist/vibe-monitor.mjs> <qa-root>");
const entryFile=path.resolve(entry);
const resultFile=path.join(base,"reports","mcp-results.json");
const project=path.join(base,"synthetic-project");
const home=path.join(base,"ag-home");
const state=path.join(base,"ag-state");
for(const p of [project,home,state,path.dirname(resultFile),path.join(project,"src")])fs.mkdirSync(p,{recursive:true});
fs.writeFileSync(path.join(project,"package.json"),JSON.stringify({name:"vibe-windows-qa",version:"1.0.0",private:true,type:"module"},null,2));
fs.writeFileSync(path.join(project,"src","index.js"),"import { test } from './test.js';\nexport const value = test(5);\n// QA_PRIVATE_SOURCE_SENTINEL_DO_NOT_UPLOAD\n");
fs.writeFileSync(path.join(project,"src","test.js"),"export const test=x=>x+1;\n");
if(!fs.existsSync(path.join(project,".git")))execFileSync("git",["init","-q"],{cwd:project});
const env={...process.env,HOME:home,USERPROFILE:home,VIBE_MONITOR_HOME:state,VIBE_MONITOR_SETUP_HOME:home};
// Mirror the normal open-client install: initialize required telemetry ON by default.
process.env.VIBE_MONITOR_HOME=state;
process.env.HOME=home;
initializeFreeTelemetry();
const child=spawn(process.execPath,[entryFile,"mcp","--agent","antigravity"],{cwd:project,env,stdio:["pipe","pipe","pipe"],windowsHide:true});
let requestId=0,dead=false;
const pending=new Map(),errors=[];
child.stderr.on("data",x=>{ const v=x.toString();if(/error|fatal/i.test(v))errors.push(v.slice(0,500)); });
createInterface({input:child.stdout}).on("line",line=>{
 let v;try{v=JSON.parse(line)}catch{errors.push("non_json_stdout");return;}
 if(v.id==null)return;const item=pending.get(v.id);if(!item)return;
 clearTimeout(item.timer);pending.delete(v.id);
 v.error?item.reject(new Error(JSON.stringify(v.error))):item.resolve(v.result);
});
child.on("exit",(code)=>{dead=true;for(const item of pending.values()){clearTimeout(item.timer);item.reject(new Error("MCP exited "+code));}pending.clear();});
function rpc(method,params={},timeout=90000){
 return new Promise((resolve,reject)=>{
  if(dead)return reject(new Error("MCP process exited"));
  const id=++requestId,timer=setTimeout(()=>{pending.delete(id);reject(new Error("MCP timeout: "+method));},timeout);
  pending.set(id,{resolve,reject,timer});
  child.stdin.write(JSON.stringify({jsonrpc:"2.0",id,method,params})+"\n");
 });
}
function unpack(r){const c=r?.content?.find(x=>x.type==="text")?.text;if(!c)return r;try{return JSON.parse(c)}catch{return c;}}
function noError(r,label){if(r?.isError)throw new Error(label+" tool error: "+JSON.stringify(r).slice(0,400));return unpack(r)}
const output={version:"1.0.1-rc.0",os:process.platform,agent:"antigravity",checks:[],startedAt:new Date().toISOString(),syntheticProject:true};
const check=(name,success,details)=>{output.checks.push({name,pass:!!success,...(details?{details}:{} )});if(!success)throw new Error(name+" FAILED");};
try{
 const init=await rpc("initialize",{protocolVersion:"2025-06-18",capabilities:{},clientInfo:{name:"windows-antigravity-rc-qa",version:"1"}});
 check("MCP initialize",init?.serverInfo?.version==="1.0.1-rc.0",{serverVersion:init?.serverInfo?.version});
 child.stdin.write(JSON.stringify({jsonrpc:"2.0",method:"notifications/initialized"})+"\n");
 const list=await rpc("tools/list",{});
 const names=(list?.tools??[]).map(x=>x.name);
 check("16 MCP tools discovered",names.length===16,{count:names.length});
 for(const name of ["vibe_version","vibe_session_start","vibe_project_status","vibe_checkpoint","vibe_findings","vibe_explain_finding"])
  check("Tool available: "+name,names.includes(name));
 const version=noError(await rpc("tools/call",{name:"vibe_version",arguments:{}}),"vibe_version");
 check("Runtime version correct",JSON.stringify(version).includes("1.0.1-rc.0"));
 const session=noError(await rpc("tools/call",{name:"vibe_session_start",arguments:{path:project}}),"vibe_session_start");
 check("Synthetic project session initialized",!session?.error&&!session?.monitoring?.disabled);
 const noPath=noError(await rpc("tools/call",{name:"vibe_project_status",arguments:{}}),"vibe_project_status");
 check("No-path status query",!noPath?.error && !!(noPath?.project||noPath?.status));
 const findings=noError(await rpc("tools/call",{name:"vibe_findings",arguments:{path:project}}),"vibe_findings");
 check("Finding list returned",Array.isArray(findings?.findings),{count:findings?.findings?.length,keys:Object.keys(findings??{}),preview:JSON.stringify(findings).slice(0,400)});
 if(findings.findings.length){
  const id=findings.findings[0].id;
  const detail=noError(await rpc("tools/call",{name:"vibe_explain_finding",arguments:{id,path:project}}),"vibe_explain_finding");
  check("Finding evidence explain",!detail?.error);
 }
 const checkpoint=noError(await rpc("tools/call",{name:"vibe_checkpoint",arguments:{path:project}}),"vibe_checkpoint");
 check("Checkpoint completed",!checkpoint?.error);
 await new Promise(res=>setTimeout(res,16000)); // Automatic flush; no explicit sync calls
 const qdir=path.join(state,"free-telemetry"),stateFile=path.join(qdir,"sync-state.json");
 const queue=path.join(qdir,"queue.jsonl");
 const pendingEvents=fs.existsSync(queue)?fs.readFileSync(queue,"utf8").split("\n").filter(Boolean).length:0;
 const dump=fs.existsSync(queue)?fs.readFileSync(queue,"utf8"):"";
 check("No source/prompt leakage in queued telemetry",!dump.includes("QA_PRIVATE_SOURCE_SENTINEL_DO_NOT_UPLOAD")&&!dump.includes("src\\index.js"));
 output.autoSync={observedAfterSeconds:16,pendingEvents,syncStatePresent:fs.existsSync(stateFile)};
 output.pass=true;
}catch(error){output.pass=false;output.failure=String(error.message??error);}
finally{
 output.finishedAt=new Date().toISOString();
 output.stderrErrors=errors.slice(0,3);
 fs.writeFileSync(resultFile,JSON.stringify(output,null,2)+"\n");
 console.log(JSON.stringify(output));
 child.kill();
}
if(!output.pass)process.exitCode=1;
