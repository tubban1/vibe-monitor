import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readSecret,writeSecret} from "../src/secure-store.js";
import {verifiedBetaHandoffInstalled} from "../src/beta-stable-handoff.js";
import {installOpenClientProduct,detectUnmigratedBetaInstallation,readRuntimePointer} from "../src/install.js";

function fixture(t){
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-beta41-direct-"));
 const keys=["VIBE_MONITOR_HOME","VIBE_MONITOR_TEST_SECRET_DIR","VIBE_MONITOR_SETUP_HOME"];
 const previous=Object.fromEntries(keys.map(k=>[k,process.env[k]]));
 process.env.VIBE_MONITOR_HOME=path.join(temp,"home");
 process.env.VIBE_MONITOR_TEST_SECRET_DIR=path.join(temp,"vault");
 process.env.VIBE_MONITOR_SETUP_HOME=path.join(temp,"setup");
 const legacy=crypto.randomUUID(),stable=crypto.randomUUID(),device=crypto.randomUUID();
 const oldToken="vmb_"+crypto.randomBytes(24).toString("base64url");
 const stableToken="vms_"+crypto.randomBytes(32).toString("base64url");
 const home=process.env.VIBE_MONITOR_HOME;
 const put=(name,value)=>{
  const file=path.join(home,name);
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify(value),{mode:0o600});
  return file;
 };
 const cloud=put("cloud/client.json",{schemaVersion:1,installationId:legacy,
  deviceId:device,baseUrl:"https://vibe-api.fde.fan",version:"0.3.0-beta.41"});
 put("device.json",{deviceId:device});
 const history=put("projects/demo/history.json",{revisionCount:42});
 writeSecret("cloud-installation-token",oldToken);
 t.after(()=>{
  for(const key of keys){
   if(previous[key]===undefined)delete process.env[key];
   else process.env[key]=previous[key];
  }
  fs.rmSync(temp,{recursive:true,force:true});
 });
 return {temp,home,legacy,stable,device,oldToken,stableToken,cloud,history};
}

function migrationServer(ctx){
 const calls=[];
 const fetchImpl=async(url,options)=>{
  const route=new URL(url).pathname;
  calls.push(route);
  const body=JSON.parse(options.body||"{}");
  if(route==="/migration/beta/prepare"){
   assert.equal(options.headers.authorization,"Bearer "+ctx.oldToken);
   assert.equal(body.deviceId,ctx.device);
   assert.match(body.nonce,/^[0-9a-f-]{36}$/i);
   return new Response(JSON.stringify({status:"prepared",
    legacyInstallationId:ctx.legacy,stableInstallationId:ctx.stable,
    stableToken:ctx.stableToken,
    expiresAt:new Date(Date.now()+15*60_000).toISOString()}),{
     status:201,headers:{"content-type":"application/json"}});
  }
  if(route==="/migration/beta/activate"){
   assert.equal(options.headers.authorization,"Bearer "+ctx.stableToken);
   assert.equal(body.stableInstallationId,ctx.stable);
   return new Response(JSON.stringify({status:"active",
    legacyInstallationId:ctx.legacy,stableInstallationId:ctx.stable}),{
     status:200,headers:{"content-type":"application/json"}});
  }
  if(route==="/migration/beta/verify"){
   assert.equal(options.headers.authorization,"Bearer "+ctx.stableToken);
   assert.equal(body.stableInstallationId,ctx.stable);
   assert.equal(body.deviceId,ctx.device);
   return new Response(JSON.stringify({status:"active",
    legacyInstallationId:ctx.legacy,stableInstallationId:ctx.stable,
    deviceId:ctx.device}),{
     status:200,headers:{"content-type":"application/json"}});
  }
  throw Error("unexpected_migration_route");
 };
 return {calls,fetchImpl};
}

test("Beta.41 remains unchanged unless install explicitly requests migration",async t=>{
 const ctx=fixture(t);
 const beforeCloud=fs.readFileSync(ctx.cloud);
 const beforeHistory=fs.readFileSync(ctx.history);
 await assert.rejects(
  ()=>installOpenClientProduct({agents:[],local:true,cliPath:path.resolve("src/cli.js")}),
  /legacy_beta_upgrade_requires_verified_handoff/
 );
 assert.ok(beforeCloud.equals(fs.readFileSync(ctx.cloud)));
 assert.ok(beforeHistory.equals(fs.readFileSync(ctx.history)));
 assert.equal(readSecret("cloud-installation-token"),ctx.oldToken);
 assert.equal(fs.existsSync(path.join(ctx.home,"runtime","current.json")),false);
 assert.equal(fs.existsSync(path.join(ctx.home,"migration","stable-handoff-verified.json")),false);
});

test("Beta.41 directly migrates to stable identity and 1.0.1 install without duplicate MCP entry",async t=>{
 const ctx=fixture(t);
 const beforeCloud=fs.readFileSync(ctx.cloud);
 const beforeHistory=fs.readFileSync(ctx.history);
 const server=migrationServer(ctx);
 const previousFetch=globalThis.fetch;
 try{
  globalThis.fetch=server.fetchImpl;
  const installed=await installOpenClientProduct({
   agents:["codex"],local:true,cliPath:path.resolve("src/cli.js"),migrateBeta:true
  });
  assert.equal(installed.installed,true);
 }finally{
  globalThis.fetch=previousFetch;
 }

 assert.deepEqual(server.calls,[
  "/migration/beta/prepare",
  "/migration/beta/activate",
  "/migration/beta/verify"
 ]);
 assert.equal(readSecret("cloud-installation-token"),ctx.oldToken);
 assert.equal(readSecret("stable-installation-token"),ctx.stableToken);
 assert.ok(beforeCloud.equals(fs.readFileSync(ctx.cloud)));
 assert.ok(beforeHistory.equals(fs.readFileSync(ctx.history)));

 const journal=JSON.parse(fs.readFileSync(path.join(ctx.home,"migration","beta-stable.json")));
 assert.equal(journal.phase,"active");
 assert.equal(journal.legacyInstallationId,ctx.legacy);
 assert.equal(journal.stableInstallationId,ctx.stable);
 assert.ok(Number.isFinite(Date.parse(journal.approvedAt)));

 const receipt=fs.readFileSync(path.join(ctx.home,"migration","stable-handoff-verified.json"),"utf8");
 assert.doesNotMatch(receipt,/vmb_|vms_/);
 assert.equal(verifiedBetaHandoffInstalled(),true);
 assert.equal(detectUnmigratedBetaInstallation(),null);
 assert.equal(readRuntimePointer("current")?.type,"local");

 const codex=path.join(ctx.temp,"setup",".codex","config.toml");
 assert.equal((fs.readFileSync(codex,"utf8").match(/\[mcp_servers[.]vibe-monitor\]/g)||[]).length,1);
 const second=await installOpenClientProduct({
  agents:["codex"],local:true,cliPath:path.resolve("src/cli.js")
 });
 assert.equal(second.installed,true);
 assert.equal((fs.readFileSync(codex,"utf8").match(/\[mcp_servers[.]vibe-monitor\]/g)||[]).length,1);
});

test("invalid prepare identity never installs stable runtime",async t=>{
 const ctx=fixture(t);
 const previousFetch=globalThis.fetch;
 try{
  globalThis.fetch=async(url,options)=>{
   assert.equal(new URL(url).pathname,"/migration/beta/prepare");
   assert.equal(options.headers.authorization,"Bearer "+ctx.oldToken);
   return new Response(JSON.stringify({status:"prepared",
    legacyInstallationId:crypto.randomUUID(),
    stableInstallationId:ctx.stable,stableToken:ctx.stableToken,
    expiresAt:new Date(Date.now()+10*60_000).toISOString()}),{status:201});
  };
  await assert.rejects(()=>installOpenClientProduct({
   agents:[],local:true,cliPath:path.resolve("src/cli.js"),migrateBeta:true
  }),/beta_migration_prepare_invalid/);
 }finally{
  globalThis.fetch=previousFetch;
 }
 assert.equal(fs.existsSync(path.join(ctx.home,"runtime","current.json")),false);
 assert.equal(readSecret("cloud-installation-token"),ctx.oldToken);
 assert.equal(fs.existsSync(path.join(ctx.home,"migration","stable-handoff-verified.json")),false);
});
