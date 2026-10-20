#!/usr/bin/env node
// Offline signer. Never bundled; private key is read locally, not logged.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {FREE_UPDATE_KEY_ID,verifyFreeUpdateEnvelope} from "../src/update.js";
const reject=reason=>{process.stderr.write("release_signing_rejected:"+reason+"\n");process.exit(2);};
const argv=process.argv.slice(2), a={};
if(argv.length%2)reject("arguments");
for(let i=0;i<argv.length;i+=2){if(!argv[i].startsWith("--")||Object.hasOwn(a,argv[i]))reject("arguments");a[argv[i]]=argv[i+1];}
const keys=["--key-file","--artifact","--output","--version","--revision","--rollout-percent","--rollout-salt"];
const optional=["--targets-file"];
if(keys.some(k=>!a[k])||Object.keys(a).some(k=>![...keys,...optional].includes(k)))reject("arguments");
const version=a["--version"], revision=Number(a["--revision"]),
 percent=Number(a["--rollout-percent"]),salt=a["--rollout-salt"];
if(!/^[0-9]+[.][0-9]+[.][0-9]+$/.test(version)||!Number.isSafeInteger(revision)||revision<1||
 !Number.isInteger(percent)||percent<0||percent>100||!/^[a-z0-9-]{8,64}$/i.test(salt))reject("metadata");
const keyFile=path.resolve(a["--key-file"]), artFile=path.resolve(a["--artifact"]), outFile=path.resolve(a["--output"]);
if(new Set([keyFile,artFile,outFile]).size!==3)reject("output_conflict");
let key, bytes;
try{
 const stat=fs.lstatSync(keyFile);
 if(!stat.isFile()||stat.isSymbolicLink()||(process.platform!=="win32"&&(stat.mode&0o077)))reject("key_permissions");
 key=crypto.createPrivateKey(fs.readFileSync(keyFile));
 if(key.asymmetricKeyType!=="ed25519")reject("key_type");
 const st=fs.lstatSync(artFile);
 if(!st.isFile()||st.isSymbolicLink()||st.size<=0||st.size>25*1024*1024||!artFile.endsWith(".tgz"))reject("artifact");
 bytes=fs.readFileSync(artFile);
}catch{reject("key_or_artifact");}
if(fs.existsSync(outFile))reject("output_exists");
let targeting=null;
if(a["--targets-file"]){
 if(percent!==0||salt.length<12)reject("target_rollout_must_be_zero");
 let ids;
 try{
  const f=fs.lstatSync(path.resolve(a["--targets-file"]));
  if(!f.isFile()||f.isSymbolicLink()||(process.platform!=="win32"&&(f.mode&0o077))||f.size>16000)
   reject("targets_file_permissions");
  ids=JSON.parse(fs.readFileSync(path.resolve(a["--targets-file"]),"utf8"));
 }catch{reject("targets_file_invalid");}
 if(!Array.isArray(ids)||ids.length<1||ids.length>128||
    ids.some(id=>typeof id!=="string"||!/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(id)))
  reject("targets_file_invalid");
 const unique=[...new Set(ids.map(id=>id.toLowerCase()))];
 if(unique.length!==ids.length)reject("targets_file_duplicates");
 targeting={mode:"installation-digests",salt,
  digests:unique.map(id=>crypto.createHash("sha256").update(salt+":"+id).digest("hex")).sort()};
}
const now=Math.floor(Date.now()/1000);
const payload={schemaVersion:targeting?2:1,audience:"vibe-monitor-free-update-v1",
 revision,issuedAt:now,expiresAt:now+3600,version,rolloutPercent:percent,rolloutSalt:salt,
 artifact:{url:"https://registry.npmjs.org/@vibe-monitor/setup/-/setup-"+version+".tgz",
 sha256:crypto.createHash("sha256").update(bytes).digest("hex")},
 ...(targeting?{targeting}:{})};
const envelope={payload,keyId:FREE_UPDATE_KEY_ID,
 signature:crypto.sign(null,Buffer.from(JSON.stringify(payload)),key).toString("base64url")};
const publicKey=crypto.createPublicKey(key).export({type:"spki",format:"pem"});
if(!verifyFreeUpdateEnvelope(envelope,{keys:{[FREE_UPDATE_KEY_ID]:publicKey}}))reject("self_verify");
try{
 const fd=fs.openSync(outFile,"wx",0o600);
 try{fs.writeFileSync(fd,JSON.stringify(envelope,null,2)+"\n");}finally{fs.closeSync(fd);}
}catch{reject("output_write");}
const fingerprint=crypto.createHash("sha256").update(crypto.createPublicKey(key).export({type:"spki",format:"der"})).digest("hex");
process.stdout.write(JSON.stringify({signed:true,version,revision,rolloutPercent:percent,
 artifactSha256:payload.artifact.sha256,publicKeyFingerprint:fingerprint,output:outFile})+"\n");
