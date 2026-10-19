import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {readSecret,writeSecret} from "../src/secure-store.js";
import {verifyAndRecordActiveBetaHandoff,verifiedBetaHandoffInstalled} from "../src/beta-stable-handoff.js";
import {installOpenClientProduct,detectUnmigratedBetaInstallation,readRuntimePointer} from "../src/install.js";
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-public-handoff-"));
const keys=["VIBE_MONITOR_HOME","VIBE_MONITOR_TEST_SECRET_DIR","VIBE_MONITOR_SETUP_HOME"];
const prev=Object.fromEntries(keys.map(x=>[x,process.env[x]]));
process.env.VIBE_MONITOR_HOME=path.join(temp,"home");
process.env.VIBE_MONITOR_SETUP_HOME=path.join(temp,"setup");
process.env.VIBE_MONITOR_TEST_SECRET_DIR=path.join(temp,"vault");
const legacy=crypto.randomUUID(),stable=crypto.randomUUID(),device=crypto.randomUUID();
const bearer="vms_"+crypto.randomBytes(32).toString("base64url");
const old="vmb_SYNTHETIC_LEGACY_NOT_REAL";
const home=process.env.VIBE_MONITOR_HOME;
const put=(name,obj)=>{const f=path.join(home,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,JSON.stringify(obj),{mode:0o600});return f;};
const cloud=put("cloud/client.json",{schemaVersion:1,installationId:legacy,deviceId:device});
put("device.json",{deviceId:device});
put("migration/beta-stable.json",{schemaVersion:1,phase:"active",legacyInstallationId:legacy,stableInstallationId:stable,deviceId:device});
const consent=put("migration/stable-migration-consent.json",{schemaVersion:1,consentVersion:"stable-migration-v1",
 termsSha256:"d829b3c238d1543bb810e29b2ac4d13095144a99f83581d13cab36634a64299b",
 acceptedAt:new Date().toISOString(),legacyInstallationId:legacy,deviceId:device});
put("projects/demo/history.json",{revisionCount:42});
writeSecret("stable-installation-token",bearer);
writeSecret("cloud-installation-token",old);
test.after(()=>{
 for(const k of keys)if(prev[k]===undefined)delete process.env[k];else process.env[k]=prev[k];
 fs.rmSync(temp,{recursive:true,force:true});
});
const responder=async(url,options)=>{
 assert.equal(url,"https://vibe-api.fde.fan/migration/beta/verify");
 assert.equal(options.headers.authorization,"Bearer "+bearer);
 assert.doesNotMatch(JSON.stringify(options),/vmb_/);
 return new Response(JSON.stringify({status:"active",legacyInstallationId:legacy,stableInstallationId:stable,deviceId:device}),{status:200,headers:{"content-type":"application/json"}});
};
test("unverified Beta remains blocked and wrong server identity cannot write proof",async()=>{
 assert.equal(detectUnmigratedBetaInstallation(),"legacy_beta_upgrade_requires_verified_handoff");
 assert.equal(verifiedBetaHandoffInstalled(),false);
 assert.equal(await verifyAndRecordActiveBetaHandoff({fetchImpl:async()=>new Response(JSON.stringify({status:"active",legacyInstallationId:crypto.randomUUID(),stableInstallationId:stable,deviceId:device}),{status:200})}),false);
 assert.equal(fs.existsSync(path.join(home,"migration/stable-handoff-verified.json")),false);
});
test("active Stable bearer and consent allow OSS takeover; preserve Beta and history",async()=>{
 const oldData=fs.readFileSync(cloud);
 assert.equal(await verifyAndRecordActiveBetaHandoff({fetchImpl:responder}),true);
 const receipt=fs.readFileSync(path.join(home,"migration/stable-handoff-verified.json"),"utf8");
 assert.doesNotMatch(receipt,/vmb_|vms_/);
 assert.equal(detectUnmigratedBetaInstallation(),"legacy_beta_upgrade_requires_verified_handoff");
 const priorFetch=globalThis.fetch;
 try{
  globalThis.fetch=responder;
  const installed=await installOpenClientProduct({agents:["codex"],local:true,cliPath:path.resolve("src/cli.js")});
  assert.equal(installed.installed,true);
 }finally{globalThis.fetch=priorFetch;}
 assert.equal(detectUnmigratedBetaInstallation(),null);
 assert.equal(verifiedBetaHandoffInstalled(),true);
 assert.ok(oldData.equals(fs.readFileSync(cloud)));
 assert.equal(readSecret("cloud-installation-token"),old);
 assert.equal(fs.readFileSync(path.join(home,"projects/demo/history.json"),"utf8"),'{"revisionCount":42}');
 const codex=path.join(temp,"setup",".codex","config.toml");
 assert.equal((fs.readFileSync(codex,"utf8").match(/\[mcp_servers[.]vibe-monitor\]/g)||[]).length,1);
 const second=await installOpenClientProduct({agents:["codex"],local:true,cliPath:path.resolve("src/cli.js")});
 assert.equal(second.installed,true);
 assert.equal((fs.readFileSync(codex,"utf8").match(/\[mcp_servers[.]vibe-monitor\]/g)||[]).length,1);
 assert.equal(readRuntimePointer("current")?.type,"local");
});
test("tampered migration consent stops the previously verified local handoff",async()=>{
 const prior=fs.readFileSync(consent,"utf8");
 fs.writeFileSync(consent,JSON.stringify({...JSON.parse(prior),termsSha256:"0".repeat(64)}));
 try{
  assert.equal(verifiedBetaHandoffInstalled(),false);
  assert.equal(await verifyAndRecordActiveBetaHandoff({fetchImpl:responder}),false);
 }finally{fs.writeFileSync(consent,prior);}
});
