import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs, VALID_COMMANDS, findPreviousEntriesForPair, previousTemplateIds, targetsOutsideFilter } from "../bin/cli.js";
import { parseServerSpec } from "../lib/commands.js";

test("parseArgs defaults to the init command with dry run false", () => {
  const result = parseArgs(["node", "cli.js"]);
  assert.equal(result.command, "init");
  assert.equal(result.dryRun, false);
});

test("parseArgs recognizes the configure command", () => {
  const result = parseArgs(["node", "cli.js", "configure"]);
  assert.equal(result.command, "configure");
});

test("parseArgs recognizes the list command", () => {
  const result = parseArgs(["node", "cli.js", "list"]);
  assert.equal(result.command, "list");
});

test("parseArgs recognizes the doctor command", () => {
  const result = parseArgs(["node", "cli.js", "doctor"]);
  assert.equal(result.command, "doctor");
});

test("parseArgs recognizes the reconfigure command", () => {
  const result = parseArgs(["node", "cli.js", "reconfigure"]);
  assert.equal(result.command, "reconfigure");
});

test("parseArgs detects the dry run flag alongside a command", () => {
  const result = parseArgs(["node", "cli.js", "init", "--dry-run"]);
  assert.equal(result.command, "init");
  assert.equal(result.dryRun, true);
});

test("parseArgs detects the dry run flag alongside the reconfigure command", () => {
  const result = parseArgs(["node", "cli.js", "reconfigure", "--dry-run"]);
  assert.equal(result.command, "reconfigure");
  assert.equal(result.dryRun, true);
});

test("parseArgs does not silently fall back to init for an unknown command", () => {
  const result = parseArgs(["node", "cli.js", "bogus-command"]);
  assert.equal(result.command, "bogus-command");
  assert.equal(VALID_COMMANDS.includes(result.command), false);
});

test("VALID_COMMANDS lists exactly the supported commands", () => {
  assert.deepEqual(VALID_COMMANDS, ["init", "configure", "list", "doctor", "reconfigure", "remove", "export"]);
});

test("parseArgs recognizes the remove command", () => {
  const result = parseArgs(["node", "cli.js", "remove"]);
  assert.equal(result.command, "remove");
});

test("parseArgs recognizes the export command", () => {
  const result = parseArgs(["node", "cli.js", "export"]);
  assert.equal(result.command, "export");
});

test("parseArgs detects --help and -h", () => {
  assert.equal(parseArgs(["node", "cli.js", "--help"]).help, true);
  assert.equal(parseArgs(["node", "cli.js", "-h"]).help, true);
  assert.equal(parseArgs(["node", "cli.js"]).help, false);
});

test("parseArgs detects --version and -v", () => {
  assert.equal(parseArgs(["node", "cli.js", "--version"]).version, true);
  assert.equal(parseArgs(["node", "cli.js", "-v"]).version, true);
  assert.equal(parseArgs(["node", "cli.js"]).version, false);
});

test("parseArgs detects --yes and --json flags", () => {
  const result = parseArgs(["node", "cli.js", "list", "--yes", "--json"]);
  assert.equal(result.yes, true);
  assert.equal(result.json, true);
});

test("parseArgs defaults yes and json to false", () => {
  const result = parseArgs(["node", "cli.js"]);
  assert.equal(result.yes, false);
  assert.equal(result.json, false);
});

test("parseArgs parses --servers into an array", () => {
  const result = parseArgs(["node", "cli.js", "init", "--servers", "powerbi,dataverse"]);
  assert.deepEqual(result.servers, ["powerbi", "dataverse"]);
});

test("parseArgs parses --servers= form into an array", () => {
  const result = parseArgs(["node", "cli.js", "init", "--servers=powerbi, dataverse "]);
  assert.deepEqual(result.servers, ["powerbi", "dataverse"]);
});

test("parseArgs parses --servers with templateId:instanceName specs as raw strings", () => {
  // parseArgs itself stays a pure string splitter -- it does not know about
  // the templateId:instanceName spec syntax. Spec parsing happens downstream
  // via parseServerSpec, in the command flow, on each raw string it returns.
  const result = parseArgs(["node", "cli.js", "init", "--servers", "dataverse:dev,powerbi"]);
  assert.deepEqual(result.servers, ["dataverse:dev", "powerbi"]);
});

test("parseArgs parses --servers= with templateId:instanceName specs as raw strings", () => {
  const result = parseArgs(["node", "cli.js", "init", "--servers=dataverse:dev, powerbi"]);
  assert.deepEqual(result.servers, ["dataverse:dev", "powerbi"]);
});

test("parseArgs parses --targets into an array", () => {
  const result = parseArgs(["node", "cli.js", "init", "--targets", "claude-code,cursor-user"]);
  assert.deepEqual(result.targets, ["claude-code", "cursor-user"]);
});

test("parseArgs leaves servers and targets null when not provided", () => {
  const result = parseArgs(["node", "cli.js", "init"]);
  assert.equal(result.servers, null);
  assert.equal(result.targets, null);
});

test("parseArgs supports servers, targets, dry-run, and yes together", () => {
  const result = parseArgs([
    "node",
    "cli.js",
    "init",
    "--servers",
    "powerbi",
    "--targets",
    "claude-code",
    "--dry-run",
    "--yes",
  ]);
  assert.equal(result.command, "init");
  assert.deepEqual(result.servers, ["powerbi"]);
  assert.deepEqual(result.targets, ["claude-code"]);
  assert.equal(result.dryRun, true);
  assert.equal(result.yes, true);
});

test("parseArgs is a pure function: it never prints or exits", () => {
  // No assertion needed beyond "did not throw / did not call process.exit" --
  // simply invoking it with a variety of inputs and reaching this line proves it.
  parseArgs(["node", "cli.js"]);
  parseArgs(["node", "cli.js", "--help"]);
  parseArgs(["node", "cli.js", "not-a-real-command"]);
  assert.ok(true);
});

// --- server-spec parsing, through the seam parseArgs hands off to -----------
//
// parseArgs stays pure and returns the raw --servers strings as given; actual
// templateId:instanceName parsing happens per-string via parseServerSpec
// (lib/commands.js) in the install-flow command handler. These tests drive
// that seam directly: parseArgs's raw output piped through parseServerSpec.

test("parseServerSpec resolves a plain template id with no instance", () => {
  const raw = parseArgs(["node", "cli.js", "init", "--servers", "powerbi"]).servers[0];
  const spec = parseServerSpec(raw);
  assert.deepEqual(spec, { templateId: "powerbi", instanceName: null, serverId: "powerbi" });
});

test("parseServerSpec resolves a templateId:instanceName spec to a suffixed serverId", () => {
  const raw = parseArgs(["node", "cli.js", "init", "--servers", "dataverse:dev"]).servers[0];
  const spec = parseServerSpec(raw);
  assert.deepEqual(spec, { templateId: "dataverse", instanceName: "dev", serverId: "dataverse-dev" });
});

test("parseServerSpec rejects instance names with invalid characters", () => {
  const raw = parseArgs(["node", "cli.js", "init", "--servers", "dataverse:not valid!"]).servers[0];
  assert.throws(() => parseServerSpec(raw), /instance name/i);
});

test("parseServerSpec accepts every --servers entry from a mixed spec list", () => {
  const raw = parseArgs(["node", "cli.js", "init", "--servers", "dataverse:dev,powerbi"]).servers;
  const specs = raw.map(parseServerSpec);
  assert.deepEqual(specs, [
    { templateId: "dataverse", instanceName: "dev", serverId: "dataverse-dev" },
    { templateId: "powerbi", instanceName: null, serverId: "powerbi" },
  ]);
});


// --- --prune flag -----------------------------------------------------------

test("parseArgs defaults prune to false", () => {
  const result = parseArgs(["node", "cli.js", "configure"]);
  assert.equal(result.prune, false);
});

test("parseArgs detects --prune", () => {
  const result = parseArgs(["node", "cli.js", "configure", "--servers", "powerbi", "--prune"]);
  assert.equal(result.prune, true);
  assert.deepEqual(result.servers, ["powerbi"]);
});

test("parseArgs supports --prune alongside other flags", () => {
  const result = parseArgs([
    "node",
    "cli.js",
    "configure",
    "--servers",
    "powerbi",
    "--targets",
    "claude-code",
    "--prune",
    "--yes",
  ]);
  assert.equal(result.prune, true);
  assert.equal(result.yes, true);
  assert.deepEqual(result.targets, ["claude-code"]);
});

// --- findPreviousEntriesForPair ----------------------------------------------
//
// Previous selections are instance-keyed (serverId like "dataverse-dev"), not
// bare-template-id-keyed. This is the seam that fixes the interactive-picker
// bug where an already-installed instance was never recognized as installed.

const fakeTemplates = [
  { id: "dataverse" },
  { id: "powerbi" },
  { id: "pac-cli" },
];

test("findPreviousEntriesForPair matches every instance-keyed previous entry for a base template id", () => {
  const previousSelections = [
    { absPath: "/a.json", serverId: "dataverse-dev", templateId: "dataverse" },
    { absPath: "/a.json", serverId: "dataverse-prod", templateId: "dataverse" },
    { absPath: "/a.json", serverId: "powerbi", templateId: "powerbi" },
  ];
  const result = findPreviousEntriesForPair({
    previousSelections,
    absPath: "/a.json",
    templateId: "dataverse",
    templates: fakeTemplates,
  });
  const serverIds = result.map((e) => e.serverId).sort();
  assert.deepEqual(serverIds, ["dataverse-dev", "dataverse-prod"]);
});

test("findPreviousEntriesForPair returns nothing for a different absPath", () => {
  const previousSelections = [{ absPath: "/a.json", serverId: "dataverse-dev", templateId: "dataverse" }];
  const result = findPreviousEntriesForPair({
    previousSelections,
    absPath: "/b.json",
    templateId: "dataverse",
    templates: fakeTemplates,
  });
  assert.deepEqual(result, []);
});

test("findPreviousEntriesForPair falls back to parsing the base id out of serverId when templateId is missing (old manifests)", () => {
  const previousSelections = [
    { absPath: "/a.json", serverId: "dataverse-dev" },
    { absPath: "/a.json", serverId: "pac-cli" },
  ];
  const result = findPreviousEntriesForPair({
    previousSelections,
    absPath: "/a.json",
    templateId: "dataverse",
    templates: fakeTemplates,
  });
  assert.deepEqual(result.map((e) => e.serverId), ["dataverse-dev"]);

  const pacResult = findPreviousEntriesForPair({
    previousSelections,
    absPath: "/a.json",
    templateId: "pac-cli",
    templates: fakeTemplates,
  });
  assert.deepEqual(pacResult.map((e) => e.serverId), ["pac-cli"]);
});

test("findPreviousEntriesForPair does not confuse a bare template id match with an unrelated pair", () => {
  const previousSelections = [{ absPath: "/a.json", serverId: "powerbi", templateId: "powerbi" }];
  const result = findPreviousEntriesForPair({
    previousSelections,
    absPath: "/a.json",
    templateId: "dataverse",
    templates: fakeTemplates,
  });
  assert.deepEqual(result, []);
});


// --- remove command: rest/specs -------------------------------------------

test("parseArgs captures positional specs after the command into rest", () => {
  const result = parseArgs(["node", "cli.js", "remove", "dataverse:dev", "powerbi"]);
  assert.equal(result.command, "remove");
  assert.deepEqual(result.rest, ["dataverse:dev", "powerbi"]);
});

test("parseArgs rest is empty for a command with no positional specs", () => {
  const result = parseArgs(["node", "cli.js", "remove"]);
  assert.deepEqual(result.rest, []);
});

test("parseArgs rest ignores flags interleaved with positional specs", () => {
  const result = parseArgs(["node", "cli.js", "remove", "powerbi", "--dry-run", "dataverse:dev"]);
  assert.deepEqual(result.rest, ["powerbi", "dataverse:dev"]);
  assert.equal(result.dryRun, true);
});

test("parseArgs rest stays empty for the default init command with no positional args", () => {
  const result = parseArgs(["node", "cli.js"]);
  assert.deepEqual(result.rest, []);
});

// --- export command: --out --------------------------------------------------

test("parseArgs parses --out into a file path", () => {
  const result = parseArgs(["node", "cli.js", "export", "--out", "config.json"]);
  assert.equal(result.command, "export");
  assert.equal(result.out, "config.json");
});

test("parseArgs parses --out= form into a file path", () => {
  const result = parseArgs(["node", "cli.js", "export", "--out=config.json"]);
  assert.equal(result.out, "config.json");
});

test("parseArgs leaves --out null when not provided", () => {
  const result = parseArgs(["node", "cli.js", "export"]);
  assert.equal(result.out, null);
});

// --- init command: --from ----------------------------------------------------

test("parseArgs parses --from into a file path", () => {
  const result = parseArgs(["node", "cli.js", "init", "--from", "team-config.json"]);
  assert.equal(result.command, "init");
  assert.equal(result.from, "team-config.json");
});

test("parseArgs parses --from= form into a file path", () => {
  const result = parseArgs(["node", "cli.js", "init", "--from=team-config.json"]);
  assert.equal(result.from, "team-config.json");
});

test("parseArgs leaves --from null when not provided", () => {
  const result = parseArgs(["node", "cli.js", "init"]);
  assert.equal(result.from, null);
});


// --- previousTemplateIds (BLOCKING 1 regression) ----------------------------
//
// Reproduces the confirmed bug: with dataverse:dev and dataverse:prod already
// installed (instance-keyed serverIds, no bare "dataverse" entry), the server
// picker initialValues previously filtered templates.map(t => t.id) against a
// Set of raw serverIds, so "dataverse" was never pre-checked and the picker
// showed it unchecked -- unchecking it on apply wiped both instances.

test("previousTemplateIds includes the base template id when only instance-keyed entries exist", () => {
  const previousSelections = [
    { absPath: "/a.json", serverId: "dataverse-dev", templateId: "dataverse" },
    { absPath: "/a.json", serverId: "dataverse-prod", templateId: "dataverse" },
  ];
  const result = previousTemplateIds({ previousSelections, templates: fakeTemplates });
  assert.ok(result.has("dataverse"));
});

test("previousTemplateIds matches what the picker initialValues filter needs: every previously installed template id, base or instanced", () => {
  const previousSelections = [
    { absPath: "/a.json", serverId: "dataverse-dev", templateId: "dataverse" },
    { absPath: "/a.json", serverId: "powerbi", templateId: "powerbi" },
  ];
  const result = previousTemplateIds({ previousSelections, templates: fakeTemplates });
  const templateIds = fakeTemplates.map((t) => t.id).filter((id) => result.has(id));
  assert.deepEqual(templateIds.sort(), ["dataverse", "powerbi"]);
});

test("previousTemplateIds falls back to parsing the base id out of serverId for old manifests without templateId", () => {
  const previousSelections = [{ absPath: "/a.json", serverId: "dataverse-dev" }];
  const result = previousTemplateIds({ previousSelections, templates: fakeTemplates });
  assert.ok(result.has("dataverse"));
});

test("previousTemplateIds is empty for no previous selections", () => {
  const result = previousTemplateIds({ previousSelections: [], templates: fakeTemplates });
  assert.equal(result.size, 0);
});

// --- targetsOutsideFilter (SHOULD-FIX 5 regression: pure predicate) --------

test("targetsOutsideFilter returns an empty array when there is no filter", () => {
  assert.deepEqual(targetsOutsideFilter(["claude-code", "copilot-cli-project"], null), []);
});

test("targetsOutsideFilter returns ids outside the filter when the group is shared by more tools than the filter names", () => {
  const result = targetsOutsideFilter(["claude-code", "copilot-cli-project"], ["claude-code"]);
  assert.deepEqual(result, ["copilot-cli-project"]);
});

test("targetsOutsideFilter returns an empty array when the filter already covers every id sharing the file", () => {
  const result = targetsOutsideFilter(["claude-code", "copilot-cli-project"], ["claude-code", "copilot-cli-project"]);
  assert.deepEqual(result, []);
});

// --- parseArgs value-swallowing (SHOULD-FIX 7 regression) -------------------
//
// Reproduces the confirmed bug: --servers --yes consumed "--yes" as the
// servers value instead of being recognized as its own flag.

test("parseArgs rejects --servers immediately followed by another flag instead of swallowing it", () => {
  const result = parseArgs(["node", "cli.js", "configure", "--servers", "--yes"]);
  assert.deepEqual(result.servers, []);
  assert.equal(result.errors.length, 1);
  assert.match(result.errors[0], /--servers/);
  assert.equal(result.yes, true);
});

test("parseArgs rejects --servers with no following value at all", () => {
  const result = parseArgs(["node", "cli.js", "configure", "--servers"]);
  assert.deepEqual(result.servers, []);
  assert.equal(result.errors.length, 1);
});

test("parseArgs rejects --targets, --out, and --from when each swallows a following flag", () => {
  const targetsResult = parseArgs(["node", "cli.js", "configure", "--targets", "--yes"]);
  assert.equal(targetsResult.errors.length, 1);
  assert.match(targetsResult.errors[0], /--targets/);
  assert.equal(targetsResult.yes, true);

  const outResult = parseArgs(["node", "cli.js", "export", "--out", "--yes"]);
  assert.equal(outResult.errors.length, 1);
  assert.match(outResult.errors[0], /--out/);
  assert.equal(outResult.yes, true);

  const fromResult = parseArgs(["node", "cli.js", "init", "--from", "--dry-run"]);
  assert.equal(fromResult.errors.length, 1);
  assert.match(fromResult.errors[0], /--from/);
  assert.equal(fromResult.dryRun, true);
});

test("parseArgs defaults errors to an empty array for well-formed input", () => {
  const result = parseArgs(["node", "cli.js", "configure", "--servers", "powerbi", "--yes"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.servers, ["powerbi"]);
});

test("parseArgs still accepts --servers= and --out= forms unaffected by the value-swallowing guard", () => {
  const result = parseArgs(["node", "cli.js", "configure", "--servers=powerbi"]);
  assert.deepEqual(result.errors, []);
  assert.deepEqual(result.servers, ["powerbi"]);
});