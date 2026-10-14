import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { CLIENT_VERSION } from "./constants.js";
import { vibeHome, ensureDir } from "./utils.js";
import {isSafeInstallCode} from "./install-error.js";
export {safeInstallError} from "./install-error.js";

export const INSTALL_STAGES = Object.freeze([
  "started", "credentials_checked", "cloud_reachable", "awaiting_activation",
  "activated", "runtime_installed", "mcp_configured", "completed", "failed", "interrupted"
]);
const stages = new Set(INSTALL_STAGES);
export function installTrackingDirectory() {
  return path.join(vibeHome(), "installation-attempts");
}

export class InstallTracker {
  constructor({ baseUrl, mode, home = installTrackingDirectory(), fetchImpl = (...args) => fetch(...args), attemptId = crypto.randomUUID() } = {}) {
    this.baseUrl = String(baseUrl || "").replace(/\/+$/, "");
    this.mode = mode === "upgrade" ? "upgrade" : "first_install";
    this.attemptId = attemptId;
    this.home = home;
    this.file = path.join(home, attemptId + ".json");
    this.fetchImpl = fetchImpl;
    this.inviteCode = null;
    this.token = null;
    this.inFlight = null;
    this.data = {
      attemptId, clientVersion: CLIENT_VERSION, mode: this.mode,
      os: process.platform, arch: os.arch(),
      events: [], acknowledged: -1, linked: false
    };
  }
  setBaseUrl(value) { this.baseUrl = String(value || "").replace(/\/+$/, ""); }
  setInvite(value) { this.inviteCode = typeof value === "string" ? value.trim() : null; }
  setToken(value) { this.token = typeof value === "string" ? value : null; }
  mark(stage, errorCode = null) {
    if (!stages.has(stage)) return;
    const sequence = this.data.events.length;
    if (sequence >= 64) return;
    this.data.events.push({
      sequence, stage, occurredAt: new Date().toISOString(),
      ...(stage === "failed" ? { errorCode: isSafeInstallCode(errorCode) ? errorCode : "install_failed" } : {})
    });
    this.persist();
  }
  persist() {
    try {
      ensureDir(this.home);
      const temp = this.file + ".tmp-" + process.pid;
      fs.writeFileSync(temp, JSON.stringify(this.data), { mode: 0o600 });
      fs.renameSync(temp, this.file);
    } catch { /* reporting must never break installation */ }
  }
  async flush() {
    if (this.inFlight) {
      await this.inFlight;
      if (this.data.events.at(-1)?.sequence <= this.data.acknowledged && !(this.token && this.data.linked !== true)) return true;
    }
    const send = async () => {
      const pending = this.data.events.filter(e => e.sequence > this.data.acknowledged);
      const events = pending.length ? pending.slice(0, 20) :
        this.token && this.data.linked !== true ? this.data.events.slice(-1) : [];
      if (!events.length) return true;
      try {
        const target=new URL(this.baseUrl);
        if(target.protocol!=="https:" && !(target.protocol==="http:" && ["localhost","127.0.0.1","::1"].includes(target.hostname)))return false;
        const response = await this.fetchImpl(this.baseUrl + "/install-attempts", {
          method: "POST",
          headers: {
            "content-type": "application/json",
            ...(this.token ? { authorization: "Bearer " + this.token } : {})
          },
          body: JSON.stringify({
            attemptId: this.attemptId, clientVersion: this.data.clientVersion,
            mode: this.mode, os: this.data.os, arch: this.data.arch,
            ...(!this.token && this.inviteCode ? { inviteCode: this.inviteCode } : {}),
            events
          }),
          signal: AbortSignal.timeout(4000)
        });
        if (!response.ok) return false;
        const ack = await response.json();
        if (ack.accepted !== true) return false;
        this.data.acknowledged = Math.max(this.data.acknowledged, ...events.map(e => e.sequence));
        this.data.linked = ack.linked === true;
        this.persist();
        return true;
      } catch { return false; }
    };
    this.inFlight = send().finally(() => { this.inFlight = null; });
    return this.inFlight;
  }
  async flushAll() {
    for (let i = 0; i < 4 && (this.data.events.some(e => e.sequence > this.data.acknowledged) || (this.token && this.data.linked !== true)); i++) {
      if (!(await this.flush())) break;
    }
  }
}

export function createInstallTracker(options) {
  try { return new InstallTracker(options); } catch { return null; }
}

// Re-send bounded pending local evidence on a later installer invocation. Old attempts
// are replayed without an activation code. If the current device is authenticated,
// its existing OS-protected token may associate the same user's attempt.
export async function retryPendingInstallAttempts({baseUrl, token=null, maxAttempts=4} = {}) {
  const directory=installTrackingDirectory();
  let files=[];
  try {
    files=fs.readdirSync(directory).filter(name => /^[0-9a-f-]{36}\.json$/i.test(name))
      .map(name=>({name,mtime:fs.statSync(path.join(directory,name)).mtimeMs}))
      .sort((a,b)=>b.mtime-a.mtime);
  }
  catch { return { retried:0 }; }
  let retried=0;
  const replay=async({name:filename})=>{
    try {
      const record=JSON.parse(fs.readFileSync(path.join(directory,filename),"utf8"));
      if(!Array.isArray(record.events) || !record.events.length || record.events.length>64)return;
      if(record.events.every(e=>e.sequence<=record.acknowledged) && (!token || record.linked===true))return;
      if(!/^\d+\.\d+\.\d+-beta\.\d+$/.test(record.clientVersion||""))return;
      if(!["first_install","upgrade"].includes(record.mode))return;
      const age=Date.now()-Date.parse(record.events[0].occurredAt);
      if(!Number.isFinite(age)||age<0||age>14*86400e3)return;
      const tracker=new InstallTracker({baseUrl,mode:record.mode,home:directory,attemptId:record.attemptId});
      tracker.data=record;
      if(token)tracker.setToken(token);
      await tracker.flushAll();
      retried++;
    } catch { /* corrupted journal must not block install */ }
  };
  // At most two network uploads run together; do not add minutes to installation.
  for(let i=0;i<Math.min(maxAttempts,files.length);i+=2){
    await Promise.all(files.slice(i,i+2).map(replay));
  }
  return {retried};
}
