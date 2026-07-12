# Security Policy

## Supported versions

| Version | Supported |
|---------|-----------|
| Latest 0.x release | Yes |
| Older releases | No — please update to the latest version |

## Reporting a vulnerability

Please report vulnerabilities privately — do not open a public issue.

- Preferred: GitHub private vulnerability reporting on this repository
  (Security tab -> Report a vulnerability).
- Alternatively: email contact@kaelabs.dev.

You can expect an acknowledgement within 72 hours and a status update as the
report is triaged. Verified issues are fixed as quickly as severity warrants,
and reporters are credited in the release notes unless they prefer otherwise.

## Scope

bi-agent-kit writes MCP server entries into local AI tool configuration
files. In scope, for example:

- Anything that causes it to read or write files outside the intended target
  config files (path traversal, symlink or junction escapes).
- Corruption or destructive modification of a user's existing configuration
  beyond entries the tool owns.
- Leakage of secrets entered during setup walkthroughs (into logs, exports,
  backups outside the self-gitignored backup directory, or the manifest).
- Command injection through any user-provided value or template field.
- Supply-chain issues in the publish pipeline or dependency set.

Out of scope: vulnerabilities in the MCP servers the templates install
(Power BI MCP, Azure MCP, and the rest) — report those upstream to their
maintainers; the templates only reference them.

## Design notes for researchers

The security model and its guarantees (manifest-only ownership, collision
refusal, atomic writes, drift detection) are described in the README's
Safety section. The test suite contains adversarial cases for the symlink,
collision, and drift paths — reproductions in that style are especially
easy to act on.
