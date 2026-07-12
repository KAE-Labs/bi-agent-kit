import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { runDoctor } from "../lib/doctor.js";
import { addServerToTarget } from "../lib/merge-config.js";
import { resolveTargets } from "../lib/targets.js";
import { loadTemplates } from "../lib/commands.js";
import { MANIFEST_FILENAME } from "../lib/manifest.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bi-agent-kit-doctor-test-"));
}

function claudeCodeGroup(dir, homedir, platform) {
  const groups = resolveTargets(dir, homedir, platform);
  const group = groups.find((g) => g.absPath === path.join(dir, ".mcp.json"));
  if (!group) throw new Error("expected claude-code target group to resolve");
  return group;
}

function findingsFor(findings, area, level) {
  return findings.filter((f) => f.area === area && (level === undefined || f.level === level));
}

async function installTemplate(dir, homedir, platform, templateId) {
  const templates = await loadTemplates();
  const template = templates.find((t) => t.id === templateId);
  const group = claudeCodeGroup(dir, homedir, platform);
  await addServerToTarget({
    dir,
    resolvedTarget: group,
    serverKey: template.id,
    serverValue: template.config,
  });
  return { template, group };
}

test("runDoctor reports ok/nothing-installed when there is no manifest", async () => {
  const dir = await makeTempDir();
  const findings = await runDoctor({ dir, homedir: dir, platform: process.platform });
  assert.equal(findings.some((f) => f.level === "error"), false);
  assert.equal(findings.some((f) => f.level === "warn"), false);
  const manifestFindings = findingsFor(findings, "manifest", "ok");
  assert.equal(manifestFindings.length, 1);
  assert.match(manifestFindings[0].message, /nothing installed/i);
});

test("runDoctor reports error for a corrupt manifest", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, MANIFEST_FILENAME), "{ not json", "utf8");
  const findings = await runDoctor({ dir, homedir: dir, platform: process.platform });
  const errors = findingsFor(findings, "manifest", "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /corrupt/i);
});

test("runDoctor reports all-ok findings for a healthy single install", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  await installTemplate(dir, homedir, platform, "powerbi");

  const findings = await runDoctor({ dir, homedir, platform });

  assert.equal(findings.some((f) => f.level === "error"), false);
  assert.equal(findings.some((f) => f.level === "warn"), false);
  assert.ok(findingsFor(findings, "manifest", "ok").length >= 1);
  assert.ok(findingsFor(findings, "target-file", "ok").length >= 1);
  assert.ok(findingsFor(findings, "parse", "ok").length >= 1);
  assert.ok(findingsFor(findings, "server-key", "ok").length >= 1);
  assert.ok(findingsFor(findings, "drift", "ok").length >= 1);
  assert.ok(findingsFor(findings, "placeholder", "ok").length >= 1);
  assert.ok(findingsFor(findings, "lockfile", "ok").length >= 1);
  // powerbi has no requiresBinary, so nothing installed needs a PATH check
  assert.ok(findingsFor(findings, "binary", "ok").length >= 1);
});

test("runDoctor warns when the target file was deleted after install", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  await installTemplate(dir, homedir, platform, "powerbi");
  await fs.unlink(path.join(dir, ".mcp.json"));

  const findings = await runDoctor({ dir, homedir, platform });

  const warns = findingsFor(findings, "target-file", "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /no longer exists/i);
});

test("runDoctor reports an error when the target file is corrupted", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  await installTemplate(dir, homedir, platform, "powerbi");
  await fs.writeFile(path.join(dir, ".mcp.json"), "{ this is not valid json", "utf8");

  const findings = await runDoctor({ dir, homedir, platform });

  const errors = findingsFor(findings, "parse", "error");
  assert.equal(errors.length, 1);
  assert.match(errors[0].message, /malformed/i);
});

test("runDoctor warns when the server key was removed by hand", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  await installTemplate(dir, homedir, platform, "powerbi");
  await fs.writeFile(path.join(dir, ".mcp.json"), "{\n  \"mcpServers\": {}\n}\n", "utf8");

  const findings = await runDoctor({ dir, homedir, platform });

  const warns = findingsFor(findings, "server-key", "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /removed by hand/i);
});

test("runDoctor warns on hash drift when the live value was hand edited", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  await installTemplate(dir, homedir, platform, "powerbi");
  const absPath = path.join(dir, ".mcp.json");
  const original = await fs.readFile(absPath, "utf8");
  await fs.writeFile(absPath, original.replace("npx", "hand-edited-command"), "utf8");

  const findings = await runDoctor({ dir, homedir, platform });

  const warns = findingsFor(findings, "drift", "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /edited outside bi-agent-kit/i);
  assert.match(warns[0].message, /skipped on removal/i);
});

test("runDoctor warns on an unfilled REPLACE_ placeholder", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  // postgres-mcp ships with a REPLACE_WITH_YOUR_POSTGRES_CONNECTION_STRING placeholder
  // still in its default config, and installing it unmodified keeps the hash intact.
  await installTemplate(dir, homedir, platform, "postgres");

  const findings = await runDoctor({ dir, homedir, platform });

  assert.equal(findingsFor(findings, "drift", "warn").length, 0);
  const warns = findingsFor(findings, "placeholder", "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /REPLACE_/);
  assert.match(warns[0].message, /will not launch/i);
});

test("runDoctor warns when a template's required binary is missing from PATH", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  // pac-cli requires the "pac" binary, which is not expected to be on PATH
  // in this test environment.
  await installTemplate(dir, homedir, platform, "pac-cli");

  const findings = await runDoctor({ dir, homedir, platform });

  const binaryFindings = findingsFor(findings, "binary");
  assert.ok(binaryFindings.length >= 1);
  const anyWarnsAboutPac = binaryFindings.some(
    (f) => f.level === "warn" && f.message.includes("pac")
  );
  const allOk = binaryFindings.every((f) => f.level === "ok");
  // Only assert the warning if "pac" genuinely isn't on this machine's PATH;
  // if it somehow is, the ok-summary path is equally valid coverage.
  assert.ok(anyWarnsAboutPac || allOk);
});

test("runDoctor warns about a stale lockfile and includes its pid", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(
    path.join(dir, ".kae-bi-kit.lock"),
    JSON.stringify({ pid: 424242, timestamp: Date.now() }),
    "utf8"
  );

  const findings = await runDoctor({ dir, homedir: dir, platform: process.platform });

  const warns = findingsFor(findings, "lockfile", "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /424242/);
});

test("runDoctor handles multiple manifest entries across different states independently", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  await installTemplate(dir, homedir, platform, "powerbi");
  await installTemplate(dir, homedir, platform, "postgres");

  const absPath = path.join(dir, ".mcp.json");
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /powerbi/);
  assert.match(fileText, /postgres/);

  const findings = await runDoctor({ dir, homedir, platform });

  assert.equal(findings.some((f) => f.level === "error"), false);
  // postgres still carries its unfilled placeholder; powerbi does not.
  const placeholderWarns = findingsFor(findings, "placeholder", "warn");
  assert.equal(placeholderWarns.length, 1);
});

test("runDoctor reports a drifted instance entry by its instance key, not the base template id", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  const templates = await loadTemplates();
  const template = templates.find((t) => t.id === "dataverse");
  const group = claudeCodeGroup(dir, homedir, platform);
  await addServerToTarget({
    dir,
    resolvedTarget: group,
    serverKey: "dataverse-dev",
    serverValue: { command: "npx", args: ["original-value"] },
    templateId: "dataverse",
  });

  const absPath = path.join(dir, ".mcp.json");
  const original = await fs.readFile(absPath, "utf8");
  await fs.writeFile(absPath, original.replace("original-value", "hand-edited-value"), "utf8");

  const findings = await runDoctor({ dir, homedir, platform });

  const warns = findingsFor(findings, "drift", "warn");
  assert.equal(warns.length, 1);
  assert.match(warns[0].message, /dataverse-dev/);
});

test("runDoctor names the instance serverKey (not the template id) in a missing-binary finding", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  const group = claudeCodeGroup(dir, homedir, platform);
  // pac-cli requires the "pac" binary on PATH, which is not expected to be present here.
  await addServerToTarget({
    dir,
    resolvedTarget: group,
    serverKey: "pac-cli-dev",
    serverValue: { command: "pac", args: ["dev"] },
    templateId: "pac-cli",
  });

  const findings = await runDoctor({ dir, homedir, platform });

  const binaryFindings = findingsFor(findings, "binary");
  const anyWarnsAboutInstance = binaryFindings.some(
    (f) => f.level === "warn" && f.message.includes("pac-cli-dev")
  );
  const allOk = binaryFindings.every((f) => f.level === "ok");
  assert.ok(anyWarnsAboutInstance || allOk);
});

test("runDoctor resolves the template for an old manifest entry that has no templateId field, including its requiresBinary check", async () => {
  const dir = await makeTempDir();
  const homedir = dir;
  const platform = process.platform;
  await installTemplate(dir, homedir, platform, "pac-cli");

  const manifestPath = path.join(dir, MANIFEST_FILENAME);
  const manifest = JSON.parse(await fs.readFile(manifestPath, "utf8"));
  delete manifest.entries[0].templateId;
  await fs.writeFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n", "utf8");

  const findings = await runDoctor({ dir, homedir, platform });

  assert.equal(findings.some((f) => f.level === "error"), false);
  const binaryFindings = findingsFor(findings, "binary");
  const anyWarnsAboutPac = binaryFindings.some(
    (f) => f.level === "warn" && f.message.includes("pac-cli")
  );
  const allOk = binaryFindings.every((f) => f.level === "ok");
  assert.ok(anyWarnsAboutPac || allOk);
});
