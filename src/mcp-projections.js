// Context-efficient MCP views: the scan itself and persisted evidence remain unchanged.
// Legacy/full results are opt-in, so prior machine clients can request their schema.
const METRICS = [
  "sourceFiles", "totalLoc", "testFiles", "testLoc", "duplicateBlockGroups",
  "duplicateAffectedFiles", "productionDependencies", "publicEndpoints",
  "apiContractSignals", "platformAssumptions", "asyncPaths", "persistenceSignals",
  "retrySignals", "timeoutSignals"
];
const int=(n,fallback)=>Number.isSafeInteger(n)&&n>=0?n:fallback;
const asArray=value=>Array.isArray(value)?value:[];

function baseMonitoring(m){
  if(!m)return null;
  return {
    mode:m.mode ?? null, assessmentAvailable:m.assessmentAvailable ?? null,
    callId:m.callId ?? null,scanId:m.scanId ?? null,
    scanDurationMs:m.scanDurationMs ?? null,handlerElapsedMs:m.handlerElapsedMs ?? null,
    phaseTimings:m.phaseTimings?{
      policyMs:m.phaseTimings.policyMs??null,analysisMs:m.phaseTimings.analysisMs??null,
      toolHandlerMs:m.phaseTimings.toolHandlerMs??null
    }:null,
    ...(m.reason?{reason:m.reason}:{}),
    ...(m.nextAction?{nextAction:m.nextAction}:{})
  };
}
export function buildProjectStatusView(result,{detail="summary"}={}){
  if(detail==="full")return result;
  const findings=asArray(result.findings);
  const byStage=Object.fromEntries(["S1","S2","S3","S4","S5"].map(
    stage=>[stage,findings.filter(f=>f.stage===stage).length]));
  const interesting=[...findings].filter(f=>f.requiresAttention)
    .sort((a,b)=>(b.intelligence?.priority??b.score??0)-(a.intelligence?.priority??a.score??0));
  const overview=interesting.slice(0,2).map(f=>({
    id:f.id,stage:f.stage,family:f.family,target:f.target,score:f.score,
    title:f.title,doNow:asArray(f.doNow).slice(0,1),
    nextTrigger:typeof f.nextTrigger==="string"?f.nextTrigger.slice(0,140):null
  }));
  const summary=Object.fromEntries(METRICS.filter(k=>
    typeof result.summary?.[k]==="number").map(k=>[k,result.summary[k]]));
  const structural=result.summary?.structuralScan;
  if(structural)summary.structuralCoverage={
    candidateFiles:structural.candidateFiles??null,
    analyzedFiles:structural.analyzedFiles??null,
    skippedByBudget:structural.skippedByBudget??null,
    parserErrors:structural.parserErrors??null
  };
  return {
    schemaVersion:result.schemaVersion,evidenceVersion:result.evidenceVersion,
    view:"summary",project:result.project,capturedAt:result.capturedAt,
    status:result.status,summary,risks:{byStage,attentionCount:interesting.length,top:overview,
      moreAttention:interesting.length>overview.length},
    monitoring:baseMonitoring(result.monitoring),
    evidenceIndex:findings.slice(0,3).map(f=>({id:f.id,stage:f.stage,target:f.target})),
    evidenceCount:findings.length,hasMoreEvidence:findings.length>3,
    next:{findings:"vibe_findings (limit/offset/detail)",
      explanation:"vibe_explain_finding (id)",fullStatus:"vibe_project_status (detail=full)"},
    limitation:"Stage and source indicators are observational, not proof of refactoring necessity."
  };
}
export function buildProjectFilesView(result,scan,{limit=20,offset=0}={}){
  const size=Math.min(50,int(limit,20)),start=int(offset,0);
  const files=asArray(scan.files);
  const portion=files.slice(start,start+size).map(f=>({
    path:f.path,loc:f.loc,nonBlankLoc:f.nonBlankLoc,bytes:f.bytes,
    functionCount:f.functionCount,importCount:f.importCount,
    decisionCount:f.decisionCount,duplicateBlockCount:f.duplicateBlockCount,
    responsibilities:asArray(f.responsibilities),
    isTestFile:Boolean(f.isTestFile),isToolingFile:Boolean(f.isToolingFile),
    metricsScope:"local_static_heuristics_not_confirmed_defects"
  }));
  const hasMore=start+portion.length<files.length;
  return {
    view:"files",project:result.project,capturedAt:result.capturedAt,
    files:portion,sourceFiles:files.length,
    pagination:{limit:size,offset:start,returned:portion.length,total:files.length,
      hasMore,nextOffset:hasMore?start+portion.length:null},
    note:"Explicit read-only local file metrics; no source content or secrets returned. Heuristic metrics require verification."
  };
}
function briefFinding(f){
  return {
    id:f.id,family:f.family,stage:f.stage,score:f.score,target:f.target,title:f.title,
    requiresAttention:Boolean(f.requiresAttention),evidenceQuality:f.evidenceQuality??null,
    doNow:asArray(f.doNow).slice(0,2),doNotDoYet:asArray(f.doNotDoYet).slice(0,1),
    nextTrigger:f.nextTrigger??null,
    trend:f.intelligence?.trend??null,
    evidenceRef:{tool:"vibe_explain_finding",id:f.id}
  };
}
export function buildFindingsPage(result,{limit=5,offset=0,detail="summary"}={}){
  const total=asArray(result.findings).length;
  const start=int(offset,0);
  const size=Math.min(50,int(limit,5));
  const page=result.findings.slice(start,start+size);
  const hasMore=start+page.length<total;
  const common={
    project:result.project,status:result.status,
    view:detail,findings:detail==="full"?page:page.map(briefFinding),
    pagination:{limit:size,offset:start,total,returned:page.length,
      hasMore,nextOffset:hasMore?start+page.length:null},
    monitoring:baseMonitoring(result.monitoring)
  };
  if(detail==="full"){
    return {
      ...common,recommendationGroups:null,highSeverityReviewQueue:null,
      // Complete legacy summary lists are returned only for full unpaginated results.
      ...(start===0&&page.length===total?{legacySummaryIncluded:true}:{legacySummaryIncluded:false})
    };
  }
  return common;
}
export function compactFindingDetail(payload,{format="compact"}={}){
  if(format==="full")return payload;
  const detail={...payload,explanation:{...payload.explanation}};
  const category=detail.explanation.evidenceClassification;
  if(category){
    const classification={...category};
    const advice=classification.recommendation;
    if(advice&&
      JSON.stringify(asArray(advice.doNow))===JSON.stringify(asArray(payload.doNow))&&
      JSON.stringify(asArray(advice.prepare))===JSON.stringify(asArray(payload.prepare))&&
      JSON.stringify(asArray(advice.doNotDoYet))===JSON.stringify(asArray(payload.doNotDoYet))&&
      (advice.nextTrigger??null)===(payload.nextTrigger??null)&&
      JSON.stringify(asArray(advice.decisionQuestions))===JSON.stringify(asArray(payload.decisionQuestions))){
      delete classification.recommendation;
      classification.recommendationRef="$.doNow / $.prepare / $.doNotDoYet / $.nextTrigger / $.decisionQuestions";
    }
    detail.explanation.evidenceClassification=classification;
  }
  if(detail.boundaryAssessment&&detail.explanation.decisionAssessment&&
    JSON.stringify(detail.boundaryAssessment)===JSON.stringify(detail.explanation.decisionAssessment)){
    delete detail.explanation.decisionAssessment;
    detail.explanation.decisionAssessmentRef="$.boundaryAssessment";
  }
  return detail;
}
