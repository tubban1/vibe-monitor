#!/usr/bin/env node
// Real MCP stdio probe with telemetry isolated in a disposable home and all network blocked.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {fileURLToPath} from "node:url";
import {performance} from "node:perf_hooks";
import {Client} from "@modelcontextprotocol/sdk/client/index.js";
import {StdioClientTransport} from "@modelcontextprotocol/sdk/client/stdio.js";
const root=path.resolve(fileURLToPath(new URL("../",import.meta.url)));
const args=process.argv.slice(2),option=(k,d)=>{const i=args.indexOf(k);return i<0?d:args[i+1]};
const entry=path.resolve(option("--entry",path.join(root,"src/cli.js")));
const project=path.resolve(option("--project",root));
const output=option("--output",null);
const home=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-stable-are-home-"));
const mock=path.join(home,"block-fetch.mjs");
fs.writeFileSync(mock,"globalThis.fetch=async()=>{throw Error('ARE_TEST_NETWORK_BLOCKED');};\n");
const env={...process.env,HOME:home,USERPROFILE:home,VIBE_MONITOR_HOME:path.join(home,"app"),
 VIBE_MONITOR_SETUP_HOME:home,VIBE_CLOUD_URL:"http://127.0.0.1:1",
 VIBE_MONITOR_TEST_SECRET_DIR:path.join(home,"secrets"),
 VIBE_MONITOR_TEST_MASTER_KEY:"f".repeat(64),VIBE_MONITOR_TEST_SOURCE_INSTALL:"1"};
const transport=new StdioClientTransport({command:process.execPath,
 args:["--import",mock,entry,"mcp","--agent","antigravity"],cwd:project,env});
const client=new Client({name:"vibe-stable-are-e2e",version:"1.0.0"});
const out={entry,project,at:new Date().toISOString(),context:"public stable; fresh local HOME; fetch BLOCKED",
 calls:[],taskChecks:{},toolList:null};
function parse(res){try{return JSON.parse(res?.content?.find(c=>c.type==="text")?.text||"")}catch{return null}}
async function call(name,variables={},key=name){
 const start=performance.now();
 let result,error;
 try{result=await client.callTool({name,arguments:variables},undefined,{timeout:30000})}
 catch(e){error=String(e.message).slice(0,250)}
 const txt=result?.content?.find(c=>c.type==="text")?.text||"";
 const body=parse(result);
 out.calls.push({key,name,elapsedMs:+(performance.now()-start).toFixed(2),
  contentBytes:Buffer.byteLength(txt,"utf8"),isError:result?.isError===true,
  bodyKeys:body?Object.keys(body):null,error:error??null,
  evidenceCount:body?.evidenceCount??body?.pagination?.total??body?.findings?.length??null,
  assessmentAvailable:body?.status?.assessmentAvailable??null});
 return {body,result};
}
try{
 await client.connect(transport);
 const s=performance.now(),tools=(await client.listTools()).tools;
 out.toolList={count:tools.length,bytes:Buffer.byteLength(JSON.stringify(tools),"utf8"),
  elapsedMs:+(performance.now()-s).toFixed(2),
  sizes:tools.map(x=>({name:x.name,bytes:Buffer.byteLength(JSON.stringify(x),"utf8")})),
  annotations:tools.map(x=>({name:x.name,value:x.annotations||null}))};
 await call("vibe_version");
 await call("vibe_account_connect");
 const stat=await call("vibe_project_status",{path:project});
 const find=await call("vibe_findings",{path:project});
 const firstId=find.body?.findings?.[0]?.id;
 out.taskChecks.T1={statusReadable:stat.body?.status?.assessmentAvailable===true,
  summary:stat.body?.view==="summary",hasRiskIndex:Array.isArray(stat.body?.evidenceIndex)};
 await call("vibe_product_intent",{path:project});
 const preview=await call("vibe_set_product_intent",{path:project,delivery:"local",dry_run:true},"intent_preview");
 out.taskChecks.T2={preview:preview.body?.dryRun===true,persisted:preview.body?.persisted===false};
 await call("vibe_explain_finding",{path:project,id:firstId||"VM-MISSING"},"explain_valid_or_missing");
 await call("vibe_explain_finding",{path:project,id:"VM-MISSING"},"explain_missing");
 await call("vibe_finding_intelligence",{path:project,id:"VM-MISSING"},"intelligence_missing");
 await call("vibe_skip_current",{},"cancel_idle");
 out.taskChecks.T3={firstFindingId:firstId||null,
  errorProper:out.calls.some(x=>x.key==="explain_missing"&&x.isError===true)};
 out.summary={count:out.toolList.count,annotations:out.toolList.annotations.filter(x=>x.value).length,
  totalBytes:out.calls.reduce((a,b)=>a+b.contentBytes,0)};
}finally{
 try{await client.close()}catch{}
 if(output){fs.mkdirSync(path.dirname(output),{recursive:true});fs.writeFileSync(output,JSON.stringify(out,null,2)+"\n")}
 fs.rmSync(home,{recursive:true,force:true});
}
console.log(JSON.stringify({summary:out.summary,calls:out.calls.map(x=>({
 key:x.key,bytes:x.contentBytes,elapsedMs:x.elapsedMs,isError:x.isError,
 evidenceCount:x.evidenceCount,assessmentAvailable:x.assessmentAvailable,error:x.error})),
 tasks:out.taskChecks},null,2));
