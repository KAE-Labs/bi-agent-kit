import { promises as fs } from "node:fs";
import { readFileIfExists } from "./atomic-fs.js";

export class LockHeldError extends Error {
  constructor(lockPath) {
    super("Another bi-agent-kit run is already in progress, lock at " + lockPath);
    this.name = "LockHeldError";
    this.lockPath = lockPath;
  }
}

async function tryExclusiveCreate(lockPath, payload) {
  const handle = await fs.open(lockPath, "wx");
  try {
    await handle.writeFile(payload, "utf8");
  } finally {
    await handle.close();
  }
}

export async function acquireLock(lockPath, options) {
  const ttlMs = options && options.ttlMs ? options.ttlMs : 30000;
  const payload = JSON.stringify({ pid: process.pid, timestamp: Date.now() });
  try {
    await tryExclusiveCreate(lockPath, payload);
    return async function release() {
      await releaseLock(lockPath);
    };
  } catch (err) {
    if (err.code !== "EEXIST") throw err;
  }
  const existing = await readFileIfExists(lockPath);
  if (existing !== null) {
    const parsed = JSON.parse(existing);
    const age = Date.now() - parsed.timestamp;
    if (age < ttlMs) {
      throw new LockHeldError(lockPath);
    }
  }
  // Reclaiming a stale lock is best effort, not fully atomic.
  // Acceptable for a single user local CLI, not a distributed system.
  await fs.unlink(lockPath).catch(() => {});
  await tryExclusiveCreate(lockPath, payload);
  return async function release() {
    await releaseLock(lockPath);
  };
}

export async function releaseLock(lockPath) {
  try {
    await fs.unlink(lockPath);
  } catch (err) {
    if (err.code !== "ENOENT") throw err;
  }
}
