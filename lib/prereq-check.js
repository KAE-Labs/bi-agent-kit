import { execFile } from "node:child_process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

export async function isBinaryOnPath(binaryName) {
  const finderCommand = process.platform === "win32" ? "where" : "which";
  try {
    await execFileAsync(finderCommand, [binaryName]);
    return true;
  } catch {
    return false;
  }
}
