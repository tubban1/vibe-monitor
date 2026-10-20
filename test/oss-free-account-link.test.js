import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {projectIdentity} from "../src/project.js";
import {writeSecret} from "../src/secure-store.js";
import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {freeProjectProof,submitFreeAccountLink,previewFreeAccountPairing,linkFreeAccountFromWorkspace,approvalMatchesGithubLogin,submitLegacyBetaAccountLink,localLegacyBetaIdentity} from "../src/free-account-link.js";

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

test('Pair preview returns target GitHub login and sends code only (no installation proof)',async()=>{
 const calls=[];
 const preview=await previewFreeAccountPairing({code:'a'.repeat(64),fetchImpl:async(url,opts)=>{
  calls.push({url,opts});return {status:200,json:async()=>({accountLogin:'target-dev'})};
 }});
 assert.deepEqual(preview,{ok:true,accountLogin:'target-dev'});
 assert.equal(calls.length,1);
 assert.match(calls[0].url,/free-pair-preview$/);
 assert.deepEqual(JSON.parse(calls[0].opts.body),{code:'a'.repeat(64)});
 assert.equal(calls[0].opts.redirect,'error');
});
test('Wrong or absent target approval stops before reading vault and never sends proof',async()=>{
 let calls=0;
 const result=await linkFreeAccountFromWorkspace({code:'a'.repeat(64),
   cwd:'/deliberately/invalid/path',
   fetchImpl:async(url)=>{calls++;assert.match(url,/free-pair-preview$/);return {status:200,json:async()=>({accountLogin:'other-account'})}},
   confirmTarget:async login=>{assert.equal(login,'other-account');return false;}
 });
 assert.deepEqual(result,{accepted:false,reason:'local_user_declined'});
 assert.equal(calls,1);
 assert.equal((await linkFreeAccountFromWorkspace({code:'a'.repeat(64),cwd:'/invalid',
   fetchImpl:async()=>({status:200,json:async()=>({accountLogin:'other-account'})})})).reason,'local_user_declined');
});
test('Pairing preview refuses malformed or unauthentic server identity',async()=>{
 const bad=await previewFreeAccountPairing({code:'a'.repeat(64),fetchImpl:async()=>({status:200,json:async()=>({accountLogin:'not/valid'})})});
 assert.equal(bad.ok,false);
 assert.equal(bad.reason,'invalid_pairing_response');
 assert.equal(approvalMatchesGithubLogin('target-dev','target-dev'),true);
 assert.equal(approvalMatchesGithubLogin('target-dev',' TARGET-DEV '),true);
 assert.equal(approvalMatchesGithubLogin('target-dev','attacker'),false);
});
test('Preview failure cannot advance to ownership-proof submission',async()=>{
 let calls=0;
 const result=await linkFreeAccountFromWorkspace({code:'a'.repeat(64),
  fetchImpl:async()=>{calls++;return {status:409}},
  confirmTarget:async()=>{throw Error('should not prompt')}
 });
 assert.equal(result.accepted,false);
 assert.equal(result.reason,'invalid_or_expired_pairing_code');
 assert.equal(calls,1);
});

test('Native-style Mac local secure-store fixture flows through preview, consent and HMAC proof',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vibe-free-link-native-'));
 const oldHome=process.env.VIBE_MONITOR_HOME,oldVault=process.env.VIBE_MONITOR_TEST_SECRET_DIR;
 t.after(()=>{if(oldHome===undefined)delete process.env.VIBE_MONITOR_HOME;else process.env.VIBE_MONITOR_HOME=oldHome;
  if(oldVault===undefined)delete process.env.VIBE_MONITOR_TEST_SECRET_DIR;else process.env.VIBE_MONITOR_TEST_SECRET_DIR=oldVault;
  fs.rmSync(dir,{recursive:true,force:true});});
 const home=path.join(dir,'home'),vault=path.join(dir,'vault'),repo=path.join(dir,'repo');
 fs.mkdirSync(path.join(home,'free-telemetry'),{recursive:true});fs.mkdirSync(repo);fs.mkdirSync(vault);
 fs.writeFileSync(path.join(repo,'package.json'),'{}');
 const secret=crypto.randomBytes(32).toString('hex'),id=fixture.installationId;
 fs.writeFileSync(path.join(home,'free-telemetry','identity.json'),JSON.stringify({schemaVersion:1,installationId:id}));
 process.env.VIBE_MONITOR_HOME=home;process.env.VIBE_MONITOR_TEST_SECRET_DIR=vault;
 writeSecret('free-telemetry-hmac-secret',secret);
 const expected=freeProjectProof({installationId:id,secret,projectInstanceId:projectIdentity(repo).projectInstanceId});
 const calls=[];
 const result=await linkFreeAccountFromWorkspace({code:'b'.repeat(64),cwd:repo,
  confirmTarget:async username=>{assert.equal(username,'trusted-dev');return true},
  fetchImpl:async(url,opts)=>{calls.push({url,body:JSON.parse(opts.body)});
   return url.includes('free-pair-preview')?{status:200,json:async()=>({accountLogin:'trusted-dev'})}:{status:200};
  }});
 assert.equal(result.accepted,true);
 assert.equal(calls.length,2);
 assert.deepEqual(calls[0].body,{code:'b'.repeat(64)});
 assert.deepEqual(calls[1].body,{code:'b'.repeat(64),...expected});
 assert.ok(!JSON.stringify(calls).includes(repo));
 assert.ok(!JSON.stringify(calls).includes(secret));
});

test('Beta41 migration credential is sent ONLY to account center after explicit approval',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'vm-account-beta-migration-'));
 const oldHome=process.env.VIBE_MONITOR_HOME,oldSecret=process.env.VIBE_MONITOR_TEST_SECRET_DIR;
 t.after(()=>{if(oldHome===undefined)delete process.env.VIBE_MONITOR_HOME;else process.env.VIBE_MONITOR_HOME=oldHome;
  if(oldSecret===undefined)delete process.env.VIBE_MONITOR_TEST_SECRET_DIR;else process.env.VIBE_MONITOR_TEST_SECRET_DIR=oldSecret;
  fs.rmSync(dir,{recursive:true,force:true})});
 const home=path.join(dir,'home'),vault=path.join(dir,'vault');
 fs.mkdirSync(path.join(home,'cloud'),{recursive:true});fs.mkdirSync(vault,{recursive:true});
 const token='vmb_'+'a'.repeat(43),id=fixture.installationId;
 process.env.VIBE_MONITOR_HOME=home;process.env.VIBE_MONITOR_TEST_SECRET_DIR=vault;
 fs.writeFileSync(path.join(home,'cloud','client.json'),JSON.stringify({
  schemaVersion:1,installationId:id,baseUrl:'https://vibe-api.fde.fan'
 }));
 writeSecret('cloud-installation-token',token);
 assert.deepEqual(localLegacyBetaIdentity(),{installationId:id,token});
 let approved=0;const calls=[];
 const result=await linkFreeAccountFromWorkspace({code:'b'.repeat(64),cwd:'/does/not/exist',
  confirmTarget:async login=>{approved++;assert.equal(login,'correct-user');return true;},
  fetchImpl:async(url,opts)=>{
   calls.push({url,opts});
   return url.endsWith('free-pair-preview')
     ?{status:200,json:async()=>({accountLogin:'correct-user'})}:{status:200};
  }});
 assert.equal(approved,1);
 assert.deepEqual(result,{accepted:true,status:'waiting_for_web_confirmation'});
 assert.equal(calls.length,2);
 assert.equal(calls[0].opts.headers.authorization,undefined);
 assert.ok(calls[1].url.endsWith('legacy-beta-accept'));
 assert.equal(calls[1].opts.headers.authorization,'Bearer '+token);
 assert.deepEqual(JSON.parse(calls[1].opts.body),{code:'b'.repeat(64),installationId:id});
 assert.ok(!calls[1].opts.body.includes(token));
 assert.equal(calls[1].opts.redirect,'error');
});
test('Invalid legacy credential cannot be used to claim another installation',async()=>{
 const id=fixture.installationId,code='a'.repeat(64),calls=[];
 const cases=[
  {installationId:id,token:null},
  {installationId:id,token:'raw-password'},
  {installationId:'random-id',token:'vmb_'+'a'.repeat(43)}
 ];
 for(const identity of cases){
  const r=await submitLegacyBetaAccountLink({code,identity,fetchImpl:(...args)=>{calls.push(args);throw Error('forbidden');}});
  assert.equal(r.accepted,false);
 }
 assert.equal(calls.length,0);
});
test('Legacy migration does not pass untrusted origin or source in request',async()=>{
 const identity={installationId:fixture.installationId,token:'vmb_'+'b'.repeat(43)};
 let hits=0;
 const r=await submitLegacyBetaAccountLink({code:'a'.repeat(64),identity,fetchImpl:async(url,init)=>{
  hits++;assert.equal(url,'https://vibe.fde.fan/api/account?action=legacy-beta-accept');
  assert.equal(init.redirect,'error');return{status:409};
 }});
 assert.equal(hits,1);
 assert.equal(r.reason,'legacy_credential_rejected_or_pairing_expired');
});
