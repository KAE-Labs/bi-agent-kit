import { test } from "node:test";
import assert from "node:assert/strict";
import { parse } from "jsonc-parser";
import { readJsonServers, setJsonServer, removeJsonServer, MalformedConfigError } from "../lib/json-adapter.js";

test("readJsonServers returns an empty object for empty file text", () => {
  assert.deepEqual(readJsonServers("", "mcpServers"), {});
});

test("readJsonServers returns an empty object when the root key is missing", () => {
  const text = "{\n  \"other\": true\n}\n";
  assert.deepEqual(readJsonServers(text, "mcpServers"), {});
});

test("readJsonServers extracts existing server entries", () => {
  const text = "{\n  \"mcpServers\": {\n    \"foo\": { \"command\": \"npx\" }\n  }\n}\n";
  const result = readJsonServers(text, "mcpServers");
  assert.deepEqual(result, { foo: { command: "npx" } });
});

test("setJsonServer creates the root key on an empty file", () => {
  const result = setJsonServer("", "mcpServers", "powerbi", { command: "npx" });
  const parsed = parse(result);
  assert.deepEqual(parsed, { mcpServers: { powerbi: { command: "npx" } } });
});

test("setJsonServer preserves unrelated existing entries", () => {
  const text = "{\n  \"mcpServers\": {\n    \"existing\": { \"command\": \"other\" }\n  }\n}\n";
  const result = setJsonServer(text, "mcpServers", "powerbi", { command: "npx" });
  const parsed = parse(result);
  assert.deepEqual(parsed.mcpServers.existing, { command: "other" });
  assert.deepEqual(parsed.mcpServers.powerbi, { command: "npx" });
});

test("setJsonServer preserves comments elsewhere in the file", () => {
  const text = "{\n  // keep me\n  \"mcpServers\": {\n    \"existing\": { \"command\": \"other\" }\n  }\n}\n";
  const result = setJsonServer(text, "mcpServers", "powerbi", { command: "npx" });
  assert.match(result, /\/\/ keep me/);
});

test("setJsonServer works with a servers root key", () => {
  const result = setJsonServer("", "servers", "powerbi", { command: "npx" });
  const parsed = parse(result);
  assert.deepEqual(parsed, { servers: { powerbi: { command: "npx" } } });
});

test("removeJsonServer removes only the target key", () => {
  const text = "{\n  \"mcpServers\": {\n    \"keep\": { \"command\": \"a\" },\n    \"drop\": { \"command\": \"b\" }\n  }\n}\n";
  const result = removeJsonServer(text, "mcpServers", "drop");
  const parsed = parse(result);
  assert.deepEqual(parsed.mcpServers, { keep: { command: "a" } });
});

test("removeJsonServer is a no-op when the key does not exist", () => {
  const text = "{\n  \"mcpServers\": {\n    \"keep\": { \"command\": \"a\" }\n  }\n}\n";
  const result = removeJsonServer(text, "mcpServers", "missing");
  const parsed = parse(result);
  assert.deepEqual(parsed.mcpServers, { keep: { command: "a" } });
});

test("readJsonServers throws MalformedConfigError on invalid json content", () => {
  assert.throws(() => readJsonServers("not valid json", "mcpServers"), MalformedConfigError);
});
