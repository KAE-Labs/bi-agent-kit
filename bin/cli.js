#!/usr/bin/env node
import * as clack from "@clack/prompts";
import path from "node:path";
import os from "node:os";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
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
import { isBinaryOnPath } from "../lib/prereq-check.js";
import { offerInstall } from "../lib/installers.js";

const execFileAsync = promisify(execFile);

const SECRET_TOKEN_MARKERS = ["TOKEN", "SECRET", "PASSWORD", "CONNECTION_STRING", "PAT", "KEY", "URI"];

export function parseArgs(argv) {
  const args = argv.slice(2);
  const command = args.find((a) => !a.startsWith("-")) || "init";
  const dryRun = args.includes("--dry-run");
  return { command, dryRun };
}

function formatChoiceLabel(group, template) {
  return template.label + " -> " + group.labels.join(", ");
}

function looksSecretLike(token) {
  return SECRET_TOKEN_MARKERS.some((marker) => token.includes(marker));
}

async function warnIfSecretNotGitignored({ dir, absPath }) {
  const resolvedDir = path.resolve(dir);
  const resolvedAbsPath = path.resolve(absPath);
  const relative = path.relative(resolvedDir, resolvedAbsPath);
  const isProjectScoped = relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
  if (!isProjectScoped) return;

  try {
    await execFileAsync("git", ["check-ignore", "-q", resolvedAbsPath], { cwd: resolvedDir });
    // exit 0 -> file is ignored, nothing to warn about
  } catch (err) {
    // git absent, not a repo, or any other execution failure -- stay silent
    if (typeof err.code === "number") {
      clack.log.warn(
        absPath + " now contains a credential and is not gitignored. Add it to .gitignore before committing."
      );
    }
  }
}

async function offerBinaryInstall(binaryName) {
  const result = await offerInstall(binaryName, {
    confirm: (opts) => clack.confirm(opts),
  });
  if (!result.attempted) return false;
  if (result.installed) {
    const nowOnPath = await isBinaryOnPath(binaryName);
    if (nowOnPath) {
      clack.log.success(binaryName + " installed and found on PATH.");
      return true;
    }
    clack.log.warn(binaryName + " install command completed, but it was still not found on PATH.");
    return false;
  }
  clack.log.error("Failed to install " + binaryName + (result.message ? ": " + result.message : ""));
  return false;
}

async function offerPacAuthWalkthrough() {
  const configureNow = await clack.confirm({ message: "Configure a pac auth profile now?" });
  if (clack.isCancel(configureNow) || !configureNow) return;

  try {
    const { stdout } = await execFileAsync("pac", ["auth", "list"]);
    clack.log.info(stdout.trim().length > 0 ? stdout.trim() : "No pac auth profiles found.");
  } catch (err) {
    clack.log.warn("Could not run pac auth list: " + err.message);
  }

  const createNow = await clack.confirm({ message: "Create a new pac auth profile?" });
  if (clack.isCancel(createNow) || !createNow) return;

  const environmentUrl = await clack.text({
    message: "Environment URL (leave blank to skip)",
    placeholder: "https://yourorg.crm.dynamics.com",
  });
  if (clack.isCancel(environmentUrl)) return;

  const args = ["auth", "create"];
  if (environmentUrl.trim().length > 0) {
    args.push("--environment", environmentUrl.trim());
  }

  clack.log.info("A browser window will open for interactive login. Waiting for it to complete...");
  try {
    await execFileAsync("pac", args);
    clack.log.success("pac auth profile created.");
  } catch (err) {
    clack.log.error("pac auth create failed: " + err.message);
  }
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

  const missingBinaries = new Set();
  for (const template of templates) {
    if (!template.requiresBinary) continue;
    const found = await isBinaryOnPath(template.requiresBinary);
    if (!found) missingBinaries.add(template.requiresBinary);
  }

  if (!dryRun) {
    for (const binaryName of Array.from(missingBinaries)) {
      const wantsInstall = await clack.confirm({
        message: binaryName + " was not found on PATH. Install it now?",
      });
      if (clack.isCancel(wantsInstall)) {
        clack.cancel("Cancelled.");
        process.exit(1);
      }
      if (!wantsInstall) {
        clack.log.warn(binaryName + " was not found on PATH -- servers that require it will be flagged in the picker below.");
        continue;
      }
      const succeeded = await offerBinaryInstall(binaryName);
      if (succeeded) missingBinaries.delete(binaryName);
    }
  } else {
    for (const binaryName of missingBinaries) {
      clack.log.warn(binaryName + " was not found on PATH -- servers that require it will be flagged in the picker below.");
    }
  }

  const options = [];
  for (const group of groups) {
    for (const template of templates) {
      const value = group.absPath + "::" + template.id;
      if (externallyManagedKeys.has(value)) continue;
      let label = formatChoiceLabel(group, template);
      if (template.requiresBinary && missingBinaries.has(template.requiresBinary)) {
        label += " (requires " + template.requiresBinary + " on PATH, not found)";
      }
      options.push({
        value,
        label,
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
  const secretSelectionKeys = new Set();
  let pacCliJustConfigured = false;
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
      if (template && template.id === "pac-cli") pacCliJustConfigured = true;
      continue;
    }
    clack.log.step("Setup needed for " + template.label + " at " + selection.absPath);
    const answers = [];
    for (const placeholder of placeholders) {
      const answer = await clack.text({
        message: describePlaceholder(placeholder.path, placeholder.token),
        placeholder: placeholder.token,
      });
      if (clack.isCancel(answer)) {
        clack.cancel("Cancelled.");
        process.exit(1);
      }
      if (answer.trim().length > 0) {
        answers.push({ path: placeholder.path, token: placeholder.token, value: answer.trim() });
        if (looksSecretLike(placeholder.token)) {
          secretSelectionKeys.add(key);
        }
      }
    }
    const configOverride = applyPlaceholderValues(template.config, answers);
    selections.push({ ...selection, configOverride });
    if (template && template.id === "pac-cli") pacCliJustConfigured = true;
  }

  const report = await applySelections({ dir, homedir, platform, templates, selections, dryRun });

  for (const entry of report) {
    clack.log.info(entry.action + " " + entry.serverId + " at " + entry.absPath + ": " + entry.status);
    if (entry.action === "add" && entry.status === "written") {
      const key = entry.absPath + "::" + entry.serverId;
      if (secretSelectionKeys.has(key)) {
        await warnIfSecretNotGitignored({ dir, absPath: entry.absPath });
      }
    }
  }

  if (!dryRun) {
    const pacAvailable = await isBinaryOnPath("pac");
    if (pacAvailable && pacCliJustConfigured) {
      await offerPacAuthWalkthrough();
    }
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
