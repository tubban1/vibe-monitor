import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {analyzeStructuralFile,supportsStructuralEvidence} from "../src/structural-evidence.js";
import {componentScript,STRUCTURAL_LANGUAGES} from "../src/languages.js";

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
 for(const p of ["main.go","Main.java","lib.rs","App.cs"]){
  assert.equal(supportsStructuralEvidence(p),false,p);
  assert.equal(analyzeStructuralFile(file(path.basename(p),"x"),p),null,p);
 }
 assert.deepEqual([...STRUCTURAL_LANGUAGES].sort(),["javascript","python","svelte","tsx","typescript","vue"]);
});
