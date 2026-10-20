import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import {
 verifyFreeUpdateEnvelope,FREE_UPDATE_KEY_ID,
 signedUpdateEligibleForInstallation,fetchVerifiedFreeUpdateManifest,
 FREE_TARGETED_UPDATE_MANIFEST_URL,FREE_UPDATE_MANIFEST_URL
} from "../src/update.js";

const signer=fileURLToPath(new URL("../scripts/sign-stable-update-manifest.mjs",import.meta.url));
const owner="8d9a4ea5-4af2-4328-ae12-af0df00d7890";
const other="5be2200c-2d16-4a0d-9f6d-4b82929ab341";

function fixture(){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vm-targeted-update-"));
 const pair=crypto.generateKeyPairSync("ed25519",{
  publicKeyEncoding:{type:"spki",format:"pem"},privateKeyEncoding:{type:"pkcs8",format:"pem"}});
 const file=(name,contents)=>{
  const p=path.join(dir,name);fs.writeFileSync(p,contents,{mode:0o600});fs.chmodSync(p,0o600);return p;
 };
 const key=file("private.pem",pair.privateKey);
 const artifact=file("release.tgz","synthetic test artifact");
 const targets=file("targets.json",JSON.stringify([owner]));
 const output=path.join(dir,"manifest.json");
 const args=["--key-file",key,"--artifact",artifact,"--output",output,
  "--version","1.0.5","--revision","7","--rollout-percent","0",
  "--rollout-salt","pilot-salt-20261020","--targets-file",targets];
 return {dir,pair,key,artifact,targets,output,args,
  clean:()=>fs.rmSync(dir,{recursive:true,force:true}),
  sign:(argv=args)=>spawnSync(process.execPath,[signer,...argv],{encoding:"utf8",timeout:10000})};
}

test("signed v2 limits installation to an exact owner-selected UUID, not percent cohort",()=>{
 const f=fixture();
 try {
  const r=f.sign();assert.equal(r.status,0,r.stderr);
  const envelope=JSON.parse(fs.readFileSync(f.output,"utf8"));
  const verify=e=>verifyFreeUpdateEnvelope(e,{keys:{[FREE_UPDATE_KEY_ID]:f.pair.publicKey}});
  const manifest=verify(envelope);
  assert.equal(manifest.schemaVersion,2);
  assert.equal(manifest.rolloutPercent,0);
  assert.equal(manifest.targeting.digests.length,1);
  assert.ok(!JSON.stringify(envelope).includes(owner),"IDs never shipped in manifests");
  assert.equal(signedUpdateEligibleForInstallation(manifest,owner),true);
  assert.equal(signedUpdateEligibleForInstallation(manifest,other),false);
  const forged={...envelope,payload:{...envelope.payload,targeting:{
   ...envelope.payload.targeting,digests:[
    crypto.createHash("sha256").update(manifest.targeting.salt+":"+other).digest("hex")
   ]}}};
  assert.equal(verify(forged),null,"signed target list cannot be changed");
  assert.equal(verify({...envelope,payload:{...envelope.payload,rolloutPercent:100}}),null);
  assert.equal(verify({...envelope,payload:{...envelope.payload,targeting:{
   ...manifest.targeting,digests:[...manifest.targeting.digests,manifest.targeting.digests[0]]
  }}}),null);
 }finally{f.clean();}
});

test("signer fails closed on nonzero rollout, duplicates, wrong permissions and empty target file",()=>{
 const f=fixture();
 try{
  const badPercent=f.args.slice();badPercent[badPercent.indexOf("--rollout-percent")+1]="1";
  assert.equal(f.sign(badPercent).status,2);
  fs.writeFileSync(f.targets,JSON.stringify([owner,owner]));
  assert.equal(f.sign().status,2);
  fs.writeFileSync(f.targets,"[]");
  assert.equal(f.sign().status,2);
  fs.writeFileSync(f.targets,JSON.stringify([owner]));
  if(process.platform!=="win32"){
   fs.chmodSync(f.targets,0o644);
   assert.equal(f.sign().status,2);
  }
 }finally{f.clean();}
});

test("targeted endpoint is exact URL-allowlisted and signed payload remains validated",async()=>{
 const f=fixture();
 try{
  assert.equal(f.sign().status,0);
  const signed=fs.readFileSync(f.output,"utf8");
  const keys={[FREE_UPDATE_KEY_ID]:f.pair.publicKey};
  const fake=async url=>{
   assert.equal(url,FREE_TARGETED_UPDATE_MANIFEST_URL);
   return {ok:true,redirected:false,headers:{get:()=>null},body:null,text:async()=>signed};
  };
  const v=await fetchVerifiedFreeUpdateManifest({
   fetchImpl:fake,publicKeysById:keys,url:FREE_TARGETED_UPDATE_MANIFEST_URL
  });
  assert.equal(v.manifest?.schemaVersion,2);
  const denied=await fetchVerifiedFreeUpdateManifest({
   fetchImpl:async()=>{throw Error("should not fetch");},publicKeysById:keys,
   url:"https://attacker.example/manifest"
  });
  assert.equal(denied.manifest,null);
  assert.equal(denied.reason,"signed_update_manifest_url_not_allowed");
  assert.notEqual(FREE_UPDATE_MANIFEST_URL,FREE_TARGETED_UPDATE_MANIFEST_URL);
 }finally{f.clean();}
});
