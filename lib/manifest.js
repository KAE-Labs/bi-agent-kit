import path from "node:path";
import { atomicWriteFile, readFileIfExists } from "./atomic-fs.js";

export const MANIFEST_FILENAME = ".kae-bi-kit.json";

export class ManifestCorruptError extends Error {
  constructor(manifestPath, cause) {
    super("Manifest at " + manifestPath + " is corrupt. Re-run init to rebuild it.");
    this.name = "ManifestCorruptError";
    this.manifestPath = manifestPath;
    this.cause = cause;
  }
}

function manifestPathFor(dir) {
  return path.join(dir, MANIFEST_FILENAME);
}

function emptyManifest() {
  return { version: 1, entries: [] };
}

export async function readManifest(dir) {
  const manifestPath = manifestPathFor(dir);
  const text = await readFileIfExists(manifestPath);
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (!parsed || typeof parsed !== "object" || !Array.isArray(parsed.entries)) {
      throw new Error("missing entries array");
    }
    return parsed;
  } catch (err) {
    throw new ManifestCorruptError(manifestPath, err);
  }
}

async function persist(dir, manifest) {
  const manifestPath = manifestPathFor(dir);
  const currentContent = await readFileIfExists(manifestPath);
  if (currentContent !== null) {
    await atomicWriteFile(manifestPath + ".bak", currentContent);
  }
  await atomicWriteFile(manifestPath, JSON.stringify(manifest, null, 2) + "\n");
}

export async function writeManifestEntry(dir, entry) {
  let manifest = await readManifest(dir);
  if (manifest === null) manifest = emptyManifest();
  const index = manifest.entries.findIndex(
    (e) => e.absPath === entry.absPath && e.serverKey === entry.serverKey
  );
  if (index === -1) {
    manifest.entries.push(entry);
  } else {
    manifest.entries[index] = entry;
  }
  await persist(dir, manifest);
  return manifest;
}

export async function removeManifestEntry(dir, absPath, serverKey) {
  const manifest = await readManifest(dir);
  if (manifest === null) return null;
  manifest.entries = manifest.entries.filter(
    (e) => !(e.absPath === absPath && e.serverKey === serverKey)
  );
  await persist(dir, manifest);
  return manifest;
}
