import { test } from "node:test";
import assert from "node:assert/strict";
import { promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { detectExistingTargets } from "../lib/detect.js";

async function makeTempDir() {
  return await fs.mkdtemp(path.join(os.tmpdir(), "bi-agent-kit-detect-test-"));
}

test("detectExistingTargets includes a target whose file already exists", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, ".mcp.json");
  await fs.writeFile(filePath, "{}", "utf8");
  const targets = [
    { absPath: filePath, shape: "json", rootKey: "mcpServers", targetIds: ["claude-code"], labels: ["Claude Code"] },
  ];
  const result = await detectExistingTargets(targets);
  assert.equal(result.length, 1);
});

test("detectExistingTargets includes a target whose parent directory exists even without the file", async () => {
  const dir = await makeTempDir();
  const subDir = path.join(dir, ".cursor");
  await fs.mkdir(subDir);
  const filePath = path.join(subDir, "mcp.json");
  const targets = [
    { absPath: filePath, shape: "json", rootKey: "mcpServers", targetIds: ["cursor-project"], labels: ["Cursor"] },
  ];
  const result = await detectExistingTargets(targets);
  assert.equal(result.length, 1);
});

test("detectExistingTargets excludes a target whose file and parent directory are both absent", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, ".gemini", "settings.json");
  const targets = [
    { absPath: filePath, shape: "json", rootKey: "mcpServers", targetIds: ["gemini-project"], labels: ["Gemini CLI"] },
  ];
  const result = await detectExistingTargets(targets);
  assert.equal(result.length, 0);
});

test("detectExistingTargets requires the file itself for a root level target, a directory match is not enough", async () => {
  const dir = await makeTempDir();
  const filePath = path.join(dir, ".mcp.json");
  const targets = [
    { absPath: filePath, shape: "json", rootKey: "mcpServers", rootLevel: true, targetIds: ["claude-code"], labels: ["Claude Code"] },
  ];
  const beforeCreate = await detectExistingTargets(targets);
  assert.equal(beforeCreate.length, 0);
  await fs.writeFile(filePath, "{}", "utf8");
  const afterCreate = await detectExistingTargets(targets);
  assert.equal(afterCreate.length, 1);
});

test("detectExistingTargets returns an empty list for an empty input", async () => {
  const result = await detectExistingTargets([]);
  assert.deepEqual(result, []);
});
