import fs from "node:fs";
import path from "node:path";
import Parser from "tree-sitter";
import { RESPONSIBILITY_PATTERNS } from "./constants.js";
import { resolveLanguage, supportsLanguage } from "./languages.js";

const RESPONSIBILITY_GROUPS = Object.freeze({
  presentation: new Set(["ui", "rendering"]),
  data: new Set(["data", "filesystem", "state"]),
  integration: new Set(["api", "auth", "network", "ai"]),
  execution: new Set(["process", "scheduling"]),
  operations: new Set(["observability"]),
  delivery: new Set(["export"])
});

export function supportsStructuralEvidence(filePath) {
  return supportsLanguage(filePath);
}

function nodeText(source, node) {
  return source.slice(node.startIndex, node.endIndex);
}

function responsibilityNames(text) {
  return Object.entries(RESPONSIBILITY_PATTERNS)
    .filter(([, regex]) => regex.test(text))
    .map(([name]) => name);
}

function groupForResponsibilities(names) {
  let best = null;
  let bestCount = 0;
  for (const [group, members] of Object.entries(RESPONSIBILITY_GROUPS)) {
    const count = names.filter(name => members.has(name)).length;
    if (count > bestCount) {
      best = group;
      bestCount = count;
    }
  }
  return best || "domain";
}

function walk(node, visit, { stopAtNestedFunctions = false, rootFunction = null, functionTypes = null } = {}) {
  const stack = [node];
  while (stack.length) {
    const current = stack.pop();
    if (
      stopAtNestedFunctions &&
      current !== rootFunction &&
      functionTypes?.has(current.type)
    ) {
      continue;
    }
    visit(current);
    for (let i = current.namedChildCount - 1; i >= 0; i--) {
      const child = current.namedChild(i);
      if (child) stack.push(child);
    }
  }
}

function functionName(node, source, adapter) {
  const direct = node.childForFieldName?.("name");
  if (direct) return nodeText(source, direct).trim();
  const field = adapter.nameParents[node.parent?.type];
  if (field) {
    const name = node.parent.childForFieldName?.(field);
    if (name) return nodeText(source, name).trim();
  }
  return null;
}

function callTarget(node, source) {
  const target = node.childForFieldName?.("function") || node.namedChild?.(0);
  if (!target) return null;
  const text = nodeText(source, target).trim();
  return /^[A-Za-z_$][\w$]*$/.test(text) ? text : null;
}

function structuralImports(root, source, adapter) {
  const specs = new Set();
  let count = 0;
  const text = node => nodeText(source, node);
  walk(root, node => {
    const spec = adapter.importSpec(node, text);
    if (spec === undefined) return;
    count += 1;
    if (spec) specs.add(spec);
  });
  return { count, specs: [...specs] };
}

function countErrors(root) {
  let errors = 0;
  walk(root, node => {
    if (node.type === "ERROR" || node.isMissing) errors += 1;
  });
  return errors;
}

export function analyzeStructuralFile(absolutePath, relativePath = absolutePath) {
  const resolved = resolveLanguage(relativePath, () => fs.readFileSync(absolutePath, "utf8"));
  if (!resolved) return null;
  const { adapter, source, lineOffset } = resolved;
  const parser = new Parser();
  parser.setLanguage(adapter.grammar);
  const tree = parser.parse(source);
  const root = tree.rootNode;

  const functions = [];
  walk(root, node => {
    if (!adapter.functionTypes.has(node.type)) return;
    const name = functionName(node, source, adapter);
    const text = nodeText(source, node);
    const responsibilities = responsibilityNames(text);
    functions.push({
      name,
      group: groupForResponsibilities(responsibilities),
      responsibilityCount: responsibilities.length,
      line: (node.startPosition?.row + 1 || 1) + lineOffset,
      node
    });
  });

  const namedFunctions = functions.filter(fn => fn.name && /^[A-Za-z_$][\w$]*$/.test(fn.name));
  const localNames = new Set(namedFunctions.map(fn => fn.name));
  const groupByName = new Map();
  for (const fn of namedFunctions) {
    if (!groupByName.has(fn.name)) groupByName.set(fn.name, fn.group);
  }

  const groupCounts = {};
  for (const fn of functions) {
    groupCounts[fn.group] = (groupCounts[fn.group] || 0) + 1;
  }

  let localCallEdges = 0;
  const edgeSet = new Set();
  const internalByGroup = {};
  const crossByGroup = {};

  for (const fn of namedFunctions) {
    walk(fn.node, node => {
      if (!adapter.callTypes.has(node.type)) return;
      const target = callTarget(node, source);
      if (!target || !localNames.has(target) || target === fn.name) return;
      const edgeKey = fn.name + "->" + target;
      if (edgeSet.has(edgeKey)) return;
      edgeSet.add(edgeKey);
      localCallEdges += 1;

      const fromGroup = fn.group;
      const toGroup = groupByName.get(target) || "domain";
      if (fromGroup === toGroup) {
        internalByGroup[fromGroup] = (internalByGroup[fromGroup] || 0) + 1;
      } else {
        crossByGroup[fromGroup] = (crossByGroup[fromGroup] || 0) + 1;
      }
    }, { stopAtNestedFunctions: true, rootFunction: fn.node, functionTypes: adapter.functionTypes });
  }

  const boundaryCandidates = Object.entries(groupCounts)
    .filter(([group, count]) => group !== "domain" && count >= 2)
    .map(([group, functionCount]) => {
      const internalCalls = internalByGroup[group] || 0;
      const crossCalls = crossByGroup[group] || 0;
      const separated = internalCalls >= 1 && crossCalls <= Math.max(1, Math.floor(internalCalls * 0.5));
      const members = functions
        .filter(fn => fn.group === group && fn.name)
        .slice(0, 5)
        .map(fn => ({ name: fn.name, line: fn.line }));
      return { group, functionCount, internalCalls, crossCalls, separated, members };
    })
    .filter(item => item.separated)
    .sort((a, b) =>
      (b.functionCount - a.functionCount) ||
      (b.internalCalls - a.internalCalls) ||
      (a.crossCalls - b.crossCalls)
    )
    .slice(0, 4);

  const imports = structuralImports(root, source, adapter);
  const responsibilityClusterCount = Object.entries(groupCounts)
    .filter(([group, count]) => group !== "domain" && count >= 2)
    .length;

  return {
    parser: "tree-sitter",
    language: resolved.language,
    parseErrors: countErrors(root),
    functionCount: functions.length,
    namedFunctionCount: namedFunctions.length,
    importDeclarationCount: imports.count,
    responsibilityClusterCount,
    localCallEdges,
    boundaryCandidateCount: boundaryCandidates.length,
    boundaryCandidates,
    groupCounts
  };
}
