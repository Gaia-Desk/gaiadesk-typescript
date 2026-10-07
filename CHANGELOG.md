# Changelog

## Unreleased: gaiadesk-cli 0.10.324

- **API transport.** `new GaiaDesk({ apiKey, deskToken?, baseUrl? })` drives
  desks through GaiaDesk's hosted API (`https://api.gaiadesk.net/v1`) with
  the global `fetch` only: no gaiadesk-cli, no native binary. Same method
  names, result shapes and error classes/kinds for what the API serves
  (`devices`, `exec`, `execStream` over SSE, `runJob`, `jobs`, `killJob`,
  `jobLogs`, `followJobLogs` over SSE, `stats`, single-file `upload` /
  `download` up to 256 MB, `createToken`, `listTokens`, `revokeToken`), plus
  `uploadBytes` / `downloadBytes`; everything else is a `UsageError` saying
  it is not available over the API transport. Per call, `deskToken` and
  `wake` (`wake_s`). Errors gain `status`, `requestId` and `retryAfter`
  (null on the other backends). `backend` is `'api'` for such a client.
  Constructing without `apiKey` behaves exactly as before.
- `@gaiadesk/cli` (the `gaiadesk-cli` command line, prebuilt per platform) is
  an optional dependency, and `locateCli` tries its binary right after
  `$GAIADESK_CLI`, before `PATH`: `npm install @gaiadesk/sdk` works with
  nothing else installed. `npmCliBinary()` is exported.
- Result types are generated from GaiaDesk's JSON Schema of every `--json`
  shape (`src/types.generated.ts`). The public names (`ExecResult`,
  `JobInfo`, `DeskStats`, `TokenInfo`, ...) are kept as aliases; every schema
  type is also exported in the `Schema` namespace, and `CliError`,
  `CliErrorKind`, `CliErrorEnvelope`, `ExecEvent`, `ExecExit`, `VersionInfo`,
  `JobList`, `TokenList`, `AuditLog`, `JobLogs` are new. `ExecResult.error`
  is `null` or `{kind, message, reason?, desk?}`.
- Errors: the one error envelope, `{"error": {kind, message, reason?,
  desk?}}`, is read for every command. The class follows the envelope's kind
  (`failed` is `OperationFailedError`, `protocol` is `ProtocolError`); the
  SDK `kind` is the `reason` when it is an SDK kind, so `offline` stays
  `offline`. Every error has `reason` and `desk` (null when not given),
  on both backends.
- `cwd` option for `exec`, `execStream` and `runJob` (`--cwd` on the CLI,
  `cwd` on the native library). On a CLI without the `exec_cwd` / `run_cwd`
  feature it is a `UsageError` saying to update gaiadesk-cli, never ignored.
- `execStream` runs `exec --json-stream`: the same chunks, and `wait()`'s
  exit carries the run's `result` (an `ExecExit`) and `error`. Native
  streams fill `result` / `error` too.
- Feature detection: `versionInfo()` (`--version --json`) and `features()`,
  asked once per CLI path.
- `jobLogs`, `followJobLogs`, `meshIp`, `disconnect` and `agentConnect` use
  the `--json` forms, so their failures are typed by the error envelope.
  `disconnect()` returns `{closed: [...]}` (both backends); a
  `followJobLogs` failure is on `wait()`'s `error`.
- `cwd` for `shell` and `shellStream` (`shell --cwd`, feature `shell_cwd`;
  a CLI without it is a `UsageError`).
- `createToken` returns the generated `MintResult`, or with `out` the
  generated `TokenFileResult` (`{tokens[{desk, token}], file}`); the
  hand-written `TokenCreateResult` is now their union. `MeshIp`,
  `Disconnected` and `AgentCheck` are exported.
- `jobs()`, `listTokens()` and `audit()` read the `{"jobs"}` / `{"tokens"}`
  / `{"events"}` objects; `jobLogs()` and `meshIp()` read `{output}` /
  `{mesh_ip}`.
- MCP: `GAIADESK_TOOLS` lists the `gaiadesk_*` tool names; docs and
  examples use them, and `callTool` sends the name as given.
- Tests: example desk ids are 123456789 / 234567890 / 345678901 only; the
  real-binary test takes its stub desk ids from `GAIADESK_SDK_NATIVE_DESKS`.

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
- Credentials passed only through the environment, never argv.
- Locates `gaiadesk-cli` via `$GAIADESK_CLI`, `PATH`, then the standard
  install locations.
- Tests (TypeScript, `node:test`) against a fake `gaiadesk-cli`; CI on
  Linux, macOS and Windows with Node 18, 20 and 22.
- This repository was `Gaia-Desk/gaiadesk-sdk`, which held both SDKs; the
  Python SDK now lives in
  [Gaia-Desk/gaiadesk-python](https://github.com/Gaia-Desk/gaiadesk-python).
