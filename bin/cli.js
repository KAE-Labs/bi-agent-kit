#!/usr/bin/env node
import * as clack from "@clack/prompts";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";
import {
  loadTemplates,
  getDetectedTargetGroups,
  getCurrentSelections,
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

  const options = [];
  for (const group of groups) {
    for (const template of templates) {
      options.push({
        value: group.absPath + "::" + template.id,
        label: formatChoiceLabel(group, template),
      });
    }
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

  const selections = chosen.map((value) => {
    const [absPath, serverId] = value.split("::");
    return { absPath, serverId };
  });

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
