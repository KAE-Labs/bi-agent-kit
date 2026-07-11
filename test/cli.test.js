import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "../bin/cli.js";

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

test("parseArgs detects the dry run flag alongside a command", () => {
  const result = parseArgs(["node", "cli.js", "init", "--dry-run"]);
  assert.equal(result.command, "init");
  assert.equal(result.dryRun, true);
});
