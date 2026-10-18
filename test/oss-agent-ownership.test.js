import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {installSetup,uninstallSetup} from "../src/setup.js";

function sandbox(t) {
  const tmp=fs.mkdtempSync(path.join(os.tmpdir(),"vibe-qa-ownership-"));
  const home=path.join(tmp,"测试 user é");
  fs.mkdirSync(home,{recursive:true});
  const prior=process.env.VIBE_MONITOR_SETUP_HOME;
  process.env.VIBE_MONITOR_SETUP_HOME=home;
  t.after(()=>{
    if(prior===undefined) delete process.env.VIBE_MONITOR_SETUP_HOME;
    else process.env.VIBE_MONITOR_SETUP_HOME=prior;
    fs.rmSync(tmp,{recursive:true,force:true});
  });
  return home;
}
const install=agents=>installSetup({agents,runtimeCommand:"/qa/safe/vibe-monitor"});
const remove=agents=>uninstallSetup({agents});

test("pre-existing same-name JSON configuration survives installation and repeated removal",t=>{
  const home=sandbox(t), file=path.join(home,".cursor","mcp.json");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const original={mcpServers:{"vibe-monitor":{command:"original-private"},another:{command:"keep"}},theme:"user"};
  fs.writeFileSync(file,JSON.stringify(original));
  assert.ok(install(["cursor"]).changes.some(c=>c.kind==="mcp"&&c.manualRequired));
  remove(["cursor"]);remove(["cursor"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),original);
});
test("fresh owned JSON registration is idempotent; removal preserves unrelated settings",t=>{
  const home=sandbox(t), file=path.join(home,".cursor","mcp.json");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,JSON.stringify({mcpServers:{another:{command:"keep"}},theme:"user"}));
  assert.ok(install(["cursor"]).changes.some(c=>c.kind==="mcp"&&c.changed));
  assert.ok(install(["cursor"]).changes.some(c=>c.kind==="mcp"&&!c.changed));
  const data=JSON.parse(fs.readFileSync(file,"utf8"));data.theme="changed";fs.writeFileSync(file,JSON.stringify(data));
  assert.ok(remove(["cursor"]).changes.some(c=>c.kind==="mcp"&&c.changed));
  assert.equal(remove(["cursor"]).changes.some(c=>c.kind==="mcp"&&c.changed),false);
  const result=JSON.parse(fs.readFileSync(file,"utf8"));
  assert.equal(result.theme,"changed");
  assert.equal(result.mcpServers["vibe-monitor"],undefined);
  assert.deepEqual(result.mcpServers.another,{command:"keep"});
});
test("manual changes to managed registrations are not removed",t=>{
  const home=sandbox(t);install(["antigravity"]);
  const file=path.join(home,".gemini","config","mcp_config.json");
  const data=JSON.parse(fs.readFileSync(file,"utf8"));data.mcpServers["vibe-monitor"].command="user-edited";
  fs.writeFileSync(file,JSON.stringify(data));remove(["antigravity"]);
  assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).mcpServers["vibe-monitor"].command,"user-edited");
});
test("Codex TOML conflicting stanza is preserved, fresh owned stanza removable",t=>{
  const home=sandbox(t), file=path.join(home,".codex","config.toml");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const original='theme = "user"\n[mcp_servers.vibe-monitor]\ncommand = "custom"\nargs = []\n[other]\nkey = 1\n';
  fs.writeFileSync(file,original);
  assert.ok(install(["codex"]).changes.some(c=>c.kind==="mcp"&&c.manualRequired));
  remove(["codex"]);assert.equal(fs.readFileSync(file,"utf8"),original);
  fs.writeFileSync(file,'theme = "user"\n[other]\nkey = 1\n');
  assert.ok(install(["codex"]).changes.some(c=>c.kind==="mcp"&&c.changed));
  assert.ok(remove(["codex"]).changes.some(c=>c.kind==="mcp"&&c.changed));
  assert.doesNotMatch(fs.readFileSync(file,"utf8"),/\[mcp_servers.vibe-monitor\]/);
  assert.match(fs.readFileSync(file,"utf8"),/\[other\]/);
});
test("existing Cursor user-owned rules remain intact on install and uninstall",t=>{
  const home=sandbox(t), file=path.join(home,".cursor","rules","vibe-monitor.mdc");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,"user-owned rule\n");
  assert.ok(install(["cursor"]).changes.some(c=>c.kind==="instructions"&&c.manualRequired));
  remove(["cursor"]);assert.equal(fs.readFileSync(file,"utf8"),"user-owned rule\n");
});

test("Claude pre-existing user-scope registration is never replaced or removed",t=>{
  const home=sandbox(t), file=path.join(home,".claude.json");
  const original={numStartups:4,mcpServers:{"vibe-monitor":{command:"custom-vibe",args:["--original"]},other:{command:"other"}}};
  fs.writeFileSync(file,JSON.stringify(original));
  assert.ok(install(["claude"]).changes.some(c=>c.kind==="mcp"&&c.manualRequired));
  remove(["claude"]);remove(["claude"]);
  assert.deepEqual(JSON.parse(fs.readFileSync(file,"utf8")),original);
  assert.equal(fs.existsSync(file+".vibe-monitor-owned.json"),false);
});
test("Claude fresh user-scope registration is idempotent and safely removable",t=>{
  const home=sandbox(t), file=path.join(home,".claude.json");
  fs.writeFileSync(file,JSON.stringify({numStartups:4,mcpServers:{other:{command:"other"}}}));
  assert.ok(install(["claude"]).changes.some(c=>c.kind==="mcp"&&c.changed));
  assert.ok(install(["claude"]).changes.some(c=>c.kind==="mcp"&&!c.changed));
  assert.ok(remove(["claude"]).changes.some(c=>c.kind==="mcp"&&c.changed));
  const result=JSON.parse(fs.readFileSync(file,"utf8"));
  assert.equal(result.numStartups,4);
  assert.equal(result.mcpServers["vibe-monitor"],undefined);
  assert.deepEqual(result.mcpServers.other,{command:"other"});
});
test("Claude externally modified managed server survives uninstall; malformed config is preserved",t=>{
  const home=sandbox(t), file=path.join(home,".claude.json");
  install(["claude"]);
  const data=JSON.parse(fs.readFileSync(file,"utf8"));
  data.mcpServers["vibe-monitor"].command="edited-by-user";
  fs.writeFileSync(file,JSON.stringify(data));
  remove(["claude"]);
  assert.equal(JSON.parse(fs.readFileSync(file,"utf8")).mcpServers["vibe-monitor"].command,"edited-by-user");
  const bad="{incomplete";
  fs.writeFileSync(file,bad);
  assert.ok(install(["claude"]).changes.some(c=>c.kind==="mcp"&&c.manualRequired));
  assert.equal(fs.readFileSync(file,"utf8"),bad);
});

test("pre-existing same-marker instructions without ownership remain unchanged",t=>{
  const home=sandbox(t),file=path.join(home,".codex","AGENTS.md");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const original="# custom\n<!-- vibe-monitor:start -->\nUser-owned instructions\n<!-- vibe-monitor:end -->\n# notes\n";
  fs.writeFileSync(file,original);
  assert.ok(install(["codex"]).changes.some(c=>c.kind==="instructions"&&c.manualRequired));
  remove(["codex"]);remove(["codex"]);
  assert.equal(fs.readFileSync(file,"utf8"),original);
});
test("owned instruction block removal preserves unrelated user content",t=>{
  const home=sandbox(t),file=path.join(home,".gemini","GEMINI.md");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  fs.writeFileSync(file,"# my preferences\n\nDo not change my projects\n");
  assert.ok(install(["antigravity"]).changes.some(c=>c.kind==="instructions"&&c.changed));
  assert.ok(install(["antigravity"]).changes.some(c=>c.kind==="instructions"&&!c.changed));
  assert.ok(remove(["antigravity"]).changes.some(c=>c.kind==="instructions"&&c.changed));
  assert.match(fs.readFileSync(file,"utf8"),/Do not change my projects/);
  assert.doesNotMatch(fs.readFileSync(file,"utf8"),/vibe-monitor:start/);
});
test("edited managed instruction block is never silently removed",t=>{
  const home=sandbox(t);
  install(["claude"]);
  const file=path.join(home,".claude","CLAUDE.md");
  const text=fs.readFileSync(file,"utf8");
  fs.writeFileSync(file,text.replace("Vibe Monitor is a session-scoped","Vibe Monitor is user-updated"));
  remove(["claude"]);
  assert.match(fs.readFileSync(file,"utf8"),/Vibe Monitor is user-updated/);
});
test("malformed marker is preserved and does not get another managed block",t=>{
  const home=sandbox(t),file=path.join(home,".codex","AGENTS.md");
  fs.mkdirSync(path.dirname(file),{recursive:true});
  const original="notes\n<!-- vibe-monitor:start -->\n";
  fs.writeFileSync(file,original);
  assert.ok(install(["codex"]).changes.some(c=>c.kind==="instructions"&&c.manualRequired));
  remove(["codex"]);
  assert.equal(fs.readFileSync(file,"utf8"),original);
});


