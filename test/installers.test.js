import { test } from "node:test";
import assert from "node:assert/strict";
import { INSTALLERS, offerInstall } from "../lib/installers.js";

test("INSTALLERS has entries for pac, dab, and uvx with a command array for the current platform shape", () => {
  for (const name of ["pac", "dab", "uvx"]) {
    const installer = INSTALLERS[name];
    assert.ok(installer, name + " should have an installer entry");
    assert.equal(typeof installer.label, "string");
    for (const platform of ["win32", "darwin", "linux"]) {
      const spec = installer.commands[platform];
      assert.ok(spec, name + " should define a command for " + platform);
      assert.equal(typeof spec.command, "string");
      assert.ok(Array.isArray(spec.args));
    }
  }
});

test("offerInstall invokes the confirm callback and runs the injected runner when accepted", async () => {
  const calls = [];
  const confirmMessages = [];
  const result = await offerInstall("pac", {
    platform: "linux",
    confirm: async ({ message }) => {
      confirmMessages.push(message);
      return true;
    },
    runner: async (command, args) => {
      calls.push({ command, args });
    },
  });

  assert.equal(confirmMessages.length, 1);
  assert.match(confirmMessages[0], /pac/i);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].command, "dotnet");
  assert.deepEqual(result, { attempted: true, installed: true });
});

test("offerInstall skips execution when the user declines", async () => {
  let ran = false;
  const result = await offerInstall("dab", {
    platform: "linux",
    confirm: async () => false,
    runner: async () => {
      ran = true;
    },
  });

  assert.equal(ran, false);
  assert.equal(result.attempted, false);
  assert.equal(result.installed, false);
  assert.equal(result.reason, "declined");
});

test("offerInstall reports an unknown binary without prompting", async () => {
  let confirmed = false;
  const result = await offerInstall("not-a-real-binary", {
    platform: "linux",
    confirm: async () => {
      confirmed = true;
      return true;
    },
    runner: async () => {},
  });

  assert.equal(confirmed, false);
  assert.equal(result.attempted, false);
  assert.equal(result.reason, "no-installer");
});

test("offerInstall surfaces runner failures without throwing", async () => {
  const result = await offerInstall("uvx", {
    platform: "darwin",
    confirm: async () => true,
    runner: async () => {
      throw new Error("boom");
    },
  });

  assert.equal(result.attempted, true);
  assert.equal(result.installed, false);
  assert.equal(result.reason, "error");
  assert.match(result.message, /boom/);
});
