// Evidence-only structural evolution audit. Not a semantic equivalence proof.
import fs from "node:fs";
import path from "node:path";
import {execFileSync} from "node:child_process";
import Parser from "tree-sitter";
import {resolveLanguage} from "./languages.js";

const MAX_SOURCE_BYTES=256*1024;
const SOURCE=/\.(?:[cm]?[jt]sx?|py)$/i;
const TEST=/(?:^|\/)(?:test|tests|__tests__|fixtures)(?:\/|$)|(?:\.|-)(?:test|spec)\.[cm]?[jt]sx?$/i;
const STOP=new Set(["identifier","property_identifier","type_identifier","number","string","string_fragment","integer","float","true","false","null","comment"]);
const MAX_FUNCTIONS=600;
function functionsOf(root,relative) {
  const full=path.resolve(root,relative);
  if(!full.startsWith(root+path.sep))return [];
  if(fs.statSync(full).size>MAX_SOURCE_BYTES||!fs.realpathSync(full).startsWith(root+path.sep))return [];
  const r=resolveLanguage(relative,()=>fs.readFileSync(full,"utf8"));
  if(!r)return [];
  const parser=new Parser();
  parser.setLanguage(r.adapter.grammar);
  const tree=parser.parse(r.source);
  const stack=[tree.rootNode],out=[];
  while(stack.length&&out.length<120){
    const n=stack.pop();
    if(r.adapter.functionTypes.has(n.type)){
      const typed=[];
      const pending=[n];
      while(pending.length&&typed.length<420){
        const node=pending.pop();
        if(!STOP.has(node.type))typed.push(node.type);
        for(let i=node.namedChildCount-1;i>=0;i--)pending.push(node.namedChild(i));
      }
      if(typed.length>=18&&typed.length<420){
        const nameNode=n.childForFieldName?.("name")||n.parent?.childForFieldName?.("name");
        const name=nameNode?r.source.slice(nameNode.startIndex,nameNode.endIndex):null;
        out.push({path:relative,line:n.startPosition.row+1,name,
          tokens:typed, nodeCount:typed.length});
      }
    }
    for(let i=n.namedChildCount-1;i>=0;i--)stack.push(n.namedChild(i));
  }
  return out;
}
function shingles(tokens){
  const result=new Set();
  for(let i=0;i<=tokens.length-5;i++)
    result.add(tokens.slice(i,i+5).join(">"));
  return result;
}
function jaccard(a,b){
  let same=0;
  for(const val of a)if(b.has(val))same++;
  return same/(a.size+b.size-same||1);
}
export function analyzeImplementationOverlap(root,{files,maxFiles=70,maxPairs=25}={}){
  const base=fs.realpathSync(root), functions=[];
  let skippedFiles=0;
  const paths=(files||[]).filter(x=>SOURCE.test(x)&&!TEST.test(x)).slice(0,Math.max(1,maxFiles));
  for(const rel of paths){
    try{
      const list=functionsOf(base,rel);
      functions.push(...list.slice(0,Math.max(0,MAX_FUNCTIONS-functions.length)));
    }catch{skippedFiles++;}
    if(functions.length>=MAX_FUNCTIONS)break;
  }
  const prepared=functions.map(f=>({...f,shape:shingles(f.tokens)}));
  const pairs=[];
  for(let i=0;i<prepared.length;i++){
    const a=prepared[i];
    for(let j=i+1;j<prepared.length;j++){
      const b=prepared[j];
      if(a.path===b.path||a.shape.size<4||b.shape.size<4)continue;
      const ratio=Math.min(a.nodeCount,b.nodeCount)/Math.max(a.nodeCount,b.nodeCount);
      if(ratio<0.75)continue;
      const similarity=jaccard(a.shape,b.shape);
      if(similarity<0.84)continue;
      pairs.push({left:{path:a.path,line:a.line,symbol:a.name},
        right:{path:b.path,line:b.line,symbol:b.name},
        kind:"structural-implementation-similarity",
        similarity:Number(similarity.toFixed(3)),nodeCountA:a.nodeCount,nodeCountB:b.nodeCount,
        confidence:"heuristic-only",deletionAuthorized:false,
        caution:"Similar AST shapes do not prove identical behavior or redundant functionality."});
    }
  }
  pairs.sort((a,b)=>b.similarity-a.similarity);
  return {method:"tree-sitter-function-structural-shingle-v1",
    assessmentAvailable:paths.length>0&&skippedFiles===0,
    selectedFiles:paths.length,skippedFiles,functionsInspected:functions.length,
    pairs:pairs.slice(0,maxPairs),truncated:pairs.length>maxPairs||functions.length>=MAX_FUNCTIONS,
    caution:"Source-limited, name-independent structural similarity. Not full semantic equivalence."};
}
export function summarizeEvolution(root,summary={},snapshots=[]){
  const base=fs.realpathSync(root);
  const observations=snapshots.filter(x=>x&&x.summary).slice(-12).map(x=>({
    at:x.capturedAt||null,loc:x.summary.totalLoc||0,sourceFiles:x.summary.sourceFiles||0,
    duplicateBlockGroups:x.summary.duplicateBlockGroups||0,
    decisionCount:x.summary.totalDecisions||0
  }));
  if(!observations.length||observations.at(-1).loc!==summary.totalLoc)
    observations.push({at:null,loc:summary.totalLoc||0,sourceFiles:summary.sourceFiles||0,
      duplicateBlockGroups:summary.duplicateBlockGroups||0,decisionCount:summary.totalDecisions||0});
  let commits=0,additions=0,deletions=0,filesTouched=0,skippedBinaryChanges=0;
  try{
    const raw=execFileSync("git",["log","-20","--no-merges","--numstat","--format=COMMIT:%H"],
      {cwd:base,encoding:"utf8",maxBuffer:1024*1024,timeout:3500,stdio:["ignore","pipe","ignore"]});
    for(const line of raw.split("\n")){
      if(line.startsWith("COMMIT:"))commits++;
      else if(/^\d+\t\d+\t/.test(line)){
        const [a,d]=line.split("\t");additions+=Number(a);deletions+=Number(d);filesTouched++;
      }else if(/^-\t-\t/.test(line))skippedBinaryChanges++;
    }
  }catch{/* unavailable Git is explicitly disclosed */}
  const first=observations[0],last=observations.at(-1);
  return {method:"snapshot-structural-delta+git-numstat-v1",
    snapshotsCompared:observations.length,observations,
    structuralDelta:{loc:last.loc-first.loc,
      sourceFiles:last.sourceFiles-first.sourceFiles,
      duplicateBlockGroups:last.duplicateBlockGroups-first.duplicateBlockGroups,
      decisionCount:last.decisionCount-first.decisionCount},
    recentGit:{commits,additions,deletions,filesTouched,skippedBinaryChanges},
    causalAttribution:"not-established",businessValue:"not-measured",
    caution:"Git churn and structural growth do not prove waste or attribute causes. Compare same evidence and scoring versions."};
}
