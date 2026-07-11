import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  loadTemplates,
  getDetectedTargetGroups,
  findExternallyManagedEntries,
  computeDiff,
  collectPlaceholders,
  applyPlaceholderValues,
  describePlaceholder,
  applySelections,
  listInstalled,
} from "../lib/commands.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bi-agent-kit-commands-test-"));
}

test("loadTemplates returns the nine expected server templates", async () => {
  const templates = await loadTemplates();
  const ids = templates.map((t) => t.id).sort();
  assert.deepEqual(ids, ["azure", "dataverse", "dbt", "fabric", "pac-cli", "postgres", "powerbi", "snowflake", "sqlserver"]);
});

test("getDetectedTargetGroups only returns groups whose file or directory exists", async () => {
  const dir = await makeTempDir();
  const groups = await getDetectedTargetGroups({ dir, homedir: dir, platform: "linux" });
  assert.deepEqual(groups, []);
  await fs.writeFile(path.join(dir, ".mcp.json"), "{}", "utf8");
  const afterCreate = await getDetectedTargetGroups({ dir, homedir: dir, platform: "linux" });
  assert.ok(afterCreate.some((g) => g.targetIds.includes("claude-code")));
});

test("computeDiff separates additions from removals", () => {
  const previousSelections = [{ absPath: "/a.json", serverId: "powerbi" }];
  const newSelections = [{ absPath: "/a.json", serverId: "dataverse" }];
  const { toAdd, toRemove } = computeDiff({ previousSelections, newSelections });
  assert.deepEqual(toAdd, [{ absPath: "/a.json", serverId: "dataverse" }]);
  assert.deepEqual(toRemove, [{ absPath: "/a.json", serverId: "powerbi" }]);
});

test("applySelections in dry run mode makes no file changes", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, ".mcp.json"), "{}", "utf8");
  const templates = await loadTemplates();
  const absPath = path.join(dir, ".mcp.json");
  const report = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi" }],
    dryRun: true,
  });
  assert.equal(report[0].status, "dry-run");
  const fileText = await fs.readFile(absPath, "utf8");
  assert.equal(fileText, "{}");
});

test("applySelections installs a newly selected server", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  const report = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi" }],
    dryRun: false,
  });
  assert.equal(report[0].status, "written");
  const installed = await listInstalled({ dir });
  assert.equal(installed.length, 1);
  assert.equal(installed[0].serverId, "powerbi");
});

test("applySelections removes a previously installed server that is no longer selected", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi" }],
    dryRun: false,
  });
  const report = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [],
    dryRun: false,
  });
  assert.equal(report[0].status, "removed");
  const installed = await listInstalled({ dir });
  assert.equal(installed.length, 0);
});

test("applySelections reports a collision but still processes the remaining selections", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(
    absPath,
    "{\n  \"mcpServers\": {\n    \"powerbi\": { \"command\": \"hand configured\" }\n  }\n}\n",
    "utf8"
  );
  const templates = await loadTemplates();
  const report = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [
      { absPath, serverId: "powerbi" },
      { absPath, serverId: "dataverse" },
    ],
    dryRun: false,
  });
  const powerbiResult = report.find((r) => r.serverId === "powerbi");
  const dataverseResult = report.find((r) => r.serverId === "dataverse");
  assert.equal(powerbiResult.status, "collision");
  assert.equal(dataverseResult.status, "written");
});

test("applySelections reports an error for a malformed target file but still processes the other targets", async () => {
  const dir = await makeTempDir();
  const malformedPath = path.join(dir, ".cursor", "mcp.json");
  const goodPath = path.join(dir, ".gemini", "settings.json");
  await fs.mkdir(path.dirname(malformedPath), { recursive: true });
  await fs.mkdir(path.dirname(goodPath), { recursive: true });
  await fs.writeFile(malformedPath, "not valid json", "utf8");
  await fs.writeFile(goodPath, "{}", "utf8");
  const templates = await loadTemplates();
  const report = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [
      { absPath: malformedPath, serverId: "powerbi" },
      { absPath: goodPath, serverId: "dataverse" },
    ],
    dryRun: false,
  });
  const malformedResult = report.find((r) => r.absPath === malformedPath);
  const goodResult = report.find((r) => r.absPath === goodPath);
  assert.equal(malformedResult.status, "error");
  assert.equal(goodResult.status, "written");
  const untouchedContent = await fs.readFile(malformedPath, "utf8");
  assert.equal(untouchedContent, "not valid json");
});

test("listInstalled returns an empty array when no manifest exists", async () => {
  const dir = await makeTempDir();
  const installed = await listInstalled({ dir });
  assert.deepEqual(installed, []);
});

test("findExternallyManagedEntries detects a key already present that bi-agent-kit does not own", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(
    absPath,
    "{\n  \"mcpServers\": {\n    \"powerbi\": { \"command\": \"hand configured\" }\n  }\n}\n",
    "utf8"
  );
  const templates = await loadTemplates();
  const groups = await getDetectedTargetGroups({ dir, homedir: dir, platform: "linux" });
  const result = await findExternallyManagedEntries({ dir, groups, templates });
  assert.ok(result.some((r) => r.absPath === absPath && r.serverId === "powerbi"));
});

test("findExternallyManagedEntries does not flag a key bi-agent-kit already owns", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi" }],
    dryRun: false,
  });
  const groups = await getDetectedTargetGroups({ dir, homedir: dir, platform: "linux" });
  const result = await findExternallyManagedEntries({ dir, groups, templates });
  assert.equal(result.some((r) => r.absPath === absPath && r.serverId === "powerbi"), false);
});

test("applySelections never overwrites an externally managed entry even if selected", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(
    absPath,
    "{\n  \"mcpServers\": {\n    \"powerbi\": { \"command\": \"hand configured\" }\n  }\n}\n",
    "utf8"
  );
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi" }],
    dryRun: false,
  });
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /hand configured/);
});

test("collectPlaceholders finds every REPLACE_ marked string anywhere in a nested config", () => {
  const config = {
    command: "npx",
    args: ["-y", "pkg", "REPLACE_WITH_YOUR_ORG_URL"],
    env: { TOKEN: "REPLACE_WITH_YOUR_TOKEN" },
  };
  const found = collectPlaceholders(config);
  assert.equal(found.length, 2);
  assert.deepEqual(
    found.map((f) => f.path).sort(),
    [["args", 2], ["env", "TOKEN"]].sort()
  );
});

test("collectPlaceholders returns an empty array when no placeholders exist", () => {
  const config = { command: "npx", args: ["-y", "pkg"], env: {} };
  assert.deepEqual(collectPlaceholders(config), []);
});

test("applyPlaceholderValues substitutes only the given paths and leaves the rest untouched", () => {
  const config = {
    command: "npx",
    args: ["-y", "pkg", "REPLACE_WITH_YOUR_ORG_URL"],
    env: { TOKEN: "REPLACE_WITH_YOUR_TOKEN" },
  };
  const result = applyPlaceholderValues(config, [
    { path: ["args", 2], value: "https://example.crm.dynamics.com" },
    { path: ["env", "TOKEN"], value: "abc123" },
  ]);
  assert.deepEqual(result, {
    command: "npx",
    args: ["-y", "pkg", "https://example.crm.dynamics.com"],
    env: { TOKEN: "abc123" },
  });
  assert.equal(config.args[2], "REPLACE_WITH_YOUR_ORG_URL");
});

test("describePlaceholder produces a human readable prompt from a REPLACE_WITH_ style marker", () => {
  const message = describePlaceholder(["args", 2], "REPLACE_WITH_YOUR_ORG_URL");
  assert.match(message, /your org url/);
  assert.match(message, /args\.2/);
});

test("applySelections applies a configOverride instead of the raw template when provided", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [
      {
        absPath,
        serverId: "dataverse",
        configOverride: { command: "npx", args: ["-y", "@microsoft/dataverse", "mcp", "https://filled-in.example.com"], env: {} },
      },
    ],
    dryRun: false,
  });
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /filled-in\.example\.com/);
  assert.doesNotMatch(fileText, /REPLACE_WITH_YOUR_ORG_URL/);
});
