import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {verifyFreeUpdateEnvelope,FREE_UPDATE_KEY_ID} from "../src/update.js";
const script=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"../scripts/sign-stable-update-manifest.mjs");
test("offline update signing validates Ed25519, digest, rollout and denies tampering/unsafe keys",()=>{
 const temp=fs.mkdtempSync(path.join(os.tmpdir(),"vm-release-sign-"));
 try {
  const pair=crypto.generateKeyPairSync("ed25519",{
   publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
  const key=path.join(temp,"private.pem"),art=path.join(temp,"package.tgz"),out=path.join(temp,"manifest.json");
  fs.writeFileSync(key,pair.privateKey,{mode:0o600});fs.chmodSync(key,0o600);
  fs.writeFileSync(art,"synthetic-test-only-no-published-package");
  const args=["--key-file",key,"--artifact",art,"--output",out,"--version","1.0.1",
   "--revision","9","--rollout-percent","0","--rollout-salt","uat-zero-rollout-2026"];
  const call=(a)=>spawnSync(process.execPath,[script,...a],{encoding:"utf8",timeout:10000});
  const issued=call(args);
  assert.equal(issued.status,0,issued.stderr);
  assert.doesNotMatch(issued.stdout+issued.stderr,/PRIVATE KEY/);
  const envelope=JSON.parse(fs.readFileSync(out));
  const verify=e=>verifyFreeUpdateEnvelope(e,{keys:{[FREE_UPDATE_KEY_ID]:pair.publicKey}});
  assert.equal(verify(envelope)?.version,"1.0.1");
  assert.equal(verify(envelope)?.rolloutPercent,0);
  assert.equal(verify({...envelope,payload:{...envelope.payload,rolloutPercent:100}}),null);
  assert.equal(verify({...envelope,payload:{...envelope.payload,artifact:{...envelope.payload.artifact,sha256:"b".repeat(64)}}}),null);
  assert.equal(call(args).status,2,"no signature overwrite");
  const bad=args.slice();bad[7]="1.0.1-rc.0";bad[5]=path.join(temp,"bad.json");
  assert.equal(call(bad).status,2,"cannot sign prerelease for stable channel");
  if(process.platform!=="win32"){
   fs.chmodSync(key,0o644);
   const b=args.slice();b[5]=path.join(temp,"permissions.json");
   assert.equal(call(b).status,2,"reject readable key");
  }
 } finally{fs.rmSync(temp,{recursive:true,force:true});}
});
