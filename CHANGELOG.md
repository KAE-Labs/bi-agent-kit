# Changelog

All notable changes to bi-agent-kit are documented here. The format follows
Keep a Changelog, and the project follows semantic versioning.

## 0.1.1 - 2026-07-13

### Fixed

- Interactive `init` / `configure` no longer completes silently when servers
  are selected but no config file is chosen to install into. The target
  prompt now warns that nothing would be written (and no setup steps would
  run), then re-prompts, with a confirmation escape hatch for the rare case
  of intentionally installing nothing.

## 0.1.0 - 2026-07-12

Initial public release.

### Added

- Interactive installer (`init` / `configure`) that wires BI-focused MCP
  servers into the config files of ten AI coding tools (Claude Code project
  and user scope, Claude Desktop, Cursor, Gemini CLI, GitHub Copilot CLI, the
  GitHub Copilot VS Code extension, OpenAI Codex CLI, Windsurf, Roo Code, and
  JetBrains Junie) without touching anything else in those files.
- Nine verified server templates: Power BI MCP, Dataverse MCP, PAC CLI MCP,
  Fabric MCP, Azure MCP, dbt MCP, SQL Server MCP, Snowflake MCP, and
  Postgres MCP.
- Named instances (`dataverse:dev`, `dataverse:prod`) for multi-environment
  and multi-account setups of any server, with independent setup values.
- `reconfigure` command to re-prompt a server's setup values in place, with
  drift detection and confirmation before overwriting hand-edits.
- `remove` command with exact instance matching, shared-file warnings, and
  dry-run support.
- Team config sharing: `export` writes a portable, secret-free selection
  document; `init --from` imports it additively on another machine.
- `doctor` command that health-checks the manifest, installed entries,
  required CLIs, unfilled placeholders, and stale locks.
- Non-interactive mode (`--servers`, `--targets`, `--yes`, `--prune`,
  `--json`) for scripts and CI; additive by default, destructive only with
  an explicit `--prune`.
- Prerequisite handling: missing `pac`, `dab`, or `uvx` CLIs get an offer to
  install them, and PAC CLI gets a guided `pac auth` profile walkthrough.
- Safety layer: collision detection against entries bi-agent-kit does not
  own, format-preserving JSON and TOML edits, atomic writes, symlink and
  junction refusal, self-gitignoring backups on first touch, a lockfile
  against concurrent runs, and a warning when a secret lands in a
  non-gitignored project file.
