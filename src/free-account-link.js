import crypto from "node:crypto";
import path from "node:path";
import {vibeHome,safeJsonRead} from "./utils.js";
import {readSecret} from "./secure-store.js";
import {projectIdentity,findProjectRoot} from "./project.js";

const CODE=/^[0-9a-f]{64}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROOF=/^[0-9a-f]{32}$/;
const ENDPOINT="https://vibe.fde.fan/api/account?action=free-device-accept";

// This proof matches a secret-derived anonymous project pseudonym already
// received by Vibe Monitor BEFORE the legacy enrollment cutoff.
// Without historical evidence the server will refuse the claim.
// No source, path, token or secret is sent to the account service.
export function freeProjectProof({installationId,secret,projectInstanceId}={}){
 if(!UUID.test(installationId||"")||typeof secret!=="string"||secret.length<32||
    !/^[0-9a-f]{16}$/.test(projectInstanceId||""))
  throw new Error("local_free_identity_unavailable");
 return {
  installationId,
  projectProof:crypto.createHmac("sha256",secret)
    .update(projectInstanceId).digest("hex").slice(0,32)
 };
}

export function localFreeAccountIdentity({cwd=process.cwd()}={}){
 const identity=safeJsonRead(path.join(vibeHome(),"free-telemetry","identity.json"),null);
 // Never auto-create or replace an identity while linking an existing install.
 if(!identity?.installationId||!UUID.test(identity.installationId))
  throw new Error("free_installation_identity_not_found");
 const secret=readSecret("free-telemetry-hmac-secret");
 if(typeof secret!=="string"||secret.length<32)
  throw new Error("free_installation_secret_not_found");
 const root=findProjectRoot(cwd);
 const project=projectIdentity(root);
 return freeProjectProof({installationId:identity.installationId,
  secret,projectInstanceId:project.projectInstanceId});
}

export async function submitFreeAccountLink({
 code,identity,fetchImpl=fetch,timeoutMs=8000
}={}){
 if(!CODE.test(code||""))return {accepted:false,reason:"invalid_pairing_code"};
 if(!identity||!UUID.test(identity.installationId||"")||
    !PROOF.test(identity.projectProof||""))
  return {accepted:false,reason:"local_free_identity_unavailable"};
 try{
  const res=await fetchImpl(ENDPOINT,{
   method:"POST",redirect:"error",credentials:"omit",cache:"no-store",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({code:code.toLowerCase(),installationId:identity.installationId,
     projectProof:identity.projectProof}),
   signal:AbortSignal.timeout(timeoutMs)
  });
  if(res.status===200)return {accepted:true,status:"waiting_for_web_confirmation"};
  if(res.status===409)return {accepted:false,reason:"no_verified_historical_project_or_pairing_expired"};
  if(res.status===503)return {accepted:false,reason:"account_linking_not_enabled"};
  if(res.status===400)return {accepted:false,reason:"invalid_pairing_request"};
  return {accepted:false,reason:"account_linking_unavailable"};
 }catch{return {accepted:false,reason:"account_linking_unavailable"};}
}

export async function linkFreeAccountFromWorkspace({code,cwd=process.cwd(),fetchImpl=fetch}={}){
 return submitFreeAccountLink({
   code,identity:localFreeAccountIdentity({cwd}),fetchImpl
 });
}
