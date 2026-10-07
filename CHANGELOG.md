# Changelog

## 0.1.0 (unreleased)

- A native backend: when `@gaiadesk/sdk-native` (an optional dependency,
  GaiaDesk's client library as a prebuilt binary) is installed, every method
  runs on it instead of spawning `gaiadesk-cli`. Same results, same error
  classes and kinds. `backend` option / `GAIADESK_SDK_BACKEND`
  (`auto` | `native` | `cli`), `gd.backend`, `native` to inject a module.
  `raw()` and `mcp()` stay on the CLI. Streams are typed `OutputStream`
  (CliStream implements it).

First version of `@gaiadesk/sdk` (TypeScript, Node 18+), over `gaiadesk-cli`:

- `devices` / `probe`, `exec` / `execStream`, `shell` / `shellStream`,
  `upload` / `download`, `runJob` / `jobs` / `jobLogs` / `followJobLogs` /
  `killJob`, `stats`, `measure`, `createToken` / `listTokens` / `revokeToken`,
  `audit`, `meshStatus` / `meshIp`, `disconnect`, `forward`, `agentConnect`,
  `mcp()` (a client for `gaiadesk-cli mcp`, MCP 2026-07-28), and `raw()`.
- Typed results (the CLI's JSON, field for field) and typed errors mapped
  from the CLI's exit codes and `--json` error kinds. Every error envelope
  the CLI prints is read in one place (`errorEnvelope`).
- `McpClient.callTool` accepts tool names with a dot or an underscore
  (`gaiadesk.exec` / `gaiadesk_exec`) and sends the spelling the server
  advertises.
- Credentials passed only through the environment, never argv.
- Locates `gaiadesk-cli` via `$GAIADESK_CLI`, `PATH`, then the standard
  install locations.
- Tests (TypeScript, `node:test`) against a fake `gaiadesk-cli`; CI on
  Linux, macOS and Windows with Node 18, 20 and 22.
- This repository was `Gaia-Desk/gaiadesk-sdk`, which held both SDKs; the
  Python SDK now lives in
  [Gaia-Desk/gaiadesk-python](https://github.com/Gaia-Desk/gaiadesk-python).
