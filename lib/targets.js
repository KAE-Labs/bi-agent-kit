import path from "node:path";

function claudeDesktopPath(homedir, platform) {
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "Claude", "claude_desktop_config.json");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(homedir, "AppData", "Roaming");
    return path.join(appData, "Claude", "claude_desktop_config.json");
  }
  return null;
}

function vsCodeUserDir(homedir, platform) {
  if (platform === "darwin") {
    return path.join(homedir, "Library", "Application Support", "Code", "User");
  }
  if (platform === "win32") {
    const appData = process.env.APPDATA || path.join(homedir, "AppData", "Roaming");
    return path.join(appData, "Code", "User");
  }
  return path.join(homedir, ".config", "Code", "User");
}

export const TARGET_DEFINITIONS = [
  {
    id: "claude-code",
    rootLevel: true,
    label: "Claude Code (project)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd) {
      return path.join(cwd, ".mcp.json");
    },
  },
  {
    id: "claude-code-user",
    rootLevel: true,
    label: "Claude Code (user)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd, homedir) {
      return path.join(homedir, ".claude.json");
    },
  },
  {
    id: "claude-desktop",
    label: "Claude Desktop (user)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd, homedir, platform) {
      return claudeDesktopPath(homedir, platform);
    },
  },
  {
    id: "cursor-project",
    label: "Cursor (project)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd) {
      return path.join(cwd, ".cursor", "mcp.json");
    },
  },
  {
    id: "cursor-user",
    label: "Cursor (user)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd, homedir) {
      return path.join(homedir, ".cursor", "mcp.json");
    },
  },
  {
    id: "gemini-project",
    label: "Gemini CLI (project)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd) {
      return path.join(cwd, ".gemini", "settings.json");
    },
  },
  {
    id: "gemini-user",
    label: "Gemini CLI (user)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd, homedir) {
      return path.join(homedir, ".gemini", "settings.json");
    },
  },
  {
    id: "copilot-cli-project",
    rootLevel: true,
    label: "GitHub Copilot CLI (project)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd) {
      return path.join(cwd, ".mcp.json");
    },
  },
  {
    id: "copilot-cli-user",
    label: "GitHub Copilot CLI (user)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd, homedir) {
      return path.join(homedir, ".copilot", "mcp-config.json");
    },
  },
  {
    id: "copilot-vscode-workspace",
    label: "GitHub Copilot, VS Code extension (workspace)",
    shape: "json",
    rootKey: "servers",
    resolve(cwd) {
      return path.join(cwd, ".vscode", "mcp.json");
    },
  },
  {
    id: "copilot-vscode-user",
    label: "GitHub Copilot, VS Code extension (user)",
    shape: "json",
    rootKey: "servers",
    resolve(cwd, homedir, platform) {
      const dir = vsCodeUserDir(homedir, platform);
      return dir ? path.join(dir, "mcp.json") : null;
    },
  },
  {
    id: "codex-project",
    label: "OpenAI Codex CLI (project)",
    shape: "toml",
    resolve(cwd) {
      return path.join(cwd, ".codex", "config.toml");
    },
  },
  {
    id: "codex-user",
    label: "OpenAI Codex CLI (user)",
    shape: "toml",
    resolve(cwd, homedir) {
      return path.join(homedir, ".codex", "config.toml");
    },
  },
  {
    id: "windsurf-user",
    label: "Windsurf (user)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd, homedir) {
      return path.join(homedir, ".codeium", "windsurf", "mcp_config.json");
    },
  },
  {
    id: "roo-code-project",
    label: "Roo Code (project)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd) {
      return path.join(cwd, ".roo", "mcp.json");
    },
  },
  {
    id: "junie-project",
    label: "JetBrains Junie (project)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd) {
      return path.join(cwd, ".junie", "mcp", "mcp.json");
    },
  },
  {
    id: "junie-user",
    label: "JetBrains Junie (user)",
    shape: "json",
    rootKey: "mcpServers",
    resolve(cwd, homedir) {
      return path.join(homedir, ".junie", "mcp", "mcp.json");
    },
  },
];

export function resolveTargets(cwd, homedir, platform) {
  const resolved = [];
  for (const def of TARGET_DEFINITIONS) {
    const absPath = def.resolve(cwd, homedir, platform);
    if (!absPath) continue;
    resolved.push({
      id: def.id,
      label: def.label,
      shape: def.shape,
      rootKey: def.rootKey,
      rootLevel: Boolean(def.rootLevel),
      absPath,
    });
  }
  const groups = new Map();
  for (const target of resolved) {
    if (!groups.has(target.absPath)) {
      groups.set(target.absPath, []);
    }
    groups.get(target.absPath).push(target);
  }
  const deduped = [];
  for (const [absPath, group] of groups) {
    deduped.push({
      absPath,
      shape: group[0].shape,
      rootKey: group[0].rootKey,
      rootLevel: group.some((t) => t.rootLevel),
      targetIds: group.map((t) => t.id),
      labels: group.map((t) => t.label),
    });
  }
  return deduped;
}
