# Changelog

## 0.1.0 (unreleased)

First version of both packages, `@gaiadesk/sdk` (TypeScript, Node 18+) and
`gaiadesk` (Python 3.9+, sync and asyncio), over `gaiadesk-cli`:

- `devices` / `probe`, `exec` / `execStream`, `shell` / `shellStream`,
  `upload` / `download`, `runJob` / `jobs` / `jobLogs` / `followJobLogs` /
  `killJob`, `stats`, `measure`, `createToken` / `listTokens` / `revokeToken`,
  `audit`, `meshStatus` / `meshIp`, `disconnect`, `forward`, `agentConnect`,
  `mcp()` (a client for `gaiadesk-cli mcp`, MCP 2026-07-28), and `raw()`.
- Typed errors mapped from the CLI's exit codes and `--json` error kinds.
- Credentials passed only through the environment, never argv.
- Locates `gaiadesk-cli` via `$GAIADESK_CLI`, `PATH`, then the standard
  install locations.
- Tests against a fake `gaiadesk-cli` for both languages; CI on Linux,
  macOS and Windows.
