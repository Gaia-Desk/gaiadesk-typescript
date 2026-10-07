# GaiaDesk SDK for TypeScript

Drive your GaiaDesk machines ("desks") from TypeScript and Node.js: list
them and check that they are reachable, run commands and get exit codes
back, stream output, copy files, run background jobs, read stats, mint and
revoke scoped agent tokens, forward ports, and reach the screen tools
through MCP.

- Package: `@gaiadesk/sdk` (Node.js 18+, ESM, written in TypeScript, type
  declarations included)
- Runtime dependencies: none

**How it works.** The SDK runs the `gaiadesk-cli` that ships with the
GaiaDesk app and parses the JSON it prints with `--json`. It contains no
GaiaDesk code; GaiaDesk itself is closed-source. It exposes only what the
CLI does, with the CLI's own flags and JSON field names. Where the CLI has
no JSON output, the SDK says so instead of guessing (see
[Known gaps](#known-gaps)).

Other GaiaDesk developer tools:

- **Python SDK**: [Gaia-Desk/gaiadesk-python](https://github.com/Gaia-Desk/gaiadesk-python) (`pip install gaiadesk`)
- **MCP server** for AI assistants: [Gaia-Desk/gaiadesk-mcp](https://github.com/Gaia-Desk/gaiadesk-mcp) (`npx -y @gaiadesk/mcp`)
- **MCP or SDK?** [When to give a model the MCP server and when to use an SDK](https://github.com/Gaia-Desk/gaiadesk-mcp/blob/main/docs/mcp-vs-sdk.md)

MIT-licensed. GaiaDesk itself is proprietary and not covered by this license.

---

## Contents

- [Install](#install)
- [Quickstart](#quickstart)
- [Credentials](#credentials)
- [API](#api)
- [Errors and exit codes](#errors-and-exit-codes)
- [Examples](#examples)
- [Known gaps](#known-gaps)
- [Development](#development)

---

## Install

1. Install GaiaDesk (it includes `gaiadesk-cli`): <https://gaiadesk.net/download>.
   The SDK finds `gaiadesk-cli` through `$GAIADESK_CLI`, then `PATH`, then
   the standard locations (`/Applications/GaiaDesk.app/Contents/MacOS/gaiadesk-cli`,
   `C:\Program Files\GaiaDesk\gaiadesk-cli.exe`, `/usr/bin/gaiadesk-cli`), or
   use the `cli` option to point at it.
2. Install the package:

   ```sh
   npm install @gaiadesk/sdk
   ```

## Quickstart

```ts
import { GaiaDesk, RefusedError } from '@gaiadesk/sdk';

const gd = new GaiaDesk({ tokenFile: `${process.env.HOME}/.config/gaiadesk/bot.token` });

const { devices } = await gd.devices();
console.log(devices.map((d) => `${d.desk_id} ${d.name} online=${d.online}`));

const r = await gd.exec('392586273', 'uname -a', { shell: 'sh', timeout: 60 });
console.log(r.exit, r.stdout, r.route);

try {
  await gd.upload('./dist', '392586273', 'deploy/', { recursive: true });
} catch (e) {
  if (e instanceof RefusedError) console.error('the token lacks the cp scope:', e.message);
  else throw e;
}

// Stream output as it is produced:
const s = gd.execStream('392586273', ['npm', 'test']);
for await (const c of s.text()) process[c.stream].write(c.text);
console.log('exit', (await s.wait()).exitCode);

// Many desks at once:
const results = await Promise.all(['392586273', '608876148'].map((d) => gd.exec(d, 'hostname')));
for (const x of results) console.log(x.desk, x.stdout.trim());
```

Every result is typed (`ExecResult`, `CpSummary`, `JobInfo`, `DeskStats`,
... in [`src/types.ts`](src/types.ts)), with the CLI's own field names.

## Credentials

Credentials are always passed to `gaiadesk-cli` through its environment,
never on its command line (other users on a machine can read command lines).
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
await owner.createToken({ desks: '392586273', name: 'ci', scopes: ['exec', 'cp', 'jobs'], expires: '24h', cwd: '/srv/app', lowPriv: true, out: '/home/ci/.config/gaiadesk/ci.token' });
await owner.listTokens('392586273');
await owner.revokeToken('392586273', 'ci');            // or { all: true }; { account: true } via your signed-in account
await owner.audit('392586273', { token: 'ci', limit: 100 });
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
| `devices({probe?, deskId?})` | `devices --json [--probe] [-d]` | `{devices[], sources[], notes[]}`; with `probe`, unreachable desks have `reachable: false` |
| `probe(deskId)` | `devices --probe -d` | one device row with `probe` |
| `exec(deskId, command, opts)` | `exec --json` | `{exit, remote_code, stdout, stderr, duration_ms, desk, route, mode, shell, timed_out, error, notes, truncated}` |
| `execStream(deskId, command, opts)` | `exec` | a stream of stdout/stderr chunks, then the exit code |
| `shell(deskId, script, opts)` | `shell --json`, script on stdin | as `exec` |
| `shellStream(deskId, script?, opts)` | `shell` | stream; without a script, stdin stays open for `write()`/`end()` |
| `upload(local, deskId, remote, {recursive})` | `cp --json <local> <desk>:<remote>` | `{direction, desk, destination, files, dirs, bytes, resumed_bytes, failed[], seconds}` |
| `download(deskId, remote, local, {recursive})` | `cp --json <desk>:<remote> <local>` | as above |
| `runJob(deskId, name, command, {priority, cpu, mem, keepAwake})` | `run --detach --json` | job `{name, command, state, pid, exit_code, started_at_ms, ended_at_ms, log_bytes, by, limits, enforcement}` |
| `jobs(deskId)` | `ps --json` | job[] |
| `jobLogs(deskId, name, {tail})` | `logs` | output text |
| `followJobLogs(deskId, name)` | `logs -f` | stream |
| `killJob(deskId, name)` | `kill --json` | job |
| `stats(deskId)` | `stats --json` | `{desk, hostname, os, os_version, cpu_percent, cpus, load, mem_total_mb, mem_free_mb, disks[], uptime_secs, jobs_running}` |
| `measure(deskId, {count})` | `measure --json` | `{desk, sent, rtt_ms{n,p50,p95,max}, clock_offset_ms, clock_uncertainty_ms}` |
| `createToken({desks, name, expires, scopes, cwd, lowPriv, out})` | `token create --json` | `{tokens[{desk, token, secret?}], file?}` |
| `listTokens(deskId)` | `token list --json` | token[] `{label, id, scopes, issued_at_ms, expires_at_ms, revoked, last_used_ms, cwd, low_priv}` |
| `revokeToken(deskId, nameOrId \| {all:true}, {account})` | `token revoke --json` | `{revoked, stopped_sessions}` or (account) `{desk, ok, message}` |
| `audit(deskId, {token, limit, account})` | `audit --json` | event[] `{at_ms, desk, token, token_id, action, detail, bytes, cwd, exit_code, duration_ms}` |
| `meshStatus()` | `mesh status --json` | `{self, peers[]}` |
| `meshIp(deskId)` | `mesh ip` | the address |
| `disconnect(deskId?)` | `disconnect --desk-id \| --all` | nothing |
| `forward(deskId, spec \| spec[])` | `forward --json` | handle with `listening[]`, `close()` and `done` |
| `agentConnect(deskId)` | `agent-connect` | the CLI's confirmation line |
| `mcp({auditDir, allowDomains})` | `mcp` (stdio) | an MCP client: `listTools()`, `callTool(name, args)`, `close()` |
| `raw(args, {input})` | anything | `{code, stdout, stderr}`: the escape hatch |

`exec`/`shell` options: `shell` (`default` \| `none` \| `sh` \| `cmd` \|
`pwsh`), `timeout` (seconds or `"10m"`; `0` = none; CLI default 30m),
`connectTimeout` (default 60s), `persist`, `verbose`, `stdin` (text or
bytes; default closed), `check` (throw `CommandError` on a non-zero exit).
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
protocol (MCP 2026-07-28, stateless):

```ts
const gd = new GaiaDesk({ agentToken: process.env.GAIADESK_AGENT_TOKEN });
const m = gd.mcp({ auditDir: '/var/log/gaiadesk-agent' });
const open = await m.callTool('gaiadesk.open_session', { desk_id: '392586273' });
const session = open.structuredContent?.session_id as string;
const shot = await m.callTool('gaiadesk.screenshot', { session_id: session });
await m.callTool('gaiadesk.click', { session_id: session, x: 200, y: 140 });
await m.callTool('gaiadesk.close_session', { session_id: session });
await m.close();
```

Every tool and its arguments are listed in the
[gaiadesk-mcp README](https://github.com/Gaia-Desk/gaiadesk-mcp#the-tools)
("The tools"), and `listTools()` returns their schemas. `callTool` accepts a
tool name with a dot or an underscore (`gaiadesk.exec` or `gaiadesk_exec`)
and sends the spelling the server advertises.

## Errors and exit codes

| Error | When |
|---|---|
| `CliNotFoundError` | `gaiadesk-cli` could not be started |
| `UsageError` | bad arguments (from the SDK, or the CLI's `usage` kind, including "no credential") |
| `RefusedError` | exit 254: wrong code, token without the scope, expired or revoked, permission off |
| `UnreachableError` | `exec`/`shell` kinds `offline`, `unknown_desk`, `not_online`, `network`, `not_signed_in`, `timeout` |
| `ConnectionLostError` | kind `connection_lost`, or `shell` exit 253 |
| `OperationFailedError` | exit 1 from a desk operation: a file failed (the summary is in `.json`), no such job, nothing to revoke |
| `ProtocolError` | the CLI printed something other than its documented JSON |
| `CommandError` | `exec`/`shell` with `check: true` and a non-zero exit (`.result` has the output) |
| `McpError` | a JSON-RPC error from `gaiadesk-cli mcp` (`.code`) |
| `GaiaDeskError` | the base class; also exit 255 from a desk operation (`kind: 'cli_error'`) |

Every error carries `exitCode`, `kind`, `stderr`, `argv` and the parsed
`json` when there was one.

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

1. **No working directory for `exec`.** There is no `--cwd` flag. A token
   minted with `--cwd` starts every command there; otherwise write it into
   the command line (`cd /srv/app && make`, shell-dependent).
2. **`run --detach` re-quotes its command.** The CLI joins everything after
   `--` with POSIX single-quote quoting, even a single argument, so a one-string
   command line containing spaces arrives at the desk as one quoted word
   (and `cmd.exe` does not understand single quotes at all). Until the CLI
   changes, pass `runJob` an **argument array** for POSIX desks
   (`['make', '-j8']`, `['sh', '-c', 'cd /srv && make']`); the MCP tool
   `gaiadesk.job_run` passes its `command` through verbatim.
3. **No JSON for some commands.** `logs` (raw output; the job's final state
   is only a stderr line), `mesh ip`, `disconnect`, `agent-connect`, `login`
   and `--version` print text. `forward --json` prints only `listening`
   events.
4. **Desk-operation failures have no error kind.** When `cp`, `run`, `ps`,
   `kill`, `stats`, `measure`, `token` or `audit` cannot reach the desk, the
   CLI prints a sentence on stderr and exits 254 or 255; only `exec` and
   `shell` report a machine-readable `kind`. The SDK raises `RefusedError`
   (254) or `GaiaDeskError` with `kind: 'cli_error'` (255) carrying that
   sentence; it cannot tell "offline" from "bad arguments" there.
5. **Inconsistent JSON envelopes.** Errors appear as `{"error": "..."}`,
   `{"refused": "..."}`, `{"desk", "error"}`, `{"desk", "ok", "message"}`, or
   exec's `{"error": {"kind", "message"}}`; `ps`, `token list` and `audit`
   print bare arrays. The SDK normalizes these into the errors above, and
   reads them in exactly one place (`errorEnvelope` in
   [`src/errors.ts`](src/errors.ts)).
6. **Exit 1 vs 254 for jobs and tokens** is decided inside the CLI by
   matching the desk's wording, so an unusual refusal may surface as
   `OperationFailedError` rather than `RefusedError`.
7. **Streaming loses the structure.** `exec --json` buffers the whole output
   (up to 16 MB per stream). Streaming uses plain `exec`, which gives the
   bytes and the exit code but not `route`, `shell` or an error `kind`.
8. **No interactive terminal.** `shell` is interactive only on a real TTY;
   the SDK runs it over pipes (a script, or lines you write).
9. **Version and features.** `gaiadesk-cli --version` reports the CLI
   crate's version, not the GaiaDesk app's, and there is no capability query,
   so the SDK cannot feature-detect a CLI or desk.
10. **Durations** are whole seconds or `30s`/`10m`/`2h`-style strings;
    fractional seconds are rounded up.
11. **Not wrapped:** `gaiadesk-cli login`/`logout` (interactive device flow;
    run it once, or pass `accountToken`), `agent run` (the bring-your-own-key
    screen agent, which needs a model API key and writes reports),
    `support` and `provision` (app/installer plumbing). Use `raw()`.
12. **MCP desk tools** (`copy_files`, `job_*`, `forward_*`) return their JSON
    as text, without `structuredContent` (only `gaiadesk.exec` has it).

## Development

```sh
npm ci
npm test       # build src/ to dist/, build test/ to dist-test/, type-check examples/, run node:test
```

The tests import the built `dist/` (what npm publishes) and never touch a
real desk: [`test/fixtures/fake-cli.ts`](test/fixtures/fake-cli.ts) prints
the JSON shapes the real CLI documents and records the argv and environment
it was given. CI runs on Linux, macOS and Windows with Node 18, 20 and 22
([`.github/workflows/ci.yml`](.github/workflows/ci.yml)).

The only dev dependencies are `typescript` and `@types/node`.

## License

MIT. See [LICENSE](LICENSE). GaiaDesk itself is proprietary software and is
not covered by this license.
