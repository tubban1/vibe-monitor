import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
const repo=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vm-real-beta41-migration-"));
const previous=process.env.VIBE_MONITOR_HOME;
const run=(args)=>{
 const p=spawnSync("npm",args,{encoding:"utf8",timeout:120000,cwd:repo,env:{...process.env,npm_config_registry:"https://registry.npmjs.org"}});
 assert.equal(p.status,0,"npm failed: "+String(p.stderr).slice(-1000));
 return p.stdout.trim();
};
const log=(k,v)=>console.log("REAL_BETA41_UAT",k,v);
try{
 const meta=JSON.parse(run(["view","@vibe-monitor/setup@0.3.0-beta.41","dist","--json"]));
 const pack=run(["pack","@vibe-monitor/setup@0.3.0-beta.41","--pack-destination",temp,"--ignore-scripts"]).split("\n").at(-1);
 const archive=path.join(temp,pack),bytes=fs.readFileSync(archive);
 assert.equal("sha512-"+crypto.createHash("sha512").update(bytes).digest("base64"),meta.integrity);
 log("OFFICIAL_REGISTRY_SHA512","PASS");
 const prefix=path.join(temp,"installed-beta");
 run(["install","--prefix",prefix,"--ignore-scripts","--no-audit","--no-fund",archive]);
 const pkg=JSON.parse(fs.readFileSync(path.join(prefix,"node_modules/@vibe-monitor/setup/package.json")));
 assert.equal(pkg.version,"0.3.0-beta.41");
 log("OFFICIAL_BETA41_PACKAGE_INSTALLED","PASS");
 const home=path.join(temp,"old-beta-home");
 const cloudFile=path.join(home,"cloud/client.json");
 const historyFile=path.join(home,"projects/important-project/history-marker.json");
 fs.mkdirSync(path.dirname(cloudFile),{recursive:true});
 fs.mkdirSync(path.dirname(historyFile),{recursive:true});
 const token="qa-only-fake-beta-credential-never-valid";
 fs.writeFileSync(cloudFile,JSON.stringify({registered:true,token,version:"0.3.0-beta.41"}));
 fs.writeFileSync(historyFile,JSON.stringify({history:"preserve",entries:2}));
 process.env.VIBE_MONITOR_HOME=home;
 const {detectUnmigratedBetaInstallation,installOpenClientProduct}=await import("../src/install.js");
 const blocked=detectUnmigratedBetaInstallation();
 assert.equal(blocked,"legacy_beta_upgrade_requires_verified_handoff");
 const before=[fs.readFileSync(cloudFile),fs.readFileSync(historyFile)];
 const cli=path.join(prefix,"node_modules/@vibe-monitor/setup/dist/vibe-monitor.mjs");
 await assert.rejects(()=>installOpenClientProduct({agents:[],local:true,cliPath:cli}),
  /legacy_beta_upgrade_requires_verified_handoff/);
 const after=[fs.readFileSync(cloudFile),fs.readFileSync(historyFile)];
 assert.ok(before[0].equals(after[0])&&before[1].equals(after[1]));
 assert.equal(fs.existsSync(path.join(home,"runtime/current.json")),false);
 assert.ok(!JSON.stringify({blocked}).includes(token));
 log("UNVERIFIED_HANDOFF_REJECTED_WITHOUT_DATA_LOSS","PASS");
 log("CREDENTIAL_NOT_REUSED_OR_EXPOSED","PASS");
 log("RESULT","PASS_SAFE_BLOCK; VERIFIED_HANDOFF_STILL_REQUIRED");
}finally{
 if(previous===undefined)delete process.env.VIBE_MONITOR_HOME;else process.env.VIBE_MONITOR_HOME=previous;
 if(process.env.VIBE_MONITOR_OTA_UAT_KEEP==="1")log("ISOLATED_DIR",temp);
 else fs.rmSync(temp,{recursive:true,force:true});
}
