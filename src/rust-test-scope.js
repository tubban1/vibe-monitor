// Rust inline tests are parsed as syntax-tree regions, not filename-only heuristics.
import Parser from "tree-sitter";
import Rust from "tree-sitter-rust";

const parser = new Parser();
parser.setLanguage(Rust);
const IS_TEST = /#\s*\[\s*(?:cfg\s*\(\s*test\s*\)|test(?:\s*\([^]]*\))?)\s*\]/;

export function rustTestRanges(source) {
  const tree = parser.parse(source);
  const spans = [];
  function visit(parent) {
    let testNext = false;
    for (const n of parent.namedChildren) {
      if (n.type === "attribute_item" && IS_TEST.test(n.text)) {
        if (/#\s*\[\s*cfg/.test(n.text)) spans.push([n.startIndex, n.endIndex]);
        testNext = true;
        continue;
      }
      if (testNext && ["mod_item", "function_item", "impl_item"].includes(n.type)) {
        spans.push([n.startIndex, n.endIndex]);
        testNext = false;
        continue;
      }
      testNext = false;
      if (n.namedChildCount) visit(n);
    }
  }
  visit(tree.rootNode);
  spans.sort((a,b) => a[0]-b[0]);
  const merged=[];
  for(const [a,b] of spans){
    const prior=merged.at(-1);
    if(prior && a <= prior[1]) prior[1]=Math.max(prior[1],b);
    else merged.push([a,b]);
  }
  return {ranges: merged, parseErrors: Boolean(tree.rootNode.hasError)};
}

export function locInRanges(source,ranges){
  const lines=new Set();
  for(const [a,b] of ranges){
    let line=source.slice(0,a).split("\n").length;
    for(const chunk of source.slice(a,b).split("\n")){
      if(chunk.trim()) lines.add(line);
      line++;
    }
  }
  return lines.size;
}
export function withinRanges(node,ranges){
  return ranges.some(([a,b])=>node.startIndex>=a && node.endIndex<=b);
}


export function maskSourceRanges(source,ranges){
  if(!ranges?.length)return source;
  let last=0;
  let out="";
  for(const [a,b] of ranges){
    out+=source.slice(last,a)+source.slice(a,b).replace(/[^\n]/g," ");
    last=b;
  }
  return out+source.slice(last);
}
