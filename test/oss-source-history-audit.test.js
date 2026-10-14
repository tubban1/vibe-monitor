import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {execFileSync} from "node:child_process";
import {auditIntroducedHistory} from "../scripts/verify-oss-source-history.mjs";

function git(root,...args){
 return execFileSync("git",args,{cwd:root,encoding:"utf8",stdio:["ignore","pipe","pipe"]}).trim();
}
function commit(root,message){
 git(root,"add","-A");
 git(root,"-c","user.name=QA Fixture","-c","user.email=qa@example.invalid",
  "-c","commit.gpgsign=false","commit","-qm",message);
 return git(root,"rev-parse","HEAD");
}
function temporaryRepo(t){
 const root=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-history-gate-"));
 t.after(()=>fs.rmSync(root,{recursive:true,force:true}));
 git(root,"init","-q");
 fs.writeFileSync(path.join(root,"README.md"),"reviewed public baseline\n");
 const base=commit(root,"public baseline");
 return {root,base};
}
test("introduced-object history gate approves clean diff only as technical screening",t=>{
 const {root,base}=temporaryRepo(t);
 fs.mkdirSync(path.join(root,"src"));
 fs.writeFileSync(path.join(root,"src","cli.js"),"export const offline=true;\n");
 const head=commit(root,"add reviewed source");
 const report=auditIntroducedHistory({repoPath:root,baseline:base});
 assert.equal(report.ok,true);
 assert.equal(report.publicationApproved,false);
 assert.equal(report.head,head);
 assert.equal(report.commitsReviewed,1);
 assert.ok(report.blobsScanned>0);
 assert.deepEqual(report.issues,[]);
});
test("deleted leaked Git token and .env path remain forbidden in history",t=>{
 const {root,base}=temporaryRepo(t);
 fs.mkdirSync(path.join(root,"src"));
 const synthetic="gh"+"p_"+"Q".repeat(36);
 fs.writeFileSync(path.join(root,"src","unused.txt"),synthetic+"\n");
 fs.writeFileSync(path.join(root,".env.staging"),"test only\n");
 commit(root,"add unwanted historic file");
 fs.rmSync(path.join(root,"src","unused.txt"));
 fs.rmSync(path.join(root,".env.staging"));
 commit(root,"delete unwanted files");
 const report=auditIntroducedHistory({repoPath:root,baseline:base});
 assert.equal(report.publicationApproved,false);
 assert.equal(report.ok,false);
 assert.ok(report.issues.some(x=>x.kind==="github_token"));
 assert.ok(report.issues.some(x=>x.kind==="forbidden_historical_path"&&x.location===".env.staging"));
 assert.ok(report.commitsReviewed>=2);
});
test("history review requires correct ancestor baseline",t=>{
 const {root}=temporaryRepo(t);
 assert.throws(()=>auditIntroducedHistory({repoPath:root,baseline:"refs/heads/not-a-real-branch"}),
  /baseline_not_ancestor_of_head/);
});
