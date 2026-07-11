<div align="center">
  <img src=".github/banner.png" alt="BI Agent Kit -- configurable MCP starter kit for AI-powered BI development" width="100%" />
</div>

# bi-agent-kit

**A configurable installer for AI-agent tooling aimed at Business Intelligence work.**

`bi-agent-kit` installs BI-related MCP server entries into the config files of the AI coding tools you already use -- Claude Code, Cursor, Gemini CLI, GitHub Copilot, and more -- without ever touching anything else already in those files.

Pick the servers you want, pick which tools to wire them into, and `bi-agent-kit` handles the rest: safe merges, atomic writes, and a manifest so entries can be cleanly added or removed later.

## Usage

No install step required.

```
npx bi-agent-kit init
```

Detects which supported AI tool config files exist in your project and your home directory, lets you pick which BI servers to add to which of them, and writes a manifest so it can cleanly add or remove entries later.

```
npx bi-agent-kit configure
```

Re-opens the same picker with current selections pre-checked, adds anything newly selected, and removes anything deselected -- as long as that entry has not been hand-edited since install.

```
npx bi-agent-kit list
```

Shows what `bi-agent-kit` currently has installed, and where.

Add `--dry-run` to `init` or `configure` to preview exactly what would be written or removed without touching any file.

## Supported AI tools

| Tool | Scope |
|---|---|
| Claude Code | project |
| Claude Desktop | user |
| Cursor | project + user |
| Gemini CLI | project + user |
| GitHub Copilot CLI | project + user |
| GitHub Copilot -- VS Code extension | workspace + user |
| OpenAI Codex CLI | project + user |

## Supported BI servers

- **Power BI MCP** -- semantic model authoring (TMSL/TOM)
- **Dataverse MCP** -- Dataverse hosted MCP endpoint
- **PAC CLI MCP** -- built into the Power Platform CLI
- **Fabric MCP** -- Fabric REST APIs, item definitions, workspace operations

All four are official, first-party Microsoft servers.

## Coming soon

ChatGPT desktop and Grok Build support are planned but not yet shipped. Ollama and Meta AI are not included because neither currently exposes a local, file-based MCP client configuration to write into.

## Safety

`bi-agent-kit` never overwrites a config entry it does not already own. If a key it wants to write already exists and was not created by `bi-agent-kit`, it stops and reports a conflict for that one entry instead of overwriting it. Every write is atomic, and the first time a target file is touched, a backup copy is kept alongside it.

If a config file you are about to run `init` against already has hand-configured secrets in it, make sure your `.gitignore` covers `*.bak` before running.

## License

MIT

---

Built by [KAE Labs](https://kaelabs.dev) -- an independent studio for applied AI, data, and software.
