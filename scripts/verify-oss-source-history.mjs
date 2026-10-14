#!/usr/bin/env node
// Fail-closed review of all introduced Git objects, including deleted files.
// Technical screening only; NEVER an IP or publication authorization.
import {execFileSync,spawnSync} from "node:child_process";
import {fileURLToPath} from "node:url";
import path from "node:path";

const MAX_BLOB_BYTES=5*1024*1024;
const MAX_OBJECTS=5000;
const RULES=[
 ["private_key_pem",/-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----/],
 ["github_token",/\bgh[pous]_[a-zA-Z0-9]{30,}\b/],
 ["npm_token",/\bnpm_[a-zA-Z0-9]{30,}\b/],
 ["stripe_live_secret",/\b(?:sk_live_|rk_live_)[a-zA-Z0-9]{20,}\b/],
 ["aws_access_key",/\bAKIA[A-Z0-9]{16}\b/],
 ["database_password_url",/\b(?:postgres(?:ql)?|neon):\/\/[^\s:@/]+:[^\s@/]+@/i],
 ["private_repository_url",/github\.com\/tubban1\/vibe-monitor-internal\b/i]
];
const FORBIDDEN_PATH=/(?:^|\/)(?:\.env(?:\.[^/]*)?|secrets?|credentials|internal|private|admin|cloud|node_modules|\.npm|\.vercel)(?:\/|$)|\.(?:pem|key|p12|pfx|sqlite|db|bak|log)$/i;

const git=(root,args,options={})=>execFileSync("git",args,{
 cwd:root,encoding:"utf8",maxBuffer:8*1024*1024,
 stdio:["pipe","pipe","pipe"],...options
});
const add=(issues,kind,location)=>issues.push({kind,location});
export function auditIntroducedHistory({repoPath,baseline="origin/main",head="HEAD"}={}){
 if(!repoPath)throw new TypeError("repoPath required");
 const root=path.resolve(repoPath),issues=[];
 const ancestor=spawnSync("git",["merge-base","--is-ancestor",baseline,head],
  {cwd:root,encoding:"utf8"});
 if(ancestor.status!==0)throw new Error("baseline_not_ancestor_of_head");
 const headSha=git(root,["rev-parse",head]).trim();
 const commitCount=Number(git(root,["rev-list","--count",baseline+".."+head]).trim());
 if(!Number.isSafeInteger(commitCount)||commitCount===0||commitCount>1000)
  throw new Error("history_review_commit_count_invalid");
 const listing=git(root,["rev-list","--objects",baseline+".."+head]).trim();
 const rows=listing.split("\n").filter(Boolean);
 if(rows.length>MAX_OBJECTS)throw new Error("history_review_too_many_objects");
 const objects=new Map();
 // Also consider removed/reused paths whose blobs are reachable from baseline.
 const changedPaths=git(root,["log","--format=","--name-only",baseline+".."+head])
  .split(/\r?\n/).filter(Boolean);
 for(const name of new Set(changedPaths))
  if(FORBIDDEN_PATH.test(name))add(issues,"forbidden_historical_path",name);
 for(const row of rows){
  const match=/^([a-f0-9]{40,64})(?: (.*))?$/.exec(row);
  if(!match)throw new Error("invalid_git_object_listing");
  const [,oid,name=""]=match;
  if(name && FORBIDDEN_PATH.test(name))add(issues,"forbidden_historical_path",name);
  if(!objects.has(oid))objects.set(oid,name);
 }
 const metadata=git(root,["cat-file","--batch-check"],{
  input:[...objects.keys()].join("\n")+"\n"
 }).trim().split("\n");
 let blobsScanned=0;
 for(const row of metadata){
  const match=/^([a-f0-9]{40,64}) (blob|tree|commit|tag) (\d+)$/.exec(row);
  if(!match)throw new Error("invalid_git_object_metadata");
  const [,oid,type,sizeString]=match;
  if(type!=="blob")continue;
  const location=objects.get(oid)||oid.slice(0,12);
  const size=Number(sizeString);
  if(size>MAX_BLOB_BYTES){add(issues,"oversized_historical_blob",location);continue;}
  const data=git(root,["cat-file","blob",oid],{encoding:"buffer",maxBuffer:MAX_BLOB_BYTES+4096});
  if(data.includes(0)){add(issues,"binary_historical_blob",location);continue;}
  blobsScanned++;
  const contents=data.toString("utf8");
  for(const [kind,pattern] of RULES)
   if(pattern.test(contents))add(issues,kind,location);
 }
 const messages=git(root,["log","--format=%B%x00",baseline+".."+head]).split("\0");
 for(const [i,message] of messages.entries())
  for(const [kind,pattern] of RULES)
   if(pattern.test(message))add(issues,"commit_message_"+kind,"commit_message_"+(i+1));
 const uniqueIssues=[...new Map(issues.map(item=>[item.kind+"|"+item.location,item])).values()];
 return {
  ok:uniqueIssues.length===0,head:headSha,baseline,
  commitsReviewed:commitCount,objectsReviewed:objects.size,blobsScanned,
  issues:uniqueIssues,publicationApproved:false,review:"technical-only"
 };
}
if(process.argv[1]&&path.resolve(process.argv[1])===fileURLToPath(import.meta.url)){
 const arg=n=>{const i=process.argv.indexOf(n);return i>=0?process.argv[i+1]:undefined;};
 try{
  const result=auditIntroducedHistory({
   repoPath:arg("--repo")||path.resolve(path.dirname(fileURLToPath(import.meta.url)),".."),
   baseline:arg("--baseline")||"origin/main",
   head:arg("--head")||"HEAD"
  });
  console.log(JSON.stringify(result,null,2));
  if(!result.ok)process.exitCode=1;
 }catch(err){console.error("OSS_HISTORY_AUDIT_FAILED:",String(err.message||err));process.exitCode=2;}
}
