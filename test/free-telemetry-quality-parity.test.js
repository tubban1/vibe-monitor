import test from "node:test";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import {freeTelemetryWireBatch} from "../src/telemetry.js";
import {assessFreeTelemetryProjection,encodeEvidenceQuality,decodeEvidenceQuality,TELEMETRY_EVIDENCE_QUALITY_VALUES} from "../src/telemetry-quality.js";
const families=["code-structure","dependency-coupling","platform-portability","security-surface","state-data","async-concurrency","reliability-recovery","testing-verification","observability","distribution-scaling","api-contract","provider-integration","ai-drift"];
const base=(event,patch={})=>({schemaVersion:4,eventId:crypto.randomUUID(),installationId:crypto.randomUUID(),at:new Date().toISOString(),event,projectId:"a".repeat(32),repoId:"b".repeat(32),projectInstanceId:"a".repeat(32),findingId:"c".repeat(32),sessionId:crypto.randomUUID(),callId:crypto.randomUUID(),scanId:crypto.randomUUID(),evidenceVersion:7,policyRevision:2,agent:"codex",...patch});
const sample=(family,i)=>base("finding.observed",{family,stage:i%2?"S5":"S3",payload:{score:i+70,confidence:.74,evidenceQuality:TELEMETRY_EVIDENCE_QUALITY_VALUES[i%TELEMETRY_EVIDENCE_QUALITY_VALUES.length],signals:[{name:"size",bucket:"high",valueBucket:"501-1000",independenceGroup:"size"}],supportingSignalCount:1,actionMode:"observe-only",semanticReviewRecommended:false,prompt:"hidden",sourcePath:"/Users/private"}});
test("13 Beta.41 detector families retain exact stage, score, decimal confidence and evidence categories",()=>{
 assert.equal(families.length,13);
 for(const [i,f] of families.entries()){
  const source=sample(f,i),out=freeTelemetryWireBatch([source])[0];
  assert.ok(out,f);assert.equal(out.family,f);assert.equal(out.stage,source.stage);
  for(const k of ["score","confidence","signals","supportingSignalCount","actionMode","semanticReviewRecommended"])assert.deepEqual(out.payload[k],source.payload[k],f+":"+k);
  assert.equal(decodeEvidenceQuality(out.payload.evidenceQuality),source.payload.evidenceQuality);
  assert.equal(Object.hasOwn(out.payload,"prompt"),false);
  assert.equal(Object.hasOwn(out.payload,"sourcePath"),false);
  assert.equal(assessFreeTelemetryProjection([source],[out]).ok,true,f);
 }
});
test("Beta full scan phase timings, graph, counts and decimals preserve values",()=>{
 const src=base("scan.observed",{findingId:null,stage:"S5",findingCount:22,attentionCount:10,scannerOverheadPct:1.25,monitoringWallTimeMs:397,monitoringMode:"full",payload:{mode:"full",reason:"observed",phaseTimings:{engineMs:55,structuralMs:10},structural:{mode:"adaptive",languages:["javascript"],candidateFiles:5,analyzedFiles:5},graph:{edgeCountBucket:"21-50",cycleCountBucket:"lt1",maxFanInBucket:"3-5",maxFanOutBucket:"6-10"},projectChanged:false,sourceFilesBucket:"21-50"}});
 const out=freeTelemetryWireBatch([src])[0];assert.ok(out);
 for(const k of ["findingCount","attentionCount","scannerOverheadPct","monitoringWallTimeMs","stage","repoId","scanId","callId"])assert.equal(out[k],src[k]);
 for(const k of ["mode","reason","phaseTimings","structural","graph","projectChanged","sourceFilesBucket"])assert.deepEqual(out.payload[k],src.payload[k],k);
 assert.equal(assessFreeTelemetryProjection([src],[out]).ok,true);
});
test("Beta risk transitions and feedback plus outcome action and verification values remain comparable",()=>{
 const examples=[
 ["finding.new_attention",{transitionType:"new_attention",currentActionMode:"observe-only"}],
 ["finding.worsened",{transitionType:"worsened",currentActionMode:"staged-remediation"}],
 ["finding.improved",{transitionType:"improved",currentActionMode:"next-change-watch"}],
 ["feedback.useful",{verdict:"useful",actionMode:"observe-only"}],
 ["feedback.false_positive",{verdict:"false_positive",actionMode:"observe-only"}],
 ["feedback.too_early",{verdict:"too_early",actionMode:"observe-only"}],
 ["feedback.too_late",{verdict:"too_late",actionMode:"observe-only"}],
 ["feedback.confusing",{verdict:"confusing",actionMode:"observe-only"}],
 ["outcome.action",{outcomeRef:"d".repeat(32),actor:"agent",disposition:"applied",outcomeStatus:"pending"}],
 ["outcome.verification",{outcomeRef:"d".repeat(32),actor:"user",disposition:"applied",verificationVerdict:"confirmed",evidenceType:"regression_test",outcomeStatus:"verified"}]
 ];
 for(const [event,payload] of examples){
  const src=base(event,{fromStage:"S3",toStage:"S4",payload});
  const out=freeTelemetryWireBatch([src])[0];assert.ok(out,event);
  for(const [k,v] of Object.entries(payload))assert.deepEqual(out.payload[k],v,event+":"+k);
  assert.equal(out.fromStage,"S3");assert.equal(out.toStage,"S4");
  assert.equal(assessFreeTelemetryProjection([src],[out]).ok,true,event);
 }
});
test("quality detects legal null, omitted optional, filtered evidence and invalid fields",()=>{
 const x=sample("code-structure",0);x.payload.evidenceQuality=null;
 const a=assessFreeTelemetryProjection([x],freeTelemetryWireBatch([x]));
 assert.equal(a.ok,true);assert.equal(a.counts.unproducedOptional,1);
 const b=sample("code-structure",1);b.payload.evidenceQuality="unsupported+external";
 const filtered=assessFreeTelemetryProjection([b],freeTelemetryWireBatch([b]));
 assert.equal(filtered.counts.filteredLoss,1);assert.equal(filtered.ok,false);
 const c=sample("code-structure",1);c.family=null;
 assert.equal(assessFreeTelemetryProjection([c],freeTelemetryWireBatch([c])).counts.criticalMissing,1);
 for(const illegal of ["direct+unapproved","secret/path","sk-secret","direct+heuristic;rm",null])
  assert.equal(encodeEvidenceQuality(illegal),null);
});
