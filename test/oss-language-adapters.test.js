import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {analyzeStructuralFile,supportsStructuralEvidence} from "../src/structural-evidence.js";
import {componentScript,STRUCTURAL_LANGUAGES} from "../src/languages.js";
import {TEST_SCOPE_PATTERN} from "../src/constants.js";

const dir=fs.mkdtempSync(path.join(os.tmpdir(),"vm-lang-"));
const file=(name,text)=>{const p=path.join(dir,name);fs.writeFileSync(p,text);return p;};
test.after(()=>fs.rmSync(dir,{recursive:true,force:true}));

const VUE=`<template>
  <div>{{ total }}</div>
</template>

<script setup lang="ts">
import { ref } from "vue";
import { fetchOrders } from "./api";
const orders = ref([]);
async function loadOrders() { orders.value = await fetchOrders(); }
function total() { return orders.value.length; }
const render = () => total();
function refresh() { loadOrders(); render(); }
</script>
`;

test("Vue <script setup lang=ts> is parsed as TypeScript and reported as vue",()=>{
 const r=analyzeStructuralFile(file("Orders.vue",VUE),"src/Orders.vue");
 assert.equal(r.language,"vue");
 assert.equal(r.parseErrors,0);
 assert.equal(r.functionCount,4);
 assert.equal(r.importDeclarationCount,2);
 assert.ok(r.localCallEdges>=2,"refresh -> loadOrders/render");
});

test("Svelte uses the instance script, not the module script",()=>{
 const src=`<script context="module">export const prerender = true;</script>
<script>
  let count = 0;
  function increment() { count += 1; }
  function reset() { count = 0; }
</script>
<button on:click={increment}>{count}</button>`;
 const r=analyzeStructuralFile(file("Counter.svelte",src),"src/Counter.svelte");
 assert.equal(r.language,"svelte");
 assert.equal(r.functionCount,2);
});

test("a template-only component has no functions and no parse errors (negative fixture)",()=>{
 const r=analyzeStructuralFile(file("Static.vue","<template><p>Hello</p></template>\n<style>p{color:red}</style>\n"),"src/Static.vue");
 assert.equal(r.language,"vue");
 assert.equal(r.functionCount,0);
 assert.equal(r.parseErrors,0);
});

test("script line offset maps function lines back to the component file",()=>{
 const s=componentScript(VUE);
 assert.equal(s.typescript,true);
 assert.equal(s.lineOffset,4);
 assert.equal(componentScript("<template/>"),null);
});

test("languages without an adapter stay unsupported",()=>{
 for(const p of ["Main.java","App.cs"]){
  assert.equal(supportsStructuralEvidence(p),false,p);
  assert.equal(analyzeStructuralFile(file(path.basename(p),"x"),p),null,p);
 }
 assert.deepEqual([...STRUCTURAL_LANGUAGES].sort(),["go","javascript","python","rust","svelte","swift","tsx","typescript","vue"]);
});

test("Go *_test.go scope detection: standard suffix without false positives",()=>{
  const { test: scopeTest } = { test: TEST_SCOPE_PATTERN.test.bind(TEST_SCOPE_PATTERN) };
  for (const p of ["cli/deploy_test.go","pkg/util_test.go","internal/a_test.go","nested/path/case_test.go"]) {
    assert.equal(scopeTest(p), true, p);
  }
  for (const p of ["cli/test_helper.go","pkg/testdata.go","pkg/util.go","pkg/my_test.golang"]) {
    assert.equal(scopeTest(p), false, p);
  }
});

test("Go and Rust AST adapters parse functions, calls and imports",()=>{
 const go=analyzeStructuralFile(file("worker.go",'package main\nimport "fmt"\nfunc process() int { return helper() }\nfunc helper() int { fmt.Println("ok"); return 1 }\n'),"src/worker.go");
 assert.equal(go.language,"go");
 assert.equal(go.functionCount,2);
 assert.equal(go.localCallEdges,1);
 assert.equal(go.parseErrors,0);
 const rust=analyzeStructuralFile(file("worker.rs",'use std::fmt;\nfn process() -> i32 { helper() }\nfn helper() -> i32 { 1 }\n#[cfg(test)] mod tests { #[test] fn test_process(){ assert_eq!(process(),1); }}\n'),"src/worker.rs");
 assert.equal(rust.language,"rust");
 assert.equal(rust.functionCount,2,"test function must be excluded");
 assert.equal(rust.localCallEdges,1);
 assert.ok(rust.excludedTestRegions>=1);
 assert.equal(rust.parseErrors,0);
});

test("Swift WASM structural grammar identifies functions, local calls and mixed test regions",()=>{
 const src='import Foundation\nfunc doWork() { helper() }\nfunc helper() {}\n';
 const r=analyzeStructuralFile(file("Worker.swift",src),"Sources/Worker.swift");
 assert.equal(r.language,"swift");
 assert.equal(r.functionCount,2);
 assert.equal(r.localCallEdges,1);
 assert.equal(r.parseErrors,0);
 const withTests='import Testing\nfunc run() { helper() }\n@Test func testRun() { #expect(true) }\nfunc helper() {}\n';
 const testScan=analyzeStructuralFile(file("Mixed.swift",withTests),"Sources/Mixed.swift");
 assert.equal(testScan.functionCount,2,"@Test function is not production");
 assert.ok(testScan.excludedTestRegions>0);
});
