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
  parseServerSpec,
  getInstalledEntries,
  reconfigureEntry,
  getCurrentSelections,
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

test("findExternallyManagedEntries detects a hand-added named-instance key", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(
    absPath,
    "{\n  \"mcpServers\": {\n    \"dataverse-dev\": { \"command\": \"hand configured\" }\n  }\n}\n",
    "utf8"
  );
  const templates = await loadTemplates();
  const groups = await getDetectedTargetGroups({ dir, homedir: dir, platform: "linux" });
  const result = await findExternallyManagedEntries({ dir, groups, templates });
  assert.ok(
    result.some(
      (r) => r.absPath === absPath && r.serverId === "dataverse-dev" && r.templateId === "dataverse"
    )
  );
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
  const argsEntry = found.find((f) => f.path.join(".") === "args.2");
  assert.equal(argsEntry.value, "REPLACE_WITH_YOUR_ORG_URL");
  assert.equal(argsEntry.token, "REPLACE_WITH_YOUR_ORG_URL");
  const envEntry = found.find((f) => f.path.join(".") === "env.TOKEN");
  assert.equal(envEntry.value, "REPLACE_WITH_YOUR_TOKEN");
  assert.equal(envEntry.token, "REPLACE_WITH_YOUR_TOKEN");
});

test("collectPlaceholders returns an empty array when no placeholders exist", () => {
  const config = { command: "npx", args: ["-y", "pkg"], env: {} };
  assert.deepEqual(collectPlaceholders(config), []);
});

test("collectPlaceholders returns one entry per token when a single string holds multiple REPLACE_ markers", () => {
  const config = {
    url: "https://REPLACE_WITH_YOUR_ACCOUNT_IDENTIFIER.snowflakecomputing.com/api/v2/databases/REPLACE_WITH_YOUR_DATABASE/schemas/REPLACE_WITH_YOUR_SCHEMA/mcp-servers/REPLACE_WITH_YOUR_MCP_SERVER_NAME",
  };
  const found = collectPlaceholders(config);
  assert.equal(found.length, 4);
  assert.deepEqual(
    found.map((f) => f.token),
    [
      "REPLACE_WITH_YOUR_ACCOUNT_IDENTIFIER",
      "REPLACE_WITH_YOUR_DATABASE",
      "REPLACE_WITH_YOUR_SCHEMA",
      "REPLACE_WITH_YOUR_MCP_SERVER_NAME",
    ]
  );
  assert.ok(found.every((f) => f.value === config.url));
  assert.ok(found.every((f) => f.path.join(".") === "url"));
});

test("applyPlaceholderValues substitutes only the given paths and leaves the rest untouched", () => {
  const config = {
    command: "npx",
    args: ["-y", "pkg", "REPLACE_WITH_YOUR_ORG_URL"],
    env: { TOKEN: "REPLACE_WITH_YOUR_TOKEN" },
  };
  const result = applyPlaceholderValues(config, [
    { path: ["args", 2], token: "REPLACE_WITH_YOUR_ORG_URL", value: "https://example.crm.dynamics.com" },
    { path: ["env", "TOKEN"], token: "REPLACE_WITH_YOUR_TOKEN", value: "abc123" },
  ]);
  assert.deepEqual(result, {
    command: "npx",
    args: ["-y", "pkg", "https://example.crm.dynamics.com"],
    env: { TOKEN: "abc123" },
  });
  assert.equal(config.args[2], "REPLACE_WITH_YOUR_ORG_URL");
});

test("applyPlaceholderValues splices all four tokens of the real snowflake template URL, preserving surrounding structure", async () => {
  const templates = await loadTemplates();
  const snowflake = templates.find((t) => t.id === "snowflake");
  const placeholders = collectPlaceholders(snowflake.config);
  const urlPlaceholders = placeholders.filter((p) => p.path.join(".") === "url");
  assert.equal(urlPlaceholders.length, 4);

  const answerValues = {
    REPLACE_WITH_YOUR_ACCOUNT_IDENTIFIER: "acme-prod",
    REPLACE_WITH_YOUR_DATABASE: "analytics_db",
    REPLACE_WITH_YOUR_SCHEMA: "public",
    REPLACE_WITH_YOUR_MCP_SERVER_NAME: "my_mcp_server",
  };
  const answers = placeholders.map((p) => ({
    path: p.path,
    token: p.token,
    value: answerValues[p.token] ?? p.token,
  }));

  const result = applyPlaceholderValues(snowflake.config, answers);
  assert.equal(
    result.url,
    "https://acme-prod.snowflakecomputing.com/api/v2/databases/analytics_db/schemas/public/mcp-servers/my_mcp_server"
  );
  assert.doesNotMatch(result.url, /REPLACE_/);
  const bearerPlaceholder = placeholders.find((p) => p.path.join(".") === "headers.Authorization");
  const bearerAnswer = { path: bearerPlaceholder.path, token: bearerPlaceholder.token, value: "secret-pat-token" };
  const withBearer = applyPlaceholderValues(result, [bearerAnswer]);
  assert.equal(withBearer.headers.Authorization, "Bearer secret-pat-token");
});

test("applyPlaceholderValues replaces a prefix token and preserves the literal suffix in the sqlserver template", async () => {
  const templates = await loadTemplates();
  const sqlserver = templates.find((t) => t.id === "sqlserver");
  const placeholders = collectPlaceholders(sqlserver.config);
  const pathArgPlaceholder = placeholders.find((p) => p.token === "REPLACE_WITH_ABSOLUTE_PATH");
  assert.ok(pathArgPlaceholder);
  assert.equal(pathArgPlaceholder.value, "REPLACE_WITH_ABSOLUTE_PATH/dab-config.json");

  const result = applyPlaceholderValues(sqlserver.config, [
    { path: pathArgPlaceholder.path, token: pathArgPlaceholder.token, value: "/home/user/project" },
  ]);
  const updatedArg = getAtPathForTest(result, pathArgPlaceholder.path);
  assert.equal(updatedArg, "/home/user/project/dab-config.json");
});

function getAtPathForTest(target, pathSegments) {
  let cursor = target;
  for (const segment of pathSegments) {
    cursor = cursor[segment];
  }
  return cursor;
}

test("describePlaceholder produces a human readable prompt from a REPLACE_WITH_ style token", () => {
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

test("parseServerSpec returns templateId only shape for a spec with no instance", () => {
  const result = parseServerSpec("dataverse");
  assert.deepEqual(result, { templateId: "dataverse", instanceName: null, serverId: "dataverse" });
});

test("parseServerSpec parses an instanced spec into templateId, instanceName, and a combined serverId", () => {
  const result = parseServerSpec("dataverse:dev");
  assert.deepEqual(result, { templateId: "dataverse", instanceName: "dev", serverId: "dataverse-dev" });
});

test("parseServerSpec accepts instance names with digits and hyphens, case insensitively", () => {
  const result = parseServerSpec("dataverse:Prod-02");
  assert.deepEqual(result, { templateId: "dataverse", instanceName: "Prod-02", serverId: "dataverse-Prod-02" });
});

test("parseServerSpec throws a plain Error naming the rule for an invalid instance name", () => {
  assert.throws(() => parseServerSpec("dataverse:not_valid!"), (err) => {
    assert.ok(err instanceof Error);
    assert.match(err.message, /\^\[a-z0-9-\]\+\$/i);
    return true;
  });
});

test("applySelections installs two instances of the same template into the same target file, both present and independently removable", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();

  const devOverride = { command: "npx", args: ["-y", "@microsoft/dataverse", "mcp", "https://dev.crm.dynamics.com"], env: {} };
  const prodOverride = { command: "npx", args: ["-y", "@microsoft/dataverse", "mcp", "https://prod.crm.dynamics.com"], env: {} };

  const installReport = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [
      { absPath, serverId: "dataverse-dev", templateId: "dataverse", configOverride: devOverride },
      { absPath, serverId: "dataverse-prod", templateId: "dataverse", configOverride: prodOverride },
    ],
    dryRun: false,
  });
  assert.equal(installReport.find((r) => r.serverId === "dataverse-dev").status, "written");
  assert.equal(installReport.find((r) => r.serverId === "dataverse-prod").status, "written");

  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /dataverse-dev/);
  assert.match(fileText, /dataverse-prod/);
  assert.match(fileText, /dev\.crm\.dynamics\.com/);
  assert.match(fileText, /prod\.crm\.dynamics\.com/);

  const installed = await listInstalled({ dir });
  assert.equal(installed.length, 2);
  assert.ok(installed.every((e) => e.templateId === "dataverse"));

  const removeDevReport = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "dataverse-prod", templateId: "dataverse" }],
    dryRun: false,
  });
  assert.equal(removeDevReport.find((r) => r.serverId === "dataverse-dev").status, "removed");

  const afterRemoveText = await fs.readFile(absPath, "utf8");
  assert.doesNotMatch(afterRemoveText, /dataverse-dev/);
  assert.match(afterRemoveText, /dataverse-prod/);
  assert.match(afterRemoveText, /prod\.crm\.dynamics\.com/);

  const remainingInstalled = await listInstalled({ dir });
  assert.equal(remainingInstalled.length, 1);
  assert.equal(remainingInstalled[0].serverId, "dataverse-prod");
  assert.equal(remainingInstalled[0].templateId, "dataverse");
});

test("getInstalledEntries returns label, templateId, and hasPlaceholders for each installed entry", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "postgres", templateId: "postgres" }],
    dryRun: false,
  });
  const entries = await getInstalledEntries({ dir, templates });
  assert.equal(entries.length, 1);
  assert.equal(entries[0].serverId, "postgres");
  assert.equal(entries[0].templateId, "postgres");
  assert.equal(entries[0].hasPlaceholders, true);
  assert.match(entries[0].label, /Postgres/i);
  assert.match(entries[0].label, new RegExp(absPath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
});

test("getInstalledEntries reports hasPlaceholders false for a template with no REPLACE_ tokens", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi", templateId: "powerbi" }],
    dryRun: false,
  });
  const entries = await getInstalledEntries({ dir, templates });
  assert.equal(entries[0].hasPlaceholders, false);
});

test("getInstalledEntries includes an instance suffix in the label for instanced entries", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "dataverse-dev", templateId: "dataverse" }],
    dryRun: false,
  });
  const entries = await getInstalledEntries({ dir, templates });
  assert.equal(entries.length, 1);
  assert.match(entries[0].label, /dev/);
});

test("reconfigureEntry updates an installed entry value in place and refreshes the content hash so removal succeeds cleanly", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi", templateId: "powerbi" }],
    dryRun: false,
  });

  const newValue = { command: "npx", args: ["-y", "reconfigured-value"] };
  const result = await reconfigureEntry({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    absPath,
    serverId: "powerbi",
    configOverride: newValue,
  });
  assert.equal(result.status, "written");

  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /reconfigured-value/);

  const removeReport = await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [],
    dryRun: false,
  });
  assert.equal(removeReport[0].status, "removed");
});

test("reconfigureEntry errors sanely for an entry that was never installed", async () => {
  const dir = await makeTempDir();
  const templates = await loadTemplates();
  await assert.rejects(
    () =>
      reconfigureEntry({
        dir,
        homedir: dir,
        platform: "linux",
        templates,
        absPath: path.join(dir, ".mcp.json"),
        serverId: "powerbi",
        configOverride: { command: "npx" },
      }),
    /No installed entry found/
  );
});

test("an old manifest entry without a templateId field still resolves its template by serverKey (backward compatibility)", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{}", "utf8");
  const templates = await loadTemplates();
  await applySelections({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    selections: [{ absPath, serverId: "powerbi", templateId: "powerbi" }],
    dryRun: false,
  });

  const manifestPath = path.join(dir, ".kae-bi-kit.json");
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.entries[0].templateId;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const selections = await getCurrentSelections({ dir });
  assert.equal(selections[0].templateId, "powerbi");

  const entries = await getInstalledEntries({ dir, templates });
  assert.equal(entries[0].templateId, "powerbi");
  assert.match(entries[0].label, /Power BI/i);

  const reconfigured = await reconfigureEntry({
    dir,
    homedir: dir,
    platform: "linux",
    templates,
    absPath,
    serverId: "powerbi",
    configOverride: { command: "npx", args: ["-y", "still-works"] },
  });
  assert.equal(reconfigured.status, "written");
});
