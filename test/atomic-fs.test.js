import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { atomicWriteFile, backupIfMissing, readFileIfExists } from "../lib/atomic-fs.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bi-agent-kit-test-"));
}

test("readFileIfExists returns null for a missing file", async () => {
  const dir = await makeTempDir();
  const result = await readFileIfExists(path.join(dir, "missing.json"));
  assert.equal(result, null);
});

test("atomicWriteFile writes new content and readFileIfExists reads it back", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "config.json");
  await atomicWriteFile(target, "{\"a\":1}");
  const result = await readFileIfExists(target);
  assert.equal(result, "{\"a\":1}");
});

test("atomicWriteFile creates parent directories as needed", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "nested", "deep", "config.json");
  await atomicWriteFile(target, "hello");
  const result = await readFileIfExists(target);
  assert.equal(result, "hello");
});

test("atomicWriteFile leaves no temp file behind after a successful write", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "config.json");
  await atomicWriteFile(target, "content");
  const entries = await fs.readdir(dir);
  assert.deepEqual(entries, ["config.json"]);
});

test("backupIfMissing copies the original file into a dedicated backups directory on first touch", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "config.json");
  await atomicWriteFile(target, "original content");
  const didBackup = await backupIfMissing(target);
  assert.equal(didBackup, true);
  const backup = await readFileIfExists(path.join(dir, ".bi-agent-kit-backups", "config.json"));
  assert.equal(backup, "original content");
});

test("backupIfMissing writes a self-gitignore into the backups directory the first time it is created", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "config.json");
  await atomicWriteFile(target, "original content");
  await backupIfMissing(target);
  const gitignore = await readFileIfExists(path.join(dir, ".bi-agent-kit-backups", ".gitignore"));
  assert.equal(gitignore, "*\n");
});

test("backupIfMissing works alongside a user-scope target file's own directory", async () => {
  const dir = await makeTempDir();
  const userDir = path.join(dir, "home", ".config", "sometool");
  const target = path.join(userDir, "config.toml");
  await atomicWriteFile(target, "user scope content");
  const didBackup = await backupIfMissing(target);
  assert.equal(didBackup, true);
  const backup = await readFileIfExists(path.join(userDir, ".bi-agent-kit-backups", "config.toml"));
  assert.equal(backup, "user scope content");
  const gitignore = await readFileIfExists(path.join(userDir, ".bi-agent-kit-backups", ".gitignore"));
  assert.equal(gitignore, "*\n");
});

test("backupIfMissing does not overwrite an existing backup", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "config.json");
  await atomicWriteFile(target, "first version");
  await backupIfMissing(target);
  await atomicWriteFile(target, "second version");
  const didBackupAgain = await backupIfMissing(target);
  assert.equal(didBackupAgain, false);
  const backup = await readFileIfExists(path.join(dir, ".bi-agent-kit-backups", "config.json"));
  assert.equal(backup, "first version");
});

test("backupIfMissing is a no-op when the target file does not exist yet", async () => {
  const dir = await makeTempDir();
  const target = path.join(dir, "missing.json");
  const didBackup = await backupIfMissing(target);
  assert.equal(didBackup, false);
  const backupDirEntries = await readFileIfExists(path.join(dir, ".bi-agent-kit-backups", "missing.json"));
  assert.equal(backupDirEntries, null);
});
