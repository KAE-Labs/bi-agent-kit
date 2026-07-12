import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { addServerToTarget, removeServerFromTarget, CollisionError } from "../lib/merge-config.js";
import { readManifest } from "../lib/manifest.js";
import { SymlinkRefusedError } from "../lib/atomic-fs.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bi-agent-kit-merge-test-"));
}

function jsonTarget(absPath, targetIds) {
  return { absPath, shape: "json", rootKey: "mcpServers", targetIds, labels: targetIds };
}

function tomlTarget(absPath, targetIds) {
  return { absPath, shape: "toml", rootKey: undefined, targetIds, labels: targetIds };
}

test("addServerToTarget writes a new entry and records it in the manifest", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  const result = await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx", args: ["-y", "pkg"] },
  });
  assert.equal(result.status, "written");
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /powerbi/);
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].serverKey, "powerbi");
});

test("addServerToTarget preserves unrelated existing entries in the same file", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(
    absPath,
    "{\n  \"mcpServers\": {\n    \"other\": { \"command\": \"unrelated\" }\n  }\n}\n",
    "utf8"
  );
  const target = jsonTarget(absPath, ["claude-code"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /other/);
  assert.match(fileText, /unrelated/);
  assert.match(fileText, /powerbi/);
});

test("addServerToTarget backs up the file on first touch only", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(absPath, "{\n  \"mcpServers\": {}\n}\n", "utf8");
  const target = jsonTarget(absPath, ["claude-code"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  const backup = await fs.readFile(
    path.join(dir, ".bi-agent-kit-backups", ".mcp.json"),
    "utf8"
  );
  assert.match(backup, /"mcpServers": \{\}/);
});

test("addServerToTarget throws CollisionError on an existing unowned key", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  await fs.writeFile(
    absPath,
    "{\n  \"mcpServers\": {\n    \"powerbi\": { \"command\": \"hand configured\" }\n  }\n}\n",
    "utf8"
  );
  const target = jsonTarget(absPath, ["claude-code"]);
  await assert.rejects(
    () =>
      addServerToTarget({
        dir,
        resolvedTarget: target,
        serverKey: "powerbi",
        serverValue: { command: "npx" },
      }),
    CollisionError
  );
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /hand configured/);
});

test("addServerToTarget allows overwriting a key it already owns", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "first" },
  });
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "second" },
  });
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /second/);
  assert.doesNotMatch(fileText, /first/);
});

test("removeServerFromTarget removes an entry it owns and updates the manifest", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  const result = await removeServerFromTarget({ dir, resolvedTarget: target, serverKey: "powerbi" });
  assert.equal(result.status, "removed");
  const fileText = await fs.readFile(absPath, "utf8");
  assert.doesNotMatch(fileText, /powerbi/);
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries.length, 0);
});

test("removeServerFromTarget skips removal when the entry was hand edited since install", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  const beforeEdit = await fs.readFile(absPath, "utf8");
  const edited = beforeEdit.replace("npx", "hand-edited-command");
  await fs.writeFile(absPath, edited, "utf8");
  const result = await removeServerFromTarget({ dir, resolvedTarget: target, serverKey: "powerbi" });
  assert.equal(result.status, "skipped-drift");
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /hand-edited-command/);
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries.length, 1);
});

test("removeServerFromTarget returns not installed for a key it never wrote", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  const result = await removeServerFromTarget({ dir, resolvedTarget: target, serverKey: "powerbi" });
  assert.equal(result.status, "not-installed");
});

test("addServerToTarget works for the toml shape and preserves unrelated content", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, "config.toml");
  await fs.writeFile(absPath, "# keep this comment\nprofile = \"default\"\n", "utf8");
  const target = tomlTarget(absPath, ["codex-project"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /# keep this comment/);
  assert.match(fileText, /profile = "default"/);
  assert.match(fileText, /mcp_servers.powerbi/);
});

test("addServerToTarget refuses a target whose parent directory is a symlink into the host filesystem", async (t) => {
  const dir = await makeTempDir();
  const outsideDir = path.join(dir, "outside-project");
  await fs.mkdir(outsideDir, { recursive: true });
  await fs.writeFile(path.join(outsideDir, "hosts"), "sensitive host content", "utf8");

  const projectDir = path.join(dir, "project");
  const linkedDir = path.join(projectDir, ".cursor");
  await fs.mkdir(projectDir, { recursive: true });

  try {
    await fs.symlink(outsideDir, linkedDir, "junction");
  } catch {
    t.skip("symlink/junction creation not permitted in this environment");
    return;
  }

  const absPath = path.join(linkedDir, "hosts");
  const target = jsonTarget(absPath, ["some-target"]);

  await assert.rejects(
    () =>
      addServerToTarget({
        dir: projectDir,
        resolvedTarget: target,
        serverKey: "powerbi",
        serverValue: { command: "npx" },
      }),
    SymlinkRefusedError
  );

  const outsideContent = await fs.readFile(path.join(outsideDir, "hosts"), "utf8");
  assert.equal(outsideContent, "sensitive host content");
});

test("addServerToTarget is unaffected by symlink protection for normal, non-symlinked operation", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, "nested", ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  const result = await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  assert.equal(result.status, "written");
});

test("a run that fails partway through leaves the manifest matching exactly what was written", async () => {
  const dir = await makeTempDir();
  const targetA = jsonTarget(path.join(dir, "a.json"), ["target-a"]);
  const badTarget = jsonTarget(
    path.join(dir, "bad" + String.fromCharCode(0) + "dir", "b.json"),
    ["target-b"]
  );
  await addServerToTarget({
    dir,
    resolvedTarget: targetA,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  let threw = false;
  try {
    await addServerToTarget({
      dir,
      resolvedTarget: badTarget,
      serverKey: "dataverse",
      serverValue: { command: "npx" },
    });
  } catch {
    threw = true;
  }
  assert.equal(threw, true);
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].serverKey, "powerbi");
});

test("addServerToTarget records the given templateId in the manifest, distinct from serverKey", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  const result = await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "dataverse-dev",
    serverValue: { command: "npx" },
    templateId: "dataverse",
  });
  assert.equal(result.status, "written");
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries[0].serverKey, "dataverse-dev");
  assert.equal(manifest.entries[0].templateId, "dataverse");
});

test("addServerToTarget defaults templateId to serverKey when omitted", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "powerbi",
    serverValue: { command: "npx" },
  });
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries[0].templateId, "powerbi");
});

test("two instances of the same template installed into the same target file both persist independently, and removing one leaves the other intact", async () => {
  const dir = await makeTempDir();
  const absPath = path.join(dir, ".mcp.json");
  const target = jsonTarget(absPath, ["claude-code"]);
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "dataverse-dev",
    serverValue: { command: "npx", args: ["dev"] },
    templateId: "dataverse",
  });
  await addServerToTarget({
    dir,
    resolvedTarget: target,
    serverKey: "dataverse-prod",
    serverValue: { command: "npx", args: ["prod"] },
    templateId: "dataverse",
  });

  const fileText = await fs.readFile(absPath, "utf8");
  assert.match(fileText, /dataverse-dev/);
  assert.match(fileText, /dataverse-prod/);

  const manifestBefore = await readManifest(dir);
  assert.equal(manifestBefore.entries.length, 2);

  const removeResult = await removeServerFromTarget({ dir, resolvedTarget: target, serverKey: "dataverse-dev" });
  assert.equal(removeResult.status, "removed");

  const fileTextAfter = await fs.readFile(absPath, "utf8");
  assert.doesNotMatch(fileTextAfter, /dataverse-dev/);
  assert.match(fileTextAfter, /dataverse-prod/);

  const manifestAfter = await readManifest(dir);
  assert.equal(manifestAfter.entries.length, 1);
  assert.equal(manifestAfter.entries[0].serverKey, "dataverse-prod");
  assert.equal(manifestAfter.entries[0].templateId, "dataverse");
});
