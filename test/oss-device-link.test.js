import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {Readable} from "node:stream";
import {readFileSync} from "node:fs";
import {deviceKey,deviceLinkMessage,linkDevice,readCodeFromStdin,accountMatches} from "../src/device-link.js";

const CODE="ab".repeat(32);
const ID="12345678-1234-4234-8234-1234567890ab";
const NOW=Date.UTC(2026,9,21,12,0,0);

function memoryVault(){
 const store=new Map();
 return {read:n=>store.get(n)||null,write:(n,v)=>store.set(n,v),store};
}
function server({account="alice",linkStatus=200}={}){
 const calls=[];
 return {calls,fetchImpl:async(url,options)=>{
  calls.push({url,options,body:JSON.parse(options.body)});
  if(url.endsWith("pair-preview"))return new Response(JSON.stringify({account}),{status:200});
  return new Response("{}",{status:linkStatus});
 }};
}
const noLegacy=()=>null;

test("device key is created once in the vault and only the SPKI public key is exported",()=>{
 const vault=memoryVault();
 const a=deviceKey(vault),b=deviceKey(vault);
 assert.equal(a.publicKey,b.publicKey);
 assert.match(a.publicKey,/^MCowBQYDK2VwAyEA[A-Za-z0-9+/]{43}=$/);
 assert.equal(vault.store.size,1);
});

test("signed link sends code, installation id, public key and a verifiable signature only",async()=>{
 const vault=memoryVault(),s=server();
 const result=await linkDevice({code:CODE,account:"Alice",fetchImpl:s.fetchImpl,now:()=>NOW,
  legacy:noLegacy,installationId:()=>ID,key:()=>deviceKey(vault)});
 assert.equal(result.accepted,true);
 assert.equal(s.calls.length,2);
 const body=s.calls[1].body;
 assert.deepEqual(Object.keys(body).sort(),["code","installationId","publicKey","signature","signedAt"]);
 assert.equal(s.calls[1].url,"https://vibe.fde.fan/api/account?action=device-link");
 const pub=crypto.createPublicKey({key:Buffer.from(body.publicKey,"base64"),format:"der",type:"spki"});
 assert.equal(crypto.verify(null,Buffer.from(deviceLinkMessage(CODE,ID,body.signedAt)),pub,Buffer.from(body.signature,"base64")),true);
 assert.ok(!JSON.stringify(s.calls).includes(vault.store.values().next().value),"private key never sent");
});

test("a code for a different account is refused before any device proof is sent",async()=>{
 const s=server({account:"mallory"});
 const result=await linkDevice({code:CODE,account:"alice",fetchImpl:s.fetchImpl,
  legacy:noLegacy,installationId:()=>ID,key:()=>{throw new Error("key must not be read")}});
 assert.equal(result.accepted,false);
 assert.equal(result.reason,"pairing_code_belongs_to_another_account");
 assert.equal(s.calls.length,1);
});

test("legacy Beta installations prove with their existing bearer instead of a key",async()=>{
 const s=server();
 const token="vmb_"+"t".repeat(40);
 const result=await linkDevice({code:CODE,account:"alice",fetchImpl:s.fetchImpl,
  legacy:()=>({installationId:ID,token}),key:()=>{throw new Error("no key for legacy")}});
 assert.equal(result.accepted,true);
 assert.deepEqual(s.calls[1].body,{code:CODE,installationId:ID});
 assert.equal(s.calls[1].options.headers.authorization,"Bearer "+token);
});

test("server rejections map to stable reasons",async()=>{
 for(const [status,reason] of [[409,"code_used_or_device_already_linked"],[401,"device_proof_rejected"],[503,"account_linking_not_enabled"]]){
  const s=server({linkStatus:status});
  const r=await linkDevice({code:CODE,account:"alice",fetchImpl:s.fetchImpl,legacy:noLegacy,
   installationId:()=>ID,key:()=>deviceKey(memoryVault())});
  assert.equal(r.reason,reason);
 }
});

test("pairing code is read from stdin for non-interactive Agents and validated",async()=>{
 assert.equal(await readCodeFromStdin(Readable.from([CODE.toUpperCase()+"\n"])),CODE);
 await assert.rejects(readCodeFromStdin(Readable.from(["not-a-code"])),/invalid_pairing_code/);
 await assert.rejects(readCodeFromStdin(Readable.from(["a".repeat(2000)])),/invalid_pairing_code/);
});

test("account comparison is exact apart from case and surrounding space",()=>{
 assert.equal(accountMatches(" Alice@Example.org ","alice@example.org"),true);
 assert.equal(accountMatches("alice","alice2"),false);
 assert.equal(accountMatches("","alice"),false);
});

test("CLI rejects --code arguments and requires --account when not interactive",()=>{
 const cli=readFileSync(new URL("../src/cli.js",import.meta.url),"utf8");
 assert.match(cli,/Do not pass pairing codes via command arguments/);
 assert.match(cli,/--account is required/);
 assert.match(cli,/readCodeFromStdin\(\)/);
});
