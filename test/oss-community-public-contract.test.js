import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import {fileURLToPath} from "node:url";
import path from "node:path";
import {DISTRIBUTION_MODE} from "../src/distribution.js";
import {COMMUNITY_POLICY_TRUSTED_PUBLIC_KEY_PEM} from "../src/community-cloud-policy.js";
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
