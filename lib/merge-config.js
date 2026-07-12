import { readJsonServers, setJsonServer, removeJsonServer } from "./json-adapter.js";
import { readTomlServers, setTomlServer, removeTomlServer } from "./toml-adapter.js";
import path from "node:path";
import { readFileIfExists, atomicWriteFile, backupIfMissing, assertNoSymlinkedAncestors } from "./atomic-fs.js";
import { readManifest, writeManifestEntry, removeManifestEntry } from "./manifest.js";
import { hashValue } from "./hash.js";

export class CollisionError extends Error {
  constructor(absPath, serverKey) {
    super(
      "A key named " + serverKey + " already exists in " + absPath +
        " and is not owned by bi-agent-kit. Rename the server or remove the conflicting entry by hand first."
    );
    this.name = "CollisionError";
    this.absPath = absPath;
    this.serverKey = serverKey;
  }
}

function readServers(shape, fileText, rootKey) {
  if (shape === "toml") return readTomlServers(fileText);
  return readJsonServers(fileText, rootKey);
}

function writeServer(shape, fileText, rootKey, serverKey, serverValue) {
  if (shape === "toml") return setTomlServer(fileText, serverKey, serverValue);
  return setJsonServer(fileText, rootKey, serverKey, serverValue);
}

function deleteServer(shape, fileText, rootKey, serverKey) {
  if (shape === "toml") return removeTomlServer(fileText, serverKey);
  return removeJsonServer(fileText, rootKey, serverKey);
}

// Every path component below this ancestor is checked for symlinks before we read/write it.
// For paths inside the project dir, that's the project dir itself. For paths outside it
// (e.g. user-home-scoped targets), fall back to the file's own grandparent directory so we
// still catch a symlinked immediate parent without following the entire host filesystem.
function symlinkCheckStopDir(dir, absPath) {
  const resolvedDir = path.resolve(dir);
  const resolvedAbsPath = path.resolve(absPath);
  const relative = path.relative(resolvedDir, resolvedAbsPath);
  if (relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative)) {
    return resolvedDir;
  }
  return path.dirname(path.dirname(resolvedAbsPath));
}

export async function addServerToTarget({ dir, resolvedTarget, serverKey, serverValue, templateId }) {
  const manifest = await readManifest(dir);
  const entries = manifest ? manifest.entries : [];
  const ownedByUs = entries.some(
    (e) => e.absPath === resolvedTarget.absPath && e.serverKey === serverKey
  );
  const fileHasAnyOwnedEntry = entries.some((e) => e.absPath === resolvedTarget.absPath);

  await assertNoSymlinkedAncestors(
    resolvedTarget.absPath,
    symlinkCheckStopDir(dir, resolvedTarget.absPath)
  );

  const fileText = await readFileIfExists(resolvedTarget.absPath);
  const currentServers = readServers(resolvedTarget.shape, fileText, resolvedTarget.rootKey);

  if (Object.prototype.hasOwnProperty.call(currentServers, serverKey) && !ownedByUs) {
    throw new CollisionError(resolvedTarget.absPath, serverKey);
  }

  if (!fileHasAnyOwnedEntry && fileText !== null) {
    await backupIfMissing(resolvedTarget.absPath);
  }

  const newFileText = writeServer(
    resolvedTarget.shape,
    fileText,
    resolvedTarget.rootKey,
    serverKey,
    serverValue
  );
  await assertNoSymlinkedAncestors(
    resolvedTarget.absPath,
    symlinkCheckStopDir(dir, resolvedTarget.absPath)
  );
  await atomicWriteFile(resolvedTarget.absPath, newFileText);

  await writeManifestEntry(dir, {
    absPath: resolvedTarget.absPath,
    serverKey,
    templateId: templateId || serverKey,
    targetIds: resolvedTarget.targetIds,
    contentHash: hashValue(serverValue),
    installedAt: Date.now(),
  });

  return { status: "written" };
}

export async function removeServerFromTarget({ dir, resolvedTarget, serverKey }) {
  const manifest = await readManifest(dir);
  const entry = manifest
    ? manifest.entries.find((e) => e.absPath === resolvedTarget.absPath && e.serverKey === serverKey)
    : undefined;
  if (!entry) {
    return { status: "not-installed" };
  }

  await assertNoSymlinkedAncestors(
    resolvedTarget.absPath,
    symlinkCheckStopDir(dir, resolvedTarget.absPath)
  );

  const fileText = await readFileIfExists(resolvedTarget.absPath);
  const currentServers = readServers(resolvedTarget.shape, fileText, resolvedTarget.rootKey);
  const currentValue = currentServers[serverKey];

  if (currentValue === undefined) {
    await removeManifestEntry(dir, resolvedTarget.absPath, serverKey);
    return { status: "already-removed" };
  }

  const currentHash = hashValue(currentValue);
  if (currentHash !== entry.contentHash) {
    return { status: "skipped-drift" };
  }

  const newFileText = deleteServer(resolvedTarget.shape, fileText, resolvedTarget.rootKey, serverKey);
  const remaining = readServers(resolvedTarget.shape, newFileText, resolvedTarget.rootKey);
  if (Object.prototype.hasOwnProperty.call(remaining, serverKey)) {
    // Removal did not actually take effect; do not write and do not update the
    // manifest, so state stays truthful and the entry remains managed.
    return { status: "remove-failed" };
  }
  await assertNoSymlinkedAncestors(
    resolvedTarget.absPath,
    symlinkCheckStopDir(dir, resolvedTarget.absPath)
  );
  await atomicWriteFile(resolvedTarget.absPath, newFileText);
  await removeManifestEntry(dir, resolvedTarget.absPath, serverKey);

  return { status: "removed" };
}
