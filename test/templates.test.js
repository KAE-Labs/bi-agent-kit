import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(here, "..", "templates");
const FILES = [
  "powerbi-mcp.json",
  "dataverse-mcp.json",
  "pac-cli-mcp.json",
  "fabric-mcp.json",
  "azure-mcp.json",
  "dbt-mcp.json",
  "sqlserver-mcp.json",
  "snowflake-mcp.json",
  "postgres-mcp.json",
];
const EXPECTED_IDS = ["powerbi", "dataverse", "pac-cli", "fabric", "azure", "dbt", "sqlserver", "snowflake", "postgres"];

async function loadTemplate(filename) {
  const text = await fs.readFile(path.join(templatesDir, filename), "utf8");
  return JSON.parse(text);
}

test("all nine template files parse as valid json with the required fields", async () => {
  for (const file of FILES) {
    const template = await loadTemplate(file);
    assert.equal(typeof template.id, "string");
    assert.equal(typeof template.label, "string");
    assert.equal(typeof template.description, "string");
    assert.equal(typeof template.config, "object");
    const isLocalLaunch = typeof template.config.command === "string";
    const isRemote = typeof template.config.url === "string";
    assert.ok(isLocalLaunch || isRemote, file + " config must have either command or url");
    if (isLocalLaunch) {
      assert.ok(Array.isArray(template.config.args));
      assert.equal(typeof template.config.env, "object");
    }
    if (isRemote) {
      assert.equal(typeof template.config.headers, "object");
    }
  }
});

test("template ids match the expected nine servers with no duplicates", async () => {
  const ids = [];
  for (const file of FILES) {
    const template = await loadTemplate(file);
    ids.push(template.id);
  }
  assert.deepEqual(ids.sort(), [...EXPECTED_IDS].sort());
});

test("no template embeds a literal secret in its env or headers block", async () => {
  for (const file of FILES) {
    const template = await loadTemplate(file);
    const values = Object.values(template.config.env || {}).concat(
      Object.values(template.config.headers || {})
    );
    for (const value of values) {
      assert.match(String(value), /REPLACE_|^\$\{/);
    }
  }
});
