import { test } from "node:test";
import assert from "node:assert/strict";
import path from "node:path";
import { resolveTargets, TARGET_DEFINITIONS } from "../lib/targets.js";

test("TARGET_DEFINITIONS has 17 logical target entries", () => {
  assert.equal(TARGET_DEFINITIONS.length, 17);
});

test("resolveTargets dedupes claude-code and copilot-cli-project onto one entry", () => {
  const results = resolveTargets("/proj", "/home/test", "linux");
  const shared = results.find((r) => r.targetIds.includes("claude-code"));
  assert.ok(shared);
  assert.ok(shared.targetIds.includes("copilot-cli-project"));
  assert.equal(shared.absPath, path.join("/proj", ".mcp.json"));
});

test("resolveTargets skips claude-desktop on linux", () => {
  const results = resolveTargets("/proj", "/home/test", "linux");
  const found = results.find((r) => r.targetIds.includes("claude-desktop"));
  assert.equal(found, undefined);
});

test("resolveTargets resolves claude-desktop on darwin", () => {
  const results = resolveTargets("/proj", "/home/test", "darwin");
  const found = results.find((r) => r.targetIds.includes("claude-desktop"));
  assert.ok(found);
  assert.equal(
    found.absPath,
    path.join("/home/test", "Library", "Application Support", "Claude", "claude_desktop_config.json")
  );
});

test("resolveTargets assigns the servers root key to the copilot vscode shape", () => {
  const results = resolveTargets("/proj", "/home/test", "linux");
  const found = results.find((r) => r.targetIds.includes("copilot-vscode-workspace"));
  assert.equal(found.rootKey, "servers");
});

test("resolveTargets assigns the toml shape to codex targets", () => {
  const results = resolveTargets("/proj", "/home/test", "linux");
  const found = results.find((r) => r.targetIds.includes("codex-project"));
  assert.equal(found.shape, "toml");
});

test("resolveTargets resolves claude-code-user to homedir/.claude.json without merging into the project .mcp.json group", () => {
  const results = resolveTargets("/proj", "/home/test", "linux");
  const userTarget = results.find((r) => r.targetIds.includes("claude-code-user"));
  assert.ok(userTarget);
  assert.equal(userTarget.absPath, path.join("/home/test", ".claude.json"));
  assert.equal(userTarget.rootKey, "mcpServers");
  assert.equal(userTarget.rootLevel, true);
  assert.equal(userTarget.targetIds.length, 1);

  const projectGroup = results.find((r) => r.targetIds.includes("claude-code"));
  assert.ok(projectGroup);
  assert.ok(!projectGroup.targetIds.includes("claude-code-user"));
  assert.notEqual(projectGroup.absPath, userTarget.absPath);
});
