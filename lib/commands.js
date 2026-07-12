import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTargets } from "./targets.js";
import { detectExistingTargets } from "./detect.js";
import { addServerToTarget, removeServerFromTarget, CollisionError } from "./merge-config.js";
import { readManifest, removeManifestEntry, MANIFEST_FILENAME } from "./manifest.js";
import { acquireLock } from "./lock.js";
import { readFileIfExists, normalizePathForCompare } from "./atomic-fs.js";
import { hashValue } from "./hash.js";
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
 * When prune is false (the default, additive semantics), returns the union of
 * newSelections and previousSelections -- previous entries not re-listed in
 * newSelections are preserved, and on key collision the newSelections entry wins
 * (so a configOverride carried on the new entry flows through unchanged).
 *
 * When prune is true, returns newSelections plus any previous selection whose
 * absPath is outside scopePaths (out-of-scope entries are preserved verbatim,
 * so a scoped `--targets` prune cannot remove entries belonging to files
 * outside that scope). scopePaths is a Set of absPaths, compared with
 * normalizePathForCompare (case-insensitive on win32); pass scopePaths as
 * null/undefined for the unscoped full-prune behavior (returns newSelections
 * as-is, dropping every previous entry not re-listed).
 */
export function mergeWithPrevious({ previousSelections, newSelections, prune, scopePaths }) {
  if (!prune) {
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
  if (!scopePaths) return newSelections;
  const normalizedScope = new Set(Array.from(scopePaths).map(normalizePathForCompare));
  const outOfScope = previousSelections.filter(
    (s) => !normalizedScope.has(normalizePathForCompare(s.absPath))
  );
  return newSelections.concat(outOfScope);
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
 * Reconstructs the "templateId" or "templateId:instanceName" spec string for
 * a manifest entry from its templateId + serverId, the inverse of
 * parseServerSpec.
 */
function specFor(templateId, serverId) {
  if (serverId === templateId) return templateId;
  const prefix = templateId + "-";
  if (serverId.startsWith(prefix)) {
    return templateId + ":" + serverId.slice(prefix.length);
  }
  return templateId;
}

/**
 * Returns true if outPath (resolved) collides with the manifest, the manifest
 * backup file, or any resolved target group's absPath -- case-insensitively
 * on win32. Used to refuse `export --out` writes that would clobber the
 * manifest or a live target config file instead of writing a portable export
 * document to it.
 */
export function isProtectedExportPath({ dir, outPath, groups }) {
  const manifestPath = path.join(dir, MANIFEST_FILENAME);
  const protectedPaths = [manifestPath, manifestPath + ".bak", ...groups.map((g) => g.absPath)];
  const normalizedOut = normalizePathForCompare(outPath);
  return protectedPaths.some((p) => normalizePathForCompare(p) === normalizedOut);
}

/**
 * Builds a portable, machine-independent export document from the manifest:
 * { version: 1, note, servers: [{ spec, targetIds }] }. Only the spec string
 * (templateId or templateId:instanceName) and the logical targetIds are
 * included -- never absPaths (those are machine-specific) and never
 * configOverride/placeholder/secret values, since the manifest itself never
 * stores answered placeholder values either (they live only in the target
 * config files). Entries sharing the same spec across multiple absPaths on
 * this machine are folded into one doc entry with the union of their
 * targetIds.
 */
export async function exportConfig({ dir, templates }) {
  const installed = await listInstalled({ dir });
  const validTemplateIds = new Set(templates.map((t) => t.id));
  const bySpec = new Map();
  for (const entry of installed) {
    if (!validTemplateIds.has(entry.templateId)) continue;
    const spec = specFor(entry.templateId, entry.serverId);
    if (!bySpec.has(spec)) bySpec.set(spec, new Set());
    for (const targetId of entry.targetIds || []) {
      bySpec.get(spec).add(targetId);
    }
  }
  const servers = Array.from(bySpec.entries()).map(([spec, targetIdSet]) => ({
    spec,
    targetIds: Array.from(targetIdSet),
  }));
  return {
    version: 1,
    note:
      "Placeholder values and secrets are never exported. On import, any REPLACE_ tokens are " +
      "re-prompted interactively, or left as literal placeholders (with a warning) in non-interactive mode.",
    servers,
  };
}

/**
 * Resolves an export document (see exportConfig) against this machine's
 * detected target groups, building additive selections ready to hand to
 * mergeWithPrevious/applySelections. Each doc entry's targetIds are resolved
 * independently against groups -- a targetId not detected on this machine is
 * recorded in `skipped` (as { spec, targetId }) rather than throwing, so a
 * partially-portable doc still imports what it can.
 *
 * Throws if doc is missing or its version is not the supported 1, or if any
 * spec string is malformed (via parseServerSpec).
 */
export function buildSelectionsFromConfig({ doc, groups }) {
  if (!doc || typeof doc !== "object" || doc.version !== 1) {
    throw new Error("Unsupported or missing config document version. Expected version 1.");
  }
  const selectionsByKey = new Map();
  const skipped = [];
  for (const server of doc.servers || []) {
    const spec = parseServerSpec(server.spec);
    for (const targetId of server.targetIds || []) {
      const group = groups.find((g) => g.targetIds.includes(targetId));
      if (!group) {
        skipped.push({ spec: server.spec, targetId });
        continue;
      }
      // A shared-file targetId (e.g. claude-code and copilot-cli-project both
      // resolving to .mcp.json) yields one doc entry per targetId but the same
      // (absPath, serverId) selection -- dedupe here so callers (init --prune
      // in particular) never see the same key twice in one selections list.
      const key = group.absPath + "::" + spec.serverId;
      if (!selectionsByKey.has(key)) {
        selectionsByKey.set(key, { absPath: group.absPath, serverId: spec.serverId, templateId: spec.templateId });
      }
    }
  }
  return { selections: Array.from(selectionsByKey.values()), skipped };
}

/**
 * True if the live value currently stored under entry.serverKey in the target
 * file no longer hashes to entry.contentHash -- i.e. it was hand-edited
 * outside bi-agent-kit since it was last written. A key that is missing
 * entirely from the live file is not considered drift here (nothing to
 * compare against; addServerToTarget/reconfigureEntry will simply write it).
 */
async function computeEntryDrift({ group, entry }) {
  const fileText = await readFileIfExists(group.absPath);
  const currentServers = readExistingServers(group, fileText);
  const currentValue = currentServers[entry.serverKey];
  if (currentValue === undefined) return false;
  return hashValue(currentValue) !== entry.contentHash;
}

/**
 * Reports whether an installed entry has drifted (been hand-edited outside
 * bi-agent-kit) since it was last written, without mutating anything. Meant
 * to be called by the CLI's reconfigure command BEFORE prompting for new
 * placeholder values, so a user who declines to overwrite drifted config
 * isn't asked questions first. Returns false (no drift) if the entry, or its
 * target group, can't be resolved -- reconfigureEntry itself is the source of
 * truth for those error cases.
 */
export async function getEntryDrift({ dir, homedir, platform, absPath, serverId }) {
  const manifest = await readManifest(dir);
  const entry = manifest
    ? manifest.entries.find((e) => e.absPath === absPath && e.serverKey === serverId)
    : undefined;
  if (!entry) return false;

  const allGroups = resolveTargets(dir, homedir, platform);
  const group = allGroups.find((g) => g.absPath === absPath);
  if (!group) return false;

  return await computeEntryDrift({ group, entry });
}

/**
 * Re-applies an installed entry in place with a new configOverride: resolves the
 * target group for absPath, finds the template by the manifest entry templateId
 * (falling back to serverKey for old manifests), and re-adds it via addServerToTarget
 * (owned-key overwrite is already permitted there), returning its status object
 * plus a `drift` flag reporting whether the live value had already diverged
 * from the manifest's recorded contentHash before this call overwrote it.
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

  const drift = await computeEntryDrift({ group, entry });

  const result = await addServerToTarget({
    dir,
    resolvedTarget: group,
    serverKey: serverId,
    serverValue: configOverride,
    templateId,
  });

  return { ...result, drift };
}
