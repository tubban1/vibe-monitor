import crypto from "node:crypto";
import path from "node:path";
import {vibeHome,safeJsonRead} from "./utils.js";
import {readSecret,writeSecret} from "./secure-store.js";

// Unified account link: the browser mints a one-time code, the user's Agent
// runs `account link --account <name>` with the code on stdin, and this
// installation proves itself with an Ed25519 key kept in the OS vault.
// Only the public key, installation ID and a signature leave this machine.
const BASE="https://vibe.fde.fan/api/account?action=";
const CODE=/^[0-9a-f]{64}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const KEY_NAME="device-link-ed25519-pkcs8";

export const deviceLinkMessage=(code,installationId,signedAt)=>
 "vibe-monitor-device-link-v1\n"+crypto.createHash("sha256").update(code.toLowerCase()).digest("hex")+
 "\n"+installationId.toLowerCase()+"\n"+signedAt;

export function deviceKey({read=readSecret,write=writeSecret}={}){
 const stored=read(KEY_NAME);
 let privateKey;
 if(typeof stored==="string"&&stored.length>0){
  privateKey=crypto.createPrivateKey({key:Buffer.from(stored,"base64url"),format:"der",type:"pkcs8"});
 }else{
  ({privateKey}=crypto.generateKeyPairSync("ed25519"));
  write(KEY_NAME,privateKey.export({type:"pkcs8",format:"der"}).toString("base64url"));
 }
 const publicKey=crypto.createPublicKey(privateKey).export({type:"spki",format:"der"}).toString("base64");
 return {privateKey,publicKey};
}

// An upgraded Beta41 installation keeps its private installation credential
// in the OS vault; the server already knows it as a SHA-256 hash.
export function localLegacyBetaIdentity(){
 const client=safeJsonRead(path.join(vibeHome(),"cloud","client.json"),null);
 const token=readSecret("cloud-installation-token");
 if(!UUID.test(client?.installationId||"")||
    typeof token!=="string"||!/^vmb_[A-Za-z0-9_-]{32,256}$/.test(token)||
    client?.baseUrl!=="https://vibe-api.fde.fan")
  return null;
 return {installationId:client.installationId,token};
}

export function localInstallationId(){
 const identity=safeJsonRead(path.join(vibeHome(),"free-telemetry","identity.json"),null);
 return UUID.test(identity?.installationId||"")?identity.installationId:null;
}

export function accountMatches(expected,actual){
 return typeof expected==="string"&&typeof actual==="string"&&expected.trim().length>0&&
  expected.trim().toLowerCase()===actual.trim().toLowerCase();
}

export async function readCodeFromStdin(input=process.stdin,limit=1024){
 let text="";
 for await(const chunk of input){
  text+=chunk;
  if(text.length>limit)throw new Error("invalid_pairing_code");
 }
 const code=text.trim();
 if(!CODE.test(code))throw new Error("invalid_pairing_code");
 return code.toLowerCase();
}

async function post(fetchImpl,action,body,headers={},timeoutMs=8000){
 return fetchImpl(BASE+action,{method:"POST",redirect:"error",credentials:"omit",cache:"no-store",
  headers:{"content-type":"application/json",...headers},body:JSON.stringify(body),
  signal:AbortSignal.timeout(timeoutMs)});
}

export async function previewPairing({code,fetchImpl=fetch}){
 try{
  const res=await post(fetchImpl,"pair-preview",{code});
  if(res.status===503)return {ok:false,reason:"account_linking_not_enabled"};
  if(res.status!==200)return {ok:false,reason:"invalid_or_expired_pairing_code"};
  const data=await res.json();
  return typeof data?.account==="string"?{ok:true,account:data.account}:{ok:false,reason:"invalid_pairing_response"};
 }catch{return {ok:false,reason:"account_linking_unavailable"};}
}

// The pairing code is not consent: refuse unless the code's account is the
// one the user named, BEFORE any installation proof is sent.
export async function linkDevice({code,account,fetchImpl=fetch,now=()=>Date.now(),
 legacy=localLegacyBetaIdentity,installationId=localInstallationId,key=deviceKey}={}){
 if(!CODE.test(code||""))return {accepted:false,reason:"invalid_pairing_code"};
 const preview=await previewPairing({code,fetchImpl});
 if(!preview.ok)return {accepted:false,reason:preview.reason};
 if(!accountMatches(account,preview.account))
  return {accepted:false,reason:"pairing_code_belongs_to_another_account",account:preview.account};
 let body,headers={};
 const beta=legacy();
 if(beta){
  body={code,installationId:beta.installationId};
  headers.authorization="Bearer "+beta.token;
 }else{
  const id=installationId();
  if(!id)return {accepted:false,reason:"installation_identity_not_found"};
  const {privateKey,publicKey}=key();
  const signedAt=new Date(now()).toISOString();
  const signature=crypto.sign(null,Buffer.from(deviceLinkMessage(code,id,signedAt)),privateKey).toString("base64");
  body={code,installationId:id,publicKey,signedAt,signature};
 }
 try{
  const res=await post(fetchImpl,"device-link",body,headers);
  if(res.status===200)return {accepted:true,account:preview.account,status:"waiting_for_web_confirmation"};
  if(res.status===409)return {accepted:false,reason:"code_used_or_device_already_linked"};
  if(res.status===401)return {accepted:false,reason:"device_proof_rejected"};
  if(res.status===503)return {accepted:false,reason:"account_linking_not_enabled"};
  return {accepted:false,reason:"account_linking_unavailable"};
 }catch{return {accepted:false,reason:"account_linking_unavailable"};}
}
