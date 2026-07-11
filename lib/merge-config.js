import { readJsonServers, setJsonServer, removeJsonServer } from "./json-adapter.js";
import { readTomlServers, setTomlServer, removeTomlServer } from "./toml-adapter.js";
import { readFileIfExists, atomicWriteFile, backupIfMissing } from "./atomic-fs.js";
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

export async function addServerToTarget({ dir, resolvedTarget, serverKey, serverValue }) {
  const manifest = await readManifest(dir);
  const entries = manifest ? manifest.entries : [];
  const ownedByUs = entries.some(
    (e) => e.absPath === resolvedTarget.absPath && e.serverKey === serverKey
  );
  const fileHasAnyOwnedEntry = entries.some((e) => e.absPath === resolvedTarget.absPath);

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
  await atomicWriteFile(resolvedTarget.absPath, newFileText);

  await writeManifestEntry(dir, {
    absPath: resolvedTarget.absPath,
    serverKey,
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
  await atomicWriteFile(resolvedTarget.absPath, newFileText);
  await removeManifestEntry(dir, resolvedTarget.absPath, serverKey);

  return { status: "removed" };
}
