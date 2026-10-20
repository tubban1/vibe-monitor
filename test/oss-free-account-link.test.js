import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {freeProjectProof,submitFreeAccountLink} from "../src/free-account-link.js";

const fixture={
 installationId:"12345678-1234-4234-8234-1234567890ab",
 secret:"generated-local-secret-protected-in-a-real-OS-vault-000001",
 projectInstanceId:"a123456789012345"
};
test("Free proof matches existing anonymous telemetry HMAC, not installation ID only",()=>{
 const claim=freeProjectProof(fixture);
 const expected=crypto.createHmac("sha256",fixture.secret)
  .update(fixture.projectInstanceId).digest("hex").slice(0,32);
 assert.equal(claim.projectProof,expected);
 assert.equal(claim.installationId,fixture.installationId);
 assert.equal(Object.keys(claim).length,2);
 assert.notEqual(claim.projectProof,crypto.createHash("sha256").update(fixture.installationId).digest("hex").slice(0,32));
});
test("Free proof refuses missing or malformed existing identity",()=>{
 for(const partial of [
   {...fixture,secret:null},{...fixture,secret:"short"},
   {...fixture,projectInstanceId:"arbitrary/path"},
   {...fixture,installationId:"not-a-uuid"}
 ])assert.throws(()=>freeProjectProof(partial),/local_free_identity_unavailable/);
});
test("Free client only submits pseudonym, installation ID and pairing code to official HTTPS endpoint",async()=>{
 const claim=freeProjectProof(fixture),code="a".repeat(64);
 const calls=[];
 const result=await submitFreeAccountLink({code,identity:claim,fetchImpl:async(url,options)=>{
  calls.push({url,options});
  return {status:200};
 }});
 assert.equal(result.accepted,true);
 assert.equal(calls.length,1);
 assert.equal(calls[0].url,"https://vibe.fde.fan/api/account?action=free-device-accept");
 assert.equal(calls[0].options.method,"POST");
 assert.equal(calls[0].options.redirect,"error");
 assert.equal(calls[0].options.credentials,"omit");
 const body=JSON.parse(calls[0].options.body);
 assert.deepEqual(body,{code,installationId:fixture.installationId,projectProof:claim.projectProof});
 assert.ok(!JSON.stringify(body).includes(fixture.secret));
 assert.ok(!JSON.stringify(body).includes(fixture.projectInstanceId));
 assert.ok(!JSON.stringify(body).includes("projectPath"));
 assert.equal(calls[0].options.headers.authorization,undefined);
});
test("Free link rejects invalid code locally without any network call",async()=>{
 let called=0;
 const result=await submitFreeAccountLink({code:"bad",identity:freeProjectProof(fixture),
  fetchImpl:()=>{called++;throw Error("must not call network") ;}});
 assert.equal(result.accepted,false);
 assert.equal(called,0);
});
test("Free link maps missing historical proof to safe failure without automatic retries",async()=>{
 let count=0;
 const response=await submitFreeAccountLink({code:"f".repeat(64),identity:freeProjectProof(fixture),
  fetchImpl:async()=>{count++;return {status:409};}});
 assert.equal(count,1);
 assert.equal(response.reason,"no_verified_historical_project_or_pairing_expired");
});
test("Free link never follows cross-host redirects",async()=>{
 const response=await submitFreeAccountLink({code:"a".repeat(64),identity:freeProjectProof(fixture),
  fetchImpl:async(_url,options)=>{assert.equal(options.redirect,"error");throw new Error("redirect blocked")}});
 assert.equal(response.accepted,false);
 assert.equal(response.reason,"account_linking_unavailable");
});
