# Changelog

## 0.1.2

- Administrator work (root / SYSTEM) is not available over any API: the
  hosted API and a desk's own API (local, lan) refuse an exec with
  `admin: true` (200, exit 254, before anything runs) and a token minted
  with the `admin` scope (403), both with reason `admin_not_via_api`, which
  the SDK reports as a `RefusedError` (kind `refused`; a stream ends with
  that error, exit 254). Run administrator work with
  `gaiadesk-cli exec --admin` (or MCP). The SDK never had an `admin` exec
  option or an `admin` scope constant, so no API changes; asking for the
  `admin` scope through `createToken` over the API is now refused by the
  server. Nothing landed on main after v0.1.1 besides this.

## 0.1.1

### retries: one rule in every GaiaDesk SDK

- api, local and lan transports: option `retry: { maxRetries, baseDelayMs,
  maxDelayMs, maxRetryWaitMs }` (defaults 2 / 250 / 8000 / 60000;
  `maxRetries: 0` turns retries off; negative, fractional `maxRetries` or
  non-numbers are a `UsageError`). Before, the SDK never sent a request
  again; now it does exactly when that cannot run anything twice:
  - a connection never made (DNS, refused, a TLS handshake cut off, a local
    socket or pipe not there): any method;
  - a connection lost after sending, or 502, 503, 504: GETs only (a 503
    `api_disabled`, `desk_ops_disabled` or `local_api_off` is final);
  - 429 (`rate_limited`, `desk_busy`) and 409 `idempotency_key_in_flight`:
    any method.
  Never: timeouts, anything whose answer has begun, a POST / PUT / DELETE
  that may have reached the server, any other status.
- 429 and 503 wait for `Retry-After`; one longer than `maxRetryWaitMs` is
  thrown at once, carrying it. Otherwise backoff: min(`maxDelayMs`,
  `baseDelayMs` × 2^n) × a random 0.5–1.0. A sealed operation is sealed
  afresh for each attempt; the caller's `signal` ends a wait at once.
- `idempotencyKey` per call (POST only; not sent for streams): the
  `Idempotency-Key` header. It never makes a call retryable.
- A fetch failure's message now names its cause
  (`fetch failed: connect ECONNREFUSED …`); a connect timeout is kind
  `timeout`.
- Proven on the raw-socket server: refused then appearing (one POST
  arrives), close/reset before any answer, 502/503/504, permanent 503,
  `Retry-After` honoured and over the cap, 429, 409, a kept-alive connection
  dropped under the next request (GET sent again, DELETE/POST/PUT never),
  retries off, and the local transport's socket appearing late. New exports
  `RetryOptions`, `DEFAULT_RETRY`.

### never hang on a dropped or stalled connection

- api, local and lan transports: option `timeouts: { responseTimeoutMs,
  idleTimeoutMs }` (milliseconds; `null` or `Infinity`: no limit; zero,
  negative or non-numbers are a `UsageError`). `responseTimeoutMs` (default
  16 minutes, above the API's 15-minute call limit) bounds the wait for an
  answer to begin, sending the request included: exceeded, an
  `UnreachableError` with kind and reason `timeout`. `idleTimeoutMs`
  (default 90 s; streams and held waits keep alive every 15 s) bounds every
  read of a body (JSON, error bodies, downloads plain and sealed, event
  streams, held waits): exceeded, a `ConnectionLostError` with kind
  `timeout`, and a stream ends with `error.kind` `connection_lost`, reason
  `timeout`, exit 255. Before, a server or proxy that went silent hung the
  call until undici's own 300-second limits (api) or forever (local, lan).
- Either timeout aborts the request, so its connection is abandoned, never
  reused; neither is retried. A connection closed or reset before any answer
  is an `UnreachableError` (kind `network`) at once; fetch re-sends nothing
  on its own (see retries above for what the SDK sends again). A body cut
  off mid-way is a `ConnectionLostError` (kind `network`); the caller's
  `signal` still ends a call mid-body (kind `interrupted`).
- A stream ended by a transport error reports its kind by the error's class
  (`unreachable`, `connection_lost`, `refused`, `failed`, `usage`,
  `protocol`).
- Proven on a raw-socket test server (`node:net`): closed or reset before
  any response byte (with and without reading a 4 MiB upload), stalled
  mid-body, mid-JSON, mid-stream, silent, a slow body that keeps flowing,
  and a 300-request stress run; over fetch and over the local transport's
  Unix socket. New exports `TimeoutOptions`, `DEFAULT_RESPONSE_TIMEOUT_MS`,
  `DEFAULT_IDLE_TIMEOUT_MS`.

### end-to-end encrypted desk operations

- API transport: desk operations (exec, execStream, jobs, logs, waitJob,
  killJob, stats, upload/download, tokens) are sealed end to end to the
  desk's X25519 key (`e2e_pub`): the hosted API relays ciphertext only, and
  every result, stream event and error is what the plaintext call gives. The
  protocol's fixed test vectors are reproduced byte for byte.
- Options `e2e: 'auto' | 'require' | 'off'` (default `auto`: sealed when the
  desk lists a key, else plaintext with a one-time warning, unless the desk
  requires it), `e2eKeys` (pinned desk keys), `onWarning`. New error
  `E2eError` (a `RefusedError`: `e2e_unavailable`, `e2e_key_mismatch`).
  One retry each for `e2e_required` and a rotated key (`e2e_decrypt_failed`).
- New runtime dependency `@noble/ciphers` ^1.3.0, for XChaCha20-Poly1305 only
  (neither node:crypto nor WebCrypto has it): MIT, zero dependencies,
  Cure53-audited, Node 16+ (2.x would need Node 20.19). X25519 and HKDF come
  from node:crypto or WebCrypto.
- `native: null` makes the client behave as if `@gaiadesk/sdk-native` were not
  installed (the tests that need it absent no longer depend on what npm
  installed).

### local and lan transports

- `new GaiaDesk({ transport: 'local' })`: code running on a desk drives it
  (and what it reaches) through the GaiaDesk app's own `/v1` API over its
  Unix socket (`$GAIADESK_API_DIR/api.sock`, else `~/.gaiadesk/api.sock`) or
  Windows named pipe (`$GAIADESK_API_PIPE`, else
  `\\.\pipe\gaiadesk-api-<user>`); `socketPath` overrides. An agent token
  (`deskToken`) goes as `X-GaiaDesk-Desk-Token`; otherwise the desk's local
  admin token (from `api-token` beside the socket, or `token`) as Bearer. No
  socket: `UnreachableError`, reason `local_api_unavailable`.
- `new GaiaDesk({ transport: 'lan', baseUrl, fingerprint, deskToken })`: a
  desk's LAN gateway over HTTPS, its self-signed certificate pinned by
  SHA-256 before any request byte is sent (`FingerprintMismatchError`,
  reason `fingerprint_mismatch`, on a mismatch); agent tokens only.
- Both reuse the API transport's operations unchanged (same results, errors,
  SSE streams, file transfer, held waits) over a `node:http` connection;
  `backend` is `'local'` / `'lan'`. `transport` may also be `'api'` or
  `'direct'`; without it nothing changes.
- New exports: `FingerprintMismatchError`, `normalizeFingerprint`,
  `localPipeName`, `pipeUser`, `localSocketPath`, `localTokenPath`,
  `localApiDir`, `LOCAL_API_UNAVAILABLE`, `HttpTransportName`.

### the API transport's env, shell and waitJob

- API transport: `env` on `exec`, `execStream` and `runJob`, `shell` on
  `runJob`, and `waitJob` (`GET /desks/{id}/jobs/{name}/wait`; a `timeout`
  past the API's 870-second hold, or none, asks again until the job ends; a
  held answer's keep-alive spaces and in-body error envelope are read).
- `powershell` is a shell name everywhere `pwsh` is, sent as `pwsh` (as
  gaiadesk-cli maps it). Regenerated types: `Shell` has `powershell`.

### gaiadesk-cli 0.10.324

- `waitJob(deskId, name, {timeout?})` (`wait <job> --json`, the native
  `job_wait`): blocks until the job ends; `{job, timed_out}`. The job's own
  non-zero exit code is a result, not an error.
- `env` (`{NAME: value}`) on `exec`, `execStream` and `runJob` (a bare
  `--env KEY`, the value in gaiadesk-cli's own environment, never on its
  command line, newlines kept; `--env KEY=VALUE` only for names that would
  change how the CLI itself runs: `GAIADESK_*`, `PATH`, `HOME`, ...; the
  native library's `env`); `shell` on `runJob` (`sh`, `bash`,
  `zsh`, `cmd`, `pwsh`); `bash` and `zsh` for `exec` / `shell`.
- `whoami()` (`whoami --json`, the native `whoami`): `{source, account}`;
  not signed in (`source: 'none'`) is a result, not an error. `devices()`
  has `identity`.
- `GAIADESK_TOOLS` lists `gaiadesk_job_wait`.
- Regenerated types: `Identity`, `JobWaitResult`, `Job.reason`
  (`blocked_by_os_policy`: Windows Smart App Control / WDAC), `env` and
  `shell` in the run shapes, `bash`/`zsh` in `Shell`.
- On the API transport, `waitJob`, `whoami`, `env` and a job `shell` are a
  `UsageError` (the API does not take them), never silently dropped.

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
