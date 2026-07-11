import { test } from "node:test";
import assert from "node:assert/strict";
import { hashValue } from "../lib/hash.js";

test("hashValue returns the same hash for objects with keys in different order", () => {
  const a = { command: "npx", args: ["-y", "pkg"] };
  const b = { args: ["-y", "pkg"], command: "npx" };
  assert.equal(hashValue(a), hashValue(b));
});

test("hashValue returns different hashes for different values", () => {
  const a = { command: "npx" };
  const b = { command: "npy" };
  assert.notEqual(hashValue(a), hashValue(b));
});

test("hashValue returns a 64 character hex string", () => {
  const result = hashValue({ a: 1 });
  assert.equal(result.length, 64);
  assert.match(result, /^[0-9a-f]+$/);
});

test("hashValue treats array order as significant", () => {
  const a = { args: ["-y", "pkg"] };
  const b = { args: ["pkg", "-y"] };
  assert.notEqual(hashValue(a), hashValue(b));
});
