import { parse, stringify } from "smol-toml";

export function readTomlServers(fileText) {
  if (!fileText || fileText.trim().length === 0) return {};
  const parsed = parse(fileText);
  if (!parsed || typeof parsed !== "object") return {};
  const servers = parsed.mcp_servers;
  if (!servers || typeof servers !== "object") return {};
  return servers;
}

function headerMatches(line, header) {
  const trimmed = line.trim();
  if (trimmed === header) return true;
  if (trimmed.startsWith(header)) {
    const rest = trimmed.slice(header.length).trim();
    return rest.startsWith("#");
  }
  return false;
}

function isBlockBoundary(line, serverKey) {
  const trimmed = line.trim();
  if (!trimmed.startsWith("[")) return false;
  const subTablePrefix = "[mcp_servers." + serverKey + ".";
  const subArrayPrefix = "[[mcp_servers." + serverKey + ".";
  return !trimmed.startsWith(subTablePrefix) && !trimmed.startsWith(subArrayPrefix);
}

function findServerBlockRange(lines, serverKey) {
  const header = "[mcp_servers." + serverKey + "]";
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (headerMatches(lines[i], header)) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (isBlockBoundary(lines[i], serverKey)) {
      end = i;
      break;
    }
  }
  return { start, end };
}

export function removeTomlServer(fileText, serverKey) {
  if (!fileText) return fileText;
  const lines = fileText.split("\n");
  const range = findServerBlockRange(lines, serverKey);
  if (range === null) return fileText;
  const before = lines.slice(0, range.start);
  const after = lines.slice(range.end);
  while (before.length > 0 && before[before.length - 1].trim() === "") {
    before.pop();
  }
  const combined = before.concat(after);
  return combined.join("\n");
}

export function setTomlServer(fileText, serverKey, serverValue) {
  const withoutOldBlock = removeTomlServer(fileText || "", serverKey);
  const rawSnippet = stringify({ mcp_servers: { [serverKey]: serverValue } });
  // Drop the bare parent [mcp_servers] header line smol-toml emits: appending it
  // to a file that already has one produces invalid TOML (table redefinition),
  // and [mcp_servers.<key>] alone implicitly defines the parent table anyway.
  const snippet = rawSnippet
    .split("\n")
    .filter((line) => line.trim() !== "[mcp_servers]")
    .join("\n");
  const base = withoutOldBlock.length > 0 && !withoutOldBlock.endsWith("\n")
    ? withoutOldBlock + "\n"
    : withoutOldBlock;
  const separator = base.length > 0 ? "\n" : "";
  return base + separator + snippet;
}
