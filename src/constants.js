export const EVIDENCE_VERSION = 7;
export const CLIENT_VERSION = "1.0.0";
export const DEFAULT_CLOUD_URL = "https://vibe-api.fde.fan";

export const SOURCE_EXTENSIONS = new Set([
  ".js", ".jsx", ".ts", ".tsx", ".mjs", ".cjs",
  ".py", ".go", ".rs", ".java", ".kt", ".kts",
  ".swift", ".c", ".h", ".cc", ".cpp", ".hpp",
  ".cs", ".rb", ".php", ".vue", ".svelte"
]);

export const IGNORED_DIRS = new Set([
  ".git", "node_modules", "dist", "build", ".next", ".nuxt",
  ".turbo", ".cache", "coverage", "vendor", "target", "Pods",
  ".venv", "venv", "site-packages", "dist-packages", "__pypackages__",
  ".tox", "__pycache__", ".idea", ".vscode"
]);

export const STAGES = Object.freeze({
  S0: { rank: 0, label: "Unknown" },
  S1: { rank: 1, label: "Healthy" },
  S2: { rank: 2, label: "Drift" },
  S3: { rank: 3, label: "Pressure" },
  S4: { rank: 4, label: "Transition Window" },
  S5: { rank: 5, label: "Critical" }
});

export const RESPONSIBILITY_PATTERNS = {
  ui: /(?:react|vue|svelte|component|render|dom|jsx|tsx|template)/i,
  data: /(?:database|query|sql|prisma|sequelize|mongoose|repository|storage|persist)/i,
  api: /(?:router|route|endpoint|request|response|fetch\(|axios|http)/i,
  auth: /(?:auth|oauth|jwt|session|permission|role|credential)/i,
  ai: /(?:openai|anthropic|llm|model|prompt|embedding|inference)/i,
  filesystem: /(?:readFile|writeFile|filesystem|\bfs\.|path\.)/i,
  process: /(?:child_process|spawn\(|exec\(|worker_threads|multiprocessing|subprocess)/i,
  network: /(?:socket|websocket|grpc|sse|tcp|udp|network)/i,
  state: /(?:useState|useReducer|redux|zustand|store|globalThis|singleton|state)/i,
  rendering: /(?:canvas|webgl|three|renderer|animation|gsap|svg)/i,
  export: /(?:export.*pdf|download|serialize|csv|pdf|print)/i,
  scheduling: /(?:cron|schedule|queue|job|worker|retry)/i,
  observability: /(?:telemetry|opentelemetry|trace|metric|logger|logging|span)/i
};

export const PLATFORM_PATTERNS = [
  /process\.platform/g,
  /process\.arch/g,
  /\bdarwin\b/gi,
  /\bwin32\b/gi,
  /\blinux\b/gi,
  /\barm64\b/gi,
  /\bx64\b/gi,
  /\bcuda\b/gi,
  /\bmetal\b/gi,
  /\brocm\b/gi,
  /\btpu\b/gi
];

export const CREDENTIAL_PATTERNS = [
  /process\.env\.[A-Z0-9_]*(?:TOKEN|KEY|SECRET|PASSWORD|CREDENTIAL)[A-Z0-9_]*/g,
  /(?:api[_-]?key|token|secret|password|credential)\s*[:=]\s*["'][^"']+["']/gi
];

export const PUBLIC_ENDPOINT_PATTERNS = [
  /\b(?:app|router)\.(?:get|post|put|patch|delete)\s*\(/g,
  /@(?:Get|Post|Put|Patch|Delete)\s*\(/g,
  /@(?:app|router)\.(?:get|post|put|patch|delete)\s*\(/g,
  /\bexport\s+(?:async\s+)?function\s+(?:GET|POST|PUT|PATCH|DELETE)\s*\(/g,
  /\bexport\s+const\s+(?:GET|POST|PUT|PATCH|DELETE)\s*=/g,
  /\b(?:GET|POST|PUT|PATCH|DELETE)\s+\/[A-Za-z0-9_{}:/.-]+/g
];


export const TEST_SCOPE_PATTERN = /(^|\/)(tests?|__tests__|specs?|acceptance|verification)(\/|$)|(^|\/)(?:(?:run-)?test|spec|verify|check|soak)[-_][^/]+\.[^.]+$|\.(test|spec)\.[^.]+$/i;
