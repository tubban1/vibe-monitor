import test from "node:test";
import assert from "node:assert/strict";
import { generateKeyPairSync, sign } from "node:crypto";
import { POLICY_V2_FAMILIES, sanitizeDecisionPolicy, scoreFromSignedSignals, signedAdviceForFamily } from "../src/decision-policy.js";
import { verifyCommunityPolicyEnvelope, COMMUNITY_POLICY_KEY_ID } from "../src/community-cloud-policy.js";
const strategy = (extra={})=>({
 schemaVersion:2,policyId:"cloud-rulebook-v2",revision:2,
 stageThresholds:{S2:35,S3:50,S4:70,S5:85},
 minSupportingSignals:{S3:3,S4:4,S5:4},familyScoreWeights:{},
 signalWeights:Object.fromEntries(POLICY_V2_FAMILIES.map(f=>[f,{size:20,dependency_cycles:25}])),
 adviceRules:{"code-structure":{doNow:["Cloud recommendation"]}},...extra
});
test("signed rule scores and advice are Cloud-owned for 13 families",()=>{
 const p=sanitizeDecisionPolicy(strategy());assert.ok(p);
 for(const family of POLICY_V2_FAMILIES)
  assert.equal(scoreFromSignedSignals([{name:"size",active:true},{name:"dependency_cycles",active:true}],p,family,99),45);
 assert.deepEqual(signedAdviceForFamily(p,"code-structure").doNow,["Cloud recommendation"]);
});
test("unsafe rule values are rejected",()=>{
 assert.equal(sanitizeDecisionPolicy(strategy({signalWeights:{"code-structure":{evil:999}}})),null);
 assert.equal(sanitizeDecisionPolicy(strategy({adviceRules:{"code-structure":{run:"foo"}}})),null);
 assert.equal(sanitizeDecisionPolicy(strategy({signalWeights:{"unregistered":{size:1}}})),null);
});
test("policy envelope rejects tampering",()=>{
 const {privateKey,publicKey}=generateKeyPairSync("ed25519"),now=Date.now();
 const payload={schemaVersion:1,audience:"vibe-monitor-community",revision:2,issuedAt:Math.floor(now/1000),expiresAt:Math.floor(now/1000)+1800,config:{decisionPolicy:strategy()}};
 const envelope={payload,keyId:COMMUNITY_POLICY_KEY_ID,signature:sign(null,Buffer.from(JSON.stringify(payload)),privateKey).toString("base64url")};
 const pem=publicKey.export({type:"spki",format:"pem"});
 assert.equal(verifyCommunityPolicyEnvelope(envelope,{publicKeyPem:pem,now:()=>now})?.config?.decisionPolicy?.signalWeights?.["code-structure"]?.size,20);
 payload.config.decisionPolicy.signalWeights["code-structure"].size=21;
 assert.equal(verifyCommunityPolicyEnvelope(envelope,{publicKeyPem:pem,now:()=>now}),null);
});

test("real local scan uses signed score weights and Cloud guidance", async()=>{
  const fs=await import("node:fs"),path=await import("node:path"),os=await import("node:os");
  const {analyzeProject}=await import("../src/engine.js");
  const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-cloud-rule-"));
  try {
    fs.writeFileSync(path.join(root,"large-module.js"),Array.from({length:1250},(_,i)=>"export const item"+i+" = "+i+";").join("\n"));
    const p=strategy({signalWeights:{"code-structure":{size:45}},adviceRules:{"code-structure":{doNow:["Cloud recommendation"]}}});
    const result=analyzeProject(root,{persist:false,decisionPolicy:p});
    const f=result.findings.find(x=>x.family==="code-structure");
    assert.ok(f,"Cloud strategy should produce a code-structure finding");
    assert.equal(f.score,45);
    assert.deepEqual(f.doNow,["Cloud recommendation"]);
  } finally {fs.rmSync(root,{recursive:true,force:true});}
});
