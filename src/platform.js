import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

export const BUNDLED_NODE_VERSION = "22.23.3";

function normalizeArch(arch) {
  const value = String(arch || "").toLowerCase();
  if (value === "x64" || value === "x86_64" || value === "amd64") return "x64";
  if (value === "arm64" || value === "aarch64") return "arm64";
  throw new Error("unsupported_arch:" + arch);
}

export function hardwareArch(platform = process.platform) {
  if (platform === "darwin") {
    try {
      const arm64 = execFileSync("/usr/sbin/sysctl", ["-n", "hw.optional.arm64"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      if (arm64 === "1") return "arm64";
    } catch {}
    try {
      const machine = execFileSync("/usr/bin/uname", ["-m"], {
        encoding: "utf8",
        stdio: ["ignore", "pipe", "ignore"]
      }).trim();
      return normalizeArch(machine);
    } catch {}
  }

  if (platform === "win32") {
    const machine = process.env.PROCESSOR_ARCHITEW6432 || process.env.PROCESSOR_ARCHITECTURE;
    if (machine) {
      try { return normalizeArch(machine); } catch {}
    }
  }

  return normalizeArch(os.arch());
}

function moveExtractedDirectory(parent, prefix, destination) {
  const entries = fs.readdirSync(parent, { withFileTypes: true })
    .filter(entry => entry.isDirectory() && entry.name.startsWith(prefix));
  if (entries.length !== 1) throw new Error("node_archive_layout_unexpected");
  fs.rmSync(destination, { recursive: true, force: true });
  fs.renameSync(path.join(parent, entries[0].name), destination);
}

export function windowsExpandArchiveCommand(archiveFile, tempDir) {
  const literal = value => "'" + String(value).replace(/'/g, "''") + "'";
  return "Expand-Archive -LiteralPath " + literal(archiveFile) +
    " -DestinationPath " + literal(tempDir) + " -Force -ErrorAction Stop";
}

const adapters = {
  darwin: {
    id: "macos",
    tested: true,
    nodeTarget(arch = hardwareArch("darwin")) {
      return "darwin-" + normalizeArch(arch);
    },
    nodeBinary(root) {
      return path.join(root, "bin", "node");
    },
    npmCli(root) {
      return path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    },
    extractNodeArchive(archiveFile, tempDir, destination, version) {
      execFileSync("tar", ["-xzf", archiveFile, "-C", tempDir], { stdio: "ignore" });
      moveExtractedDirectory(tempDir, "node-v" + version + "-", destination);
    }
  },
  linux: {
    id: "linux",
    tested: false,
    nodeTarget(arch = hardwareArch("linux")) {
      return "linux-" + normalizeArch(arch);
    },
    nodeBinary(root) {
      return path.join(root, "bin", "node");
    },
    npmCli(root) {
      return path.join(root, "lib", "node_modules", "npm", "bin", "npm-cli.js");
    },
    extractNodeArchive(archiveFile, tempDir, destination, version) {
      execFileSync("tar", ["-xJf", archiveFile, "-C", tempDir], { stdio: "ignore" });
      moveExtractedDirectory(tempDir, "node-v" + version + "-", destination);
    }
  },
  win32: {
    id: "windows",
    tested: false,
    nodeTarget(arch = hardwareArch("win32")) {
      return "win-" + normalizeArch(arch);
    },
    nodeBinary(root) {
      return path.join(root, "node.exe");
    },
    npmCli(root) {
      return path.join(root, "node_modules", "npm", "bin", "npm-cli.js");
    },
    extractNodeArchive(archiveFile, tempDir, destination, version) {
      const powershell = process.env.SystemRoot
        ? path.join(process.env.SystemRoot, "System32", "WindowsPowerShell", "v1.0", "powershell.exe")
        : "powershell.exe";
      // PowerShell -Command does not reliably populate $args from trailing native argv.
      const command = windowsExpandArchiveCommand(archiveFile, tempDir);
      try {
        execFileSync(powershell, ["-NoProfile", "-NonInteractive", "-Command", command], {
          encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], maxBuffer: 1024 * 1024
        });
      } catch (error) {
        const detail = String(error?.stderr || error?.stdout || error?.message || "unknown")
          .trim().replace(/\s+/g, " ").slice(0, 600);
        throw new Error("runtime_extract_failed: " + detail);
      }
      moveExtractedDirectory(tempDir, "node-v" + version + "-", destination);
    }
  }
};

export function getPlatformAdapter(platform = process.platform) {
  const adapter = adapters[platform];
  if (!adapter) throw new Error("unsupported_platform:" + platform);
  return adapter;
}

export function platformSummary() {
  const adapter = getPlatformAdapter();
  return {
    platform: adapter.id,
    nodePlatform: process.platform,
    arch: hardwareArch(),
    osRelease: os.release(),
    tested: adapter.tested
  };
}

export function nodeDistributionSpec(version = BUNDLED_NODE_VERSION) {
  const adapter = getPlatformAdapter();
  const target = adapter.nodeTarget();
  const extension = process.platform === "win32" ? "zip" : process.platform === "linux" ? "tar.xz" : "tar.gz";
  const filename = "node-v" + version + "-" + target + "." + extension;
  return {
    adapter,
    target,
    filename,
    baseUrl: "https://nodejs.org/dist/v" + version,
    archiveUrl: "https://nodejs.org/dist/v" + version + "/" + filename,
    shasumsUrl: "https://nodejs.org/dist/v" + version + "/SHASUMS256.txt"
  };
}
