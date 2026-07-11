import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "smol-toml";
import { readTomlServers, setTomlServer, removeTomlServer } from "../lib/toml-adapter.js";

test("readTomlServers returns an empty object for empty file text", () => {
  assert.deepEqual(readTomlServers(""), {});
});

test("readTomlServers returns an empty object when mcp_servers is missing", () => {
  const text = "profile = \"default\"\n";
  assert.deepEqual(readTomlServers(text), {});
});

test("readTomlServers extracts existing server entries", () => {
  const text = "[mcp_servers.foo]\ncommand = \"npx\"\n";
  const result = readTomlServers(text);
  assert.deepEqual(result, { foo: { command: "npx" } });
});

test("setTomlServer appends a new block on an empty file", () => {
  const result = setTomlServer("", "powerbi", { command: "npx", args: ["-y", "pkg"] });
  const parsed = parse(result);
  assert.deepEqual(parsed.mcp_servers.powerbi, { command: "npx", args: ["-y", "pkg"] });
});

test("setTomlServer preserves unrelated existing content and comments", () => {
  const text = "# top comment\nprofile = \"default\"\n\n[mcp_servers.existing]\ncommand = \"other\"\n";
  const result = setTomlServer(text, "powerbi", { command: "npx" });
  assert.match(result, /# top comment/);
  assert.match(result, /profile = "default"/);
  const parsed = parse(result);
  assert.deepEqual(parsed.mcp_servers.existing, { command: "other" });
  assert.deepEqual(parsed.mcp_servers.powerbi, { command: "npx" });
});

test("setTomlServer overwrites a prior block for the same key without duplicating it", () => {
  const text = "[mcp_servers.powerbi]\ncommand = \"old\"\n";
  const result = setTomlServer(text, "powerbi", { command: "new" });
  const parsed = parse(result);
  assert.deepEqual(parsed.mcp_servers.powerbi, { command: "new" });
  const occurrences = result.split("[mcp_servers.powerbi]").length - 1;
  assert.equal(occurrences, 1);
});

test("removeTomlServer removes only the target block", () => {
  const text = "[mcp_servers.keep]\ncommand = \"a\"\n\n[mcp_servers.drop]\ncommand = \"b\"\n";
  const result = removeTomlServer(text, "drop");
  const parsed = parse(result);
  assert.deepEqual(parsed.mcp_servers.keep, { command: "a" });
  assert.equal(parsed.mcp_servers.drop, undefined);
});

test("removeTomlServer is a no-op when the key does not exist", () => {
  const text = "[mcp_servers.keep]\ncommand = \"a\"\n";
  const result = removeTomlServer(text, "missing");
  assert.equal(result, text);
});

test("removeTomlServer preserves a later top level table when removing an earlier one", () => {
  const text = "[mcp_servers.drop]\ncommand = \"b\"\n\n[other_table]\nkey = \"value\"\n";
  const result = removeTomlServer(text, "drop");
  assert.match(result, /\[other_table\]/);
  assert.match(result, /key = "value"/);
});
