#!/usr/bin/env node
import { createInstallTracker, retryPendingInstallAttempts } from "./install-tracking.js";
import {safeInstallError} from "./install-error.js";
import { createLocalInstallLifecycle } from "./install-lifecycle.js";
import { INSTALL_NETWORK_MESSAGES } from "./install-network.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeProject, buildVibeCoderBrief } from "./engine.js";
import { buildDisabledPolicyPayload, runMcpServer } from "./mcp.js";
import { installSetup, uninstallSetup, classifyUninstallLifecycle } from "./setup.js";
import { activityCursor, formatActivity, readActivity, readActivityFrom } from "./activity.js";
import { inspectTelemetryQueue, setTelemetryEnabled, setDataIntelligenceEnabled, initializeFreeTelemetry, telemetryStatus } from "./telemetry.js";
import { loadCloudClient, cloudStatus, fetchRemotePolicy, registerCloud, syncTelemetry, reportLifecycleEvent } from "./cloud.js";
import { installProduct, installOpenClientProduct, installStatus } from "./install.js";
import { isOpenClientDistribution, resolveDistributionPolicy } from "./distribution.js";
import { activateStagedUpdate, rollbackUpdate, stageUpdate, updateStatus } from "./update.js";
import { inspectProjectRef, listProjects } from "./projects.js";
import { CLIENT_VERSION, DEFAULT_CLOUD_URL } from "./constants.js";
import { acceptAccountPairing, readMaskedPairingCode } from "./pairing.js";
import {
  exportProjectState,
  inspectProjectState,
  migrateProjectStateTree,
  securityStatus
} from "./secure-store.js";

const filename = fileURLToPath(import.meta.url);
const dirname = path.dirname(filename);
const args = process.argv.slice(2);
const command = args[0] || "help";
const json = args.includes("--json");

function positionalPath() {
  const values = args.slice(1).filter(v => !v.startsWith("--"));
  return values[0] || process.cwd();
}
function optionValue(name, fallback = null) {
  const index = args.indexOf(name);
  if (index < 0 || index + 1 >= args.length) return fallback;
  return args[index + 1];
}
function selectedAgents() {
  const flags = [
    ["--codex", "codex"],
    ["--claude", "claude"],
    ["--cursor", "cursor"],
    ["--antigravity", "antigravity"],
    ["--trae", "trae"]
  ];
  const selected = flags.filter(([flag]) => args.includes(flag)).map(([, name]) => name);
  return selected.length ? selected : undefined;
}
function print(value) { console.log(JSON.stringify(value, null, 2)); }

const INTELLIGENCE_NOTICE = [
  "Vibe Data Intelligence V1 (included in beta telemetry):",
  "Adds a <1 KiB scan-derived architecture profile to existing telemetry after a full scan.",
  "Includes inferred product category, technology groups, structural and test signals.",
  "No source code, prompts, dependency names, project paths or extra scans are uploaded.",
  "Use 'vibe-monitor telemetry intelligence off' to revoke; queued profiles are removed.",
  "Details: https://github.com/tubban1/vibe-monitor/blob/main/docs/governance/TELEMETRY_PRIVACY_V1.md"
].join("\n");

async function configureIntelligenceConsent() {
  if (args.includes("--accept-data-intelligence") && telemetryStatus().enabled) return setDataIntelligenceEnabled(true);
  return telemetryStatus();
}

function installErrorMessage(error) {
  const code = error?.cloudCode || error?.message || "install_failed";
  const status = error?.status || null;
  const phase = error?.installPhase || null;
  const messages = {
    activation_code_required: "Activation code is required.",
    invalid_invite: "The activation code is invalid, disabled, expired, or has reached its device limit.",
    device_owned_by_other_tester: "This device is already linked to a different beta tester.",
    cloud_preflight_failed: "Vibe Cloud could not be reached before activation.",
    credential_preflight_failed: "Windows credential protection (DPAPI) is not working on this machine.",
    cloud_request_failed: "Vibe Cloud rejected the request before returning a Vibe API response."
  };

  const lines = [
    "Vibe Monitor installation failed",
    "",
    "Reason: " + (messages[code] || code)
  ];
  if (phase) lines.push("Phase: " + phase);
  if (phase === "cloud_preflight" && error?.cloudReason) lines.push("Diagnostic: " + String(error.cloudReason).slice(0, 180));
  if (phase === "cloud_preflight" && error?.networkCode) lines.push("Network code: " + String(error.networkCode).slice(0, 80));
  if (phase === "cloud_preflight" && error?.networkCategory) lines.push("Network diagnosis: " + error.networkCategory);
  if (phase === "cloud_preflight" && INSTALL_NETWORK_MESSAGES[error?.networkCategory]) lines.push(INSTALL_NETWORK_MESSAGES[error.networkCategory]);
  if (status) lines.push("HTTP status: " + status);
  if (error?.responseKind) lines.push("Response: " + error.responseKind);
  if (error?.requestId) lines.push("Request ID: " + error.requestId);
  lines.push("");
  if (phase === "credential_preflight") {
    lines.push("Your activation code was not consumed.");
    lines.push("Vibe Monitor stopped before cloud activation. Contact the beta administrator with your Windows version.");
  } else if (phase === "cloud_preflight") {
    lines.push("Your activation code was not consumed.");
    lines.push("Try another network, then contact the beta administrator if the problem continues.");
  } else if (code === "invalid_invite") {
    lines.push("Ask the beta administrator to confirm your activation code.");
  } else {
    lines.push("Contact the beta administrator if the problem continues.");
  }
  return lines.join("\n");
}

function printInstallWelcome(result) {
  const color = process.stdout.isTTY && !process.env.NO_COLOR && process.env.TERM !== "dumb";
  const cyan = (text) => color ? "\x1b[36m" + text + "\x1b[0m" : text;
  const green = (text) => color ? "\x1b[32m" + text + "\x1b[0m" : text;
  const version = result.version || "unknown";
  const agents = result.setup?.selectedAgents || [];
  const agentLabel = agents.length ? agents.join(", ") : "Configured agents";
  const status = (enabled, name, value) =>
    console.log(`  ${enabled ? green("[OK]") : "[--]"} ${name.padEnd(15)} ${value}`);
  // Each letter is explicitly formed, avoiding ambiguous FIGlet V/W glyphs.
  console.log(cyan(String.raw`
  __     __  ___   ____   _____
  \ \   / / |_ _| | __ ) | ____|
   \ \ / /   | |  |  _ \ |  _|
    \ V /    | |  | |_) || |___
     \_/    |___| |____/ |_____|

          VIBE MONITOR
      Architecture Intelligence
`));
  status(result.installed, "Installed", version);
  status(result.activation?.registered, "Cloud", result.activation?.registered ? "Connected" : "Not registered");
  status(result.activation?.serviceEnabled, "Monitoring", result.activation?.serviceEnabled ? "Enabled" : "Disabled by policy");
  console.log("  Data Intelligence: " + (result.telemetry?.dataIntelligenceEnabled ? "Enabled" : "Not enabled (optional)"));
  status(agents.length > 0, "Agent", agentLabel);
  status(result.security?.osProtectedSecrets, "Privacy", result.security?.secretBackend === "macos-keychain" ? "macOS Keychain" : result.security?.osProtectedSecrets ? "OS protected" : "Check security status");
  console.log("\n" + cyan("  You're ready!"));
  console.log("\n  1. Restart your coding agent if it is already open.");
  console.log("  2. Open your coding project.");
  console.log('  3. Ask: "Review this project architecture with Vibe Monitor."');
  console.log("\n" + cyan("  Commands:"));
  console.log("    vibe-monitor doctor --json    Check installation");
  console.log("    vibe-monitor projects          View monitored projects");
  console.log("    vibe-monitor install --json    Full installation report");
  console.log("\n  https://github.com/tubban1/vibe-monitor\n");
}

function printDecisionBrief(brief) {
  const q = brief.questions;
  console.log("Vibe Monitor — five Vibe Coder questions (source evidence only)");
  console.log("Health: " + q.health.status + " | observed stage: " + q.health.highestObservedStage);
  console.log("Trajectory: " + q.trajectory.status);
  console.log("Next action: " + q.nextAction.status);
  for (const p of q.nextAction.priorities) {
    console.log("  [" + p.stage + "] " + p.family + " — " + p.title);
    if (p.doNow.length) console.log("    Do now: " + p.doNow.join(" "));
    if (p.doNotDoYet.length) console.log("    Do not do yet: " + p.doNotDoYet.join(" "));
    if (p.nextTrigger) console.log("    Next trigger: " + p.nextTrigger);
    if (p.standards.length) console.log("    References (not certification): " + p.standards.join("; "));
  }
  console.log("Economics: " + q.economics.status + " (cost evidence unavailable)");
  console.log("Readiness: " + q.readiness.status + " (not a launch certification)");
}

function printHuman(result) {
  console.log("Vibe Monitor — " + result.project.root);
  console.log("Stage: " + result.status.highestStage + " | attention: " + (result.status.attentionRequired ? "yes" : "no") + " | findings: " + result.status.findingCount);
  console.log("Files: " + result.summary.sourceFiles + " | LOC: " + result.summary.totalLoc + " | deps: " + result.summary.productionDependencies);
  for (const f of result.findings.slice(0, 10)) {
    console.log("\n[" + f.stage + "] " + f.family + " — " + f.target + " — score " + f.score);
    console.log(f.title);
    console.log("Do now: " + f.doNow.join(" "));
    console.log("Do not do yet: " + f.doNotDoYet.join(" "));
  }
}

if (command === "install") {
  if (isOpenClientDistribution()) {
    if (args.includes("--no-telemetry")) setTelemetryEnabled(false);
    console.error("Free V4 improvement telemetry defaults on at installation. No source, prompts, paths or raw logs. Inspect: vibe-monitor telemetry inspect; opt out: vibe-monitor telemetry off. Upload remains disabled in this review build.");
    const lifecycle=createLocalInstallLifecycle();
    lifecycle.mark("started");
    try {
      const result=await installOpenClientProduct({
        agents:selectedAgents(),local:true,cliPath:filename,
        onStage:stage=>lifecycle.mark(stage)
      });
      lifecycle.mark("completed");
      result.lifecycle=lifecycle.summary();
      if(json)print(result);else printInstallWelcome(result);
    }catch(error){
      const code=safeInstallError(error);
      lifecycle.mark("failed",code);
      if(json)print({installed:false,errorCode:code,lifecycle:lifecycle.summary()});
      console.error("Vibe Monitor installation failed: "+code);
      process.exitCode=1;
    }
  } else {
  if (args.includes("--no-telemetry")) {
    console.error("Vibe Monitor Private Beta requires telemetry. Installation cancelled.");
    process.exit(2);
  }
  const telemetryDefaultOn = true;
  const inviteCode = optionValue("--invite", process.env.VIBE_BETA_INVITE_CODE || null);
  const baseUrl = optionValue("--url", process.env.VIBE_CLOUD_URL || DEFAULT_CLOUD_URL);
  let mode = "first_install";
  try { if (cloudStatus().registered) mode = "upgrade"; } catch {}
  // Reconcile after activation so verified credentials can link anonymous attempts.
  // Reporting failures never block installation.
  const tracking = createInstallTracker({baseUrl,mode});
  tracking?.mark("started");
  void tracking?.flush();
  const onInterrupt = () => {
    tracking?.mark("interrupted");
    Promise.resolve(tracking?.flushAll()).finally(() => process.exit(130));
  };
  process.once("SIGINT", onInterrupt);
  process.once("SIGTERM", onInterrupt);
  try {
    const result = await installProduct({
      inviteCode,
      baseUrl,
      telemetryDefaultOn,
      agents: selectedAgents(),
      local: args.includes("--local"),
      cliPath: filename,
      tracking
    });
    tracking?.mark("completed");
    await tracking?.flushAll();
    try {
      const client=loadCloudClient();
      if(client?.token)await retryPendingInstallAttempts({baseUrl:client.baseUrl||baseUrl,token:client.token});
    } catch {}
    result.telemetry = { ...result.telemetry, ...await configureIntelligenceConsent() };
    // Explicit install event doubles as recovery evidence after an uninstallation.
    try {
      result.lifecycle = await reportLifecycleEvent("lifecycle.installed", {
        agents: result.setup?.selectedAgents || [],
        reusedActivation: result.activation?.reusedExisting === true,
        scope: "full"
      });
    } catch { result.lifecycle = { delivered: false, reason: "report_unavailable" }; }
    if (json) print(result);
    else printInstallWelcome(result);
  } catch (error) {
    tracking?.mark("failed", safeInstallError(error));
    await tracking?.flushAll();
    try {
      const client=loadCloudClient();
      if(client?.token)await retryPendingInstallAttempts({baseUrl:client.baseUrl||baseUrl,token:client.token});
    } catch {}
    console.error(installErrorMessage(error));
    if (args.includes("--debug")) console.error(error?.stack || error);
    process.exitCode = 1;
  } finally {
    process.removeListener("SIGINT", onInterrupt);
    process.removeListener("SIGTERM", onInterrupt);
  }
  }
} else if (command === "mcp") {
  if(!isOpenClientDistribution()){
    try {
      const client=loadCloudClient();
      if(client?.token)void retryPendingInstallAttempts({baseUrl:client.baseUrl||DEFAULT_CLOUD_URL,token:client.token});
    } catch {}
  }
  await runMcpServer({ agent: optionValue("--agent", null) });
} else if (["scan", "status", "checkpoint", "session-start", "brief"].includes(command)) {
  const remotePolicy = await resolveDistributionPolicy({fetchPolicy:fetchRemotePolicy,force:command==="session-start"});
  if (remotePolicy.enabled === false) {
    print(buildDisabledPolicyPayload(remotePolicy));
  } else {
    const persist = command !== "status" && command !== "brief";
    const result = analyzeProject(positionalPath(), { persist, decisionPolicy: remotePolicy.config?.decisionPolicy });
    if (command === "brief") {
      const brief = buildVibeCoderBrief(result);
      if (json) print(brief); else printDecisionBrief(brief);
    } else if (json) print(result); else printHuman(result);
  }
} else if (command === "projects") {
  const projects = listProjects();
  if (json) print(projects);
  else if (!projects.length) console.log("No monitored projects yet.");
  else {
    console.log("PROJECT\tID\tSTAGE\tLAST SEEN");
    for (const project of projects) {
      console.log([project.displayName, project.projectId.slice(0, 6), project.highestStage, project.lastSeenAt || "-"].join("\t"));
    }
  }
} else if (command === "inspect") {
  const ref = args[1];
  try {
    print(inspectProjectRef(ref));
  } catch (error) {
    if (Array.isArray(error?.matches) && error.matches.length) {
      console.error("Multiple matching projects:");
      for (const project of error.matches) console.error(project.displayName + "  " + project.projectId.slice(0, 6));
      console.error("Use a unique ID prefix, for example: vibe-monitor inspect " + error.matches[0].projectId.slice(0, 6));
    } else {
      console.error(error?.message || "project_lookup_failed");
    }
    process.exit(2);
  }
} else if (command === "license") {
  print(cloudStatus());
} else if (command === "doctor") {
  print({ install: installStatus(), security: securityStatus(), telemetry: telemetryStatus() });
} else if (command === "activity") {
  const parsedLimit = Number(optionValue("--limit", "50"));
  const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 50;
  const follow = args.includes("--follow");
  const items = readActivity({ limit });
  if (json && !follow) print(items);
  else for (const item of items) console.log(json ? JSON.stringify(item) : formatActivity(item));

  if (follow) {
    let offset = activityCursor();
    const timer = setInterval(() => {
      const next = readActivityFrom(offset);
      offset = next.nextOffset;
      for (const item of next.items) console.log(json ? JSON.stringify(item) : formatActivity(item));
    }, 500);
    process.on("SIGINT", () => {
      clearInterval(timer);
      process.exit(0);
    });
    process.on("SIGTERM", () => {
      clearInterval(timer);
      process.exit(0);
    });
  }
} else if (command === "telemetry") {
  const action = args[1] || "status";
  if (action === "intelligence") {
    const choice = args[2] || "status";
    if (choice === "on") {
      if (!isOpenClientDistribution()) console.error(INTELLIGENCE_NOTICE);
      print(setDataIntelligenceEnabled(true));
    } else if (choice === "off") {
      print(setDataIntelligenceEnabled(false));
    } else if (choice === "status") {
      print(telemetryStatus());
    } else {
      console.error("Expected telemetry intelligence on|off|status");
      process.exit(2);
    }
  } else if (action === "on") {
    print(setTelemetryEnabled(true));
  } else if (action === "off") {
    if (isOpenClientDistribution()) print(setTelemetryEnabled(false));
    else {
      console.error("Vibe Monitor Private Beta requires telemetry. Telemetry cannot be disabled during the beta.");
      process.exit(2);
    }
  } else if (action === "inspect") {
    const parsedLimit = Number(optionValue("--limit", "50"));
    const limit = Number.isFinite(parsedLimit) && parsedLimit > 0 ? Math.floor(parsedLimit) : 50;
    print({
      status: telemetryStatus(),
      nextBatch: inspectTelemetryQueue({ limit })
    });
  } else if (action === "status") {
    print(telemetryStatus());
  } else {
    console.error("Unknown telemetry action: " + action);
    process.exit(2);
  }
// QA opt-in only. A pairing code must never be passed as a CLI argument.
} else if (command === "account" && args[1] === "link") {
  if (isOpenClientDistribution()) {
    // Private Beta QA pairing is not a public account entitlement contract.
    // Never let an environment variable expose this legacy transport in OSS.
    console.error("Account pairing is not released for the open client yet.");
    process.exitCode = 2;
  } else if (!args.includes("--qa") || process.env.VIBE_PORTAL_PAIRING_QA !== "1") {
    console.error("Account pairing is not released yet. Existing installations are unchanged.");
    process.exitCode = 2;
  } else if (args.includes("--code") || args.some(v => v.startsWith("--code="))) {
    console.error("Do not pass pairing codes via command arguments. Use hidden interactive input.");
    process.exitCode = 2;
  } else {
    try {
      const code = await readMaskedPairingCode();
      const result = await acceptAccountPairing({client:loadCloudClient(),code});
      if (json) print(result);
      else console.log(result.accepted
        ? "Device accepted. Return to Vibe Monitor account center to confirm."
        : "Pairing not completed: " + result.reason);
      if (!result.accepted) process.exitCode = 1;
    } catch (error) {
      console.error("Pairing not completed: " + (error?.message || "request_failed"));
      process.exitCode = 1;
    }
  }
} else if (command === "cloud") {
  const action = args[1] || "status";
  // Open-client baseline reads only the public signed strategy. Beta registration and
  // telemetry uploads are not available in this distribution.
  if (isOpenClientDistribution()) {
    if (action === "status" || action === "config")
      print(await resolveDistributionPolicy({force:action==="config"&&args.includes("--force")}));
    else {
      console.error("Legacy Beta registration/sync is unavailable; Cloud account access requires a verified grant.");
      process.exit(2);
    }
  } else if (action === "register") {
    const baseUrl = optionValue("--url", process.env.VIBE_CLOUD_URL || DEFAULT_CLOUD_URL);
    const inviteCode = optionValue("--invite", process.env.VIBE_BETA_INVITE_CODE || null);
    print(await registerCloud({
      baseUrl,
      inviteCode,
      agent: "cli",
      clientVersion: CLIENT_VERSION
    }));
  } else if (action === "status") {
    print(cloudStatus());
  } else if (action === "config") {
    print(await fetchRemotePolicy({ force: args.includes("--force") }));
  } else if (action === "sync") {
    print(await syncTelemetry({ limit: Number(optionValue("--limit", "100")) || 100 }));
  } else {
    console.error("Unknown cloud action: " + action);
    process.exit(2);
  }
} else if (command === "update") {
  const action = args[1] || "status";
  try {
    if (action === "status") {
      print(await updateStatus({ refresh: args.includes("--refresh") }));
    } else if (action === "check") {
      print(await updateStatus({ refresh: true }));
    } else if (action === "stage") {
      print(await stageUpdate());
    } else if (action === "activate") {
      print(activateStagedUpdate());
    } else if (action === "rollback") {
      print(rollbackUpdate());
    } else {
      console.error("Unknown update action: " + action);
      process.exit(2);
    }
  } catch (error) {
    console.error("Vibe Monitor update failed");
    console.error("");
    console.error("Reason: " + (error?.message || "update_failed"));
    process.exit(2);
  }
} else if (command === "security") {
  const action = args[1] || "status";
  const projectPath = args[2] && !args[2].startsWith("--") ? args[2] : process.cwd();
  const section = optionValue("--section", "all");
  const snapshotLimit = Number(optionValue("--snapshots", "10")) || 10;

  if (action === "migrate") {
    const migration = migrateProjectStateTree();
    print({ migration, status: securityStatus() });
  } else if (action === "status") {
    print(securityStatus());
  } else if (action === "show") {
    print(inspectProjectState(projectPath, { section, snapshotLimit }));
  } else if (action === "export") {
    const output = optionValue("--output");
    if (!output) {
      console.error("security export requires --output <file>");
      process.exit(2);
    }
    print(exportProjectState(projectPath, output, { section, snapshotLimit }));
  } else {
    console.error("Unknown security action: " + action);
    process.exit(2);
  }
} else if (command === "setup") {
  const dryRun = args.includes("--dry-run");
  const openClient = isOpenClientDistribution();
  if (args.includes("--no-telemetry") && !openClient) {
    console.error("Vibe Monitor Private Beta requires telemetry. Setup cancelled.");
    process.exit(2);
  }
  const telemetryDefaultOn = true;
  const local = args.includes("--local");
  const installedRuntime = local ? null : installStatus();
  // Reconfigure installed coding agents against the stable, rollback-capable
  // launcher. Never silently switch a registered IDE back to npx @latest.
  const stableLauncher = installedRuntime?.launcherPresent && installedRuntime?.runtimePresent
    ? installedRuntime.launcher : undefined;
  const setup = installSetup({
    dryRun,
    local,
    runtimeCommand: stableLauncher,
    cliPath: filename,
    agents: selectedAgents()
  });
  if (dryRun) {
    print({
      ...setup,
      telemetry: {
        defaultEnabled: telemetryDefaultOn,
        userCanDisable: openClient,
        requiredDuringPrivateBeta: !openClient
      }
    });
  } else {
    const migration = migrateProjectStateTree();
    if (openClient) console.error("Free V4 telemetry defaults on; inspect/off controls are available. Anonymous Cloud intake is not released.");
    const telemetry = openClient
      ? (args.includes("--no-telemetry") ? setTelemetryEnabled(false) : initializeFreeTelemetry())
      : setTelemetryEnabled(telemetryDefaultOn);
    const intelligence = openClient ? {} : await configureIntelligenceConsent();
    print({
      ...setup,
      security: {
        migration,
        ...securityStatus()
      },
      telemetry: {
        ...telemetry,
        ...intelligence,
        defaultEnabled: telemetryDefaultOn,
        userCanDisable: openClient,
        requiredDuringPrivateBeta: !openClient,
        inspectCommand: "vibe-monitor telemetry inspect"
      }
    });
  }
} else if (command === "uninstall") {
  const removal = uninstallSetup({ agents: selectedAgents() });
  const classification = classifyUninstallLifecycle(removal);
  let report = { queued: false, delivered: false, reason: "no_change" };
  // Open-client uninstall never reports lifecycle data to the private Beta Cloud,
  // even if an earlier Beta left credentials on the same computer.
  if (classification.event && !isOpenClientDistribution()) {
    try {
      report = await reportLifecycleEvent(classification.event, classification);
    } catch {
      report = { queued: false, delivered: false, reason: "report_unavailable" };
    }
  }
  print({ ...removal, lifecycle: { ...classification, report } });
} else if (command === "self-test") {
  const proc = spawnSync(process.execPath, ["--test"], { cwd: path.resolve(dirname, ".."), stdio: "inherit" });
  process.exit(proc.status == null ? 1 : proc.status);
} else {
  console.log([
    "Vibe Monitor " + CLIENT_VERSION + (isOpenClientDistribution() ? "" : " private beta"),
    "",
    "Usage:",
    "  vibe-monitor install " + (isOpenClientDistribution() ? "[--no-telemetry] [--codex|--claude|--cursor|--antigravity|--trae]" : "[--invite CODE] [--url URL] [--codex|--claude|--cursor|--antigravity|--trae] [--debug]"),
    "  vibe-monitor session-start [path] [--json]",
    "  vibe-monitor checkpoint [path] [--json]",
    "  vibe-monitor status [path] [--json]",
    "  vibe-monitor scan [path] [--json]",
    "  vibe-monitor brief [path] [--json]   Answer five core questions from one scan",
    "  vibe-monitor mcp",
    "  vibe-monitor projects [--json]",
    "  vibe-monitor inspect <name|id|name@id>",
    "  vibe-monitor license",
    "  vibe-monitor doctor",
    "  vibe-monitor activity [--limit N] [--follow] [--json]",
    "  vibe-monitor telemetry status|inspect|on|off [--limit N]",
    ...(isOpenClientDistribution() ? [] : ["  vibe-monitor telemetry intelligence on|off|status"]),
    "  vibe-monitor cloud " + (isOpenClientDistribution() ? "status|config" : "status|config|sync"),
    ...(isOpenClientDistribution() ? [] : ["  vibe-monitor cloud register [--url URL] [--invite CODE]"]),
    "  vibe-monitor update " + (isOpenClientDistribution() ? "status|check (signed update channel pending)" : "status|check|stage|activate|rollback") + " [--refresh]",
    "  vibe-monitor security status|migrate",
    "  vibe-monitor security show [project] [--section latest|findings|intent|notice|snapshots|all]",
    "  vibe-monitor security export [project] --output <file> [--section ...]",
    "  vibe-monitor setup [--dry-run] [--local] [--codex|--claude|--cursor|--antigravity|--trae]",
    "  vibe-monitor uninstall [--codex|--claude|--cursor|--antigravity|--trae]",
    "  vibe-monitor self-test",
    "",
    "MVP principles:",
    "  - session-scoped, no background daemon",
    "  - source read-only",
    "  - local history by default",
    "  - " + (isOpenClientDistribution() ? "Free V4 telemetry defaults on after install, opt-out available; Beta upload unavailable" : "private-beta telemetry is required and inspectable"),
    "  - " + (isOpenClientDistribution() ? "signed Cloud policy stays in process memory only" : "private-beta cloud transport uses a per-installation token")
  ].join("\n"));
}
