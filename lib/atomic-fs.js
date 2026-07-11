import { promises as fs } from "node:fs";
import path from "node:path";
import crypto from "node:crypto";

export async function readFileIfExists(filePath) {
  try {
    return await fs.readFile(filePath, "utf8");
  } catch (err) {
    if (err.code === "ENOENT") return null;
    throw err;
  }
}

export async function atomicWriteFile(filePath, contents) {
  const dir = path.dirname(filePath);
  await fs.mkdir(dir, { recursive: true });
  const suffix = crypto.randomBytes(6).toString("hex");
  const tmpPath = path.join(dir, "." + path.basename(filePath) + "." + suffix + ".tmp");
  await fs.writeFile(tmpPath, contents, "utf8");
  await fs.rename(tmpPath, filePath);
}

const BACKUP_DIR_NAME = ".bi-agent-kit-backups";

function backupPathFor(filePath) {
  const backupDir = path.join(path.dirname(filePath), BACKUP_DIR_NAME);
  return { backupDir, backupPath: path.join(backupDir, path.basename(filePath)) };
}

async function ensureBackupDirIgnored(backupDir) {
  const gitignorePath = path.join(backupDir, ".gitignore");
  const existing = await readFileIfExists(gitignorePath);
  if (existing === null) {
    await atomicWriteFile(gitignorePath, "*\n");
  }
}

export async function backupIfMissing(filePath) {
  const { backupDir, backupPath } = backupPathFor(filePath);
  try {
    await fs.access(backupPath);
    return false;
  } catch {
    // no existing backup, proceed
  }
  const original = await readFileIfExists(filePath);
  if (original === null) return false;
  await ensureBackupDirIgnored(backupDir);
  await atomicWriteFile(backupPath, original);
  return true;
}
