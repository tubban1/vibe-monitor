// Swift grammar is a pinned WASM asset: no native node-gyp installation required.
// web-tree-sitter initialization is completed once at module load, before sync scans.
import { Parser, Language } from "web-tree-sitter";
import { createRequire } from "node:module";
import { locInRanges } from "./rust-test-scope.js";
const grammarFile=createRequire(import.meta.url).resolve("@lumis-sh/wasm-swift/tree-sitter-swift.wasm");
await Parser.init();
const grammar=await Language.load(grammarFile);
export const swiftParser=new Parser();
swiftParser.setLanguage(grammar);

export function swiftTestRanges(source){
  let root;
  try { root=swiftParser.parse(source).rootNode; }
  catch { return {ranges:[],testLoc:0,parserErrors:true,unavailable:true}; }
  const ranges=[];
  function walk(node){
    if(node.type==="function_declaration" && /^\s*@Test\b/.test(node.text)){
      ranges.push([node.startIndex,node.endIndex]);
      return;
    }
    if(node.type==="class_declaration" &&
      /^\s*(?:final\s+)?class\s+\w+\s*:\s*(?:XCTestCase|XCTest\.XCTestCase)\b/.test(node.text.slice(0,220))){
      ranges.push([node.startIndex,node.endIndex]);
      return;
    }
    for(const child of node.namedChildren)walk(child);
  }
  walk(root);
  ranges.sort((a,b)=>a[0]-b[0]);
  return {ranges,testLoc:locInRanges(source,ranges),parserErrors:Boolean(root.hasError)};
}
