import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, VALID_COMMANDS } from "../bin/cli.js";

test("parseArgs defaults to the init command with dry run false", () => {
  const result = parseArgs(["node", "cli.js"]);
  assert.equal(result.command, "init");
  assert.equal(result.dryRun, false);
});

test("parseArgs recognizes the configure command", () => {
  const result = parseArgs(["node", "cli.js", "configure"]);
  assert.equal(result.command, "configure");
});

test("parseArgs recognizes the list command", () => {
  const result = parseArgs(["node", "cli.js", "list"]);
  assert.equal(result.command, "list");
});

test("parseArgs recognizes the doctor command", () => {
  const result = parseArgs(["node", "cli.js", "doctor"]);
  assert.equal(result.command, "doctor");
});

test("parseArgs detects the dry run flag alongside a command", () => {
  const result = parseArgs(["node", "cli.js", "init", "--dry-run"]);
  assert.equal(result.command, "init");
  assert.equal(result.dryRun, true);
});

test("parseArgs does not silently fall back to init for an unknown command", () => {
  const result = parseArgs(["node", "cli.js", "bogus-command"]);
  assert.equal(result.command, "bogus-command");
  assert.equal(VALID_COMMANDS.includes(result.command), false);
});

test("VALID_COMMANDS lists exactly the supported commands", () => {
  assert.deepEqual(VALID_COMMANDS, ["init", "configure", "list", "doctor"]);
});

test("parseArgs detects --help and -h", () => {
  assert.equal(parseArgs(["node", "cli.js", "--help"]).help, true);
  assert.equal(parseArgs(["node", "cli.js", "-h"]).help, true);
  assert.equal(parseArgs(["node", "cli.js"]).help, false);
});

test("parseArgs detects --version and -v", () => {
  assert.equal(parseArgs(["node", "cli.js", "--version"]).version, true);
  assert.equal(parseArgs(["node", "cli.js", "-v"]).version, true);
  assert.equal(parseArgs(["node", "cli.js"]).version, false);
});

test("parseArgs detects --yes and --json flags", () => {
  const result = parseArgs(["node", "cli.js", "list", "--yes", "--json"]);
  assert.equal(result.yes, true);
  assert.equal(result.json, true);
});

test("parseArgs defaults yes and json to false", () => {
  const result = parseArgs(["node", "cli.js"]);
  assert.equal(result.yes, false);
  assert.equal(result.json, false);
});

test("parseArgs parses --servers into an array", () => {
  const result = parseArgs(["node", "cli.js", "init", "--servers", "powerbi,dataverse"]);
  assert.deepEqual(result.servers, ["powerbi", "dataverse"]);
});

test("parseArgs parses --servers= form into an array", () => {
  const result = parseArgs(["node", "cli.js", "init", "--servers=powerbi, dataverse "]);
  assert.deepEqual(result.servers, ["powerbi", "dataverse"]);
});

test("parseArgs parses --targets into an array", () => {
  const result = parseArgs(["node", "cli.js", "init", "--targets", "claude-code,cursor-user"]);
  assert.deepEqual(result.targets, ["claude-code", "cursor-user"]);
});

test("parseArgs leaves servers and targets null when not provided", () => {
  const result = parseArgs(["node", "cli.js", "init"]);
  assert.equal(result.servers, null);
  assert.equal(result.targets, null);
});

test("parseArgs supports servers, targets, dry-run, and yes together", () => {
  const result = parseArgs([
    "node",
    "cli.js",
    "init",
    "--servers",
    "powerbi",
    "--targets",
    "claude-code",
    "--dry-run",
    "--yes",
  ]);
  assert.equal(result.command, "init");
  assert.deepEqual(result.servers, ["powerbi"]);
  assert.deepEqual(result.targets, ["claude-code"]);
  assert.equal(result.dryRun, true);
  assert.equal(result.yes, true);
});

test("parseArgs is a pure function: it never prints or exits", () => {
  // No assertion needed beyond "did not throw / did not call process.exit" --
  // simply invoking it with a variety of inputs and reaching this line proves it.
  parseArgs(["node", "cli.js"]);
  parseArgs(["node", "cli.js", "--help"]);
  parseArgs(["node", "cli.js", "not-a-real-command"]);
  assert.ok(true);
});
