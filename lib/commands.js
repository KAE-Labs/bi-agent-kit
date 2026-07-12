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

const INSTANCE_NAME_PATTERN = /^[a-z0-9-]+$/i;

export async function loadTemplates() {
  const templates = [];
  for (const file of TEMPLATE_FILES) {
    const text = await fs.readFile(path.join(templatesDir, file), "utf8");
    templates.push(JSON.parse(text));
  }
  return templates;
}

/**
 * Parses a server spec string of the form "templateId" or "templateId:instanceName".
 * instanceName must match /^[a-z0-9-]+$/i. Returns { templateId, instanceName, serverId },
 * where serverId is templateId when there is no instance, else templateId + "-" + instanceName.
 */
export function parseServerSpec(spec) {
  const colonIndex = spec.indexOf(":");
  if (colonIndex === -1) {
    return { templateId: spec, instanceName: null, serverId: spec };
  }
  const templateId = spec.slice(0, colonIndex);
  const instanceName = spec.slice(colonIndex + 1);
  if (!INSTANCE_NAME_PATTERN.test(instanceName)) {
    throw new Error(
      "Invalid instance name \"" + instanceName + "\" in server spec \"" + spec +
        "\": instance names must match /^[a-z0-9-]+$/i."
    );
  }
  return { templateId, instanceName, serverId: templateId + "-" + instanceName };
}

export async function getDetectedTargetGroups({ dir, homedir, platform }) {
  const resolved = resolveTargets(dir, homedir, platform);
  return await detectExistingTargets(resolved);
}

export async function getCurrentSelections({ dir }) {
  const manifest = await readManifest(dir);
  if (!manifest) return [];
  return manifest.entries.map((e) => ({
    absPath: e.absPath,
    serverId: e.serverKey,
    templateId: e.templateId || e.serverKey,
  }));
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

/**
 * Merges newSelections with previousSelections, keyed by absPath + '::' + serverId.
 * When prune is true, returns newSelections as-is (full-sync semantics: anything
 * previously installed but not re-listed is dropped by the caller's diff). When
 * prune is false (the default, additive semantics), returns the union of
 * newSelections and previousSelections -- previous entries not re-listed in
 * newSelections are preserved, and on key collision the newSelections entry wins
 * (so a configOverride carried on the new entry flows through unchanged).
 */
export function mergeWithPrevious({ previousSelections, newSelections, prune }) {
  if (prune) return newSelections;
  const key = (s) => s.absPath + '::' + s.serverId;
  const merged = new Map();
  for (const selection of previousSelections) {
    merged.set(key(selection), selection);
  }
  for (const selection of newSelections) {
    merged.set(key(selection), selection);
  }
  return Array.from(merged.values());
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

/**
 * Resolves a server key found in a target file (e.g. "dataverse" or "dataverse-dev")
 * back to the template that owns it, matching either the bare template id or the
 * "templateId-instanceName" form used for named instances.
 */
function matchTemplateForServerKey(serverKey, templates) {
  const exact = templates.find((t) => t.id === serverKey);
  if (exact) return exact;
  return templates.find((t) => serverKey.startsWith(t.id + "-")) || null;
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
    for (const serverKey of Object.keys(existingServers)) {
      const key = group.absPath + "::" + serverKey;
      if (ownedKeys.has(key)) continue;
      const template = matchTemplateForServerKey(serverKey, templates);
      if (!template) continue;
      externallyManaged.push({ absPath: group.absPath, serverId: serverKey, templateId: template.id });
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
      const templateId = selection.templateId || selection.serverId;
      const template = templates.find((t) => t.id === templateId);
      if (!group || !template) {
        report.push({ ...selection, action: "add", status: "skipped-unknown" });
        continue;
      }
      try {
        const result = await addServerToTarget({
          dir,
          resolvedTarget: group,
          serverKey: selection.serverId,
          serverValue: selection.configOverride || template.config,
          templateId: template.id,
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
    templateId: e.templateId || e.serverKey,
    targetIds: e.targetIds,
    installedAt: e.installedAt,
  }));
}

function instanceSuffixFor(serverKey, templateId) {
  if (serverKey === templateId) return "";
  const prefix = templateId + "-";
  if (serverKey.startsWith(prefix)) {
    return " (" + serverKey.slice(prefix.length) + ")";
  }
  return "";
}

/**
 * Returns the manifest entries enriched with display/lookup information:
 * { absPath, serverId, templateId, label, hasPlaceholders }
 *   - label: template label + optional " (instanceName)" suffix + " -> " + target path
 *   - hasPlaceholders: whether the template config itself still contains REPLACE_ tokens
 */
export async function getInstalledEntries({ dir, templates }) {
  const manifest = await readManifest(dir);
  if (!manifest) return [];
  return manifest.entries.map((e) => {
    const templateId = e.templateId || e.serverKey;
    const template = templates.find((t) => t.id === templateId);
    const templateLabel = template ? template.label : templateId;
    const suffix = instanceSuffixFor(e.serverKey, templateId);
    const label = templateLabel + suffix + " -> " + e.absPath;
    const hasPlaceholders = template ? collectPlaceholders(template.config).length > 0 : false;
    return {
      absPath: e.absPath,
      serverId: e.serverKey,
      templateId,
      label,
      hasPlaceholders,
    };
  });
}

/**
 * Re-applies an installed entry in place with a new configOverride: resolves the
 * target group for absPath, finds the template by the manifest entry templateId
 * (falling back to serverKey for old manifests), and re-adds it via addServerToTarget
 * (owned-key overwrite is already permitted there), returning its status object.
 */
export async function reconfigureEntry({ dir, homedir, platform, templates, absPath, serverId, configOverride }) {
  const manifest = await readManifest(dir);
  const entry = manifest
    ? manifest.entries.find((e) => e.absPath === absPath && e.serverKey === serverId)
    : undefined;
  if (!entry) {
    throw new Error(
      "No installed entry found for \"" + serverId + "\" at " + absPath + ". Install it first."
    );
  }

  const allGroups = resolveTargets(dir, homedir, platform);
  const group = allGroups.find((g) => g.absPath === absPath);
  if (!group) {
    throw new Error("Could not resolve a target group for " + absPath + ".");
  }

  const templateId = entry.templateId || entry.serverKey;
  const template = templates.find((t) => t.id === templateId);
  if (!template) {
    throw new Error(
      "Could not find template \"" + templateId + "\" for installed entry \"" + serverId + "\"."
    );
  }

  return await addServerToTarget({
    dir,
    resolvedTarget: group,
    serverKey: serverId,
    serverValue: configOverride,
    templateId,
  });
}
