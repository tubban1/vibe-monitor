import dns from "node:dns/promises";
import net from "node:net";
import tls from "node:tls";
import { DEFAULT_CLOUD_URL } from "./constants.js";

// This is intentionally a fixed allowlist, not a user-supplied redirect target.
// Each endpoint is operated by Vibe Monitor and must return the Vibe health identity.
export const OFFICIAL_INSTALL_ENDPOINTS = Object.freeze([
  DEFAULT_CLOUD_URL,
  "https://vibe-monitor-gateway.vibe-monitor-lab.workers.dev",
  "https://br-old-dust-b35rmjhz-vibe.compute.c-4.ap-southeast-1.aws.neon.tech"
]);
const RETRYABLE_HTTP = new Set([502, 503, 504]);
const DNS_CODES = new Set(["EAI_AGAIN", "ENOTFOUND", "EAI_FAIL", "ENODATA"]);
const TCP_CODES = new Set(["UND_ERR_CONNECT_TIMEOUT", "ETIMEDOUT", "ECONNREFUSED", "ENETUNREACH", "EHOSTUNREACH"]);
// These errors indicate an untrusted issuer/chain. Corporate HTTPS inspection
// (Sangfor, Zscaler, Netskope, etc.) is one possible cause, not a proven diagnosis.
const UNTRUSTED_CA_CODES = new Set([
  "DEPTH_ZERO_SELF_SIGNED_CERT", "SELF_SIGNED_CERT_IN_CHAIN",
  "UNABLE_TO_VERIFY_LEAF_SIGNATURE", "UNABLE_TO_GET_ISSUER_CERT",
  "UNABLE_TO_GET_ISSUER_CERT_LOCALLY", "CERT_UNTRUSTED"
]);
const TLS_CODES = new Set(["CERT_HAS_EXPIRED", "ERR_TLS_CERT_ALTNAME_INVALID",
  "ERR_SSL_SSLV3_ALERT_HANDSHAKE_FAILURE"]);
export function networkErrorCode(error) {
  const seen = new Set();
  const visit = (err) => {
    if (!err || typeof err !== "object" || seen.has(err)) return null;
    seen.add(err);
    if (typeof err.code === "string" && err.code.length < 80) return err.code;
    for (const nested of [err.cause, ...(Array.isArray(err.errors) ? err.errors : [])]) {
      const found = visit(nested);
      if (found) return found;
    }
    return null;
  };
  return visit(error);
}
export function classifyNetworkError({code, status, reason} = {}) {
  if (DNS_CODES.has(code)) return "dns_failure";
  if (UNTRUSTED_CA_CODES.has(code)) return "tls_untrusted_ca";
  if (TLS_CODES.has(code) || String(code||"").startsWith("ERR_TLS") || String(code||"").startsWith("ERR_SSL")) return "tls_failure";
  if (TCP_CODES.has(code)) return "tcp_timeout";
  if (code === "TIMEOUT" || code === "ABORT_ERR" || code === "UND_ERR_HEADERS_TIMEOUT") return "https_timeout";
  if (RETRYABLE_HTTP.has(status)) return "gateway_unreachable";
  if (status) return "http_error";
  if (reason === "invalid_cloud_identity") return "invalid_cloud_identity";
  return "network_error";
}
export function officialInstallCandidates(baseUrl) {
  const first=String(baseUrl||"").trim().replace(/\/+$/, "");
  // Never override explicit/custom URLs with an unrelated cloud.
  if(first !== DEFAULT_CLOUD_URL) return first ? [first] : [];
  return [...new Set(OFFICIAL_INSTALL_ENDPOINTS)];
}
export async function resolveInstallEndpoint({baseUrl, probe, timeoutMs=6500, attempts=2, diagnose=diagnoseInstallNetwork, onProgress} = {}) {
  const candidates=officialInstallCandidates(baseUrl);
  if (!candidates.length) return {ok:false,reason:"cloud_url_required",category:"network_error",tried:0};
  let last={ok:false,reason:"cloud_preflight_failed"};
  let primaryCategory=null;
  let attempted=0;
  for (let index=0;index<candidates.length;index++) {
    const candidate=candidates[index];
    onProgress?.({phase:"attempt",index,count:candidates.length});
    attempted++;
    const r=await probe({baseUrl:candidate,timeoutMs,attempts:index===0?attempts:1});
    if(r.ok) {
      if(r.service !== "vibe-monitor-beta") {
        last={ok:false,reason:"invalid_cloud_identity",networkCode:"INVALID_CLOUD_IDENTITY"};
        break; // never fail open on wrong service identity
      }
      onProgress?.({phase:"connected",index});
      return {...r,baseUrl:candidate,usedFallback:index>0,tried:index+1};
    }
    last=r;
    const category=classifyNetworkError({code:r.networkCode,status:r.status,reason:r.reason});
    if (category === "tls_untrusted_ca" || category === "tls_failure") primaryCategory = category;
    else primaryCategory ||= category;
    // Never route around enterprise HTTPS inspection or an untrusted certificate.
    // A failed chain must be fixed, not bypassed through a different hostname.
    if (category === "tls_untrusted_ca" || category === "tls_failure") break;
    if (r.status && !RETRYABLE_HTTP.has(r.status)) break;
    if (r.reason === "invalid_cloud_identity") break;
  }
  const diagnostics = diagnose && primaryCategory !== "tls_untrusted_ca" &&
    primaryCategory !== "tls_failure" ? await diagnose({baseUrl:candidates[0],last}) : null;
  return {...last,ok:false,category:diagnostics?.category || primaryCategory || "network_error",
    diagnostic:diagnostics?.category || primaryCategory || "network_error",tried:attempted};
}
async function bounded(promise, ms) {
  let timer;
  try {
    return await Promise.race([
      promise,
      new Promise((_,reject)=>{timer=setTimeout(()=>reject(Object.assign(new Error("probe_timeout"),{code:"ETIMEDOUT"})),ms);})
    ]);
  } finally { clearTimeout(timer); }
}
function connectSocket(host, {secure=false, timeoutMs=2300}={}) {
  return new Promise((resolve,reject)=>{
    const socket=secure
      ? tls.connect({host,port:443,servername:host,rejectUnauthorized:true})
      : net.connect({host,port:443});
    let done=false;
    const finish=(error)=>{
      if(done)return;done=true;socket.destroy();error?reject(error):resolve(true);
    };
    socket.setTimeout(timeoutMs,()=>finish(Object.assign(new Error("tcp_timeout"),{code:"ETIMEDOUT"})));
    socket.once("error",finish);
    socket.once(secure?"secureConnect":"connect",()=>finish(null));
  });
}
// Diagnose only after all official gateways failed. Never print an IP, proxy credentials,
// local paths or certificate contents. These are diagnostic hints, not hard gates.
export async function diagnoseInstallNetwork({baseUrl,last,lookup=dns.lookup,connect=connectSocket}={}) {
  let host;
  try{host=new URL(baseUrl).hostname;}catch{return {category:"network_error"};}
  const classified=classifyNetworkError({code:last?.networkCode,status:last?.status,reason:last?.reason});
  try { await bounded(lookup(host),2200); }
  catch{return {category:"dns_failure"};}
  try { await connect(host,{secure:false,timeoutMs:2200}); }
  catch{return {category:"tcp_timeout"};}
  try { await connect(host,{secure:true,timeoutMs:2600}); }
  catch{return {category:"tls_failure"};}
  return {category:classified==="network_error" ? "https_timeout" : classified};
}
export const INSTALL_NETWORK_MESSAGES=Object.freeze({
  dns_failure:"DNS lookup failed. Vibe Monitor also checked verified fallback services; please retry later or use another network.",
  tcp_timeout:"HTTPS connection timed out. Vibe Monitor tried verified fallback services; please try another network.",
  tls_failure:"HTTPS certificate/handshake failed. TLS checks remain enabled. Check the system clock or ask your IT administrator to review the connection.",
  tls_untrusted_ca:"HTTPS certificate chain is not trusted. Enterprise SSL VPN / HTTPS inspection (for example Sangfor) may be involved, but is not confirmed. Ask your IT administrator to approve and configure the trusted corporate CA for Node.js/npm, or allow the official Vibe Monitor endpoints. Do not disable SSL verification.",
  https_timeout:"HTTPS did not respond in time. Verified fallback services were tried automatically.",
  gateway_unreachable:"Vibe Cloud gateway is temporarily unavailable; verified fallbacks were checked.",
  invalid_cloud_identity:"An endpoint returned an unexpected service identity; activation was stopped for safety.",
  http_error:"Vibe Cloud returned an HTTP error; activation was stopped without consuming your code.",
  network_error:"Unable to reach Vibe Cloud; tried verified fallback services where applicable."
});
