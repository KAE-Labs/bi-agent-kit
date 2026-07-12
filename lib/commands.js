import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTargets } from "./targets.js";
import { detectExistingTargets } from "./detect.js";
import { addServerToTarget, removeServerFromTarget, CollisionError } from "./merge-config.js";
import { readManifest, removeManifestEntry } from "./manifest.js";
import { acquireLock } from "./lock.js";
import { readFileIfExists } from "./atomic-fs.js";
import { readJsonServers } from "./json-adapter.js";
import { readTomlServers } from "./toml-adapter.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(here, "..", "templates");
const TEMPLATE_FILES = ["powerbi-mcp.json", "dataverse-mcp.json", "pac-cli-mcp.json", "fabric-mcp.json", "azure-mcp.json", "dbt-mcp.json", "sqlserver-mcp.json", "snowflake-mcp.json", "postgres-mcp.json"];

export async function loadTemplates() {
  const templates = [];
  for (const file of TEMPLATE_FILES) {
    const text = await fs.readFile(path.join(templatesDir, file), "utf8");
    templates.push(JSON.parse(text));
  }
  return templates;
}

export async function getDetectedTargetGroups({ dir, homedir, platform }) {
  const resolved = resolveTargets(dir, homedir, platform);
  return await detectExistingTargets(resolved);
}

export async function getCurrentSelections({ dir }) {
  const manifest = await readManifest(dir);
  if (!manifest) return [];
  return manifest.entries.map((e) => ({ absPath: e.absPath, serverId: e.serverKey }));
}

const PLACEHOLDER_TOKEN_PATTERN = /REPLACE_[A-Z0-9_]+/g;

/**
 * Finds every REPLACE_ placeholder token occurring anywhere in the config,
 * one entry per token occurrence (a single string may contain several tokens).
 *
 * Returns entries shaped: { path, value, token }
 *   - path:  array path to the string within the config (as before)
 *   - value: the FULL original string at that path (unmodified, for context)
 *   - token: the exact matched marker text for this occurrence,
 *            e.g. "REPLACE_WITH_YOUR_DATABASE"
 */
export function collectPlaceholders(value, pathPrefix) {
  const prefix = pathPrefix || [];
  const found = [];
  if (typeof value === "string") {
    const matches = value.match(PLACEHOLDER_TOKEN_PATTERN);
    if (matches) {
      for (const token of matches) {
        found.push({ path: prefix, value, token });
      }
    }
    return found;
  }
  if (Array.isArray(value)) {
    value.forEach((item, index) => {
      found.push(...collectPlaceholders(item, prefix.concat(index)));
    });
    return found;
  }
  if (value && typeof value === "object") {
    for (const key of Object.keys(value)) {
      found.push(...collectPlaceholders(value[key], prefix.concat(key)));
    }
    return found;
  }
  return found;
}

function getAtPath(target, pathSegments) {
  let cursor = target;
  for (const segment of pathSegments) {
    cursor = cursor[segment];
  }
  return cursor;
}

function setAtPath(target, pathSegments, newValue) {
  let cursor = target;
  for (let i = 0; i < pathSegments.length - 1; i++) {
    cursor = cursor[pathSegments[i]];
  }
  cursor[pathSegments[pathSegments.length - 1]] = newValue;
}

function spliceFirstTokenOccurrence(str, token, replacement) {
  const index = str.indexOf(token);
  if (index === -1) return str;
  return str.slice(0, index) + replacement + str.slice(index + token.length);
}

/**
 * Applies answers to a config, splicing each answer's replacement value into
 * only the first remaining occurrence of its exact token within the string
 * at answer.path. Multiple answers may target the same path (a string with
 * several tokens) and are applied in order, each independently.
 *
 * answers: array of { path, token, value }
 */
export function applyPlaceholderValues(config, answers) {
  const cloned = JSON.parse(JSON.stringify(config));
  for (const answer of answers) {
    const current = getAtPath(cloned, answer.path);
    const updated = spliceFirstTokenOccurrence(current, answer.token, answer.value);
    setAtPath(cloned, answer.path, updated);
  }
  return cloned;
}

function humanizePlaceholder(token) {
  const marker = token.indexOf("REPLACE_");
  const raw = token.slice(marker + "REPLACE_".length);
  const withoutWith = raw.startsWith("WITH_") ? raw.slice("WITH_".length) : raw;
  return withoutWith.replace(/_/g, " ").trim().toLowerCase();
}

export function describePlaceholder(placeholderPath, placeholderToken) {
  return "Enter a value for " + humanizePlaceholder(placeholderToken) + " (" + placeholderPath.join(".") + ")";
}

export function computeDiff({ previousSelections, newSelections }) {
  const key = (s) => s.absPath + "::" + s.serverId;
  const newKeys = new Set(newSelections.map(key));
  const previousKeys = new Set(previousSelections.map(key));
  const toAdd = newSelections.filter((s) => !previousKeys.has(key(s)));
  const toRemove = previousSelections.filter((s) => !newKeys.has(key(s)));
  return { toAdd, toRemove };
}

function readExistingServers(group, fileText) {
  if (fileText === null) return {};
  try {
    return group.shape === "toml"
      ? readTomlServers(fileText)
      : readJsonServers(fileText, group.rootKey);
  } catch {
    return {};
  }
}

export async function findExternallyManagedEntries({ dir, groups, templates }) {
  const manifest = await readManifest(dir);
  const ownedKeys = new Set(
    (manifest ? manifest.entries : []).map((e) => e.absPath + "::" + e.serverKey)
  );
  const externallyManaged = [];
  for (const group of groups) {
    const fileText = await readFileIfExists(group.absPath);
    const existingServers = readExistingServers(group, fileText);
    for (const template of templates) {
      const key = group.absPath + "::" + template.id;
      const alreadyPresent = Object.prototype.hasOwnProperty.call(existingServers, template.id);
      if (alreadyPresent && !ownedKeys.has(key)) {
        externallyManaged.push({ absPath: group.absPath, serverId: template.id });
      }
    }
  }
  return externallyManaged;
}

export async function applySelections({ dir, homedir, platform, templates, selections, dryRun }) {
  const allGroups = resolveTargets(dir, homedir, platform);
  const previousSelections = await getCurrentSelections({ dir });
  const { toAdd, toRemove } = computeDiff({ previousSelections, newSelections: selections });

  if (dryRun) {
    const additions = toAdd.map((s) => ({ ...s, action: "add", status: "dry-run" }));
    const removals = toRemove.map((s) => ({ ...s, action: "remove", status: "dry-run" }));
    return additions.concat(removals);
  }

  const lockPath = path.join(dir, ".kae-bi-kit.lock");
  const release = await acquireLock(lockPath);
  const report = [];
  try {
    for (const selection of toAdd) {
      const group = allGroups.find((g) => g.absPath === selection.absPath);
      const template = templates.find((t) => t.id === selection.serverId);
      if (!group || !template) {
        report.push({ ...selection, action: "add", status: "skipped-unknown" });
        continue;
      }
      try {
        const result = await addServerToTarget({
          dir,
          resolvedTarget: group,
          serverKey: template.id,
          serverValue: selection.configOverride || template.config,
        });
        report.push({ ...selection, action: "add", status: result.status });
      } catch (err) {
        if (err instanceof CollisionError) {
          report.push({ ...selection, action: "add", status: "collision", message: err.message });
        } else {
          report.push({ ...selection, action: "add", status: "error", message: err.message });
        }
      }
    }

    for (const selection of toRemove) {
      const group = allGroups.find((g) => g.absPath === selection.absPath);
      if (!group) {
        await removeManifestEntry(dir, selection.absPath, selection.serverId);
        report.push({ ...selection, action: "remove", status: "pruned-unresolvable" });
        continue;
      }
      try {
        const result = await removeServerFromTarget({
          dir,
          resolvedTarget: group,
          serverKey: selection.serverId,
        });
        report.push({ ...selection, action: "remove", status: result.status });
      } catch (err) {
        report.push({ ...selection, action: "remove", status: "error", message: err.message });
      }
    }
  } finally {
    await release();
  }
  return report;
}

export async function listInstalled({ dir }) {
  const manifest = await readManifest(dir);
  if (!manifest) return [];
  return manifest.entries.map((e) => ({
    absPath: e.absPath,
    serverId: e.serverKey,
    targetIds: e.targetIds,
    installedAt: e.installedAt,
  }));
}
