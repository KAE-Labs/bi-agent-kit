#!/usr/bin/env node
import * as clack from "@clack/prompts";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadTemplates,
  getDetectedTargetGroups,
  getCurrentSelections,
  findExternallyManagedEntries,
  computeDiff,
  collectPlaceholders,
  applyPlaceholderValues,
  describePlaceholder,
  applySelections,
  listInstalled,
} from "../lib/commands.js";

export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((a) => !a.startsWith("-")) || "init";
  const dryRun = args.includes("--dry-run");
  return { command, dryRun };
}

function formatChoiceLabel(group, template) {
  return template.label + " -> " + group.labels.join(", ");
}

async function runInteractive(command, dryRun) {
  clack.intro("bi-agent-kit");

  if (command === "list") {
    const installed = await listInstalled({ dir: process.cwd() });
    if (installed.length === 0) {
      clack.log.info("Nothing installed yet. Run npx bi-agent-kit init to get started.");
    } else {
      for (const entry of installed) {
        clack.log.info(entry.serverId + " -> " + entry.absPath);
      }
    }
    clack.outro("Done.");
    return;
  }

  const dir = process.cwd();
  const homedir = os.homedir();
  const platform = process.platform;

  const groups = await getDetectedTargetGroups({ dir, homedir, platform });
  if (groups.length === 0) {
    clack.log.warn("No supported AI tool config files were detected in this project or your home directory.");
    clack.outro("Nothing to do.");
    return;
  }

  const templates = await loadTemplates();
  const previousSelections = await getCurrentSelections({ dir });
  const previousKeys = new Set(previousSelections.map((s) => s.absPath + "::" + s.serverId));

  const externallyManaged = await findExternallyManagedEntries({ dir, groups, templates });
  const externallyManagedKeys = new Set(
    externallyManaged.map((e) => e.absPath + "::" + e.serverId)
  );
  if (externallyManaged.length > 0) {
    clack.log.warn(
      "Skipping " + externallyManaged.length + " entry(ies) already configured outside bi-agent-kit, they will be left as is:"
    );
    for (const entry of externallyManaged) {
      clack.log.info("  " + entry.serverId + " at " + entry.absPath);
    }
  }

  const options = [];
  for (const group of groups) {
    for (const template of templates) {
      const value = group.absPath + "::" + template.id;
      if (externallyManagedKeys.has(value)) continue;
      options.push({
        value,
        label: formatChoiceLabel(group, template),
      });
    }
  }

  if (options.length === 0) {
    clack.log.warn("Every detected server slot is already configured outside bi-agent-kit. Nothing left to offer.");
    clack.outro("Nothing to do.");
    return;
  }

  const initialValues = options.map((o) => o.value).filter((value) => previousKeys.has(value));

  const chosen = await clack.multiselect({
    message: "Select which BI servers to install into which detected config files",
    options,
    initialValues,
    required: false,
  });

  if (clack.isCancel(chosen)) {
    clack.cancel("Cancelled.");
    process.exit(1);
  }

  const newSelections = chosen.map((value) => {
    const [absPath, serverId] = value.split("::");
    return { absPath, serverId };
  });

  const { toAdd } = computeDiff({ previousSelections, newSelections });
  const toAddKeys = new Set(toAdd.map((s) => s.absPath + "::" + s.serverId));

  const selections = [];
  for (const selection of newSelections) {
    const key = selection.absPath + "::" + selection.serverId;
    if (dryRun || !toAddKeys.has(key)) {
      selections.push(selection);
      continue;
    }
    const template = templates.find((t) => t.id === selection.serverId);
    const placeholders = template ? collectPlaceholders(template.config) : [];
    if (placeholders.length === 0) {
      selections.push(selection);
      continue;
    }
    clack.log.step("Setup needed for " + template.label + " at " + selection.absPath);
    const answers = [];
    for (const placeholder of placeholders) {
      const answer = await clack.text({
        message: describePlaceholder(placeholder.path, placeholder.value),
        placeholder: placeholder.value,
      });
      if (clack.isCancel(answer)) {
        clack.cancel("Cancelled.");
        process.exit(1);
      }
      if (answer.trim().length > 0) {
        answers.push({ path: placeholder.path, value: answer.trim() });
      }
    }
    const configOverride = applyPlaceholderValues(template.config, answers);
    selections.push({ ...selection, configOverride });
  }

  const report = await applySelections({ dir, homedir, platform, templates, selections, dryRun });

  for (const entry of report) {
    clack.log.info(entry.action + " " + entry.serverId + " at " + entry.absPath + ": " + entry.status);
  }

  clack.outro(dryRun ? "Dry run complete, nothing was written." : "Done.");
}

const { command, dryRun } = parseArgs(process.argv);
const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  runInteractive(command, dryRun).catch((err) => {
    clack.log.error(err.message);
    process.exit(1);
  });
}
