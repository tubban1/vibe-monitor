// V1 is a pure projection of already-computed scan signals. No I/O, LLM or extra traversal.
export const ARCHITECTURE_PROFILE_VERSION = 1;

const STACK_GROUPS = Object.freeze(["state", "http", "validation", "orm", "logging"]);
const DEPLOYMENT_CLASSES = Object.freeze({
  vercel: "web_hosting", netlify: "web_hosting",
  fly: "platform_hosting", railway: "platform_hosting", render: "platform_hosting",
  cloudflare: "edge", docker: "container", kubernetes: "orchestration",
  serverless: "functions", procfile: "process_hosting"
});
const PROVIDER_DOMAINS = Object.freeze({
  openai: "ai", anthropic: "ai", stripe: "payments",
  supabase: "data_backend", firebase: "data_backend",
  aws: "cloud", google: "cloud", azure: "cloud",
  cloudflare: "cloud", vercel: "cloud",
  github: "developer_services", twilio: "communications", sendgrid: "communications"
});

function count(value) {
  return typeof value === "number" && Number.isFinite(value) && value >= 0 ? value : 0;
}
function band(value) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0) return "unknown";
  if (value < 1) return "none";
  if (value <= 2) return "1-2";
  if (value <= 5) return "3-5";
  if (value <= 10) return "6-10";
  if (value <= 50) return "11-50";
  return "gt50";
}
function selectedCategories(items, known, limit = 32) {
  if (!Array.isArray(items)) return [];
  const result = new Set();
  for (const item of items.slice(0, limit)) {
    if (typeof item !== "string") continue;
    const category = Object.hasOwn(known, item) ? known[item] : null;
    if (category) result.add(category);
  }
  return [...result].sort().slice(0, 8);
}
function productCandidate(s) {
  const tenant = count(s.tenantSignals);
  const commercial = count(s.commercialSignals);
  const endpoints = count(s.publicEndpoints);
  const processes = count(s.processSignals);
  const platform = count(s.platformAssumptions);
  if (tenant >= 3 && commercial >= 2) return { type: "saas_candidate", confidence: "medium" };
  if (commercial >= 2 && endpoints >= 3) return { type: "commerce_candidate", confidence: "low" };
  if (processes >= 3 && platform >= 4) return { type: "developer_tool_candidate", confidence: "low" };
  if (endpoints >= 5) return { type: "api_service_candidate", confidence: "low" };
  return { type: "unknown", confidence: "unknown" };
}

/** Bounded anonymous signals only; never claims a product category as confirmed. */
export function buildArchitectureProfile(result) {
  if (result?.monitoring?.mode !== "full") return null;
  const s = result?.summary;
  if (!s || typeof s.sourceFiles !== "number" || !Number.isFinite(s.sourceFiles) || s.sourceFiles < 0) return null;
  const technologies = s.technologyGroups && typeof s.technologyGroups === "object" ? s.technologyGroups : {};
  return {
    version: ARCHITECTURE_PROFILE_VERSION,
    provenance: "scan_inferred",
    product: productCandidate(s),
    stack: {
      technologyGroups: STACK_GROUPS.filter(group =>
        Array.isArray(technologies[group]) && technologies[group].length > 0),
      deploymentClasses: selectedCategories(s.deploymentTargets, DEPLOYMENT_CLASSES),
      integrationDomains: selectedCategories(s.providerPackages, PROVIDER_DOMAINS)
    },
    architecture: {
      workspace: count(s.workspacePackages) >= 2 ? "multi_package_signal" : "unknown",
      apiEndpoints: band(s.publicEndpoints),
      tenantConcepts: band(s.tenantSignals),
      backgroundJobs: band(s.backgroundJobSignals),
      statePersistence: band(s.persistenceSignals),
      asyncPaths: band(s.asyncPaths)
    },
    engineering: {
      duplicationGroups: band(s.duplicateBlockGroups),
      testsPresent: count(s.testFiles) > 0,
      testLoc: band(s.testLoc),
      assertionSignals: band(s.assertionSignals)
    }
  };
}
