#!/usr/bin/env node
import * as clack from "@clack/prompts";
import path from "node:path";
import os from "node:os";
import { promises as fs } from "node:fs";
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
  parseServerSpec,
  getInstalledEntries,
  reconfigureEntry,
} from "../lib/commands.js";
import { isBinaryOnPath } from "../lib/prereq-check.js";
import { offerInstall } from "../lib/installers.js";
import { TARGET_DEFINITIONS } from "../lib/targets.js";

const execFileAsync = promisify(execFile);

const SECRET_TOKEN_MARKERS = ["TOKEN", "SECRET", "PASSWORD", "CONNECTION_STRING", "PAT", "KEY", "URI"];

export const VALID_COMMANDS = ["init", "configure", "list", "doctor", "reconfigure"];

const here = path.dirname(fileURLToPath(import.meta.url));

function splitList(value) {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Pure argv parser -- never prints or exits. The caller decides what to do
 * with an unrecognized command, --help, --version, etc, which keeps this
 * function fully unit-testable without a TTY.
 */
export function parseArgs(argv) {
  const args = argv.slice(2);
  const positional = [];
  const result = {
    command: null,
    dryRun: false,
    yes: false,
    json: false,
    help: false,
    version: false,
    servers: null,
    targets: null,
  };

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--dry-run") {
      result.dryRun = true;
    } else if (arg === "--yes") {
      result.yes = true;
    } else if (arg === "--json") {
      result.json = true;
    } else if (arg === "--help" || arg === "-h") {
      result.help = true;
    } else if (arg === "--version" || arg === "-v") {
      result.version = true;
    } else if (arg === "--servers") {
      const value = args[i + 1];
      result.servers = value !== undefined ? splitList(value) : [];
      if (value !== undefined) i++;
    } else if (arg.startsWith("--servers=")) {
      result.servers = splitList(arg.slice("--servers=".length));
    } else if (arg === "--targets") {
      const value = args[i + 1];
      result.targets = value !== undefined ? splitList(value) : [];
      if (value !== undefined) i++;
    } else if (arg.startsWith("--targets=")) {
      result.targets = splitList(arg.slice("--targets=".length));
    } else if (!arg.startsWith("-")) {
      positional.push(arg);
    }
    // unknown flags are ignored -- the flags above are the full surface area
  }

  result.command = positional[0] || "init";
  return result;
}

function printHelp() {
  const lines = [
    "bi-agent-kit -- installs BI-related MCP server entries into AI coding tool configs",
    "",
    "Usage: bi-agent-kit <command> [flags]",
    "",
    "Commands:",
    "  init                    Interactively pick BI MCP servers and install them into detected configs",
    "  configure                Same as init, re-run any time to change your selections",
    "  list                     Show what bi-agent-kit has installed, grouped by target config file",
    "  doctor                   Check the environment for common setup problems",
    "  reconfigure               Re-run the placeholder walkthrough for an already-installed entry",
    "",
    "Flags:",
    "  --dry-run                Show what would change without writing anything",
    "  --yes                    Skip confirmations; never runs installers without an explicit interactive yes",
    "  --json                   Machine-readable output (list, doctor)",
    "  --servers <ids>          Comma-separated server specs, skips the interactive picker.",
    "                            Each spec is templateId or templateId:instanceName (e.g. dataverse:dev)",
    "  --targets <ids>          Comma-separated target ids (see lib/targets.js), restricts --servers to these targets",
    "  --help, -h               Show this help and exit",
    "  --version, -v            Show the installed version and exit",
  ];
  console.log(lines.join("\n"));
}

async function printVersion() {
  const packageJsonPath = path.join(here, "..", "package.json");
  const text = await fs.readFile(packageJsonPath, "utf8");
  const pkg = JSON.parse(text);
  console.log(pkg.version);
}

function formatChoiceLabel(group, template) {
  return template.label + " -> " + group.labels.join(", ");
}

function looksSecretLike(token) {
  return SECRET_TOKEN_MARKERS.some((marker) => token.includes(marker));
}

function labelForTargetIds(targetIds) {
  return (targetIds || [])
    .map((id) => {
      const def = TARGET_DEFINITIONS.find((d) => d.id === id);
      return def ? def.label : id;
    })
    .join(", ");
}

/** templateId for a selection, falling back to serverId for pre-existing manifests / callers. */
function templateIdFor(selection) {
  return selection.templateId || selection.serverId;
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

function describeExternallyManagedGuidance() {
  return "The entry stays untouched; remove or rename it by hand first if you want bi-agent-kit to manage it.";
}

/**
 * Runs the interactive placeholder walkthrough for a template, prompting for
 * every REPLACE_ token found in its config. Kept as a small isolated seam so
 * the add flow, the picker's inline reconfigure, and the reconfigure command
 * all share one implementation.
 *
 * Returns { answers, hasSecret } where answers is ready to hand to
 * applyPlaceholderValues and hasSecret flags whether any answered token
 * looked like a credential (for the gitignore warning).
 */
async function promptForPlaceholders(template) {
  const placeholders = collectPlaceholders(template.config);
  const answers = [];
  let hasSecret = false;
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
      if (looksSecretLike(placeholder.token)) hasSecret = true;
    } else {
      clack.log.warn(
        "Left " +
          placeholder.token +
          " unset -- that literal token stays in the written config, and " +
          template.label +
          " will not work until you edit it."
      );
    }
  }
  return { answers, hasSecret };
}

async function runList({ dir, json }) {
  const installed = await listInstalled({ dir });

  if (json) {
    console.log(JSON.stringify(installed, null, 2));
    return;
  }

  clack.intro("bi-agent-kit");
  if (installed.length === 0) {
    clack.log.info("Nothing installed yet. Run npx bi-agent-kit init to get started.");
    clack.outro("Done.");
    return;
  }

  const byPath = new Map();
  for (const entry of installed) {
    if (!byPath.has(entry.absPath)) byPath.set(entry.absPath, []);
    byPath.get(entry.absPath).push(entry);
  }

  for (const [absPath, entries] of byPath) {
    clack.log.step(labelForTargetIds(entries[0].targetIds) + " (" + absPath + ")");
    for (const entry of entries) {
      clack.log.info("  " + entry.serverId + " -- installed " + (entry.installedAt || "unknown date"));
    }
  }
  clack.outro("Done.");
}

async function runDoctor({ dir, homedir, platform, json }) {
  const { runDoctor: doctor } = await import("../lib/doctor.js");
  const findings = await doctor({ dir, homedir, platform });

  if (json) {
    console.log(JSON.stringify(findings, null, 2));
  } else {
    clack.intro("bi-agent-kit doctor");
    for (const finding of findings) {
      const message = "[" + finding.area + "] " + finding.message;
      if (finding.level === "error") clack.log.error(message);
      else if (finding.level === "warn") clack.log.warn(message);
      else clack.log.info(message);
    }
    clack.outro("Done.");
  }

  const hasError = findings.some((f) => f.level === "error");
  process.exitCode = hasError ? 1 : 0;
}

/**
 * Cross product of requested server specs x detected groups, restricted to
 * groups whose targetIds intersect the requested target ids (if any).
 * Each spec is "templateId" or "templateId:instanceName", parsed via
 * parseServerSpec. Throws with a message listing the valid template ids when
 * given an unknown templateId, or with parseServerSpec's own message when
 * the instance name is invalid.
 */
function buildNonInteractiveSelections({ servers, targets, groups, templates }) {
  const validServerIds = templates.map((t) => t.id);

  const specs = servers.map((raw) => {
    const spec = parseServerSpec(raw);
    if (!validServerIds.includes(spec.templateId)) {
      throw new Error(
        "Unknown server id: " + spec.templateId + ". Valid server ids: " + validServerIds.join(", ")
      );
    }
    return spec;
  });

  const validTargetIds = TARGET_DEFINITIONS.map((t) => t.id);
  if (targets) {
    for (const targetId of targets) {
      if (!validTargetIds.includes(targetId)) {
        throw new Error(
          "Unknown target id: " + targetId + ". Valid target ids: " + validTargetIds.join(", ")
        );
      }
    }
  }

  const matchingGroups = targets
    ? groups.filter((group) => group.targetIds.some((id) => targets.includes(id)))
    : groups;

  const selections = [];
  for (const spec of specs) {
    for (const group of matchingGroups) {
      selections.push({ absPath: group.absPath, serverId: spec.serverId, templateId: spec.templateId });
    }
  }
  return selections;
}

/**
 * For each already-installed (serverId, absPath) pair among the chosen
 * servers/targets, asks the user whether to keep it as is, reconfigure it in
 * place, or add a new named instance alongside it. Returns the resulting
 * selections list (skip/new-instance both contribute selections that survive
 * the diff; reconfigure additionally runs its walkthrough immediately and is
 * reported separately since it never appears in `toAdd`).
 */
async function resolveInteractiveSelections({ chosenServers, chosenTargets, previousSelections, templates, dryRun }) {
  const previousKeys = new Set(previousSelections.map((s) => s.absPath + "::" + s.serverId));
  const raw = [];
  const reconfigured = [];

  for (const templateId of chosenServers) {
    for (const absPath of chosenTargets) {
      const key = absPath + "::" + templateId;
      if (!previousKeys.has(key)) {
        raw.push({ absPath, serverId: templateId, templateId });
        continue;
      }

      const choice = await clack.select({
        message: templateId + " is already installed at " + absPath + ". What would you like to do?",
        options: [
          { value: "skip", label: "Keep as is" },
          { value: "reconfigure", label: "Reconfigure values" },
          { value: "new-instance", label: "Add as a new named instance" },
        ],
      });
      if (clack.isCancel(choice)) {
        clack.cancel("Cancelled.");
        process.exit(1);
      }

      if (choice === "skip") {
        raw.push({ absPath, serverId: templateId, templateId });
        continue;
      }

      if (choice === "reconfigure") {
        raw.push({ absPath, serverId: templateId, templateId });
        const template = templates.find((t) => t.id === templateId);
        if (dryRun) {
          reconfigured.push({ absPath, serverId: templateId, status: "dry-run" });
          continue;
        }
        clack.log.step("Reconfiguring " + template.label + " at " + absPath);
        const { answers } = await promptForPlaceholders(template);
        const configOverride = applyPlaceholderValues(template.config, answers);
        reconfigured.push({ absPath, serverId: templateId, configOverride });
        continue;
      }

      // new-instance: keep the existing entry, add a second one under a new name
      raw.push({ absPath, serverId: templateId, templateId });
      let instanceName;
      let spec = null;
      while (spec === null) {
        instanceName = await clack.text({ message: "Instance name (letters, numbers, hyphens)" });
        if (clack.isCancel(instanceName)) {
          clack.cancel("Cancelled.");
          process.exit(1);
        }
        try {
          spec = parseServerSpec(templateId + ":" + instanceName);
        } catch (err) {
          clack.log.error(err.message);
        }
      }
      raw.push({ absPath, serverId: spec.serverId, templateId: spec.templateId });
    }
  }

  return { raw, reconfigured };
}

async function runInstallFlow(parsed) {
  clack.intro("bi-agent-kit");

  const dir = process.cwd();
  const homedir = os.homedir();
  const platform = process.platform;
  const { dryRun, yes } = parsed;
  const nonInteractive = parsed.servers !== null;

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
  const externallyManagedKeys = new Set(externallyManaged.map((e) => e.absPath + "::" + e.serverId));
  if (externallyManaged.length > 0) {
    clack.log.warn(
      "Skipping " +
        externallyManaged.length +
        " entry(ies) already configured outside bi-agent-kit, they will be left as is. " +
        describeExternallyManagedGuidance()
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

  const canPromptForInstalls = !dryRun && !nonInteractive && !yes;
  if (canPromptForInstalls) {
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

  let newSelections;
  let pickerReconfigured = [];

  if (nonInteractive) {
    let raw;
    try {
      raw = buildNonInteractiveSelections({
        servers: parsed.servers,
        targets: parsed.targets,
        groups,
        templates,
      });
    } catch (err) {
      clack.log.error(err.message);
      process.exit(1);
    }
    newSelections = raw.filter((s) => !externallyManagedKeys.has(s.absPath + "::" + s.serverId));
  } else {
    const serverOptions = templates.map((template) => ({
      value: template.id,
      label: template.label + (template.description ? " -- " + template.description : ""),
    }));
    const previousServerIds = new Set(previousSelections.map((s) => s.serverId));
    const chosenServers = await clack.multiselect({
      message: "Select which BI servers to install",
      options: serverOptions,
      initialValues: templates.map((t) => t.id).filter((id) => previousServerIds.has(id)),
      required: false,
    });
    if (clack.isCancel(chosenServers)) {
      clack.cancel("Cancelled.");
      process.exit(1);
    }

    const previousAbsPaths = new Set(previousSelections.map((s) => s.absPath));
    const targetOptions = groups.map((group) => ({
      value: group.absPath,
      label: labelForTargetIds(group.targetIds) + " (" + group.absPath + ")",
    }));
    const chosenTargets = await clack.multiselect({
      message: "Select which detected config files to install into",
      options: targetOptions,
      initialValues: groups.map((g) => g.absPath).filter((absPath) => previousAbsPaths.has(absPath)),
      required: false,
    });
    if (clack.isCancel(chosenTargets)) {
      clack.cancel("Cancelled.");
      process.exit(1);
    }

    const { raw, reconfigured } = await resolveInteractiveSelections({
      chosenServers,
      chosenTargets,
      previousSelections,
      templates,
      dryRun,
    });
    pickerReconfigured = reconfigured;
    newSelections = raw.filter((s) => !externallyManagedKeys.has(s.absPath + "::" + s.serverId));
  }

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
    const template = templates.find((t) => t.id === templateIdFor(selection));
    const placeholders = template ? collectPlaceholders(template.config) : [];
    if (placeholders.length === 0) {
      selections.push(selection);
      if (template && template.id === "pac-cli") pacCliJustConfigured = true;
      continue;
    }

    if (nonInteractive) {
      clack.log.warn(
        template.label +
          " at " +
          selection.absPath +
          " still contains REPLACE_ placeholder values. Edit " +
          selection.absPath +
          " directly, or re-run interactively to fill them in."
      );
      selections.push(selection);
      if (template.id === "pac-cli") pacCliJustConfigured = true;
      continue;
    }

    clack.log.step("Setup needed for " + template.label + " at " + selection.absPath);
    const { answers, hasSecret } = await promptForPlaceholders(template);
    if (hasSecret) secretSelectionKeys.add(key);
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

  for (const item of pickerReconfigured) {
    if (item.status === "dry-run") {
      clack.log.info("reconfigure " + item.serverId + " at " + item.absPath + ": dry-run");
      continue;
    }
    const status = await reconfigureEntry({
      dir,
      homedir,
      platform,
      templates,
      absPath: item.absPath,
      serverId: item.serverId,
      configOverride: item.configOverride,
    });
    clack.log.info("reconfigure " + item.serverId + " at " + item.absPath + ": " + status.status);
  }

  if (!dryRun && !nonInteractive && !yes) {
    const pacAvailable = await isBinaryOnPath("pac");
    if (pacAvailable && pacCliJustConfigured) {
      await offerPacAuthWalkthrough();
    }
  }

  clack.outro(dryRun ? "Dry run complete, nothing was written." : "Done.");
}

async function runReconfigure(parsed) {
  clack.intro("bi-agent-kit reconfigure");

  const dir = process.cwd();
  const homedir = os.homedir();
  const platform = process.platform;

  const templates = await loadTemplates();
  const entries = await getInstalledEntries({ dir, templates });

  if (entries.length === 0) {
    clack.log.info("Nothing installed yet. Run npx bi-agent-kit init to get started.");
    clack.outro("Done.");
    return;
  }

  const chosen = await clack.select({
    message: "Which entry would you like to reconfigure?",
    options: entries.map((entry) => ({ value: entry, label: entry.label })),
  });
  if (clack.isCancel(chosen)) {
    clack.cancel("Cancelled.");
    process.exit(1);
  }

  const template = templates.find((t) => t.id === templateIdFor(chosen));
  if (!template) {
    clack.log.error("Could not find the template backing this entry (" + templateIdFor(chosen) + ").");
    process.exit(1);
  }

  if (parsed.dryRun) {
    clack.log.info(
      "Would reconfigure " +
        chosen.serverId +
        " at " +
        chosen.absPath +
        (chosen.hasPlaceholders ? " (prompts skipped in dry run)" : " (no placeholders to fill in)")
    );
    clack.outro("Dry run complete, nothing was written.");
    return;
  }

  if (!chosen.hasPlaceholders) {
    clack.log.info(template.label + " has no configurable placeholders -- reapplying its default configuration.");
  } else {
    clack.log.step("Reconfiguring " + template.label + " at " + chosen.absPath);
  }
  const { answers } = await promptForPlaceholders(template);
  const configOverride = applyPlaceholderValues(template.config, answers);

  const status = await reconfigureEntry({
    dir,
    homedir,
    platform,
    templates,
    absPath: chosen.absPath,
    serverId: chosen.serverId,
    configOverride,
  });

  clack.log.info("reconfigure " + chosen.serverId + " at " + chosen.absPath + ": " + status.status);
  clack.outro("Done.");
}

async function main(parsed) {
  if (parsed.help) {
    printHelp();
    process.exit(0);
  }
  if (parsed.version) {
    await printVersion();
    process.exit(0);
  }
  if (!VALID_COMMANDS.includes(parsed.command)) {
    console.error(
      "Unknown command: " + parsed.command + ". Valid commands: " + VALID_COMMANDS.join(", ")
    );
    process.exit(1);
  }

  if (parsed.command === "list") {
    await runList({ dir: process.cwd(), json: parsed.json });
    return;
  }

  if (parsed.command === "doctor") {
    await runDoctor({ dir: process.cwd(), homedir: os.homedir(), platform: process.platform, json: parsed.json });
    return;
  }

  if (parsed.command === "reconfigure") {
    await runReconfigure(parsed);
    return;
  }

  await runInstallFlow(parsed);
}

const parsedArgs = parseArgs(process.argv);
const isMainModule =
  process.argv[1] && fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);
if (isMainModule) {
  main(parsedArgs).catch((err) => {
    clack.log.error(err.message);
    process.exit(1);
  });
}
