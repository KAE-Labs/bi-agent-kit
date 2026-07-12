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

export class SymlinkRefusedError extends Error {
  constructor(componentPath) {
    super(
      "Refusing to operate on " + componentPath +
        " because it is a symbolic link (or junction). This can be used to escape the project " +
        "directory and read or overwrite arbitrary files. Remove the symlink and retry with a " +
        "real directory/file if this is expected."
    );
    this.name = "SymlinkRefusedError";
    this.componentPath = componentPath;
  }
}

/**
 * Walks each path component from `stopDir` down to `filePath` (inclusive) and throws
 * SymlinkRefusedError if any existing component is a symbolic link. On Windows, directory
 * junctions are reported as symbolic links by fs.lstat, so this also catches junction attacks.
 * Components that do not exist yet are skipped (nothing to follow).
 */
export async function assertNoSymlinkedAncestors(filePath, stopDir) {
  const resolvedFile = path.resolve(filePath);
  const resolvedStop = path.resolve(stopDir);

  const relative = path.relative(resolvedStop, resolvedFile);
  const segments =
    relative === "" || relative.startsWith("..") ? [resolvedFile] : relative.split(path.sep);

  let current = relative === "" || relative.startsWith("..") ? null : resolvedStop;
  const componentsToCheck = [];
  if (current !== null) {
    componentsToCheck.push(current);
    for (const segment of segments) {
      current = path.join(current, segment);
      componentsToCheck.push(current);
    }
  } else {
    componentsToCheck.push(resolvedFile);
  }

  for (const componentPath of componentsToCheck) {
    let stats;
    try {
      stats = await fs.lstat(componentPath);
    } catch (err) {
      if (err.code === "ENOENT") continue;
      throw err;
    }
    if (stats.isSymbolicLink()) {
      throw new SymlinkRefusedError(componentPath);
    }
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

export function normalizePathForCompare(filePath) {
  const resolved = path.resolve(filePath);
  return process.platform === "win32" ? resolved.toLowerCase() : resolved;
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
