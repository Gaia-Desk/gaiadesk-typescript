# GaiaDesk SDK for TypeScript

Drive your GaiaDesk machines ("desks") from TypeScript and Node.js: list
them and check that they are reachable, run commands and get exit codes
back, stream output, copy files, run background jobs, read stats, mint and
revoke scoped agent tokens, forward ports, and reach the screen tools
through MCP.

- Package: `@gaiadesk/sdk` (Node.js 18+, ESM, written in TypeScript, type
  declarations included)
- Runtime dependencies: none required; one optional, `@gaiadesk/sdk-native`

**How it works.** Two backends, one API:

- **Native** (when `@gaiadesk/sdk-native` is installed, which npm does by
  default as an optional dependency): GaiaDesk's client library as a
  prebuilt binary for your platform (macOS arm64/x64, Linux x64/arm64 glibc,
  Windows x64/arm64). Nothing else to install.
- **CLI** (otherwise): the SDK runs the `gaiadesk-cli` that ships with the
  GaiaDesk app and parses the JSON it prints with `--json`.

Both return the same results (the CLI's JSON shapes and field names) and
throw the same error classes with the same `kind`s. This package contains no
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

That also installs `@gaiadesk/sdk-native` (an optional dependency) with the
binary for your platform, and the SDK uses it: no GaiaDesk app or CLI
needed. With `--omit=optional`, or on a platform without a binary, the SDK
uses `gaiadesk-cli` instead: install GaiaDesk (it includes the CLI) from
<https://gaiadesk.net/download>. The SDK finds `gaiadesk-cli` through
`$GAIADESK_CLI`, then `PATH`, then the standard locations
(`/Applications/GaiaDesk.app/Contents/MacOS/gaiadesk-cli`,
`C:\Program Files\GaiaDesk\gaiadesk-cli.exe`, `/usr/bin/gaiadesk-cli`), or use
the `cli` option to point at it.

## Backends

`gd.backend` says which one a client uses: `'native'` or `'cli'`.

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

The SDK works with any `gaiadesk-cli`, and uses what a newer one offers.
`gaiadesk-cli` 0.10.324 and newer answer `--version --json` with a list of
`features`; the SDK asks once per CLI path (`gd.versionInfo()`,
`gd.features()`) and then:

| Feature | Used for | On an older CLI |
|---|---|---|
| `exec_json_stream` | `execStream` runs `exec --json-stream`: the exit also carries the run's `result` (`route`, `shell`, `remote_code`, ...) and `error` | plain `exec`: the bytes and the exit code |
| `exec_cwd`, `run_cwd` | the `cwd` option of `exec`, `execStream` and `runJob` | `cwd` is a `UsageError` (never silently dropped) |
| `json_error_envelope` | every failure is `{"error": {kind, message, reason?, desk?}}` | the older shapes are read too |

`ps`, `token list` and `audit` print `{"jobs": [...]}`, `{"tokens": [...]}`,
`{"events": [...]}` from 0.10.324 (bare arrays before, and with
`--json=v1`); `jobs()`, `listTokens()` and `audit()` return the list either
way. The native backend has every feature.

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
| `cli` | `GAIADESK_CLI` | Path to `gaiadesk-cli`, or a command vector. |

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
| `versionInfo()` | `--version --json` | `{name, version, features[], json_shapes[], mcp_protocol_versions[]}`, or `null` for a CLI before 0.10.324 (always the CLI, asked once per path) |
| `features()` | `--version --json` | the set of `features` (empty for a CLI before 0.10.324) |
| `devices({probe?, deskId?})` | `devices --json [--probe] [-d]` | `{devices[], sources[], notes[]}`; with `probe`, unreachable desks have `reachable: false` |
| `probe(deskId)` | `devices --probe -d` | one device row with `probe` |
| `exec(deskId, command, opts)` | `exec --json` | `{exit, remote_code, stdout, stderr, duration_ms, desk, route, mode, shell, timed_out, error, notes, truncated}` |
| `execStream(deskId, command, opts)` | `exec --json-stream` (0.10.324+), else `exec` | a stream of stdout/stderr chunks; `wait()` gives the exit code, and with `--json-stream` the run's `result` and `error` |
| `shell(deskId, script, opts)` | `shell --json [--cwd]`, script on stdin | as `exec` |
| `shellStream(deskId, script?, opts)` | `shell [--cwd]` | stream; without a script, stdin stays open for `write()`/`end()` |
| `upload(local, deskId, remote, {recursive})` | `cp --json <local> <desk>:<remote>` | `{direction, desk, destination, files, dirs, bytes, resumed_bytes, failed[], seconds}` |
| `download(deskId, remote, local, {recursive})` | `cp --json <desk>:<remote> <local>` | as above |
| `runJob(deskId, name, command, {priority, cpu, mem, keepAwake, cwd})` | `run --detach --json` | job `{name, command, state, pid, exit_code, started_at_ms, ended_at_ms, log_bytes, by, limits, enforcement}` |
| `jobs(deskId)` | `ps --json` | job[] (from `{"jobs": [...]}` or a bare array) |
| `jobLogs(deskId, name, {tail})` | `logs --json` (0.10.324+), else `logs` | output text (the `output` of `{job, output}`) |
| `followJobLogs(deskId, name)` | `logs -f --json` (0.10.324+), else `logs -f` | stream; `wait()`'s `error` says why following failed |
| `killJob(deskId, name)` | `kill --json` | job |
| `stats(deskId)` | `stats --json` | `{desk, hostname, os, os_version, cpu_percent, cpus, load, mem_total_mb, mem_free_mb, disks[], uptime_secs, jobs_running}` |
| `measure(deskId, {count})` | `measure --json` | `{desk, sent, rtt_ms{n,p50,p95,max}, clock_offset_ms, clock_uncertainty_ms}` |
| `createToken({desks, name, expires, scopes, cwd, lowPriv, out})` | `token create --json` | `MintResult` `{tokens[{desk, token, secret}]}`; with `out`, `TokenFileResult` `{tokens[{desk, token}], file}` |
| `listTokens(deskId)` | `token list --json` | token[] (from `{"tokens": [...]}` or a bare array) `{label, id, scopes, issued_at_ms, expires_at_ms, revoked, last_used_ms, cwd, low_priv}` |
| `revokeToken(deskId, nameOrId \| {all:true}, {account})` | `token revoke --json` | `{revoked, stopped_sessions}` or (account) `{desk, ok, message}` |
| `audit(deskId, {token, limit, account})` | `audit --json` | event[] (from `{"events": [...]}` or a bare array) `{at_ms, desk, token, token_id, action, detail, bytes, cwd, exit_code, duration_ms}` |
| `meshStatus()` | `mesh status --json` | `{self, peers[]}` |
| `meshIp(deskId)` | `mesh ip --json` (0.10.324+), else `mesh ip` | the address |
| `disconnect(deskId?)` | `disconnect --desk-id \| --all [--json]` | `{closed[]}` |
| `forward(deskId, spec \| spec[])` | `forward --json` | handle with `listening[]`, `close()` and `done` |
| `agentConnect(deskId)` | `agent-connect --json` (0.10.324+), else `agent-connect` | the confirmation line ("agent session open on desk N: screenshot WxH") |
| `mcp({auditDir, allowDomains})` | `mcp` (stdio) | an MCP client: `listTools()`, `callTool(name, args)`, `close()` |
| `raw(args, {input})` | anything | `{code, stdout, stderr}`: the escape hatch |

`exec`/`shell` options: `shell` (`default` \| `none` \| `sh` \| `cmd` \|
`pwsh`), `timeout` (seconds or `"10m"`; `0` = none; CLI default 30m),
`connectTimeout` (default 60s), `persist`, `verbose`, `stdin` (text or
bytes; default closed), `check` (throw `CommandError` on a non-zero exit),
and for `exec` / `execStream` `cwd`: the directory the command starts in on
the desk (relative: from the desk user's home, or a confined token's folder;
needs gaiadesk-cli 0.10.324+ or the native backend; a directory that is not
there is an `OperationFailedError`, one outside a confined token's folder a
`RefusedError`). `runJob` takes `cwd` too.
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
lists their names. Tools are named `gaiadesk_<tool>` from gaiadesk-cli
0.10.324; older CLIs name them `gaiadesk.<tool>`. `callTool` accepts either
spelling and sends the one the server advertises, so `gaiadesk_*` names work
with every CLI.

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

gaiadesk-cli 0.10.324 and newer print one error envelope for every `--json`
failure, `{"error": {"kind", "message", "reason"?, "desk"?}}`, with `kind`
one of `usage`, `refused`, `unreachable`, `connection_lost`, `failed`,
`protocol`; the error class follows that kind, and the SDK's `kind` is the
`reason` when it is one of the SDK's kinds (so an offline desk is
`kind: 'offline'` on every CLI). Older CLIs printed `{"error": "<text>"}`,
`{"refused": "<text>"}`, exec's own kinds or only a sentence on stderr; all
of them are read in one place (`errorEnvelope` in
[`src/errors.ts`](src/errors.ts)). An `exec` result's `error` is always
`null` or `{kind, message, reason?, desk?}`, whatever the CLI.

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

1. **`cwd` needs gaiadesk-cli 0.10.324+** (`exec_cwd`, `run_cwd`, `shell_cwd`). An older CLI has no `--cwd`: the
   SDK refuses the option (`UsageError`) rather than run the command
   elsewhere. A token minted with `--cwd` starts every command there on any
   CLI; otherwise write it into the command line (`cd /srv/app && make`).
2. **Before 0.10.324, `run --detach` re-quotes its command.** Those CLIs join
   everything after `--` with POSIX single-quote quoting, even a single
   argument, so a one-string command line containing spaces arrives at the
   desk as one quoted word (and `cmd.exe` does not understand single quotes
   at all). With such a CLI, pass `runJob` an **argument array** for POSIX
   desks (`['make', '-j8']`, `['sh', '-c', 'cd /srv && make']`). 0.10.324
   (feature `run_verbatim_command`) passes one string verbatim.
3. **Text from older CLIs.** `jobLogs` / `followJobLogs` (`logs`), `meshIp`
   (`mesh ip`), `disconnect` and `agentConnect` use `--json` on a CLI that
   lists `logs_json`, `mesh_ip_json`, `disconnect_json` and
   `agent_connect_json` (0.10.324+), and read an older CLI's text otherwise
   (its failures then have no kind, see 4). `forward --json` prints only
   `listening` events.
4. **Older CLIs: desk-operation failures have no kind.** Before 0.10.324, when
   `cp`, `run`, `ps`, `kill`, `stats`, `measure`, `token` or `audit` could not
   reach the desk, the CLI printed a sentence and exited 254 or 255; the SDK
   raises `RefusedError` (254) or `GaiaDeskError` with `kind: 'cli_error'`
   (255), and cannot tell "offline" from "bad arguments" there. From 0.10.324
   every failure has its kind.
5. **Exit 1 vs 254 for jobs and tokens** is decided from a field of the
   desk's answer; a desk with a GaiaDesk from before that field is read by its
   wording, so an unusual refusal may surface as `OperationFailedError`
   rather than `RefusedError`.
6. **Older CLIs: streaming loses the structure.** Before 0.10.324 there is no
   `--json-stream`: `execStream` uses plain `exec`, which gives the bytes and
   the exit code but not `route`, `shell` or an error kind (`Exit.result` and
   `Exit.error` are then absent). `exec --json` buffers the whole output (up
   to 16 MB per stream) on every CLI.
7. **No interactive terminal.** `shell` is interactive only on a real TTY;
   the SDK runs it over pipes (a script, or lines you write).
8. **Durations** are whole seconds or `30s`/`10m`/`2h`-style strings;
   fractional seconds are rounded up.
9. **Not wrapped:** `gaiadesk-cli login`/`logout` (interactive device flow;
   run it once, or pass `accountToken`), `agent run` (the bring-your-own-key
   screen agent, which needs a model API key and writes reports),
   `support` and `provision` (app/installer plumbing). Use `raw()`.
10. **MCP desk tools on older CLIs** (`copy_files`, `job_*`, `forward_*`)
    return their JSON as text, without `structuredContent` (only
    `gaiadesk.exec` has it there).

## Development

```sh
npm ci
npm test       # build src/ to dist/, build test/ to dist-test/, type-check examples/, run node:test
```

The tests import the built `dist/` (what npm publishes) and never touch a
real desk: [`test/fixtures/fake-cli.ts`](test/fixtures/fake-cli.ts) prints
the JSON shapes the real CLI documents and records the argv and environment
it was given. It plays two CLIs: a 0.10.324+ one (`fake-cli.js`) and an
older one (`fake-cli-old.js`), and every behaviour they share is tested
against both. [`test/fixtures/mock-native.ts`](test/fixtures/mock-native.ts)
stands in for `@gaiadesk/sdk-native`, as a current and an older build.

[`src/types.generated.ts`](src/types.generated.ts) is generated from
GaiaDesk's JSON Schema of the CLI's `--json` shapes (`gaiadesk-cli schema
--json`) by GaiaDesk's type generator: never edit it, regenerate it when the
schema changes. [`src/types.ts`](src/types.ts) gives those types the SDK's
public names. CI runs on Linux, macOS and Windows with Node 18, 20 and 22
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

The only dev dependencies are `typescript` and `@types/node`.

## License

MIT. See [LICENSE](LICENSE). GaiaDesk itself is proprietary software and is
not covered by this license.
