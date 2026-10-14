import crypto from "node:crypto";
import os from "node:os";
import path from "node:path";
import { atomicJsonWrite, safeJsonRead, vibeHome } from "./utils.js";
import { platformSummary } from "./platform.js";

function deviceFile() {
  return path.join(vibeHome(), "device.json");
}

function defaultDeviceLabel(summary) {
  if (summary.platform === "macos") return "macOS " + summary.arch;
  if (summary.platform === "windows") return "Windows " + summary.arch;
  if (summary.platform === "linux") return "Linux " + summary.arch;
  return summary.platform + " " + summary.arch;
}

export function getOrCreateDeviceIdentity() {
  const file = deviceFile();
  const existing = safeJsonRead(file, null);
  const summary = platformSummary();
  if (existing?.deviceId) {
    const next = {
      schemaVersion: 1,
      deviceId: existing.deviceId,
      deviceLabel: existing.deviceLabel || defaultDeviceLabel(summary),
      platform: summary.platform,
      osName: summary.platform,
      osVersion: os.release(),
      arch: summary.arch,
      createdAt: existing.createdAt || new Date().toISOString(),
      updatedAt: new Date().toISOString()
    };
    atomicJsonWrite(file, next);
    return next;
  }

  const identity = {
    schemaVersion: 1,
    deviceId: crypto.randomUUID(),
    deviceLabel: defaultDeviceLabel(summary),
    platform: summary.platform,
    osName: summary.platform,
    osVersion: os.release(),
    arch: summary.arch,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString()
  };
  atomicJsonWrite(file, identity);
  return identity;
}

export function deviceStatus() {
  return safeJsonRead(deviceFile(), null);
}
