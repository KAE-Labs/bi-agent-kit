import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { acquireLock, releaseLock, LockHeldError } from "../lib/lock.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bi-agent-kit-lock-test-"));
}

test("acquireLock succeeds when no lock file exists", async () => {
  const dir = await makeTempDir();
  const lockPath = path.join(dir, ".lock");
  const release = await acquireLock(lockPath);
  assert.equal(typeof release, "function");
  await release();
});

test("acquireLock throws LockHeldError when a fresh lock already exists", async () => {
  const dir = await makeTempDir();
  const lockPath = path.join(dir, ".lock");
  const release = await acquireLock(lockPath);
  await assert.rejects(() => acquireLock(lockPath), LockHeldError);
  await release();
});

test("acquireLock reclaims a stale lock past its ttl", async () => {
  const dir = await makeTempDir();
  const lockPath = path.join(dir, ".lock");
  const stalePayload = JSON.stringify({ pid: 999999, timestamp: Date.now() - 60000 });
  await fs.writeFile(lockPath, stalePayload, "utf8");
  const release = await acquireLock(lockPath, { ttlMs: 1000 });
  assert.equal(typeof release, "function");
  await release();
});

test("releaseLock removes the lock file", async () => {
  const dir = await makeTempDir();
  const lockPath = path.join(dir, ".lock");
  await acquireLock(lockPath);
  await releaseLock(lockPath);
  const stillExists = await fs.access(lockPath).then(() => true).catch(() => false);
  assert.equal(stillExists, false);
});

test("releaseLock does not throw when the lock file is already gone", async () => {
  const dir = await makeTempDir();
  const lockPath = path.join(dir, ".lock");
  await assert.doesNotReject(() => releaseLock(lockPath));
});
