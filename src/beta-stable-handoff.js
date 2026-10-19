// Public stable client verifies a new Stable identity before taking over a
// registered Beta installation. The old Beta credential is used only inside
// the explicit --migrate-beta flow and is never copied into Stable state.
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import {atomicJsonWrite,safeJsonRead,vibeHome} from "./utils.js";
import {readSecret,writeSecret,verifyCredentialStore} from "./secure-store.js";

const uuid=x=>typeof x==="string"&&/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(x);
const file=(...parts)=>path.join(vibeHome(),...parts);
const receiptFile=()=>file("migration","stable-handoff-verified.json");
const validStableToken=x=>typeof x==="string"&&/^vms_[A-Za-z0-9_-]{43}$/.test(x);
const validLegacyToken=x=>typeof x==="string"&&/^vmb_[A-Za-z0-9_-]{16,256}$/.test(x);

function activeContext(){
 const beta=safeJsonRead(file("cloud","client.json"),null);
 const journal=safeJsonRead(file("migration","beta-stable.json"),null);
 const device=safeJsonRead(file("device.json"),null);
 if(!uuid(beta?.installationId)||!uuid(beta?.deviceId)||!uuid(journal?.stableInstallationId)||
  !uuid(device?.deviceId)||journal.phase!=="active"||
  journal.legacyInstallationId!==beta.installationId||
  journal.deviceId!==beta.deviceId||device.deviceId!==beta.deviceId||
  !Number.isFinite(Date.parse(journal.approvedAt))||
  Date.parse(journal.approvedAt)>Date.now()+60_000)return null;
 return {legacyInstallationId:beta.installationId,
  stableInstallationId:journal.stableInstallationId,deviceId:device.deviceId};
}

export function verifiedBetaHandoffInstalled(){
 if(!fs.existsSync(file("cloud","client.json")))return false;
 const ctx=activeContext(),receipt=safeJsonRead(receiptFile(),null);
 const current=safeJsonRead(file("runtime","current.json"),null);
 return Boolean(ctx&&receipt?.schemaVersion===1&&receipt.status==="active"&&
  receipt.legacyInstallationId===ctx.legacyInstallationId&&
  receipt.stableInstallationId===ctx.stableInstallationId&&
  receipt.deviceId===ctx.deviceId&&
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
 const token=readSecret("stable-installation-token");
 if(!validStableToken(token))return false;
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
   proof.stableInstallationId!==ctx.stableInstallationId||
   proof.deviceId!==ctx.deviceId)return false;
  atomicJsonWrite(receiptFile(),{schemaVersion:1,status:"active",...ctx,
   verifiedAt:new Date().toISOString()});
  return true;
 }catch{return false;}
}

async function migrationPost(route,token,body,fetchImpl){
 const response=await fetchImpl("https://vibe-api.fde.fan/migration/beta/"+route,{
  method:"POST",redirect:"error",cache:"no-store",
  headers:{authorization:"Bearer "+token,"content-type":"application/json",accept:"application/json"},
  body:JSON.stringify(body),signal:AbortSignal.timeout(8000)
 });
 if(!response?.ok||response.redirected||
    Number(response.headers.get("content-length")||0)>4096)
  throw Error("beta_migration_service_unavailable");
 const raw=await response.text();
 if(Buffer.byteLength(raw)>4096)throw Error("beta_migration_response_invalid");
 const data=JSON.parse(raw);
 if(!data||typeof data!=="object")throw Error("beta_migration_response_invalid");
 return data;
}

export async function migrateRegisteredBetaToStable({fetchImpl=globalThis.fetch}={}){
 verifyCredentialStore();
 const beta=safeJsonRead(file("cloud","client.json"),null);
 const device=safeJsonRead(file("device.json"),null);
 if(!uuid(beta?.installationId)||!uuid(beta?.deviceId)||device?.deviceId!==beta.deviceId)
  throw Error("registered_beta_device_required");
 const base=String(beta.baseUrl||"").replace(/\/+$/,"");
 if(base!=="https://vibe-api.fde.fan")throw Error("official_migration_origin_required");

 const oldToken=readSecret("cloud-installation-token")||beta.token;
 if(!validLegacyToken(oldToken))throw Error("legacy_beta_credential_missing");

 const journalFile=file("migration","beta-stable.json");
 let journal=safeJsonRead(journalFile,null);
 if(journal?.legacyInstallationId&&journal.legacyInstallationId!==beta.installationId)
  throw Error("migration_identity_conflict");
 if(journal?.phase==="active"){
  if(await verifyAndRecordActiveBetaHandoff({fetchImpl}))return true;
  throw Error("active_handoff_verification_failed");
 }

 const approvedAt=new Date().toISOString();
 let token=readSecret("stable-installation-token");
 if(journal?.phase!=="prepared"||!validStableToken(token)||
    Date.parse(journal.expiresAt||"")<=Date.now()+5000){
  const nonce=crypto.randomUUID();
  journal={schemaVersion:1,phase:"preparing",
   legacyInstallationId:beta.installationId,
   stableInstallationId:journal?.stableInstallationId||null,
   deviceId:device.deviceId,requestNonce:nonce,approvedAt};
  atomicJsonWrite(journalFile,journal);

  const prepared=await migrationPost("prepare",oldToken,
   {deviceId:device.deviceId,nonce},fetchImpl);
  if(prepared.status!=="prepared"||
     prepared.legacyInstallationId!==beta.installationId||
     !uuid(prepared.stableInstallationId)||
     !validStableToken(prepared.stableToken)||
     !Number.isFinite(Date.parse(prepared.expiresAt))||
     Date.parse(prepared.expiresAt)<=Date.now())
    throw Error("beta_migration_prepare_invalid");

  writeSecret("stable-installation-token",prepared.stableToken);
  if(readSecret("stable-installation-token")!==prepared.stableToken)
    throw Error("stable_vault_roundtrip_failed");
  token=prepared.stableToken;
  journal={...journal,phase:"prepared",
   stableInstallationId:prepared.stableInstallationId,
   preparedAt:new Date().toISOString(),expiresAt:prepared.expiresAt};
  atomicJsonWrite(journalFile,journal);
 }else if(!Number.isFinite(Date.parse(journal.approvedAt))){
  journal={...journal,approvedAt};
  atomicJsonWrite(journalFile,journal);
 }

 if(journal.legacyInstallationId!==beta.installationId||
    journal.deviceId!==device.deviceId||
    !uuid(journal.stableInstallationId))
  throw Error("beta_migration_state_invalid");

 const activated=await migrationPost("activate",token,
  {stableInstallationId:journal.stableInstallationId},fetchImpl);
 if(activated.status!=="active"||
    activated.legacyInstallationId!==beta.installationId||
    activated.stableInstallationId!==journal.stableInstallationId)
  throw Error("beta_migration_activation_invalid");

 atomicJsonWrite(journalFile,{...journal,phase:"active",
  activatedAt:new Date().toISOString()});
 if(!await verifyAndRecordActiveBetaHandoff({fetchImpl}))
  throw Error("beta_migration_identity_not_verified");
 return true;
}
