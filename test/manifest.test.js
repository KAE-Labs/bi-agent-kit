import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import {
  readManifest,
  writeManifestEntry,
  removeManifestEntry,
  ManifestCorruptError,
  MANIFEST_FILENAME,
} from "../lib/manifest.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bi-agent-kit-manifest-test-"));
}

test("readManifest returns null when no manifest file exists", async () => {
  const dir = await makeTempDir();
  const result = await readManifest(dir);
  assert.equal(result, null);
});

test("writeManifestEntry creates a manifest on first write", async () => {
  const dir = await makeTempDir();
  const manifest = await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "powerbi",
    targetIds: ["claude-code"],
    contentHash: "abc123",
    installedAt: 1000,
  });
  assert.equal(manifest.entries.length, 1);
  const reread = await readManifest(dir);
  assert.equal(reread.entries.length, 1);
  assert.equal(reread.entries[0].serverKey, "powerbi");
});

test("writeManifestEntry updates an existing entry for the same absPath and serverKey", async () => {
  const dir = await makeTempDir();
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "powerbi",
    targetIds: ["claude-code"],
    contentHash: "first",
    installedAt: 1000,
  });
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "powerbi",
    targetIds: ["claude-code"],
    contentHash: "second",
    installedAt: 2000,
  });
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].contentHash, "second");
});

test("removeManifestEntry removes only the matching entry", async () => {
  const dir = await makeTempDir();
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "powerbi",
    targetIds: ["claude-code"],
    contentHash: "a",
    installedAt: 1000,
  });
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "dataverse",
    targetIds: ["claude-code"],
    contentHash: "b",
    installedAt: 1000,
  });
  await removeManifestEntry(dir, "/proj/.mcp.json", "powerbi");
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries.length, 1);
  assert.equal(manifest.entries[0].serverKey, "dataverse");
});

test("removeManifestEntry returns null when no manifest exists yet", async () => {
  const dir = await makeTempDir();
  const result = await removeManifestEntry(dir, "/proj/.mcp.json", "powerbi");
  assert.equal(result, null);
});

test("each write keeps a rolling backup of the previous generation", async () => {
  const dir = await makeTempDir();
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "powerbi",
    targetIds: ["claude-code"],
    contentHash: "first",
    installedAt: 1000,
  });
  const afterFirstWrite = await fs.readFile(path.join(dir, MANIFEST_FILENAME), "utf8");
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "dataverse",
    targetIds: ["claude-code"],
    contentHash: "second",
    installedAt: 2000,
  });
  const backup = await fs.readFile(path.join(dir, MANIFEST_FILENAME + ".bak"), "utf8");
  assert.equal(backup, afterFirstWrite);
});

test("readManifest throws ManifestCorruptError on invalid json", async () => {
  const dir = await makeTempDir();
  await fs.writeFile(path.join(dir, MANIFEST_FILENAME), "not json", "utf8");
  await assert.rejects(() => readManifest(dir), ManifestCorruptError);
});

test("writeManifestEntry stores a templateId field alongside serverKey", async () => {
  const dir = await makeTempDir();
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "dataverse-dev",
    templateId: "dataverse",
    targetIds: ["claude-code"],
    contentHash: "abc123",
    installedAt: 1000,
  });
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries[0].templateId, "dataverse");
  assert.equal(manifest.entries[0].serverKey, "dataverse-dev");
});

test("readManifest returns entries without a templateId field unchanged, for callers to apply their own fallback", async () => {
  const dir = await makeTempDir();
  await writeManifestEntry(dir, {
    absPath: "/proj/.mcp.json",
    serverKey: "powerbi",
    targetIds: ["claude-code"],
    contentHash: "abc123",
    installedAt: 1000,
  });
  const manifest = await readManifest(dir);
  assert.equal(manifest.entries[0].templateId, undefined);
  assert.equal(manifest.entries[0].serverKey, "powerbi");
});
