// Public client verifies the NEW vms_ bearer. Never read old vmb_ credentials.
import fs from "node:fs";
import path from "node:path";
import {atomicJsonWrite,safeJsonRead,vibeHome} from "./utils.js";
import {readSecret} from "./secure-store.js";
const termsHash="d829b3c238d1543bb810e29b2ac4d13095144a99f83581d13cab36634a64299b";
const uuid=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const file=(...parts)=>path.join(vibeHome(),...parts);
const receiptFile=()=>file("migration","stable-handoff-verified.json");
function activeContext(){
 const b=safeJsonRead(file("cloud","client.json"),null);
 const j=safeJsonRead(file("migration","beta-stable.json"),null);
 const c=safeJsonRead(file("migration","stable-migration-consent.json"),null);
 const d=safeJsonRead(file("device.json"),null);
 if(!uuid(b?.installationId)||!uuid(b?.deviceId)||!uuid(j?.stableInstallationId)||
  !uuid(d?.deviceId)||j.phase!=="active"||j.legacyInstallationId!==b.installationId||
  j.deviceId!==b.deviceId||d.deviceId!==b.deviceId||
  c?.schemaVersion!==1||c.consentVersion!=="stable-migration-v1"||c.termsSha256!==termsHash||
  !Number.isFinite(Date.parse(c.acceptedAt))||Date.parse(c.acceptedAt)>Date.now()+60_000||c.legacyInstallationId!==b.installationId||
  c.deviceId!==d.deviceId)return null;
 return {legacyInstallationId:b.installationId,stableInstallationId:j.stableInstallationId,deviceId:d.deviceId};
}
export function verifiedBetaHandoffInstalled(){
 if(!fs.existsSync(file("cloud","client.json")))return false;
 const ctx=activeContext(),receipt=safeJsonRead(receiptFile(),null);
 const current=safeJsonRead(file("runtime","current.json"),null);
 return Boolean(ctx&&receipt?.schemaVersion===1&&receipt.status==="active"&&
  receipt.legacyInstallationId===ctx.legacyInstallationId&&
  receipt.stableInstallationId===ctx.stableInstallationId&&receipt.deviceId===ctx.deviceId&&
  current&&["version","local"].includes(current.type)&&
  typeof current.version==="string"&&/^1[.]\d+[.]\d+(?:-[\w.-]+)?$/.test(current.version)&&
  (current.type==="local"
   ? typeof current.entry==="string"&&fs.existsSync(current.entry)
   : fs.existsSync(file("runtime","versions",current.version,
       "node_modules","@vibe-monitor","setup","dist","vibe-monitor.mjs"))));
}
export async function verifyAndRecordActiveBetaHandoff({fetchImpl=globalThis.fetch}={}){
 const ctx=activeContext();
 if(!ctx)return false;
 const token=readSecret("stable-installation-token"); // never old Beta credential
 if(typeof token!=="string"||!/^vms_[A-Za-z0-9_-]{43}$/.test(token))return false;
 try{
  const response=await fetchImpl("https://vibe-api.fde.fan/migration/beta/verify",{
   method:"POST",redirect:"error",cache:"no-store",
   headers:{authorization:"Bearer "+token,"content-type":"application/json",accept:"application/json"},
   body:JSON.stringify({stableInstallationId:ctx.stableInstallationId,deviceId:ctx.deviceId}),
   signal:AbortSignal.timeout(8000)
  });
  if(!response?.ok||response.redirected||
     Number(response.headers.get("content-length")||0)>2048)return false;
  const text=await response.text();
  if(Buffer.byteLength(text)>2048)return false;
  const proof=JSON.parse(text);
  if(proof?.status!=="active"||proof.legacyInstallationId!==ctx.legacyInstallationId||
   proof.stableInstallationId!==ctx.stableInstallationId||proof.deviceId!==ctx.deviceId)return false;
  atomicJsonWrite(receiptFile(),{schemaVersion:1,status:"active",...ctx,verifiedAt:new Date().toISOString()});
  return true;
 }catch{return false;}
}
