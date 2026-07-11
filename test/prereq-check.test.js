import { test } from "node:test";
import assert from "node:assert/strict";
import { isBinaryOnPath } from "../lib/prereq-check.js";

test("isBinaryOnPath returns true for a binary that exists on PATH", async () => {
  const result = await isBinaryOnPath("node");
  assert.equal(result, true);
});

test("isBinaryOnPath returns false for a binary that does not exist", async () => {
  const result = await isBinaryOnPath("definitely-not-a-real-binary-xyz123");
  assert.equal(result, false);
});
