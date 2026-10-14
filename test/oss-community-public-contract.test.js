import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {DISTRIBUTION_MODE} from "../src/distribution.js";
import {COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM,COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM,createCommunityPolicyClient} from "../src/community-cloud-policy.js";
import {fetchVerifiedNode,nodeDownloadSources} from "../src/install.js";
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),"..");
const staged=DISTRIBUTION_MODE==="open-client";
test("Unified open client has Apache-2.0 license, reproducible deps, and no publish rights",{
 skip:!staged?"only runs after source-only OSS staging":false
},()=>{
 const pkg=JSON.parse(fs.readFileSync(path.join(root,"package.json"),"utf8"));
 const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
 const license=fs.readFileSync(path.join(root,"LICENSE"),"utf8");
 assert.equal(pkg.license,"Apache-2.0");
 assert.equal(pkg.private,true);
 assert.equal(pkg.name,"@vibe-monitor/setup");
 assert.equal(pkg.version,lock.packages[""].version);
 assert.deepEqual(pkg.dependencies,lock.packages[""].dependencies);
 assert.match(license,/Apache License\s+Version 2\.0, January 2004/);
 assert.equal(COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM,null,
  "stage must remain unreleasable until real signed QA policy has been verified");
 assert.equal(COMMUNITY_POLICY_TRUSTED_NEXT_PUBLIC_KEY_PEM,null,
  "new signing verification root must not ship before Cloud security sign-off");
});
test("single client dependency lock has reviewed SPDX license categories",{
 skip:!staged?"OSS-only dependency contract":false
},()=>{
 const lock=JSON.parse(fs.readFileSync(path.join(root,"package-lock.json"),"utf8"));
 const packages=Object.entries(lock.packages).filter(([n])=>n.startsWith("node_modules/"));
 assert.equal(packages.length,130,"dependency count changed: refresh attribution review");
 for(const [name,pkg] of packages)
  assert.ok(["MIT","ISC","BSD-2-Clause","BSD-3-Clause"].includes(pkg.license),
   "Unreviewed dependency license "+name+" : "+String(pkg.license));
 const notice=fs.readFileSync(path.join(root,"NOTICE"),"utf8");
 assert.match(notice,/Transitive npm dependencies/i);
});
test("Unified signed cloud strategy stays in memory without telemetry",{
 skip:!staged?"only runs after source-only OSS staging":false
},()=>{
 const policy=fs.readFileSync(path.join(root,"src/community-cloud-policy.js"),"utf8");
 const dist=fs.readFileSync(path.join(root,"src/distribution.js"),"utf8");
 const sanitizer=fs.readFileSync(path.join(root,"src/policy-sanitizer.js"),"utf8");
 assert.match(policy,/from "\.\/policy-sanitizer\.js"/);
 assert.doesNotMatch(policy,/from "\.\/cloud\.js"/,
  "Open client must not import legacy Beta Cloud merely to normalize policy");
 assert.doesNotMatch(sanitizer,/\b(?:node:fs|readFileSync|writeFileSync|vibeHome|fetch)\b/,
  "Pure policy normalization must never read or transmit data");
 assert.match(dist,/DISTRIBUTION_MODE = "open-client"/);
 assert.doesNotMatch(policy,/node:fs|writeFileSync|readFileSync|signed-v1\.json|vibeHome/);
 assert.match(policy,/createCommunityPolicyClient/);
 assert.match(dist,/fetchCommunityCloudPolicy/);
});

test("signed strategy response cannot read beyond stream limit",async()=>{
 const client=createCommunityPolicyClient();
 let fullReads=0;
 const out=await client({publicKeyPem:"synthetic-test-public-key",now:()=>Date.UTC(2026,9,14),
  fetchImpl:async()=>({ok:true,headers:{get:()=>null},
   body:{async *[Symbol.asyncIterator](){yield {byteLength:16385};}},
   text:async()=>{fullReads++;throw Error("no unbounded text");}})});
 assert.equal(out.source,"local-baseline");
 assert.equal(fullReads,0);
});
test("Node source is pinned to the official artifact URL",()=>{
 const spec={filename:"node-v22.23.3-win-x64.zip",archiveUrl:"https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip"};
 assert.equal(nodeDownloadSources(spec).length,2);
 assert.throws(()=>nodeDownloadSources({...spec,archiveUrl:"https://example.invalid/archive"}),/runtime_archive_source_untrusted/);
});

test("Node archive response rejects excessive Content-Length before reading",async()=>{
 const spec={filename:"node-v22.23.3-win-x64.zip",archiveUrl:"https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip"};
 const original=globalThis.fetch;
 let calls=0,read=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,headers:{get:()=>String(161*1024*1024)},arrayBuffer:async()=>{read++;return new ArrayBuffer(0)}};};
 try{await assert.rejects(fetchVerifiedNode(spec),/runtime_download_failed/);assert.equal(calls,2);assert.equal(read,0);}
 finally{globalThis.fetch=original;}
});

test("Node archive streaming bytes are bounded even without Content-Length",async()=>{
 const spec={filename:"node-v22.23.3-win-x64.zip",archiveUrl:"https://nodejs.org/dist/v22.23.3/node-v22.23.3-win-x64.zip"};
 const original=globalThis.fetch;
 let calls=0;
 globalThis.fetch=async()=>{calls++;return {ok:true,headers:{get:()=>null},body:{async *[Symbol.asyncIterator](){yield {byteLength:161*1024*1024};}}};};
 try{await assert.rejects(fetchVerifiedNode(spec),/runtime_download_failed/);assert.equal(calls,2);}
 finally{globalThis.fetch=original;}
});
