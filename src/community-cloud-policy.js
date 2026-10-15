// Transient Cloud-issued public-client baseline strategy, not a plan/tier.
// Canonical Free policy URL. Historical community-named Ed25519 key IDs and
// audience are internal protocol identifiers, NOT a Community subscription.
// No Community subscription and no legacy HTTP route are offered.
// No disk storage, no credential,
// policy JSON or signed payload persistence. Cache lives only in process memory.
import {verify,createPublicKey} from "node:crypto";
import {sanitizeRemotePolicy} from "./policy-sanitizer.js";
import {POLICY_V2_FAMILIES} from "./decision-policy.js";
export const COMMUNITY_POLICY_URL="https://vibe-api.fde.fan/free/policy";
export const COMMUNITY_POLICY_KEY_ID="community-ed25519-v1";
export const COMMUNITY_POLICY_NEXT_KEY_ID="community-ed25519-v2";
// Both trust anchors stay OFF until audited build-time provisioning.
export const COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM=null;
export const COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM=null;
const MAX_AGE=3600; // signed policy can live at most one hour, RAM only
const REFRESH=900;  // refresh from Cloud after fifteen minutes
const MAX_BYTES=16384;
// Bound tiny or empty streamed fragments too: a bytes-only limit cannot
// constrain CPU and parts-array growth from infinitely many zero-byte chunks.
const MAX_CHUNKS=4096;
// Reject oversized signed policy documents during streaming, before allocating
// an unbounded response.text() body.
async function readBoundedPolicyResponse(response){
 const claimed=Number(response.headers?.get?.("content-length")||0);
 if(Number.isFinite(claimed)&&claimed>MAX_BYTES)throw Error("policy_oversized");
 if(response.body&&typeof response.body[Symbol.asyncIterator]==="function"){
  const parts=[];
  let count=0,chunks=0;
  for await(const chunk of response.body){
   if(++chunks>MAX_CHUNKS)throw Error("policy_oversized");
   const length=Number(chunk?.byteLength);
   if(Number.isFinite(length)&&length>=0&&count+length>MAX_BYTES)
    throw Error("policy_oversized");
   const bytes=Buffer.from(chunk);
   count+=bytes.length;
   if(count>MAX_BYTES)throw Error("policy_oversized");
   parts.push(bytes);
  }
  return Buffer.concat(parts,count).toString("utf8");
 }
 // Narrow fallback for deterministic test doubles with no native stream.
 const raw=await response.text();
 if(Buffer.byteLength(raw)>MAX_BYTES)throw Error("policy_oversized");
 return raw;
}
const TRUE_FAMILIES=Object.freeze(Object.fromEntries(POLICY_V2_FAMILIES.map(f=>[f,true])));
export const COMMUNITY_SAFE_POLICY=Object.freeze({
 enabled:true,source:"local-baseline",reason:null,profile:"baseline",
 version:"local-v1",update:{enabled:false},
 config:{checkpointMinIntervalSec:180,fullScanMinIntervalSec:300,
  maxNoticesPerSession:2,unchangedNoticeReminderHours:168,
  enabledMonitors:TRUE_FAMILIES,decisionPolicy:null}
});
const obj=o=>o!==null&&typeof o==="object"&&!Array.isArray(o)&&Object.getPrototypeOf(o)===Object.prototype;
const hasOnly=(o,keys)=>obj(o)&&Object.keys(o).every(k=>keys.includes(k));
const sec=now=>Math.floor(now()/1000);
export function verifyCommunityPolicyEnvelope(e,{publicKeyPem,publicKeysById=null,now=Date.now}={}){
 const n=sec(now),p=e?.payload;
 const supported=[COMMUNITY_POLICY_KEY_ID,COMMUNITY_POLICY_NEXT_KEY_ID];
 // An envelope must never supply or select its own trust root.
 const keys=publicKeysById===null?{[COMMUNITY_POLICY_KEY_ID]:publicKeyPem}:publicKeysById;
 const trustedPem=obj(keys)&&supported.includes(e?.keyId)?keys[e.keyId]:null;
 if(!Number.isSafeInteger(n)||!hasOnly(e,["payload","keyId","signature"])||
  !supported.includes(e.keyId)||typeof e.signature!=="string"||
  !/^[A-Za-z0-9_-]{86}$/.test(e.signature)||
  !hasOnly(p,["schemaVersion","audience","revision","issuedAt","expiresAt","config"])||
  p.schemaVersion!==1||p.audience!=="vibe-monitor-community"||
  !Number.isSafeInteger(p.revision)||p.revision<1||
  !Number.isSafeInteger(p.issuedAt)||!Number.isSafeInteger(p.expiresAt)||
  p.issuedAt>n+60||p.issuedAt<n-MAX_AGE-60||
  p.expiresAt<=n||p.expiresAt-p.issuedAt>MAX_AGE||
  !hasOnly(p.config,["checkpointMinIntervalSec","fullScanMinIntervalSec",
   "maxNoticesPerSession","unchangedNoticeReminderHours","decisionPolicy","enabledMonitors"])||
  typeof trustedPem!=="string")return null;
 try{
  const key=createPublicKey(trustedPem);
  if(key.asymmetricKeyType!=="ed25519"||
   !verify(null,Buffer.from(JSON.stringify(p)),key,Buffer.from(e.signature,"base64url")))return null;
  const raw=p.config,bounded=sanitizeRemotePolicy(raw);
  if(raw.decisionPolicy!=null&&!bounded.decisionPolicy)return null;
  if(raw.enabledMonitors!=null&&(!hasOnly(raw.enabledMonitors,POLICY_V2_FAMILIES)||
   Object.values(raw.enabledMonitors).some(x=>typeof x!=="boolean")))return null;
  return {enabled:true,source:"cloud-signed-baseline",reason:null,
   profile:"baseline",revision:p.revision,version:"cloud-v1:"+p.revision,
   update:{enabled:false},config:{
    checkpointMinIntervalSec:Math.max(180,bounded.checkpointMinIntervalSec),
    fullScanMinIntervalSec:Math.max(300,bounded.fullScanMinIntervalSec),
    maxNoticesPerSession:Math.min(2,bounded.maxNoticesPerSession),
    unchangedNoticeReminderHours:bounded.unchangedNoticeReminderHours,
    enabledMonitors:TRUE_FAMILIES,decisionPolicy:bounded.decisionPolicy}};
 }catch{return null;}
}

// Each instance models an isolated client process. A fresh process has NO
// downloaded strategy, even if an earlier process accepted a signed policy.
export function createCommunityPolicyClient(){
 let cached=null;
 let lastObservedSec=null;
 return async function fetchCommunityCloudPolicyForProcess({
  fetchImpl=globalThis.fetch,publicKeyPem=COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM,
  publicKeysById=null,now=Date.now,force=false
 }={}){
  const current=sec(now);
  const keys=publicKeysById===null?{
   [COMMUNITY_POLICY_KEY_ID]:publicKeyPem,
   [COMMUNITY_POLICY_NEXT_KEY_ID]:COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM
  }:publicKeysById;
  const trustSet=obj(keys)?JSON.stringify([
   keys[COMMUNITY_POLICY_KEY_ID]??null,keys[COMMUNITY_POLICY_NEXT_KEY_ID]??null
  ]):"untrusted";
  if(!Number.isSafeInteger(current)||current<=0)return COMMUNITY_SAFE_POLICY;
  // A backwards local clock jump must not revive an old signed policy.
  if(lastObservedSec!==null&&current<lastObservedSec-60)cached=null;
  lastObservedSec=current;
  let effective=null;
  if(cached&&cached.trustSet===trustSet&&current>=cached.acceptedAt-60&&
    current>=cached.fetchedAt-60&&current-cached.acceptedAt<=MAX_AGE){
   const verified=verifyCommunityPolicyEnvelope(cached.envelope,{publicKeysById:keys,now});
   if(verified)effective={...verified,source:"memory-signed-baseline"};
  }
  if(!effective)cached=null;
  if(!force&&effective&&current-cached.fetchedAt<REFRESH)return effective;
  if(!obj(keys)||![COMMUNITY_POLICY_KEY_ID,COMMUNITY_POLICY_NEXT_KEY_ID].some(id=>typeof keys[id]==="string")||
   typeof fetchImpl!=="function")
   return effective||COMMUNITY_SAFE_POLICY;
  try{
   const response=await fetchImpl(COMMUNITY_POLICY_URL,{
    method:"GET",headers:{accept:"application/json"},cache:"no-store",
    redirect:"error",signal:AbortSignal.timeout(1500)
   });
   if(!response?.ok||Number(response.headers?.get?.("content-length")||0)>MAX_BYTES)
    throw Error("cloud_unavailable");
   const raw=await readBoundedPolicyResponse(response);
   const envelope=JSON.parse(raw);
   const validated=verifyCommunityPolicyEnvelope(envelope,{publicKeysById:keys,now});
   if(!validated||(effective&&validated.revision<effective.revision))
    throw Error("invalid_signed_policy_or_rollback");
   cached={envelope,trustSet,acceptedAt:current,fetchedAt:current};
   return validated;
  }catch{return effective||COMMUNITY_SAFE_POLICY;}
 };
}
export const fetchCommunityCloudPolicy=createCommunityPolicyClient();
