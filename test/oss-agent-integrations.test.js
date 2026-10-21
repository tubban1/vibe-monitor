import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {installSetup,uninstallSetup,managedIntegrations,detectAgents,AGENT_ADAPTER_NAMES} from "../src/setup.js";
import {EXTRA_AGENT_NAMES,vscodeUserDirs} from "../src/agent-integrations.js";

function sandbox(t,platform=process.platform){
 const home=fs.mkdtempSync(path.join(os.tmpdir(),"vm-agents-"));
 const old=process.env.VIBE_MONITOR_SETUP_HOME;process.env.VIBE_MONITOR_SETUP_HOME=home;
 t.after(()=>{if(old===undefined)delete process.env.VIBE_MONITOR_SETUP_HOME;else process.env.VIBE_MONITOR_SETUP_HOME=old;fs.rmSync(home,{recursive:true,force:true});});
 const user=vscodeUserDirs(home,platform,{})[0].dir;
 return {home,user,mk:p=>fs.mkdirSync(path.join(home,p),{recursive:true}),
  read:p=>JSON.parse(fs.readFileSync(path.isAbsolute(p)?p:path.join(home,p),"utf8"))};
}
const spec={runtimeCommand:"/opt/vibe/bin/vibe-monitor"};

test("all eight new agents are registered alongside the original five",()=>{
 assert.deepEqual(EXTRA_AGENT_NAMES,["opencode","gemini-cli","cline","roo-code","copilot","kiro","windsurf","workbuddy"]);
 for(const n of ["codex","claude","cursor","antigravity","trae",...EXTRA_AGENT_NAMES])assert.ok(AGENT_ADAPTER_NAMES.includes(n));
});

test("nothing is detected or written on a machine without these agents (negative)",t=>{
 sandbox(t);
 const d=detectAgents();
 for(const n of EXTRA_AGENT_NAMES)assert.equal(d[n],false,n);
});

test("each agent gets its own schema: opencode mcp/local, VS Code servers/stdio, Copilot CLI tools, Cline disabled flag",t=>{
 const s=sandbox(t);
 for(const p of [".config/opencode",".copilot",".kiro",".codeium/windsurf",".workbuddy",".cline"])s.mk(p);
 fs.mkdirSync(path.join(s.user,"globalStorage","saoudrizwan.claude-dev"),{recursive:true});
 fs.mkdirSync(path.join(s.home,".gemini"),{recursive:true});fs.writeFileSync(path.join(s.home,".gemini","settings.json"),"{}");
 const r=installSetup({...spec,agents:EXTRA_AGENT_NAMES});
 assert.ok(!r.changes.some(c=>c.error),JSON.stringify(r.changes.filter(c=>c.error)));
 const oc=s.read(".config/opencode/opencode.json").mcp["vibe-monitor"];
 assert.deepEqual(oc,{type:"local",command:["/opt/vibe/bin/vibe-monitor","mcp","--agent","opencode"],enabled:true});
 assert.deepEqual(s.read(".copilot/mcp-config.json").mcpServers["vibe-monitor"],
  {type:"local",command:"/opt/vibe/bin/vibe-monitor",args:["mcp","--agent","copilot"],tools:["*"]});
 assert.deepEqual(s.read(path.join(s.user,"mcp.json")).servers["vibe-monitor"],
  {type:"stdio",command:"/opt/vibe/bin/vibe-monitor",args:["mcp","--agent","copilot"]});
 assert.equal(s.read(path.join(s.user,"globalStorage","saoudrizwan.claude-dev","settings","cline_mcp_settings.json")).mcpServers["vibe-monitor"].disabled,false);
 assert.equal(s.read(".cline/data/settings/cline_mcp_settings.json").mcpServers["vibe-monitor"].args.at(-1),"cline");
 assert.equal(s.read(".gemini/settings.json").mcpServers["vibe-monitor"].args.at(-1),"gemini-cli");
 assert.ok(fs.readFileSync(path.join(s.home,".kiro","steering","vibe-monitor.md"),"utf8").includes("vibe_session_start"));
 assert.ok(fs.readFileSync(path.join(s.home,".codeium","windsurf","memories","global_rules.md"),"utf8").includes("vibe_session_start"));
 assert.ok(r.plan===undefined);
 const status=managedIntegrations();
 for(const n of ["opencode","gemini-cli","cline","copilot","kiro","windsurf","workbuddy"])assert.equal(status[n],"present",n);
 assert.equal(status["roo-code"],"absent");
});

test("existing user servers are preserved and JSONC configs are never rewritten",t=>{
 const s=sandbox(t);
 s.mk(".copilot");
 fs.writeFileSync(path.join(s.home,".copilot","mcp-config.json"),JSON.stringify({mcpServers:{mine:{type:"local",command:"x"}}}));
 fs.mkdirSync(s.user,{recursive:true});
 const jsonc='{\n  // my servers\n  "servers": {}\n}\n';
 fs.writeFileSync(path.join(s.user,"mcp.json"),jsonc);
 const r=installSetup({...spec,agents:["copilot"]});
 assert.deepEqual(Object.keys(s.read(".copilot/mcp-config.json").mcpServers).sort(),["mine","vibe-monitor"]);
 assert.equal(fs.readFileSync(path.join(s.user,"mcp.json"),"utf8"),jsonc,"JSONC untouched");
 assert.ok(r.changes.some(c=>c.manualRequired&&c.file.endsWith("mcp.json")));
});

test("install is idempotent and uninstall removes only what Vibe Monitor wrote",t=>{
 const s=sandbox(t);
 s.mk(".kiro");s.mk(".config/opencode");
 fs.mkdirSync(path.join(s.home,".kiro","settings"),{recursive:true});
 fs.writeFileSync(path.join(s.home,".kiro","settings","mcp.json"),JSON.stringify({mcpServers:{other:{command:"y"}}}));
 installSetup({...spec,agents:["kiro","opencode"]});
 const again=installSetup({...spec,agents:["kiro","opencode"]});
 assert.ok(again.changes.every(c=>c.changed===false),JSON.stringify(again.changes));
 uninstallSetup({agents:["kiro","opencode"]});
 assert.deepEqual(Object.keys(s.read(".kiro/settings/mcp.json").mcpServers),["other"]);
 assert.equal(s.read(".config/opencode/opencode.json").mcp["vibe-monitor"],undefined);
 assert.equal(fs.existsSync(path.join(s.home,".kiro","steering","vibe-monitor.md")),false);
});

test("a sandboxed setup home never writes through real APPDATA or XDG_CONFIG_HOME",t=>{
 const s=sandbox(t);
 const outside=fs.mkdtempSync(path.join(os.tmpdir(),"vm-real-profile-"));
 const old={a:process.env.APPDATA,x:process.env.XDG_CONFIG_HOME};
 process.env.APPDATA=outside;process.env.XDG_CONFIG_HOME=outside;
 t.after(()=>{for(const [k,v] of [["APPDATA",old.a],["XDG_CONFIG_HOME",old.x]])if(v===undefined)delete process.env[k];else process.env[k]=v;
  fs.rmSync(outside,{recursive:true,force:true});});
 s.mk(".config/opencode");fs.mkdirSync(s.user,{recursive:true});
 installSetup({...spec,agents:["opencode","copilot"]});
 assert.deepEqual(fs.readdirSync(outside),[]);
 assert.ok(fs.existsSync(path.join(s.home,".config","opencode","opencode.json")));
});

test("VS Code-family profile directories follow each OS convention",()=>{
 assert.match(vscodeUserDirs("/h","darwin",{})[0].dir,/\/h\/Library\/Application Support\/Code\/User$/);
 assert.equal(vscodeUserDirs("/h","win32",{APPDATA:"C:\\Users\\a\\AppData\\Roaming"})[0].dir,path.join("C:\\Users\\a\\AppData\\Roaming","Code","User"));
 assert.equal(vscodeUserDirs("/h","linux",{})[0].dir,path.join("/h",".config","Code","User"));
});
