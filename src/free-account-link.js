import crypto from "node:crypto";
import {spawnSync} from "node:child_process";
import path from "node:path";
import {vibeHome,safeJsonRead} from "./utils.js";
import {readSecret} from "./secure-store.js";
import {projectIdentity,findProjectRoot} from "./project.js";

const CODE=/^[0-9a-f]{64}$/i;
const UUID=/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const PROOF=/^[0-9a-f]{32}$/;
const ENDPOINT="https://vibe.fde.fan/api/account?action=free-device-accept";
const PREVIEW_ENDPOINT="https://vibe.fde.fan/api/account?action=free-pair-preview";
const LEGACY_ENDPOINT="https://vibe.fde.fan/api/account?action=legacy-beta-accept";
const GITHUB_LOGIN=/^[a-zA-Z0-9-]{1,39}$/;

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

// A Beta41 installation upgraded in place to public Free retains a private
// installation credential in its existing OS vault. No Free registration is
// necessary, and the legacy identity must never be inferred from a UUID alone.
export function localLegacyBetaIdentity(){
 const client=safeJsonRead(path.join(vibeHome(),"cloud","client.json"),null);
 const token=readSecret("cloud-installation-token");
 if(!UUID.test(client?.installationId||"")||
    typeof token!=="string"||!/^vmb_[A-Za-z0-9_-]{32,256}$/.test(token)||
    client?.baseUrl!== "https://vibe-api.fde.fan")
  return null;
 return {installationId:client.installationId,token};
}

export async function submitLegacyBetaAccountLink({
 code,identity,fetchImpl=fetch,timeoutMs=8000
}={}){
 if(!CODE.test(code||""))return {accepted:false,reason:"invalid_pairing_code"};
 if(!UUID.test(identity?.installationId||"")||
   !/^vmb_[A-Za-z0-9_-]{32,256}$/.test(identity?.token||""))
  return {accepted:false,reason:"legacy_installation_credential_unavailable"};
 try{
  const res=await fetchImpl(LEGACY_ENDPOINT,{
   method:"POST",redirect:"error",credentials:"omit",cache:"no-store",
   headers:{"content-type":"application/json",authorization:"Bearer "+identity.token},
   body:JSON.stringify({code:code.toLowerCase(),installationId:identity.installationId}),
   signal:AbortSignal.timeout(timeoutMs)
  });
  if(res.status===200)return {accepted:true,status:"waiting_for_web_confirmation"};
  if(res.status===409)return {accepted:false,reason:"legacy_credential_rejected_or_pairing_expired"};
  if(res.status===503)return {accepted:false,reason:"account_linking_not_enabled"};
  if(res.status===401)return {accepted:false,reason:"legacy_installation_credential_unavailable"};
  return {accepted:false,reason:"account_linking_unavailable"};
 }catch{return {accepted:false,reason:"account_linking_unavailable"};}
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

// A pairing code may be supplied by another user. Reveal the GitHub account
// it targets and require explicit local approval BEFORE releasing a project proof.
export async function previewFreeAccountPairing({code,fetchImpl=fetch,timeoutMs=8000}={}){
 if(!CODE.test(code||""))return {ok:false,reason:"invalid_pairing_code"};
 try{
  const res=await fetchImpl(PREVIEW_ENDPOINT,{
   method:"POST",redirect:"error",credentials:"omit",cache:"no-store",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({code:code.toLowerCase()}),
   signal:AbortSignal.timeout(timeoutMs)
  });
  if(res.status===503)return {ok:false,reason:"account_linking_not_enabled"};
  if(res.status!==200)return {ok:false,reason:"invalid_or_expired_pairing_code"};
  const data=await res.json();
  return GITHUB_LOGIN.test(data?.accountLogin||"")
   ?{ok:true,accountLogin:data.accountLogin}
   :{ok:false,reason:"invalid_pairing_response"};
 }catch{return {ok:false,reason:"account_linking_unavailable"};}
}
export function approvalMatchesGithubLogin(login,typed){
 return GITHUB_LOGIN.test(login||"") && typeof typed==="string" &&
   typed.trim().toLowerCase()===login.toLowerCase();
}
export async function linkFreeAccountFromWorkspace({
 code,cwd=process.cwd(),fetchImpl=fetch,confirmTarget
}={}){
 const preview=await previewFreeAccountPairing({code,fetchImpl});
 if(!preview.ok)return {accepted:false,reason:preview.reason};
 // No confirmation callback means deny: don't read the vault or reveal proof.
 if(typeof confirmTarget!=="function" ||
    await confirmTarget(preview.accountLogin)!==true)
  return {accepted:false,reason:"local_user_declined"};
 try{
  // This is the only accepted migration path for in-place Beta41 upgrades.
  // Its original credential is already known to the server as a SHA256 hash.
  const legacy=localLegacyBetaIdentity();
  if(legacy)return await submitLegacyBetaAccountLink({code,identity:legacy,fetchImpl});
  return await submitFreeAccountLink({
   code,identity:localFreeAccountIdentity({cwd}),fetchImpl
  });
 }catch(error){
  return {accepted:false,reason:error?.message||"local_free_identity_unavailable"};
 }
}


const AGENT_START="https://vibe.fde.fan/api/account?action=agent-start";
const AGENT_STATUS="https://vibe.fde.fan/api/account?action=agent-status";
const AGENT_URL=/^https:\/\/vibe\.fde\.fan\/app\/#connect=[a-f0-9]{64}$/;

export async function startAgentAccountLink({cwd=process.cwd(),fetchImpl=fetch,timeoutMs=10000}={}){
 const legacy=localLegacyBetaIdentity();
 let payload,authorization;
 if(legacy){
  payload={installationId:legacy.installationId};
  authorization="Bearer "+legacy.token;
 }else{
  try{payload=localFreeAccountIdentity({cwd})}
  catch{return {ok:false,reason:"local_installation_proof_unavailable"}}
 }
 try{
  const res=await fetchImpl(AGENT_START,{
   method:"POST",redirect:"error",credentials:"omit",cache:"no-store",
   headers:{"content-type":"application/json",...(authorization?{authorization}:{})},
   body:JSON.stringify(payload),signal:AbortSignal.timeout(timeoutMs)
  });
  if(res.status===503)return {ok:false,reason:"agent_link_not_enabled"};
  if(res.status===409)return {ok:false,reason:"already_linked_or_invalid_local_proof"};
  if(res.status===429)return {ok:false,reason:"agent_link_rate_limited"};
  if(res.status!==201)return {ok:false,reason:"agent_link_unavailable"};
  const data=await res.json();
  if(!AGENT_URL.test(data?.authorizationUrl||""))
   return {ok:false,reason:"invalid_authorization_url"};
  return {ok:true,authorizationUrl:data.authorizationUrl,expiresAt:data.expiresAt};
 }catch{return {ok:false,reason:"agent_link_unavailable"};}
}

export async function agentAccountLinkStatus({
 ticket,fetchImpl=fetch,timeoutMs=8000
}={}){
 if(!CODE.test(ticket||""))return {status:"invalid"};
 try{
  const res=await fetchImpl(AGENT_STATUS,{
   method:"POST",redirect:"error",credentials:"omit",cache:"no-store",
   headers:{"content-type":"application/json"},
   body:JSON.stringify({ticket:ticket.toLowerCase()}),
   signal:AbortSignal.timeout(timeoutMs)
  });
  if(res.status!==200)return {status:"unavailable"};
  const data=await res.json();
  return ["invalid","pending","linked","expired"].includes(data?.status)
    ?{status:data.status}:{status:"unavailable"};
 }catch{return {status:"unavailable"};}
}

export function approvedAgentAccountUrl(url){
 return AGENT_URL.test(url||"");
}

export function openAgentAccountBrowser(url,{exec=spawnSync,platform=process.platform}={}){
 if(!approvedAgentAccountUrl(url))return false;
 const executable=platform==="darwin"?"open":platform==="win32"?"rundll32.exe":"xdg-open";
 const options=platform==="win32"
  ?["url.dll,FileProtocolHandler",url]:[url];
 try{
  const response=exec(executable,options,{windowsHide:true,stdio:"ignore",
   shell:false,timeout:3000});
  return response?.status===0;
 }catch{return false;}
}
