import path from "node:path";
import JavaScript from "tree-sitter-javascript";
import TypeScript from "tree-sitter-typescript";
import Python from "tree-sitter-python";

// Language adapters for structural evidence (ROADMAP §4 L0). Each adapter
// says how to find functions, calls and imports in one tree-sitter grammar.
// Adding a language = adding an adapter plus positive/negative fixtures.

const ECMASCRIPT = {
  functionTypes: new Set(["function_declaration", "generator_function_declaration", "function_expression",
    "generator_function", "arrow_function", "method_definition"]),
  callTypes: new Set(["call_expression"]),
  // Unnamed functions take the name they are assigned to.
  nameParents: { variable_declarator: "name", pair: "key" },
  importSpec(node, text) {
    if (node.type !== "import_statement") return undefined;
    const source = node.childForFieldName?.("source");
    return source ? text(source).replace(/^["']|["']$/g, "") : null;
  }
};

const PYTHON = {
  functionTypes: new Set(["function_definition"]),
  callTypes: new Set(["call"]),
  nameParents: {},
  importSpec(node, text) {
    if (node.type !== "import_statement" && node.type !== "import_from_statement") return undefined;
    const value = text(node);
    const match = value.match(/^\s*from\s+([A-Za-z0-9_.]+)/) || value.match(/^\s*import\s+([A-Za-z0-9_.]+)/);
    return match ? match[1] : null;
  }
};

const ADAPTERS = {
  javascript: { ...ECMASCRIPT, grammar: JavaScript },
  typescript: { ...ECMASCRIPT, grammar: TypeScript.typescript },
  tsx: { ...ECMASCRIPT, grammar: TypeScript.tsx },
  python: { ...PYTHON, grammar: Python }
};

const BY_EXTENSION = {
  ".js": "javascript", ".jsx": "javascript", ".mjs": "javascript", ".cjs": "javascript",
  ".ts": "typescript", ".tsx": "tsx", ".py": "python"
};

// Single-file components: only the <script> block is code. It is parsed with
// the JS/TS grammar and reported under the component language.
const COMPONENT_EXTENSIONS = { ".vue": "vue", ".svelte": "svelte" };
const SCRIPT_BLOCK = /<script\b([^>]*)>([\s\S]*?)<\/script>/gi;

export function componentScript(source) {
  let code = null, typescript = false, offset = 0;
  for (const match of source.matchAll(SCRIPT_BLOCK)) {
    const attrs = match[1] || "";
    // Prefer the instance/setup script; Svelte's module script is secondary.
    if (code !== null && /context=["']module["']/.test(attrs)) continue;
    code = match[2];
    typescript = /lang=["'](ts|typescript)["']/.test(attrs);
    offset = source.slice(0, match.index + match[0].indexOf(">") + 1).split("\n").length - 1;
    if (/\bsetup\b/.test(attrs)) break;
  }
  return code === null ? null : { code, typescript, lineOffset: offset };
}

// Returns { language, adapter, source, lineOffset } or null when unsupported.
export function resolveLanguage(filePath, readSource) {
  const ext = path.extname(filePath).toLowerCase();
  if (BY_EXTENSION[ext]) {
    const language = BY_EXTENSION[ext];
    return { language, adapter: ADAPTERS[language], source: readSource(), lineOffset: 0 };
  }
  if (COMPONENT_EXTENSIONS[ext]) {
    const script = componentScript(readSource());
    const adapter = ADAPTERS[script?.typescript ? "typescript" : "javascript"];
    return { language: COMPONENT_EXTENSIONS[ext], adapter, source: script ? script.code : "", lineOffset: script?.lineOffset || 0 };
  }
  return null;
}

export function supportsLanguage(filePath) {
  const ext = path.extname(filePath).toLowerCase();
  return Boolean(BY_EXTENSION[ext] || COMPONENT_EXTENSIONS[ext]);
}

export const STRUCTURAL_LANGUAGES = Object.freeze([...new Set([...Object.values(BY_EXTENSION), ...Object.values(COMPONENT_EXTENSIONS)])]);
