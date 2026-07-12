import path from "node:path";
import { readManifest, ManifestCorruptError } from "./manifest.js";
import { resolveTargets } from "./targets.js";
import { readFileIfExists } from "./atomic-fs.js";
import { readJsonServers } from "./json-adapter.js";
import { readTomlServers } from "./toml-adapter.js";
import { hashValue } from "./hash.js";
import { loadTemplates } from "./commands.js";
import { isBinaryOnPath } from "./prereq-check.js";

const PLACEHOLDER_TOKEN_PATTERN = /REPLACE_[A-Z0-9_]+/;
const LOCKFILE_NAME = ".kae-bi-kit.lock";

function finding(level, area, message) {
  return { level, area, message };
}

function resolveGroupForEntry(entry, groups) {
  const byPath = groups.find((g) => g.absPath === entry.absPath);
  if (byPath) return byPath;
  // Fall back to shape inference by extension when the entry's absPath no longer
  // matches any currently-resolved target (e.g. platform/homedir changed since install).
  const shape = entry.absPath.toLowerCase().endsWith(".toml") ? "toml" : "json";
  return { absPath: entry.absPath, shape, rootKey: "mcpServers" };
}

function readServersForGroup(group, fileText) {
  if (group.shape === "toml") return readTomlServers(fileText);
  return readJsonServers(fileText, group.rootKey);
}

function containsPlaceholderToken(value) {
  if (typeof value === "string") return PLACEHOLDER_TOKEN_PATTERN.test(value);
  if (Array.isArray(value)) return value.some(containsPlaceholderToken);
  if (value && typeof value === "object") {
    return Object.values(value).some(containsPlaceholderToken);
  }
  return false;
}

async function checkLockfile(dir, findings) {
  const lockPath = path.join(dir, LOCKFILE_NAME);
  const text = await readFileIfExists(lockPath);
  if (text === null) {
    findings.push(finding("ok", "lockfile", "No stale lockfile present."));
    return;
  }
  let pid = "unknown";
  try {
    const parsed = JSON.parse(text);
    if (parsed && parsed.pid !== undefined) pid = parsed.pid;
  } catch {
    // fall through with pid "unknown"
  }
  findings.push(
    finding(
      "warn",
      "lockfile",
      "A lockfile exists at " + lockPath + " from pid " + pid +
        ". If no bi-agent-kit run is currently in progress, delete it and try again."
    )
  );
}

async function checkEntry(entry, group, findings, counters) {
  const fileText = await readFileIfExists(entry.absPath);
  if (fileText === null) {
    findings.push(
      finding(
        "warn",
        "target-file",
        "Target file " + entry.absPath + " for " + entry.serverKey + " no longer exists."
      )
    );
    return;
  }
  counters.filesPresent++;

  let servers;
  try {
    servers = readServersForGroup(group, fileText);
  } catch (err) {
    findings.push(
      finding(
        "error",
        "parse",
        "Target file " + entry.absPath + " is malformed and could not be parsed: " + err.message
      )
    );
    return;
  }
  counters.filesParsed++;

  const value = servers[entry.serverKey];
  if (value === undefined) {
    findings.push(
      finding(
        "warn",
        "server-key",
        "The " + entry.serverKey + " entry in " + entry.absPath +
          " was removed by hand (bi-agent-kit still thinks it is installed)."
      )
    );
    return;
  }
  counters.keysPresent++;

  const currentHash = hashValue(value);
  if (currentHash !== entry.contentHash) {
    findings.push(
      finding(
        "warn",
        "drift",
        "The " + entry.serverKey + " entry in " + entry.absPath +
          " was edited outside bi-agent-kit and will be skipped on removal."
      )
    );
    return;
  }
  counters.hashesMatch++;

  if (containsPlaceholderToken(value)) {
    findings.push(
      finding(
        "warn",
        "placeholder",
        "The " + entry.serverKey + " entry in " + entry.absPath +
          " still has an unfilled REPLACE_ placeholder and will not launch."
      )
    );
    return;
  }
  counters.placeholdersClean++;

  counters.healthy++;
}

async function checkRequiredBinaries(manifest, findings) {
  const templates = await loadTemplates();
  const installedServerKeys = new Set(manifest.entries.map((e) => e.serverKey));
  const requiredBinaries = new Map();
  for (const template of templates) {
    if (!template.requiresBinary) continue;
    if (!installedServerKeys.has(template.id)) continue;
    if (!requiredBinaries.has(template.requiresBinary)) {
      requiredBinaries.set(template.requiresBinary, []);
    }
    requiredBinaries.get(template.requiresBinary).push(template.id);
  }

  if (requiredBinaries.size === 0) {
    findings.push(finding("ok", "binary", "No installed server requires a binary on PATH."));
    return;
  }

  let allPresent = true;
  for (const [binaryName, serverIds] of requiredBinaries) {
    const onPath = await isBinaryOnPath(binaryName);
    if (!onPath) {
      allPresent = false;
      findings.push(
        finding(
          "warn",
          "binary",
          "Required binary \"" + binaryName + "\" (for " + serverIds.join(", ") +
            ") was not found on PATH."
        )
      );
    }
  }
  if (allPresent) {
    findings.push(
      finding(
        "ok",
        "binary",
        requiredBinaries.size + " required binary(ies) checked and found on PATH."
      )
    );
  }
}

function pushEntrySummaries(findings, counters, total) {
  if (counters.filesPresent === total) {
    findings.push(finding("ok", "target-file", total + " target file(s) present."));
  }
  if (counters.filesParsed === counters.filesPresent && counters.filesPresent > 0) {
    findings.push(finding("ok", "parse", counters.filesParsed + " target file(s) parsed successfully."));
  }
  if (counters.keysPresent === counters.filesParsed && counters.filesParsed > 0) {
    findings.push(finding("ok", "server-key", counters.keysPresent + " entry key(s) still present."));
  }
  if (counters.hashesMatch === counters.keysPresent && counters.keysPresent > 0) {
    findings.push(finding("ok", "drift", counters.hashesMatch + " entry(ies) match their installed content, no drift."));
  }
  if (counters.placeholdersClean === counters.hashesMatch && counters.hashesMatch > 0) {
    findings.push(
      finding("ok", "placeholder", counters.placeholdersClean + " entry(ies) have no unfilled placeholders.")
    );
  }
}

export async function runDoctor({ dir, homedir, platform }) {
  const findings = [];

  let manifest;
  try {
    manifest = await readManifest(dir);
  } catch (err) {
    if (err instanceof ManifestCorruptError) {
      findings.push(finding("error", "manifest", err.message));
      await checkLockfile(dir, findings);
      return findings;
    }
    throw err;
  }

  if (manifest === null || manifest.entries.length === 0) {
    findings.push(finding("ok", "manifest", "No manifest found — nothing installed by bi-agent-kit yet."));
    await checkLockfile(dir, findings);
    return findings;
  }

  findings.push(finding("ok", "manifest", "Manifest read successfully with " + manifest.entries.length + " entry(ies)."));

  const groups = resolveTargets(dir, homedir, platform);
  const counters = {
    filesPresent: 0,
    filesParsed: 0,
    keysPresent: 0,
    hashesMatch: 0,
    placeholdersClean: 0,
    healthy: 0,
  };

  for (const entry of manifest.entries) {
    const group = resolveGroupForEntry(entry, groups);
    await checkEntry(entry, group, findings, counters);
  }

  pushEntrySummaries(findings, counters, manifest.entries.length);

  await checkRequiredBinaries(manifest, findings);
  await checkLockfile(dir, findings);

  return findings;
}
