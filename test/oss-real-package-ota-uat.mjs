import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {pathToFileURL,fileURLToPath} from "node:url";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vm-ota-real-tarball-"));
const oldHome=process.env.VIBE_MONITOR_HOME,oldFetch=globalThis.fetch;
const src=path.join(temp,"stable"),client=path.join(temp,"client");
const version="1.0.1",beta="0.3.0-beta.41";
const manifestUrl="https://vibe-api.fde.fan/free/update-manifest";
const tarUrl="https://registry.npmjs.org/@vibe-monitor/setup/-/setup-1.0.1.tgz";
const log=(k,v)=>console.log("REAL_OTA_UAT",k,v);
function run(bin,args,cwd=repo){
 const r=spawnSync(bin,args,{cwd,encoding:"utf8",timeout:120000,env:{...process.env}});
 assert.equal(r.error,undefined,"spawn failed: "+String(r.error?.message));
 assert.equal(r.status,0,"command failed "+path.basename(bin)+": "+String(r.stderr).slice(-1000));
 return r.stdout.trim();
}
function copy(dst){
 fs.mkdirSync(dst,{recursive:true});
 fs.cpSync(path.join(repo,"src"),path.join(dst,"src"),{recursive:true});
 for(const f of ["README.md","NOTICE","LICENSE","package.json"])fs.copyFileSync(path.join(repo,f),path.join(dst,f));
 fs.symlinkSync(path.join(repo,"node_modules"),path.join(dst,"node_modules"),"dir");
}
try{
 copy(src);
 const pkg=JSON.parse(fs.readFileSync(path.join(src,"package.json"),"utf8"));
 pkg.version=version;fs.writeFileSync(path.join(src,"package.json"),JSON.stringify(pkg,null,2));
 const f=path.join(src,"src/constants.js");const c=fs.readFileSync(f,"utf8");
 assert.ok(c.includes('CLIENT_VERSION = "1.0.1"'));
 for(const [entry,out] of [["src/cli.js","dist/vibe-monitor.mjs"],["src/scan-worker.js","dist/vibe-monitor-scan-worker.mjs"]])
  run(path.join(repo,"node_modules/.bin/esbuild"),[entry,"--bundle","--packages=external","--platform=node","--format=esm","--target=node20","--minify","--legal-comments=none","--outfile="+out],src);
 const tarDir=path.join(temp,"tarballs");fs.mkdirSync(tarDir);
 const pack=run("npm",["pack","--ignore-scripts","--pack-destination",tarDir],src).split("\n").at(-1);
 const bytes=fs.readFileSync(path.join(tarDir,pack));
 const hash=crypto.createHash("sha256").update(bytes).digest("hex");
 log("REAL_PACK",pack);log("REAL_PACK_BYTES",bytes.length);log("REAL_PACK_SHA256",hash);
 const keys=crypto.generateKeyPairSync("ed25519");
 copy(client);
 const updateFile=path.join(client,"src/update.js");
 const code=fs.readFileSync(updateFile,"utf8");
 const line=code.split("\n").find(x=>x.startsWith("export const FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM="));
 assert.ok(line);
 fs.writeFileSync(updateFile,code.replace(line,"export const FREE_UPDATE_TRUSTED_PUBLIC_KEY_PEM="+JSON.stringify(keys.publicKey.export({type:"spki",format:"pem"}))+";"));
 const update=await import(pathToFileURL(updateFile).href);
 const install=await import(pathToFileURL(path.join(client,"src/install.js")).href);
 const telemetry=await import(pathToFileURL(path.join(client,"src/telemetry.js")).href);
 const now=Math.floor(Date.now()/1000);
 const payload={schemaVersion:1,audience:"vibe-monitor-free-update-v1",revision:1,issuedAt:now,expiresAt:now+3500,version,rolloutPercent:100,rolloutSalt:"isolated-ota-release-uat",artifact:{url:tarUrl,sha256:hash}};
 const sign=p=>({payload:p,keyId:"free-update-ed25519-v1",signature:crypto.sign(null,Buffer.from(JSON.stringify(p)),keys.privateKey).toString("base64url")});
 const envelope=sign(payload);let delivered=bytes;
 assert.equal(update.verifyFreeUpdateEnvelope(envelope)?.version,version);
 assert.equal(update.verifyFreeUpdateEnvelope({...envelope,payload:{...payload,rolloutPercent:0}}),null);
 assert.equal(update.verifyFreeUpdateEnvelope(sign({...payload,expiresAt:now-1})),null);
 assert.equal(update.verifyFreeUpdateEnvelope(sign({...payload,artifact:{...payload.artifact,url:"https://bad.invalid/setup.tgz"}})),null);
 log("SIGNATURE_SECURITY_CASES","PASS");
 globalThis.fetch=async url=>{
  if(String(url)===manifestUrl)return new Response(JSON.stringify(envelope),{status:200,headers:{"content-type":"application/json"}});
  if(String(url)===tarUrl)return new Response(delivered,{status:200,headers:{"content-length":String(delivered.byteLength)}});
  throw new Error("unexpected external network request");
 };
 process.env.VIBE_MONITOR_HOME=path.join(temp,"pass-home");telemetry.initializeFreeTelemetry();
 function oldSlot(){
  const entry=install.runtimeVersionEntry(beta);fs.mkdirSync(path.dirname(entry),{recursive:true});
  fs.writeFileSync(entry,'if(process.argv.includes("doctor"))process.exit(0);if(process.argv.includes("--version"))console.log("Vibe Monitor 0.3.0-beta.41");');
  install.writeRuntimePointer("current",{schemaVersion:1,type:"version",version:beta});
 }
 oldSlot();
 const launcher=install.ensureStableLauncher(process.execPath);
 assert.match(run(launcher,["--version"]),/beta[.]41/);
 const npmCli=path.resolve(path.dirname(process.execPath),"../lib/node_modules/npm/bin/npm-cli.js");
 assert.ok(fs.existsSync(npmCli));
 const status=await update.updateStatus({refresh:true});
 assert.equal(status.available,true,JSON.stringify(status));
 const staged=await update.stageUpdate({nodeRuntime:{binary:process.execPath,npmCli}});
 assert.equal(staged.staged,true);assert.equal(staged.stagedVersion,version);assert.equal(staged.artifactSha256,hash);
 assert.equal(JSON.parse(fs.readFileSync(install.runtimeVersionPackage(version),"utf8")).version,version);
 log("DOWNLOAD_SHA256_REAL_NPM_INSTALL","PASS");
 update.activateStagedUpdate();
 assert.match(run(launcher,["--version"]),/1[.]0[.]1/);
 assert.equal(install.readRuntimePointer("previous").version,beta);
 log("NEXT_RESTART_ACTIVATION","PASS");
 update.rollbackUpdate();
 assert.match(run(launcher,["--version"]),/beta[.]41/);
 log("ROLLBACK","PASS");
 process.env.VIBE_MONITOR_HOME=path.join(temp,"tamper-home");telemetry.initializeFreeTelemetry();oldSlot();
 delivered=Buffer.from(bytes);delivered[30]^=0xff;
 await assert.rejects(()=>update.stageUpdate({nodeRuntime:{binary:process.execPath,npmCli}}),/update_artifact_checksum_mismatch/);
 const state=JSON.parse(fs.readFileSync(update.updateStateFile(),"utf8"));
 assert.ok(state.quarantinedVersions.includes(version));
 assert.equal(install.readRuntimePointer("current").version,beta);
 assert.equal(fs.existsSync(install.runtimeVersionEntry(version)),false);
 log("TAMPER_QUARANTINE_AND_NO_INSTALL","PASS");log("RESULT","PASS");
}finally{
 globalThis.fetch=oldFetch;
 if(oldHome===undefined)delete process.env.VIBE_MONITOR_HOME;else process.env.VIBE_MONITOR_HOME=oldHome;
 if(process.env.VIBE_MONITOR_OTA_UAT_KEEP==="1")log("ISOLATED_DIR",temp);
 else fs.rmSync(temp,{recursive:true,force:true});
}
