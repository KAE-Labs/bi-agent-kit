import { promises as fs } from "node:fs";
import path from "node:path";

async function pathExists(candidatePath) {
  try {
    await fs.access(candidatePath);
    return true;
  } catch {
    return false;
  }
}

export async function detectExistingTargets(resolvedTargets) {
  const results = [];
  for (const target of resolvedTargets) {
    const fileExists = await pathExists(target.absPath);
    if (target.rootLevel) {
      if (fileExists) results.push(target);
      continue;
    }
    const dirExists = await pathExists(path.dirname(target.absPath));
    if (fileExists || dirExists) {
      results.push(target);
    }
  }
  return results;
}
