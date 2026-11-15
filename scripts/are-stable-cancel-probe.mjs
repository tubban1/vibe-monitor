#!/usr/bin/env node
// Voluntary, standalone active cancellation / recovery probe. Not part of fast npm test.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
const repo=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-stable-cancel-"));
const home=path.join(tmp,"app"),project=path.join(tmp,"project");
fs.mkdirSync(project);
execFileSync("git",["init","-q"],{cwd:project});
for(let i=0;i<650;i++)fs.writeFileSync(path.join(project,"source-"+String(i).padStart(4,"0")+".ts"),
 Array.from({length:110},(_,n)=>"export function task"+n+"_"+i+"(x){return x+"+n+";}").join("\n")+"\n");
const block=path.join(tmp,"block-fetch.mjs");
fs.writeFileSync(block,"globalThis.fetch=async()=>{throw Error('NETWORK_BLOCKED_FOR_CANCEL_PROBE');};\n");
const env={...process.env,HOME:tmp,USERPROFILE:tmp,VIBE_MONITOR_HOME:home,
 VIBE_MONITOR_SETUP_HOME:tmp,VIBE_CLOUD_URL:"http://127.0.0.1:1",
 VIBE_MONITOR_TEST_SOURCE_INSTALL:"1",VIBE_MONITOR_TEST_MASTER_KEY:"f".repeat(64),
 VIBE_MONITOR_TEST_SECRET_DIR:path.join(tmp,"secret")};
const client=new Client({name:"vibe-are-active-cancel",version:"1.0.0"});
const transport=new StdioClientTransport({command:process.execPath,args:[
 "--import",block,path.join(repo,"src/cli.js"),"mcp","--agent","antigravity"],cwd:project,env});
const text=result=>JSON.parse(result.content.find(c=>c.type==="text").text);
let result={};
try{
 await client.connect(transport);
 const session=client.callTool({name:"vibe_session_start",arguments:{path:project,mode:"monitor"}},
  undefined,{timeout:30000});
 // The tool call runs concurrently; wait for a real analysis phase, not a policy wait.
 let phase=false,active=false;
 const log=path.join(home,"activity.jsonl");
 const started=Date.now();
 while(Date.now()-started<9000){
  if(fs.existsSync(log)){
   const content=fs.readFileSync(log,"utf8");
   phase=content.split("\n").some(line=>{
     try{const x=JSON.parse(line);return x.event==="call.phase"&&x.monitoringMode==="analysis"}catch{return false}
   });
  }
  if(phase){active=true;break}
  await new Promise(r=>setTimeout(r,15));
 }
 const skip=text(await client.callTool({name:"vibe_skip_current",arguments:{}},undefined,{timeout:30000}));
 const sessionResult=await session;
 const sessionPayload=text(sessionResult);
 const after=text(await client.callTool({name:"vibe_project_status",arguments:{path:project}},
  undefined,{timeout:30000}));
 result={phaseObserved:phase,cancelledScans:skip.activeCancelled,skipped:skip.skipped,
   sessionMode:sessionPayload.monitoring?.mode,sessionIsError:sessionResult.isError===true,
   recovered:after.status?.assessmentAvailable===true,
   sourceFiles:after.summary?.sourceFiles??null};
 console.log(JSON.stringify(result,null,2));
 if(!active||skip.activeCancelled<1||sessionPayload.monitoring?.mode!=="skipped"||
  sessionResult.isError===true||after.status?.assessmentAvailable!==true)
  process.exitCode=1;
}finally{
 try{await client.close()}catch{}
 fs.rmSync(tmp,{recursive:true,force:true});
}
