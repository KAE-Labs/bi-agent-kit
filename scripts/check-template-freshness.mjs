#!/usr/bin/env node
// Zero-dependency freshness check for templates/*.json.
//
// For each template whose launch mechanism (config.command/config.args)
// references a package on a public registry, verify the package still
// exists there:
//   - npm packages (launched via `npx`)  -> https://registry.npmjs.org/<name>
//   - PyPI packages (launched via `uvx`) -> https://pypi.org/pypi/<name>/json
//
// Templates with no registry-hosted package (local binaries like `pac`,
// `dab`, or remote/url-based servers like Snowflake) are skipped with a
// printed reason.
//
// Exit code is nonzero if any lookup 404s or errors.

import { readdir, readFile } from "node:fs/promises";
import { fileURLToPath } from "node:url";
import path from "node:path";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const templatesDir = path.join(__dirname, "..", "templates");

// Fallback map: template id -> { registry, name }. Used only when the
// package name cannot be derived from config.command/config.args.
const FALLBACK_MAP = {
  powerbi: { registry: "npm", name: "@microsoft/powerbi-modeling-mcp" },
  dataverse: { registry: "npm", name: "@microsoft/dataverse" },
  fabric: { registry: "npm", name: "@microsoft/fabric-mcp" },
  azure: { registry: "npm", name: "@azure/mcp" },
  dbt: { registry: "pypi", name: "dbt-mcp" },
  postgres: { registry: "pypi", name: "postgres-mcp" },
};

/**
 * Strip a trailing @version/@tag from an npm package spec, keeping the
 * leading @scope if present.
 * e.g. "@azure/mcp@latest" -> "@azure/mcp", "@microsoft/dataverse" -> unchanged
 */
function stripNpmVersion(spec) {
  const scoped = spec.startsWith("@");
  const body = scoped ? spec.slice(1) : spec;
  const atIndex = body.indexOf("@");
  if (atIndex === -1) return spec;
  return (scoped ? "@" : "") + body.slice(0, atIndex);
}

/**
 * Derive the registry package referenced by a template's launch config,
 * by inspecting config.command / config.args.
 * Returns { registry: "npm"|"pypi", name } or null if no registry
 * package is referenced by this launch mechanism (e.g. a local binary
 * or a remote url-based server).
 */
function derivePackage(config) {
  if (!config || typeof config !== "object") return null;
  const { command, args } = config;
  if (!command || !Array.isArray(args)) return null;

  if (command === "npx") {
    const spec = args.find((a) => typeof a === "string" && !a.startsWith("-"));
    if (!spec) return null;
    return { registry: "npm", name: stripNpmVersion(spec) };
  }

  if (command === "uvx") {
    const spec = args.find((a) => typeof a === "string" && !a.startsWith("-"));
    if (!spec) return null;
    return { registry: "pypi", name: spec };
  }

  // Local binaries (pac, dab, ...) are not registry packages.
  return null;
}

async function checkNpm(name) {
  const url = `https://registry.npmjs.org/${encodeURIComponent(name).replace("%40", "@")}`;
  const res = await fetch(url);
  if (res.status === 404) {
    return { ok: false, reason: `npm registry 404 for ${name}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `npm registry returned HTTP ${res.status} for ${name}` };
  }
  const body = await res.json();
  const latest = body?.["dist-tags"]?.latest;
  if (!latest) {
    return { ok: false, reason: `npm registry response for ${name} has no dist-tags.latest` };
  }
  return { ok: true, detail: `dist-tags.latest=${latest}` };
}

async function checkPyPI(name) {
  const url = `https://pypi.org/pypi/${encodeURIComponent(name)}/json`;
  const res = await fetch(url);
  if (res.status === 404) {
    return { ok: false, reason: `PyPI JSON API 404 for ${name}` };
  }
  if (!res.ok) {
    return { ok: false, reason: `PyPI JSON API returned HTTP ${res.status} for ${name}` };
  }
  const body = await res.json();
  const version = body?.info?.version;
  if (!version) {
    return { ok: false, reason: `PyPI JSON API response for ${name} has no info.version` };
  }
  return { ok: true, detail: `latest version=${version}` };
}

async function main() {
  const files = (await readdir(templatesDir)).filter((f) => f.endsWith(".json")).sort();

  let hadFailure = false;

  for (const file of files) {
    const filePath = path.join(templatesDir, file);
    let template;
    try {
      template = JSON.parse(await readFile(filePath, "utf8"));
    } catch (err) {
      console.error(`[FAIL] ${file}: could not parse JSON (${err.message})`);
      hadFailure = true;
      continue;
    }

    const id = template.id ?? path.basename(file, ".json");

    let pkg = derivePackage(template.config);
    if (!pkg && FALLBACK_MAP[id]) {
      pkg = FALLBACK_MAP[id];
    }

    if (!pkg) {
      console.log(`[SKIP] ${id}: no registry package referenced by launch mechanism (local binary or remote/url-based server)`);
      continue;
    }

    try {
      const result = pkg.registry === "npm" ? await checkNpm(pkg.name) : await checkPyPI(pkg.name);
      if (result.ok) {
        console.log(`[OK]   ${id}: ${pkg.registry} package "${pkg.name}" exists (${result.detail})`);
      } else {
        console.error(`[FAIL] ${id}: ${pkg.registry} package "${pkg.name}" -- ${result.reason}`);
        hadFailure = true;
      }
    } catch (err) {
      console.error(`[FAIL] ${id}: error checking ${pkg.registry} package "${pkg.name}" -- ${err.message}`);
      hadFailure = true;
    }
  }

  if (hadFailure) {
    console.error("\nOne or more template packages could not be verified against their registry.");
    process.exit(1);
  } else {
    console.log("\nAll template registry packages verified successfully.");
  }
}

main().catch((err) => {
  console.error(`Unexpected error: ${err.stack ?? err.message}`);
  process.exit(1);
});
