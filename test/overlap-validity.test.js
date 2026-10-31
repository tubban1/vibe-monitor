import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {analyzeImplementationOverlap} from "../src/evolution-audit.js";
function fixture(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "vm-semantic-guard-"));
  fs.mkdirSync(path.join(root, "src"), {recursive:true});
  t.after(() => fs.rmSync(root, {recursive:true,force:true}));
  const shape = (name, mul, threshold, operator="*") => [
    "export function " + name + "(input){",
    " const rows = input.map(row => {",
    "  if (!row.active) return null;",
    "  const number = row.value " + operator + " " + mul + ";",
    "  if (number > " + threshold + ") return {number, status:'large'};",
    "  return {number, status:'small'};",
    " });",
    " return rows.filter(Boolean);",
    "}"
  ].join("\n") + "\n";
  for (const [name,code] of Object.entries({
    a:shape("calculate",2,50),
    b:shape("process",2,50),
    c:shape("rate",3,50),
    d:shape("threshold",2,60),
    e:shape("subtract",2,50,"-")
  })) fs.writeFileSync(path.join(root,"src",name+".js"),code);
  return root;
}
test("positive: renamed but same implementation remains overlap candidate", t=>{
  const root=fixture(t);
  const result=analyzeImplementationOverlap(root,{files:["src/a.js","src/b.js"]});
  assert.equal(result.pairs.length,1);
  assert.equal(result.pairs[0].deletionAuthorized,false);
});
test("negative: different literals and operators must not become redundancy alerts", t=>{
  const root=fixture(t);
  for(const file of ["src/c.js","src/d.js","src/e.js"]) {
    const result=analyzeImplementationOverlap(root,{files:["src/a.js",file]});
    assert.equal(result.pairs.length,0,JSON.stringify({file,pairs:result.pairs}));
  }
});
