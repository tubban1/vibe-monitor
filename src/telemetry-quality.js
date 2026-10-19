// Privacy-safe, explicit evidence-quality vocabulary. Values never contain
// paths, code, prompts or user-supplied arbitrary strings. ':' is wire-safe.
const ALLOWED = [
  "direct","derived","direct+derived","direct+heuristic",
  "direct+derived+heuristic","direct+structural+heuristic",
  "direct+structural+derived+heuristic","direct+intent+heuristic",
  "direct+derived+intent+heuristic","direct+derived+structural+heuristic"
];
export const TELEMETRY_EVIDENCE_QUALITY_VALUES=Object.freeze(ALLOWED);
const raw=new Set(ALLOWED),encoded=new Set(ALLOWED.map(x=>x.replaceAll("+",":")));
export function encodeEvidenceQuality(x) {
  if(typeof x!=="string")return null;
  return raw.has(x)?x.replaceAll("+",":"):encoded.has(x)?x:null;
}
export function decodeEvidenceQuality(x) {
  return encoded.has(x)?x.replaceAll(":","+"):null;
}
const required={
 "lifecycle.install_stage":{top:["sessionId","stage"]},
 "lifecycle.update_stage":{top:["sessionId","stage"]},
 "finding.observed":{top:["findingId","family","stage","projectId"],payload:["score","confidence","signals","supportingSignalCount"]},
 "scan.observed":{top:["projectId","scanId"],payload:["mode","phaseTimings","structural"]},
 "session_start":{top:["projectId","sessionId"]},
 "project_status":{top:["projectId","sessionId"]},
 "call.completed":{top:["projectId","callId"],payload:["timings","toolEvent"]},
 "outcome.action":{top:["projectId","findingId"],payload:["outcomeRef","actor","disposition"]},
 "outcome.verification":{top:["projectId","findingId"],payload:["outcomeRef","actor","disposition","verificationVerdict","evidenceType"]}
};
const meaningful=x=>x!==undefined&&x!==null&&(!Array.isArray(x)||x.length>0);
export function assessFreeTelemetryProjection(events=[],wire=[]) {
  const byId=new Map(wire.map(x=>[x.eventId,x])),counts={
    valid:0,legitimateNull:0,unproducedOptional:0,filteredLoss:0,
    overLimit:0,criticalMissing:0,invalidInput:0
  },blocked=[];
  for(const source of events) {
    const out=byId.get(source?.eventId);
    let problem=null,type=null;
    if(!source||typeof source!=="object"){type="invalidInput";problem="invalid_event";}
    else if(!out){type="overLimit";problem="wire_event_rejected";}
    else{
      const contract=required[source.event]||{};
      for(const field of contract.top||[]) {
        if(!meaningful(out[field])){type="criticalMissing";problem="required_"+field;break;}
      }
      if(!type)for(const field of contract.payload||[]){
        if(!meaningful(out.payload?.[field])){type="criticalMissing";problem="required_payload_"+field;break;}
      }
      if(!type&&source.event==="scan.observed"&&out.payload?.mode==="full"){
        for(const field of ["stage","findingCount","attentionCount"])
          if(!meaningful(out[field])){type="criticalMissing";problem="full_scan_"+field;break;}
      }
      if(!type&&source.event==="finding.observed"&&
         meaningful(source.payload?.evidenceQuality)&&
         !decodeEvidenceQuality(out.payload?.evidenceQuality)){
        type="filteredLoss";problem="evidence_quality_filtered";
      }
      if(!type) {
        if(Object.values(out).some(x=>x===null))counts.legitimateNull++;
        if(source.event==="finding.observed"&&source.payload?.evidenceQuality==null)
          counts.unproducedOptional++;
      }
    }
    if(type){counts[type]++;blocked.push({event:typeof source?.event==="string"?source.event:"invalid",code:problem});}
    else counts.valid++;
  }
  return {ok:blocked.length===0,counts,blocked};
}
