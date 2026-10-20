#!/usr/bin/env node
import { createInstallTracker, retryPendingInstallAttempts } from "./install-tracking.js";
import {safeInstallError} from "./install-error.js";
import { createLocalInstallLifecycle, latestLocalInstallAttempt } from "./install-lifecycle.js";
import { INSTALL_NETWORK_MESSAGES } from "./install-network.js";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";
import { analyzeProject, buildVibeCoderBrief } from "./engine.js";
import { buildDisabledPolicyPayload, applyMonitoringPolicy, runMcpServer } from "./mcp.js";
import { installSetup, uninstallSetup, classifyUninstallLifecycle } from "./setup.js";
import { activityCursor, formatActivity, readActivity, readActivityFrom } from "./activity.js";
import { inspectTelemetryQueue, setTelemetryEnabled, setDataIntelligenceEnabled, initializeFreeTelemetry, telemetryStatus, enqueueLifecycleStageTelemetry } from "./telemetry.js";
import { loadCloudClient, cloudStatus, fetchRemotePolicy, registerCloud, syncTelemetry, syncFreeTelemetry, reportLifecycleEvent } from "./cloud.js";
import { installProduct, installOpenClientProduct, installStatus, detectUnmigratedBetaInstallation, stableReleaseUsesManagedRuntime } from "./install.js";
import {verifyAndRecordActiveBetaHandoff} from "./beta-stable-handoff.js";
import { isOpenClientDistribution, resolveDistributionPolicy, freeAnalysisContractStatus } from "./distribution.js";
import { activateStagedUpdate, rollbackUpdate, stageUpdate, updateStatus } from "./update.js";
import { inspectProjectRef, listProjects } from "./projects.js";
import { CLIENT_VERSION, DEFAULT_CLOUD_URL } from "./constants.js";
import { acceptAccountPairing, readMaskedPairingCode } from "./pairing.js";
import { linkFreeAccountFromWorkspace, approvalMatchesGithubLogin } from "./free-account-link.js";
import readline from "node:readline/promises";
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
  "Telemetry settings are managed on the Vibe Monitor website.",
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

// Protect every open-client entry that mutates Runtime or Agent registration
// before lifecycle files, package pointers or IDE configuration are written.
const changesInstalledRuntimeOrAgents=command==="install"||command==="uninstall"||
  (command==="setup"&&!args.includes("--dry-run"))||
  (command==="update"&&["stage","activate"].includes(args[1]));
if(isOpenClientDistribution()&&changesInstalledRuntimeOrAgents){
  const betaBlock=detectUnmigratedBetaInstallation();
  const explicitMigration=command==="install"&&args.includes("--migrate-beta");
  if(betaBlock&&!explicitMigration&&!(await verifyAndRecordActiveBetaHandoff())){
    if(json)print({installed:false,errorCode:betaBlock});
    console.error("Existing Beta installation preserved. Re-run install with --migrate-beta to authorize the verified handoff.");
    process.exit(2);
  }
}
if (command === "install") {
  if (isOpenClientDistribution()) {
    if (args.includes("--no-telemetry") && args.includes("--accept-telemetry")) {
      console.error("Choose either --no-telemetry or --accept-telemetry, not both.");
      process.exit(2);
    }
    console.error("Telemetry: ON by default for pseudonymous installation, runtime, update and architecture-quality statistics. No source code, prompts, project paths or secrets are uploaded. Set --no-telemetry to install without telemetry; Free analysis is unavailable while telemetry is off. Existing choices are preserved on reinstall; website preferences require a verified account/device connection.");
    // Initialize the pseudonymous choice before the first stage so even an
    // interrupted install can be diagnosed, subject to user opt-out.
    if(args.includes("--no-telemetry")) setTelemetryEnabled(false);
    else if(args.includes("--accept-telemetry")) setTelemetryEnabled(true);
    else initializeFreeTelemetry();
    const lifecycle=createLocalInstallLifecycle({onEvent:event=>
      enqueueLifecycleStageTelemetry("install",{
        attemptId:event.attemptId,stage:event.stage,
        mode:args.includes("--migrate-beta")?"migration":"first_install",
        reason:event.errorCode})});
    lifecycle.mark("started");
    const onInterrupt=()=>{
      lifecycle.mark("interrupted");
      void syncFreeTelemetry({force:true}).finally(()=>process.exit(130));
    };
    process.once("SIGINT",onInterrupt);
    process.once("SIGTERM",onInterrupt);
    try {
      await syncFreeTelemetry({force:true}); // bounded first-stage evidence
      const result=await installOpenClientProduct({
        agents:selectedAgents(),
        local:(!stableReleaseUsesManagedRuntime())||
          (process.env.VIBE_MONITOR_TEST_SOURCE_INSTALL==="1"&&
           typeof process.env.VIBE_MONITOR_TEST_SECRET_DIR==="string"&&
           process.env.VIBE_MONITOR_TEST_SECRET_DIR.length>0),
        cliPath:filename,
        migrateBeta:args.includes("--migrate-beta"),
        onStage:async stage=>{
          lifecycle.mark(stage);
          if(["node_runtime_check","npm_runtime_install_started"].includes(stage))
            await syncFreeTelemetry({force:true});
        }
      });
      if(args.includes("--accept-telemetry") || args.includes("--no-telemetry")){
        const telemetry=setTelemetryEnabled(!args.includes("--no-telemetry"));
        result.telemetry={...result.telemetry,...telemetry,defaultEnabled:true};
        result.activation.serviceEnabled=telemetry.serviceEnabled===true;
      }
      lifecycle.mark("completed");
      result.lifecycle=lifecycle.summary();
      try {
        // The install stage queue is bounded and ACKed before reporting the
        // terminal installed event; never block install on a failed upload.
        for(let i=0;i<3;i++){
          const r=await syncFreeTelemetry({force:true});
          if(r.reason || !r.remaining)break;
        }
        result.lifecycleDelivery=await reportLifecycleEvent("lifecycle.installed",{
          agents:result.setup?.selectedAgents||[],scope:"full"});
      }catch {result.lifecycleDelivery={queued:false,delivered:false,reason:"report_unavailable"};}
      if(json)print(result);else printInstallWelcome(result);
    }catch(error){
      const code=safeInstallError(error);
      lifecycle.mark("failed",code);
      await syncFreeTelemetry({force:true}).catch(()=>{});
      if(json)print({installed:false,errorCode:code,lifecycle:lifecycle.summary()});
      console.error("Vibe Monitor installation failed: "+code);
      process.exitCode=1;
    } finally {
      process.removeListener("SIGINT",onInterrupt);
      process.removeListener("SIGTERM",onInterrupt);
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
    if (isOpenClientDistribution()) process.exitCode=2;
  } else {
    const persist = command !== "status" && command !== "brief";
    const result = applyMonitoringPolicy(
      analyzeProject(positionalPath(), { persist, decisionPolicy: remotePolicy.config?.decisionPolicy,
        enabledMonitors:remotePolicy.config?.enabledMonitors }),
      remotePolicy.config || {}
    );
    if (isOpenClientDistribution() && !freeAnalysisContractStatus().serviceEnabled) {
      print(buildDisabledPolicyPayload({enabled:false,source:"free-service-contract",reason:"telemetry_required"}));
      process.exitCode=2;
    } else if (command === "brief") {
      const brief = buildVibeCoderBrief(result);
      if (json) print(brief); else printDecisionBrief(brief);
    } else if (json) print(result); else printHuman(result);
  }
  // After reporting the result, best-effort Free sync; bounded transport
  // backoff is persisted across CLI and MCP processes. Never fail analysis for
  // an unavailable service or make network access part of architecture scans.
  if(isOpenClientDistribution() && remotePolicy.enabled!==false){
    try{await syncFreeTelemetry();}catch{/* local scan stays successful */}
  }
} else if (command === "projects") {
  if (isOpenClientDistribution() && !freeAnalysisContractStatus().serviceEnabled) {
    print(buildDisabledPolicyPayload({enabled:false,source:"free-service-contract",reason:"telemetry_required"}));
    process.exit(2);
  }
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
  if (isOpenClientDistribution() && !freeAnalysisContractStatus().serviceEnabled) {
    print(buildDisabledPolicyPayload({enabled:false,source:"free-service-contract",reason:"telemetry_required"}));
    process.exit(2);
  }
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
  print({ install: installStatus(), installLifecycle: latestLocalInstallAttempt(), security: securityStatus(), telemetry: telemetryStatus() });
} else if (command === "activity") {
  if (isOpenClientDistribution() && !freeAnalysisContractStatus().serviceEnabled) {
    print(buildDisabledPolicyPayload({enabled:false,source:"free-service-contract",reason:"telemetry_required"}));
    process.exit(2);
  }
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
  if (isOpenClientDistribution() && action === "intelligence" && ["on","off"].includes(args[2])) {
    console.error("Individual telemetry-category settings require verified device pairing on the website. Use telemetry off to stop all collection now.");
    process.exitCode = 2;
  } else if (action === "intelligence") {
    const choice = args[2] || "status";
    if(isOpenClientDistribution()&&choice==="off"){
      console.error("Free architecture profiling is part of the required Free telemetry contract. To stop collection and Free analysis together, run vibe-monitor telemetry off.");
      process.exit(2);
    }
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
    if (isOpenClientDistribution()) {
      print(setTelemetryEnabled(false));
      console.error("Free telemetry stopped; architecture analysis is now disabled. Run vibe-monitor telemetry on to restore both.");
    }
    else {
      console.error("Vibe Monitor Private Beta requires telemetry. Telemetry cannot be disabled during the beta.");
      process.exit(2);
    }
  } else if (action === "sync" && isOpenClientDistribution()) {
    print(await syncFreeTelemetry({force:args.includes("--force")}));
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
  if (args.includes("--code") || args.some(v => v.startsWith("--code="))) {
    console.error("Do not pass pairing codes via command arguments. Use hidden interactive input.");
    process.exitCode = 2;
  } else if (isOpenClientDistribution()) {
    try {
      const code = await readMaskedPairingCode();
      // Pairing code is not consent. Show the target account before
      // reading local telemetry secrets or sending any ownership proof.
      const result = await linkFreeAccountFromWorkspace({code,
        confirmTarget:async login => {
          if(!process.stdin.isTTY || !process.stdout.isTTY) return false;
          const rl=readline.createInterface({input:process.stdin,output:process.stdout});
          try {
            const entered=await rl.question(
              "Link to GitHub account "+login+"? Type '"+login+"' to approve: "
            );
            return approvalMatchesGithubLogin(login,entered);
          } finally {rl.close();}
        }
      });
      if (json) print(result);
      else console.log(result.accepted
        ? "Device proof accepted. Return to the account dashboard to verify and confirm."
        : "Account linking not completed: " + result.reason);
      if (!result.accepted) process.exitCode = 1;
    } catch (error) {
      console.error("Account linking not completed: " + (error?.message || "request_failed"));
      process.exitCode = 1;
    }
  } else if (!args.includes("--qa") || process.env.VIBE_PORTAL_PAIRING_QA !== "1") {
    console.error("Account pairing is not released yet. Existing installations are unchanged.");
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
  if (openClient && args.includes("--no-telemetry") && args.includes("--accept-telemetry")) {
    console.error("Choose either --no-telemetry or --accept-telemetry, not both.");
    process.exit(2);
  }
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
        analysisStopsWhenDisabled: openClient,
        telemetryRequiredForFree: openClient,
        requiredDuringPrivateBeta: !openClient
      }
    });
  } else {
    const migration = migrateProjectStateTree();
    if (openClient) console.error("Telemetry defaults ON for new installations; --no-telemetry opts out. Reconfiguration preserves prior preferences. Website changes require verified account/device linkage.");
    const telemetry = openClient
      ? (args.includes("--accept-telemetry") ? setTelemetryEnabled(true)
          : args.includes("--no-telemetry") ? setTelemetryEnabled(false)
          : initializeFreeTelemetry())
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
        analysisStopsWhenDisabled: openClient,
        telemetryRequiredForFree: openClient,
        requiredDuringPrivateBeta: !openClient,
        inspectCommand: "vibe-monitor telemetry inspect"
      }
    });
  }
} else if (command === "uninstall") {
  const removal = uninstallSetup({ agents: selectedAgents() });
  const classification = classifyUninstallLifecycle(removal);
  let report = { queued: false, delivered: false, reason: "no_change" };
  // Uninstall here removes Agent integration; runtime files may remain.
  // For open-client, report integration_removed even when all Agents are gone.
  // It is not proof that executable/local history has been deleted.
  if (classification.event) {
    try {
      const event = isOpenClientDistribution()
        ? "lifecycle.integration_removed" : classification.event;
      report = await reportLifecycleEvent(event, classification);
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
    "  vibe-monitor install " + (isOpenClientDistribution() ? "[--migrate-beta] [--no-telemetry|--accept-telemetry] [--codex|--claude|--cursor|--antigravity|--trae]" : "[--invite CODE] [--url URL] [--codex|--claude|--cursor|--antigravity|--trae] [--debug]"),
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
    "  - " + (isOpenClientDistribution() ? "Free analysis requires product-improvement telemetry. telemetry off disables both telemetry and analysis; Cloud intake not released" : "private-beta telemetry is required and inspectable"),
    "  - " + (isOpenClientDistribution() ? "signed Cloud policy stays in process memory only" : "private-beta cloud transport uses a per-installation token")
  ].join("\n"));
}
