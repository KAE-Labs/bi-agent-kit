import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { resolveTargets } from "./targets.js";
import { detectExistingTargets } from "./detect.js";
import { addServerToTarget, removeServerFromTarget, CollisionError } from "./merge-config.js";
import { readManifest, removeManifestEntry } from "./manifest.js";
import { acquireLock } from "./lock.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(here, "..", "templates");
const TEMPLATE_FILES = ["powerbi-mcp.json", "dataverse-mcp.json", "pac-cli-mcp.json", "fabric-mcp.json"];

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

export function computeDiff({ previousSelections, newSelections }) {
  const key = (s) => s.absPath + "::" + s.serverId;
  const newKeys = new Set(newSelections.map(key));
  const previousKeys = new Set(previousSelections.map(key));
  const toAdd = newSelections.filter((s) => !previousKeys.has(key(s)));
  const toRemove = previousSelections.filter((s) => !newKeys.has(key(s)));
  return { toAdd, toRemove };
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
          serverValue: template.config,
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
