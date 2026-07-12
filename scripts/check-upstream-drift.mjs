// Watches upstream for two kinds of drift, alerting via nonzero exit:
//  1. New or removed servers in Microsoft's MCP catalog (microsoft/mcp README)
//     -- candidates for new bi-agent-kit templates.
//  2. Major-version jumps in the registry packages our templates launch
//     -- a signal to re-verify template commands and args.
// State lives in data/upstream-state.json (committed). Exit codes:
//  0 = no drift (or state just seeded), 1 = script error, 2 = drift detected.
import { promises as fs } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, "..");
const statePath = path.join(root, "data", "upstream-state.json");
const CATALOG_URL = "https://raw.githubusercontent.com/microsoft/mcp/main/README.md";

async function fetchCatalogServers() {
  const res = await fetch(CATALOG_URL);
  if (!res.ok) throw new Error("catalog fetch failed: HTTP " + res.status);
  const text = await res.text();
  const sectionStart = text.indexOf("Which MCP Servers are available from Microsoft");
  const section = sectionStart === -1 ? text : text.slice(sectionStart);
  const names = [];
  for (const line of section.split("\n")) {
    const m = line.match(/^###\s+(.*)$/);
    if (!m) continue;
    const clean = m[1]
      .replace(/<img[^>]*>/g, "")
      .replace(/[^\x20-\x7E]/g, "")
      .trim();
    if (clean) names.push(clean);
  }
  return [...new Set(names)].sort();
}

function derivePackage(config) {
  if (!config || typeof config.command !== "string") return null;
  const args = Array.isArray(config.args) ? config.args : [];
  if (config.command === "npx") {
    const arg = args.find((a) => !a.startsWith("-"));
    if (!arg) return null;
    const name = arg.startsWith("@")
      ? arg.replace(/(@[^/]+\/[^@]+)@.*$/, "$1")
      : arg.replace(/@[^@]*$/, "");
    return { registry: "npm", name };
  }
  if (config.command === "uvx") {
    const arg = args.find((a) => !a.startsWith("-"));
    return arg ? { registry: "pypi", name: arg } : null;
  }
  return null;
}

async function fetchMajor(pkg) {
  if (pkg.registry === "npm") {
    const res = await fetch("https://registry.npmjs.org/" + pkg.name);
    if (!res.ok) throw new Error(pkg.name + ": HTTP " + res.status);
    const data = await res.json();
    return String(data["dist-tags"].latest).split(".")[0];
  }
  const res = await fetch("https://pypi.org/pypi/" + pkg.name + "/json");
  if (!res.ok) throw new Error(pkg.name + ": HTTP " + res.status);
  const data = await res.json();
  return String(data.info.version).split(".")[0];
}

async function collectMajors() {
  const templatesDir = path.join(root, "templates");
  const files = (await fs.readdir(templatesDir)).filter((f) => f.endsWith(".json"));
  const majors = {};
  for (const file of files) {
    const template = JSON.parse(await fs.readFile(path.join(templatesDir, file), "utf8"));
    const pkg = derivePackage(template.config);
    if (pkg) majors[pkg.registry + ":" + pkg.name] = await fetchMajor(pkg);
  }
  return majors;
}

const current = {
  catalog: await fetchCatalogServers(),
  majors: await collectMajors(),
};

let previous = null;
try {
  previous = JSON.parse(await fs.readFile(statePath, "utf8"));
} catch {
  // no state yet
}

if (previous === null) {
  await fs.mkdir(path.dirname(statePath), { recursive: true });
  await fs.writeFile(statePath, JSON.stringify(current, null, 2) + "\n");
  console.log("Seeded upstream state:", current.catalog.length, "catalog servers,", Object.keys(current.majors).length, "tracked packages.");
  process.exit(0);
}

const report = [];
const added = current.catalog.filter((n) => !previous.catalog.includes(n));
const removed = previous.catalog.filter((n) => !current.catalog.includes(n));
if (added.length) report.push("New servers in the Microsoft MCP catalog (template candidates): " + added.join(", "));
if (removed.length) report.push("Servers removed from the Microsoft MCP catalog: " + removed.join(", "));
for (const [key, major] of Object.entries(current.majors)) {
  const prev = previous.majors[key];
  if (prev !== undefined && prev !== major) {
    report.push("Major version change for " + key + ": " + prev + " -> " + major + " (re-verify the template command and args)");
  }
}

if (report.length === 0) {
  console.log("No upstream drift.");
  process.exit(0);
}

await fs.writeFile(statePath, JSON.stringify(current, null, 2) + "\n");
console.log(report.join("\n"));
process.exit(2);
