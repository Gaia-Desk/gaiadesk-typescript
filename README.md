# GaiaDesk SDK for TypeScript

Drive your GaiaDesk machines ("desks") from TypeScript and Node.js: list
them and check that they are reachable, run commands and get exit codes
back, stream output, copy files, run background jobs, read stats, mint and
revoke scoped agent tokens, forward ports, and reach the screen tools
through MCP.

- Package: `@gaiadesk/sdk` (Node.js 18+, ESM, written in TypeScript, type
  declarations included)
- Runtime dependencies: one, `@noble/ciphers` (XChaCha20-Poly1305 for
  [end-to-end encryption](#end-to-end-encryption)); one optional, `@gaiadesk/sdk-native`

**How it works.** Two backends, one API:

- **Native** (when `@gaiadesk/sdk-native` is installed, which npm does by
  default as an optional dependency): GaiaDesk's client library as a
  prebuilt binary for your platform (macOS arm64/x64, Linux x64/arm64 glibc,
  Windows x64/arm64). Nothing else to install.
- **CLI** (otherwise): the SDK runs the `gaiadesk-cli` that ships with the
  GaiaDesk app and parses the JSON it prints with `--json`.

Both return the same results (the CLI's JSON shapes and field names) and
throw the same error classes with the same `kind`s. A third transport,
**API** (give an `apiKey`), drives desks through GaiaDesk's hosted HTTPS
API with nothing installed but this package: see
[API transport](#api-transport). This package contains no
GaiaDesk code; GaiaDesk itself is closed-source, and the native binary ships
under its own licence (see [Backends](#backends)). Where the CLI has no JSON
output, the SDK says so instead of guessing (see [Known gaps](#known-gaps)).

Other GaiaDesk developer tools:

- **Python SDK**: [Gaia-Desk/gaiadesk-python](https://github.com/Gaia-Desk/gaiadesk-python) (`pip install gaiadesk`)
- **MCP server** for AI assistants: [Gaia-Desk/gaiadesk-mcp](https://github.com/Gaia-Desk/gaiadesk-mcp) (`npx -y @gaiadesk/mcp`)
- **MCP or SDK?** [When to give a model the MCP server and when to use an SDK](https://github.com/Gaia-Desk/gaiadesk-mcp/blob/main/docs/mcp-vs-sdk.md)

MIT-licensed. GaiaDesk itself is proprietary and not covered by this license.

---

## Contents

- [Install](#install)
- [Backends](#backends)
- [API transport](#api-transport)
- [End-to-end encryption](#end-to-end-encryption)
- [Local and LAN](#local-and-lan)
- [Quickstart](#quickstart)
- [Credentials](#credentials)
- [API](#api)
- [Errors and exit codes](#errors-and-exit-codes)
- [Examples](#examples)
- [Known gaps](#known-gaps)
- [Development](#development)

---

## Install

```sh
npm install @gaiadesk/sdk
```

That also installs two optional dependencies with the binaries for your
platform: `@gaiadesk/sdk-native`, which the SDK uses directly, and
[`@gaiadesk/cli`](https://www.npmjs.com/package/@gaiadesk/cli), the
`gaiadesk-cli` command line, which it uses for whatever needs the CLI (and
which you can run as `npx gaiadesk`). No GaiaDesk app is needed on the machine.

With `--omit=optional`, or on a platform without a binary, install
`gaiadesk-cli` some other way — `npm install -g @gaiadesk/cli`, the install
scripts or Homebrew from [Gaia-Desk/gaiadesk-cli](https://github.com/Gaia-Desk/gaiadesk-cli),
or the GaiaDesk app (<https://gaiadesk.net/download>), which includes it. The
SDK finds `gaiadesk-cli` through `$GAIADESK_CLI`, then `@gaiadesk/cli`'s
binary, then `PATH`, then the standard locations
(`/Applications/GaiaDesk.app/Contents/MacOS/gaiadesk-cli`,
`C:\Program Files\GaiaDesk\gaiadesk-cli.exe`, `/usr/bin/gaiadesk-cli`), or use
the `cli` option to point at it.

## Backends

`gd.backend` says which one a client uses: `'native'` or `'cli'` (or
`'api'`, given an `apiKey`: see [API transport](#api-transport); or `'local'`
/ `'lan'`: see [Local and LAN](#local-and-lan)).

| Option | Effect |
|---|---|
| `backend: 'auto'` (default) | native when `@gaiadesk/sdk-native` loads, else the CLI. Passing `cli` means the CLI. |
| `backend: 'native'` | native, or `CliNotFoundError` when it cannot load |
| `backend: 'cli'` | always `gaiadesk-cli` |
| `GAIADESK_SDK_BACKEND=auto\|native\|cli` | the default for `backend` |
| `native: module` | use this module instead of `require('@gaiadesk/sdk-native')` |

`raw()` and `mcp()` always run `gaiadesk-cli` (they are the CLI's own
commands). On the native backend, `version()` returns `gaiadesk-native X.Y.Z`,
streams' `argv` is the operation's name, `kill()` stops the remote side
whatever the signal, and an error's `exitCode` is the one `gaiadesk-cli`
would have exited with. `@gaiadesk/sdk-native` is proprietary (free to use
with GaiaDesk; see its LICENSE); this SDK stays MIT.

## API transport

Given an `apiKey`, the client talks to GaiaDesk's hosted API
(`https://api.gaiadesk.net/v1`) over HTTPS with the global `fetch` only: no
`gaiadesk-cli`, no native binary (Node 18+; desk operations are
[end-to-end encrypted](#end-to-end-encryption) where the desk can open them). Without
`apiKey`, nothing changes: the client picks the native or CLI backend
exactly as before.

```ts
import { GaiaDesk } from '@gaiadesk/sdk';

const gd = new GaiaDesk({
  apiKey: process.env.GAIADESK_API_KEY!,        // an API key (ak_…), or a signed-in person's session token
  deskToken: process.env.GAIADESK_DESK_TOKEN,   // a scoped agent token (gdagt_…), verified by the desk
  // baseUrl: 'https://api.gaiadesk.net/v1',    // the default
});
gd.backend; // 'api'
const r = await gd.exec('123456789', 'hostname');
```

**Credentials.** Every request carries `Authorization: Bearer <apiKey>` and,
when set, `X-GaiaDesk-Desk-Token: <deskToken>`. From an API key, desk
operations need a scoped agent token (`gdagt_…`, minted with
`createToken` or `gaiadesk-cli token create`) in `deskToken`: the API relays
it to the desk, which verifies it. A signed-in person's own session works on
their own desks without one. **Token administration** (`createToken`,
`listTokens`, `revokeToken`) over the API works only for a signed-in
person's own desk, never from an API key. Per call, `deskToken` overrides
the client's, and `wake: <0-120>` rings a sleeping desk and waits that many
seconds (`wake_s`).

What it serves, with the same results and errors as the CLI transport:

| Method | API |
|---|---|
| `devices({deskId?})` | `GET /desks` (`{devices, sources, notes}`; `deskId` filters it) |
| `exec(deskId, command, opts)` | `POST /desks/{id}/exec` (an `ExecSpec`: `command` or `argv`, `shell`, `env`, `cwd`, `stdin`, `timeout_secs`) |
| `execStream(deskId, command, opts)` | `POST /desks/{id}/exec?stream=1` (Server-Sent Events of `ExecEvent`s) |
| `runJob`, `jobs`, `killJob` | `POST` / `GET /desks/{id}/jobs` (a `JobSpec`, with `shell` and `env`), `DELETE /desks/{id}/jobs/{name}` |
| `waitJob(deskId, name, {timeout})` | `GET /desks/{id}/jobs/{name}/wait?timeout=` (`{job, timed_out}`; one request holds at most 870 s, so a longer or no `timeout` asks again until the job ends) |
| `jobLogs(deskId, name, {tail})` | `GET /desks/{id}/jobs/{name}/logs?tail=` |
| `followJobLogs(deskId, name)` | `GET …/logs?follow=1` (Server-Sent Events of `JobLogEvent`s) |
| `stats(deskId)` | `GET /desks/{id}/stats` |
| `upload(local, deskId, remote)` | `PUT /desks/{id}/files?path=` with the file's bytes (a `remote` ending in `/` keeps the file name) |
| `download(deskId, remote, local)` | `GET /desks/{id}/files?path=` into `local` (a folder keeps the remote name) |
| `uploadBytes(data, deskId, remote)` / `downloadBytes(deskId, remote)` | the same, with bytes in memory (API transport only; no file system needed) |
| `createToken({desks, name, expires, scopes, cwd, lowPriv})` | `POST /desks/{id}/tokens` (a `MintSpec`), once per desk |
| `listTokens(deskId)` / `revokeToken(deskId, id)` | `GET /desks/{id}/tokens` / `DELETE /desks/{id}/tokens/{token_id}` |

- **Files** are single files of at most **256 MB** each way; copy folders
  and larger files through the CLI or native transport. `upload`/`download`
  read and write local files through `node:fs` (imported only when called).
- **Streaming**: `execStream` and `followJobLogs` return the same stream as
  on the CLI (chunks, then `wait()` with `exitCode`, `result`, `error`);
  `kill()` closes the request. stdin is given up front (`stdin` text);
  `stdin: true` (writing as it runs) is not available.
- **Errors** are the same classes and kinds, from the API's error envelope
  (`{"error": {kind, message, reason?, desk?, request_id}}`); the error also
  has `status` (HTTP), `requestId` (quote it to support) and `retryAfter`
  (seconds, on a 429). No connection is `UnreachableError` with kind
  `network`; an answer that is not the envelope is a `ProtocolError`.
- `shell: 'powershell'` is sent as `pwsh`, as gaiadesk-cli reads it. `env`
  values go in the request body and are never logged (by the API or the desk);
  a low-privilege token's desk refuses them, as for the CLI.
- `timeout` becomes `timeout_secs`; `connectTimeout`, `persist` and
  `verbose` do not apply. `createToken` needs a `name` over the API (and
  defaults `expires` to 7 days, `scopes` to exec, cp, jobs).

**Not available over the API** (a `UsageError`, kind `usage`, saying "not
available over the API transport; use the CLI or native transport"):
`shell`, `shellStream`, `forward`, `agentConnect`, `mcp`, `measure`,
`meshStatus`, `meshIp`, `disconnect`, `audit`, `probe` /
`devices({probe: true})`, recursive copies, `createToken({out})`,
`revokeToken({all: true})` / `{account: true}`, `execStream` with
`stdin: true`, `whoami`, and the CLI's own `version`, `versionInfo`,
`features`, `raw`.

Administrator work (root / SYSTEM) is only available through `gaiadesk-cli exec --admin`, not the API
(hosted, local or lan): the API refuses it with `admin_not_via_api`, a `RefusedError`.

**Timeouts** (`timeouts: { responseTimeoutMs, idleTimeoutMs }`, in
milliseconds, on the api, local and lan transports) make a server or proxy
that stops answering an error, never a hang:

```ts
const gd = new GaiaDesk({ apiKey, timeouts: { responseTimeoutMs: 60_000, idleTimeoutMs: 30_000 } });
```

- `responseTimeoutMs` (default 16 minutes, above the API's 15-minute call
  limit: a buffered `exec` answers when its command ends): the longest wait
  for an answer to begin, sending the request included. Exceeded: an
  `UnreachableError`, kind `timeout`.
- `idleTimeoutMs` (default 90 s; streams and held waits send a keep-alive
  every 15 s): the longest silence while reading a body (JSON, a download,
  an event stream). It is not a deadline: a large download that keeps
  flowing never times out. Exceeded mid-answer: a `ConnectionLostError`,
  kind `timeout` (a stream ends with `error.kind` `connection_lost`, reason
  `timeout`, exit 255).
- `null` (or `Infinity`): no limit. Zero, negative or non-numbers are a
  `UsageError`. A timeout abandons the connection; it is not retried, and
  your `signal` still ends a call at any point (kind `interrupted`).
- A connection closed or reset before any answer is an `UnreachableError`
  (kind `network`), sent again only as the retry rule below allows.

**Retries.** A request is sent again only when that cannot run anything twice:

- **The connection was never made** (DNS, refused, TLS handshake): any method — nothing was sent.
- **The connection was lost after sending, or the answer was 502, 503 or 504**: GETs only (reads).
  A 503 that says the API or desk operations are switched off is not retried.
- **429** (`rate_limited`, `desk_busy`) and **409** `idempotency_key_in_flight`: any method — the server refused
  it before acting.

Timeouts are never retried, and nothing is retried once its answer has begun. A call that changes something
(POST, PUT, DELETE) is never sent again after it may have reached the server; an `Idempotency-Key` is sent but
does not make a call retryable. 429 and 503 wait for `Retry-After`; one longer than `retry.maxRetryWaitMs`
(default 60 s) is not waited for — the error carries it. Otherwise the wait is exponential backoff with jitter:
`retry.baseDelayMs` (default 250 ms) doubling up to `retry.maxDelayMs` (default 8 s), times a random 0.5–1.0.
`retry.maxRetries` (default 2, so 3 attempts in all) sets how many times; 0 turns retries off. Each retry of
a sealed operation is sealed afresh.

```ts
const gd = new GaiaDesk({ apiKey, retry: { maxRetries: 4, baseDelayMs: 500, maxDelayMs: 8000, maxRetryWaitMs: 60_000 } });
```

Node's `fetch` (undici) itself re-sends nothing, with or without a body, not even a GET on a pooled
connection closed before any answer; the local and lan transports open one connection per request. Your
`signal` ends a call during a retry wait at once (kind `interrupted`). POSTs take `idempotencyKey` (the
`Idempotency-Key` header, 1-255 printable ASCII characters; not sent for streams): the same call again with
the same key within 24 hours gets the first answer again.

## End-to-end encryption

On the API transport, desk operations are **sealed** so GaiaDesk's servers
relay only ciphertext: the command, its `env`, `stdin`, file paths and bytes,
and all output and results are readable by the caller and the desk only. The
server still sees the credentials, the route (the operation and the desk, a
job name or token id in the path), `stream`/`follow`/`wake`, sizes, and how
the operation ended (an exit, or an error's kind and reason). `local` and
`lan` never leave the desk or the LAN and are not sealed.

Before an operation the SDK reads the desk's X25519 key (`e2e_pub` from
`GET /desks/{id}`, cached for 5 minutes) and seals the request to a fresh
ephemeral key: X25519, HKDF-SHA256, XChaCha20-Poly1305, every message bound
to the desk, the operation and its place in the stream (the protocol: the
API reference's "End-to-end encryption"; the SDK reproduces its fixed test
vectors). Results, streams, errors and file bytes come back exactly as in the
clear; a desk's error carries its own message.

```ts
const gd = new GaiaDesk({
  apiKey, deskToken,
  e2e: 'require',                            // 'auto' (default) | 'require' | 'off'
  e2eKeys: { '123456789': 'B6N8vBQgk8i3…' },  // optional: pin a desk's e2e_pub
});
```

- `auto` (default): sealed when the desk lists a key; otherwise sent in the
  clear with a one-time warning per desk (`onWarning`, default
  `console.warn`), unless the desk **requires** end-to-end encryption: then
  it is woken (`POST /desks/{id}/wake`) and asked again, and sealed or refused.
- `require`: never in the clear. A desk that lists no key (asleep, offline,
  or a GaiaDesk from before end-to-end encryption) is woken and asked again;
  still none is an `E2eError` (a `RefusedError`, reason `e2e_unavailable`),
  and nothing is sent.
- `off`: plaintext, as before.
- `e2eKeys`: a pinned key is sealed to even while the desk lists none; a
  different key from the server is an `E2eError` (`e2e_key_mismatch`) and
  nothing is sent.
- A plaintext call refused `e2e_required` (409) is sealed and sent once more;
  a sealed one the desk could not open (`e2e_decrypt_failed`, its key
  rotated) is sealed to the key read again, once. Answers that do not open
  (altered, reordered, or a plaintext answer to a sealed call) are a
  `ProtocolError` (`e2e_decrypt_failed`, `e2e_malformed`,
  `e2e_unsealed_answer`).
- Reading a desk's key needs the API key's `desks:read` scope (and waking it
  `desks:write`); in `auto`, a key that cannot be read means plaintext with
  the warning.

**The dependency.** X25519, HKDF and randomness come from the platform
(`node:crypto`, else WebCrypto). XChaCha20-Poly1305 is in neither, so the SDK
uses [`@noble/ciphers`](https://github.com/paulmillr/noble-ciphers) 1.x (only
its `xchacha20poly1305`): MIT, no dependencies of its own, audited (Cure53),
Node 16+; its 2.x needs Node 20.19.

## Local and LAN

GaiaDesk desks serve the same `/v1` desk operations themselves: the same
routes, results, error envelope, statuses, Server-Sent Events and held
waits as the hosted API. Two transports use them, with the same methods,
results and errors as the [API transport](#api-transport) (and the same
list of what is not available; hosted-only routes answer 404 `no_such_route`).
Node only (`node:net`, `node:tls`, imported when used); no runtime dependency.

**`local`: code running on the desk itself**, through the GaiaDesk app's
local API (Settings → GaiaDesk API → Local API):

```ts
const gd = new GaiaDesk({ transport: 'local' });
gd.backend; // 'local'
const r = await gd.exec('123456789', 'hostname');
```

- It connects over HTTP/1.1 on the Unix socket `$GAIADESK_API_DIR/api.sock`
  (when that is an absolute directory), else `~/.gaiadesk/api.sock`; on
  Windows the named pipe `$GAIADESK_API_PIPE`, else
  `\\.\pipe\gaiadesk-api-<user>` (`<user>`: `%USERNAME%`, lowercased,
  anything outside `[a-z0-9._-]` as `_`, at most 64 characters). `socketPath`
  overrides either.
- Credentials: a `deskToken` (an agent token, `gdagt_…`, here or per call) is
  sent as `X-GaiaDesk-Desk-Token`; without one, the desk's local admin token
  (`gdlocal_…`, read from `$GAIADESK_API_DIR/api-token`, else
  `~/.gaiadesk/api-token`, or given as `token`) as `Authorization: Bearer`.
- No socket or pipe (or no token file and no `deskToken`) is an
  `UnreachableError` with reason `local_api_unavailable`: "GaiaDesk is not
  serving its local API here: is the app running, and is Settings → GaiaDesk
  API → Local API on?"

**`lan`: a desk's opt-in LAN gateway**, its self-signed certificate pinned
by the SHA-256 fingerprint the desk shows in its Settings:

```ts
const gd = new GaiaDesk({
  transport: 'lan',
  baseUrl: 'https://gaiadesk-123456789.local:7443/v1',   // or https://192.168.1.20:7443/v1
  fingerprint: 'ab:cd:…',                                // 32 hex pairs; colons and case optional
  deskToken: process.env.GAIADESK_DESK_TOKEN,            // required: agent tokens only on the LAN
});
const { devices } = await gd.devices(); // this desk, and the paired desks it reaches on its LAN
await gd.exec(devices[1].desk_id, 'uptime'); // forwarded by the gateway
```

- `https://` only. The certificate's SHA-256 is checked after the TLS
  handshake and **before any byte of the request is sent**; a mismatch is a
  `FingerprintMismatchError` (an `UnreachableError`, reason
  `fingerprint_mismatch`, with `expected` and `actual`): it may not be your
  desk, so do not proceed.
- A `deskToken` is required (here or per call; without one, a `UsageError`
  before anything is sent): the gateway refuses the admin token (401
  `admin_token_local_only`).

Helpers: `normalizeFingerprint`, `localPipeName`, `pipeUser`,
`localSocketPath`, `localTokenPath`, `localApiDir`.

## Quickstart

```ts
import { GaiaDesk, RefusedError } from '@gaiadesk/sdk';

const gd = new GaiaDesk({ tokenFile: `${process.env.HOME}/.config/gaiadesk/bot.token` });

const { devices } = await gd.devices();
console.log(devices.map((d) => `${d.desk_id} ${d.name} online=${d.online}`));

const r = await gd.exec('123456789', 'uname -a', { shell: 'sh', timeout: 60 });
console.log(r.exit, r.stdout, r.route);

try {
  await gd.upload('./dist', '123456789', 'deploy/', { recursive: true });
} catch (e) {
  if (e instanceof RefusedError) console.error('the token lacks the cp scope:', e.message);
  else throw e;
}

// Stream output as it is produced:
const s = gd.execStream('123456789', ['npm', 'test']);
for await (const c of s.text()) process[c.stream].write(c.text);
console.log('exit', (await s.wait()).exitCode);

// Many desks at once:
const results = await Promise.all(['123456789', '234567890'].map((d) => gd.exec(d, 'hostname')));
for (const x of results) console.log(x.desk, x.stdout.trim());
```

Every result is typed (`ExecResult`, `CpSummary`, `JobInfo`, `DeskStats`,
... in [`src/types.ts`](src/types.ts)), with the CLI's own field names. The
types are generated from GaiaDesk's JSON Schema of every `--json` shape
([`src/types.generated.ts`](src/types.generated.ts); all of them are also
exported under their schema names as the `Schema` namespace, e.g.
`Schema.ExecEvent`).

### Which gaiadesk-cli

The SDK reads the JSON of the current `gaiadesk-cli`: one error envelope,
lists as objects (`{"jobs": [...]}`, `{"tokens": [...]}`,
`{"events": [...]}`), `exec --json-stream`, and `--json` on every command it
runs. `gd.versionInfo()` / `gd.features()` read `--version --json` (asked
once per CLI path). The `cwd` options check for the `exec_cwd`, `run_cwd`
and `shell_cwd` features first: a CLI without them is a `UsageError` saying
to update gaiadesk-cli, never a silently dropped option.

## Credentials

Credentials are always passed to `gaiadesk-cli` through its environment,
never on its command line (other users on a machine can read command lines).
The native backend takes the same options and variables.
`gaiadesk-cli` never prompts when run by the SDK (there is no terminal), so a
missing credential fails fast with a `UsageError`.

| Option | Environment variable | Use |
|---|---|---|
| `tokenFile` | `GAIADESK_TOKEN_FILE` | **Recommended.** A scoped, expiring agent token file from `gaiadesk-cli token create --out <file>` (mode 0600). |
| `code` | `GAIADESK_CODE` | The desk's code or unattended password. Needed for token administration (`createToken`, `listTokens`, `revokeToken`, `audit`), which only the desk's owner may do. An explicit `code` overrides an inherited `GAIADESK_TOKEN_FILE`. |
| `accountToken` | `GAIADESK_TOKEN` | A GaiaDesk account session. Optional: by default the CLI uses its own sign-in (`gaiadesk-cli login`), which lists your account's desks and enables `--account` revokes and audits. |
| `agentToken` | `GAIADESK_AGENT_TOKEN` | An agent token with the `screen` scope, for `agentConnect` and the MCP screen tools. |
| `server` | `GAIADESK_SERVER` | Signaling server (`wss://…/ws`); default `wss://gaiadesk.net/ws`. Also passed as `--server` to `mcp` and `agent-connect`. |
| `persist` | `GAIADESK_PERSIST` | How long a desk connection is held for later commands (default `10m`; `0` = none). |
| `env` | | The base environment (default: this process's). |
| `cli` | `GAIADESK_CLI` | Path to `gaiadesk-cli`, or a command vector (default: found as described under Install). |

Mint, list and revoke tokens (the desk's owner, with the unattended password):

```ts
const owner = new GaiaDesk({ code: process.env.DESK_PASSWORD });
await owner.createToken({ desks: '123456789', name: 'ci', scopes: ['exec', 'cp', 'jobs'], expires: '24h', cwd: '/srv/app', lowPriv: true, out: '/home/ci/.config/gaiadesk/ci.token' });
await owner.listTokens('123456789');
await owner.revokeToken('123456789', 'ci');            // or { all: true }; { account: true } via your signed-in account
await owner.audit('123456789', { token: 'ci', limit: 100 });
```

Scopes: `exec`, `shell`, `cp`, `forward`, `jobs`, `screen` (default
`exec,cp,jobs`). The desk enforces scopes, `cwd`, `lowPriv` and expiry on
every request; the SDK does not.

## API

Every result is the CLI's JSON, with the CLI's field names (types in
[`src/types.ts`](src/types.ts)).

| Method | CLI | Returns |
|---|---|---|
| `version()` | `--version` | `"gaiadesk-cli X.Y.Z"` |
| `versionInfo()` | `--version --json` | `{name, version, features[], mcp_protocol_versions[]}`, or `null` for a CLI too old to answer it (always the CLI, asked once per path) |
| `features()` | `--version --json` | the set of `features` |
| `whoami()` | `whoami --json` | `{source, account}`: `source` is `app`, `login`, `token` or `none` (not signed in: a result, not an error) |
| `devices({probe?, deskId?})` | `devices --json [--probe] [-d]` | `{devices[], sources[], notes[], identity}`; with `probe`, unreachable desks have `reachable: false` |
| `probe(deskId)` | `devices --probe -d` | one device row with `probe` |
| `exec(deskId, command, opts)` | `exec --json [--env KEY]...` | `{exit, remote_code, stdout, stderr, duration_ms, desk, route, mode, shell, timed_out, error, notes, truncated}` |
| `execStream(deskId, command, opts)` | `exec --json-stream` | a stream of stdout/stderr chunks; `wait()` gives the exit code, the run's `result` and `error` |
| `shell(deskId, script, opts)` | `shell --json [--cwd]`, script on stdin | as `exec` |
| `shellStream(deskId, script?, opts)` | `shell [--cwd]` | stream; without a script, stdin stays open for `write()`/`end()` |
| `upload(local, deskId, remote, {recursive})` | `cp --json <local> <desk>:<remote>` | `{direction, desk, destination, files, dirs, bytes, resumed_bytes, failed[], seconds}` |
| `download(deskId, remote, local, {recursive})` | `cp --json <desk>:<remote> <local>` | as above |
| `runJob(deskId, name, command, {priority, cpu, mem, keepAwake, cwd, shell, env})` | `run --detach --json [--shell] [--env KEY]...` | job `{name, command, state, pid, exit_code, started_at_ms, ended_at_ms, log_bytes, by, limits, enforcement, reason}` |
| `waitJob(deskId, name, {timeout?})` | `wait <job> --json [--timeout]` | `{job, timed_out}`: the job as it ended (its `exit_code` is a result, not an error), or, `timed_out`, as it stands, still running |
| `jobs(deskId)` | `ps --json` | job[] (from `{"jobs": [...]}`) |
| `jobLogs(deskId, name, {tail})` | `logs --json` | output text (the `output` of `{job, output}`) |
| `followJobLogs(deskId, name)` | `logs -f --json` | stream; `wait()`'s `error` says why following failed |
| `killJob(deskId, name)` | `kill --json` | job |
| `stats(deskId)` | `stats --json` | `{desk, hostname, os, os_version, cpu_percent, cpus, load, mem_total_mb, mem_free_mb, disks[], uptime_secs, jobs_running}` |
| `measure(deskId, {count})` | `measure --json` | `{desk, sent, rtt_ms{n,p50,p95,max}, clock_offset_ms, clock_uncertainty_ms}` |
| `createToken({desks, name, expires, scopes, cwd, lowPriv, out})` | `token create --json` | `MintResult` `{tokens[{desk, token, secret}]}`; with `out`, `TokenFileResult` `{tokens[{desk, token}], file}` |
| `listTokens(deskId)` | `token list --json` | token[] (from `{"tokens": [...]}`) `{label, id, scopes, issued_at_ms, expires_at_ms, revoked, last_used_ms, cwd, low_priv}` |
| `revokeToken(deskId, nameOrId \| {all:true}, {account})` | `token revoke --json` | `{revoked, stopped_sessions}` or (account) `{desk, ok, message}` |
| `audit(deskId, {token, limit, account})` | `audit --json` | event[] (from `{"events": [...]}`) `{at_ms, desk, token, token_id, action, detail, bytes, cwd, exit_code, duration_ms}` |
| `meshStatus()` | `mesh status --json` | `{self, peers[]}` |
| `meshIp(deskId)` | `mesh ip --json` | the address |
| `disconnect(deskId?)` | `disconnect --desk-id \| --all --json` | `{closed[]}` |
| `forward(deskId, spec \| spec[])` | `forward --json` | handle with `listening[]`, `close()` and `done` |
| `agentConnect(deskId)` | `agent-connect --json` | the confirmation line ("agent session open on desk N: screenshot WxH") |
| `mcp({auditDir, allowDomains})` | `mcp` (stdio) | an MCP client: `listTools()`, `callTool(name, args)`, `close()` |
| `raw(args, {input})` | anything | `{code, stdout, stderr}`: the escape hatch |

`exec`/`shell` options: `shell` (`default` \| `none` \| `sh` \| `bash` \|
`zsh` \| `cmd` \| `pwsh`; `runJob` takes `sh`, `bash`, `zsh`, `cmd`, `pwsh`), `timeout` (seconds or `"10m"`; `0` = none; CLI default 30m),
`connectTimeout` (default 60s), `persist`, `verbose`, `stdin` (text or
bytes; default closed), `check` (throw `CommandError` on a non-zero exit),
and for `exec` / `execStream` `cwd`: the directory the command starts in on
the desk (relative: from the desk user's home, or a confined token's folder;
a CLI without the `exec_cwd` feature is a `UsageError`; a directory that is not
there is an `OperationFailedError`, one outside a confined token's folder a
`RefusedError`). `runJob` takes `cwd` too. `env` (`exec`, `execStream`,
`runJob`): `{NAME: value}`, environment variables for the command, never
logged by the desk; through gaiadesk-cli each is a bare `--env KEY` and its
value goes in that gaiadesk-cli process's own environment, so values never
appear on this machine's command lines and keep newlines. The exception: a
name that would change how gaiadesk-cli itself runs, `GAIADESK_*` (any
case), `PATH`, `HOME`, `USERPROFILE`, `TMPDIR`, `TEMP`, `TMP`, `LANG`,
`LC_ALL`, `SystemRoot`, `ComSpec` (any case on Windows), goes as
`--env KEY=VALUE` on its command line instead. The native library takes
them in-process. A
program Windows Smart App Control / WDAC refused to start is
`error.reason === 'blocked_by_os_policy'` in an exec result, and a job's
`reason` (its `state` then says so in words).
Desk methods also take `signal` (an `AbortSignal`): aborting sends SIGINT, which
`gaiadesk-cli` turns into stopping the remote command.

`command` as a **string** is one command line for the desk's shell,
verbatim; as an **array**, separate arguments that the desk quotes for its
shell. The default shell differs by desk: the user's login shell on
macOS/Linux (zsh on a Mac), `cmd.exe` on Windows. Pass `shell: 'sh'` for
portable POSIX scripts and `shell: 'pwsh'` for PowerShell.

### Screen tools (via MCP)

The CLI exposes the screen (Agent Access: screenshots, clicks, typing) only
through `gaiadesk-cli mcp`. The SDK's `mcp()` starts it and speaks its
protocol (MCP 2026-07-28, stateless, which every `gaiadesk-cli mcp` speaks):

```ts
const gd = new GaiaDesk({ agentToken: process.env.GAIADESK_AGENT_TOKEN });
const m = gd.mcp({ auditDir: '/var/log/gaiadesk-agent' });
const open = await m.callTool('gaiadesk_open_session', { desk_id: '123456789' });
const session = open.structuredContent?.session_id as string;
const shot = await m.callTool('gaiadesk_screenshot', { session_id: session });
await m.callTool('gaiadesk_click', { session_id: session, x: 200, y: 140 });
await m.callTool('gaiadesk_close_session', { session_id: session });
await m.close();
```

Every tool and its arguments are listed in the
[gaiadesk-mcp README](https://github.com/Gaia-Desk/gaiadesk-mcp#the-tools)
("The tools"), and `listTools()` returns their schemas; `GAIADESK_TOOLS`
lists their names (`gaiadesk_<tool>`).

## Errors and exit codes

| Error | When |
|---|---|
| `CliNotFoundError` | `gaiadesk-cli` could not be started |
| `UsageError` | bad arguments (from the SDK, or the CLI's `usage` kind, including "no credential") |
| `RefusedError` | kind `refused` / exit 254: wrong code, token without the scope, expired or revoked, permission off, a `cwd` outside a confined token's folder |
| `UnreachableError` | kind `unreachable`; `kind` is the finer reason when there is one: `offline`, `unknown_desk`, `not_online`, `network`, `not_signed_in`, `timeout` |
| `ConnectionLostError` | kind `connection_lost`, or `shell` exit 253 |
| `OperationFailedError` | kind `failed` / exit 1: a file failed (the summary is in `.json`), no such job, nothing to revoke, a `cwd` that is not there |
| `ProtocolError` | kind `protocol` (usually a desk too old for the request), or the CLI printed something other than its documented JSON |
| `CommandError` | `exec`/`shell` with `check: true` and a non-zero exit (`.result` has the output) |
| `McpError` | a JSON-RPC error from `gaiadesk-cli mcp` (`.code`) |
| `GaiaDeskError` | the base class; also exit 255 from a desk operation (`kind: 'cli_error'`) |

The native backend throws the same classes with the same kinds (an
unreachable desk is `UnreachableError` with `kind: 'offline'`,
`'unknown_desk'`, ...; `'unreachable'` only when the library gives no finer
reason). `CliNotFoundError` there means `backend: 'native'` was asked for and
`@gaiadesk/sdk-native` could not load.

Every error carries `exitCode`, `kind`, `reason` (the CLI's finer cause, or
`null`), `desk` (the desk it concerned, when the CLI or native library said;
else `null`), `stderr`, `argv` and the parsed `json` when there was one.

gaiadesk-cli prints one error envelope for every `--json` failure,
`{"error": {"kind", "message", "reason"?, "desk"?}}`, with `kind` one of
`usage`, `refused`, `unreachable`, `connection_lost`, `failed`, `protocol`;
the error class follows that kind, and the SDK's `kind` is the `reason` when
it is one of the SDK's kinds (so an offline desk is `kind: 'offline'`). It
is read in one place (`errorEnvelope` in [`src/errors.ts`](src/errors.ts)).
An `exec` result's `error` is `null` or `{kind, message, reason?, desk?}`.

A non-zero exit from **your command** is not an error: `exec` returns it in
`exit` (and `remote_code`), with `timed_out: true` and exit 124 when
`--timeout` stopped it. Exit codes from the CLI:

| Code | `exec` / `shell` | desk operations |
|---|---|---|
| 0-255 | the remote command's own | 0 done, 1 did not succeed |
| 124 | `--timeout` ran out | |
| 130 | interrupted (SIGINT / abort) | |
| 253 | `shell`: connection lost / desk ended the terminal | |
| 254 | the desk refused | the desk refused |
| 255 | the CLI's own error (offline, unreachable, bad arguments) | the CLI's own error |

## Examples

[`examples/`](examples):

| File | What |
|---|---|
| `exec-on-a-desk.ts` | find a reachable desk, run a command, handle the outcomes |
| `copy-a-file.ts` | upload, run, download, resume |
| `run-a-job.ts` | a background job with caps; follow its log, stop it |

Run one with `npx tsx examples/exec-on-a-desk.ts <desk-id>`, or compile with
`tsc` and run the output with `node`. `npm test` type-checks them.

When should a model drive the desk instead of your code? See
[MCP or SDK?](https://github.com/Gaia-Desk/gaiadesk-mcp/blob/main/docs/mcp-vs-sdk.md).

## Known gaps

Things the CLI does not (yet) offer, so neither does the SDK (the Python SDK has the same list):

1. **`forward --json`** prints only `listening` events.
2. **Exit 1 vs 254 for jobs and tokens** is decided from a field of the
   desk's answer; a desk with a GaiaDesk from before that field is read by its
   wording, so an unusual refusal may surface as `OperationFailedError`
   rather than `RefusedError`.
3. **`exec --json` buffers** the whole output (up to 16 MB per stream); use
   `execStream` for large output.
4. **No interactive terminal.** `shell` is interactive only on a real TTY;
   the SDK runs it over pipes (a script, or lines you write).
5. **Durations** are whole seconds or `30s`/`10m`/`2h`-style strings;
   fractional seconds are rounded up.
6. **Not wrapped:** `gaiadesk-cli login`/`logout` (interactive device flow;
   run it once, or pass `accountToken`), `agent run` (the bring-your-own-key
   screen agent, which needs a model API key and writes reports),
   `support` and `provision` (app/installer plumbing). Use `raw()`.

## Development

```sh
npm ci
npm test       # build src/ to dist/, build test/ to dist-test/, type-check examples/, run node:test
```

The tests import the built `dist/` (what npm publishes) and never touch a
real desk: [`test/fixtures/fake-cli.ts`](test/fixtures/fake-cli.ts) prints
the JSON shapes the real CLI documents and records the argv and environment
it was given (`fake-cli-old.js` plays a CLI too old to answer `--version
--json`, for the `cwd` checks).
[`test/fixtures/mock-native.ts`](test/fixtures/mock-native.ts) stands in for
`@gaiadesk/sdk-native`, and
[`test/fixtures/mock-api.ts`](test/fixtures/mock-api.ts) for the hosted API
(a `node:http` server that answers every route from the same fake CLI); the
same mock plays a desk's own API on a Unix socket / named pipe (`local`) and
over TLS with the self-signed certificate in
[`test/fixtures/lan-cert.ts`](test/fixtures/lan-cert.ts) (`lan`).
[`test/transports.test.ts`](test/transports.test.ts) runs the same
behavioural cases against the CLI, API, local and LAN transports.

[`src/types.generated.ts`](src/types.generated.ts) is generated from
GaiaDesk's JSON Schema of the CLI's `--json` shapes (`gaiadesk-cli schema
--json`) by GaiaDesk's type generator: never edit it, regenerate it when the
schema changes. [`src/types.ts`](src/types.ts) gives those types the SDK's
public names. CI runs on Linux, macOS and Windows with Node 18, 20 and 22
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

The only dev dependencies are `typescript` and `@types/node`; the one runtime
dependency is `@noble/ciphers` (see [End-to-end encryption](#end-to-end-encryption)).

## License

MIT. See [LICENSE](LICENSE). GaiaDesk itself is proprietary software and is
not covered by this license.
