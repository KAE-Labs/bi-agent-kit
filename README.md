# bi-agent-kit

Installs BI related MCP server entries into the config files of the AI coding tools you already
use, without ever touching anything else already in those files.

## Usage

No install step required.

    npx bi-agent-kit init

Detects which supported AI tool config files exist in your project and your home directory, lets
you pick which BI servers to add to which of them, and writes a manifest so it can cleanly add or
remove entries later.

    npx bi-agent-kit configure

Re-opens the same picker with your current selections pre-checked, adds anything newly selected,
and removes anything you deselect, as long as that entry has not been hand edited since install.

    npx bi-agent-kit list

Shows what bi-agent-kit currently has installed, and where.

Add `--dry-run` to `init` or `configure` to preview exactly what would be written or removed
without touching any file.

## Supported AI tools

Claude Code, Claude Desktop, Cursor, Gemini CLI, GitHub Copilot CLI, the GitHub Copilot VS Code
extension, and OpenAI Codex CLI, at both project and user scope where each tool supports it.

## Supported BI servers

Power BI MCP, Dataverse MCP, PAC CLI MCP, and Fabric MCP, all official Microsoft first party
servers.

## Coming soon

ChatGPT desktop and Grok Build support are planned but not yet shipped. Ollama and Meta AI are not
included because neither currently exposes a local file based MCP client configuration to write
into.

## Safety

bi-agent-kit never overwrites a config entry it does not already own. If a key it wants to write
already exists and was not created by bi-agent-kit, it stops and reports a conflict for that one
entry instead of overwriting it. Every write is atomic, and the first time a target file is
touched a backup copy is kept alongside it. If a config file you are about to run init against
already has hand configured secrets in it, make sure your gitignore covers *.bak before running.

## License

MIT
