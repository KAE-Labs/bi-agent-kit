import { parse, stringify } from "smol-toml";

export function readTomlServers(fileText) {
  if (!fileText || fileText.trim().length === 0) return {};
  const parsed = parse(fileText);
  if (!parsed || typeof parsed !== "object") return {};
  const servers = parsed.mcp_servers;
  if (!servers || typeof servers !== "object") return {};
  return servers;
}

function findServerBlockRange(lines, serverKey) {
  const header = "[mcp_servers." + serverKey + "]";
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === header) {
      start = i;
      break;
    }
  }
  if (start === -1) return null;
  let end = lines.length;
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].startsWith("[")) {
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
  const snippet = stringify({ mcp_servers: { [serverKey]: serverValue } });
  const base = withoutOldBlock.length > 0 && !withoutOldBlock.endsWith("\n")
    ? withoutOldBlock + "\n"
    : withoutOldBlock;
  const separator = base.length > 0 ? "\n" : "";
  return base + separator + snippet;
}
