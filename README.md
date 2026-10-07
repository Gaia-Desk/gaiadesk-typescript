# GaiaDesk SDK (TypeScript and Python)

Drive your GaiaDesk machines ("desks") from code: list them and check that
they are reachable, run commands and get exit codes back, stream output,
copy files, run background jobs, read stats, mint and revoke scoped agent
tokens, forward ports, and reach the screen tools through MCP.

| Package | Directory | Runtime | Dependencies |
|---|---|---|---|
| `@gaiadesk/sdk` | [`typescript/`](typescript) | Node.js 18+ (ESM, with type declarations) | none |
| `gaiadesk` | [`python/`](python) | Python 3.9+ (sync and asyncio) | none |

**How it works.** Both packages run the `gaiadesk-cli` that ships with the
GaiaDesk app and parse the JSON it prints with `--json`. They contain no
GaiaDesk code; GaiaDesk itself is closed-source. They expose only what the
CLI does, with the CLI's own flags and JSON field names. Where the CLI has
no JSON output, the SDK says so instead of guessing (see
[Known gaps](#known-gaps)).

MIT-licensed. GaiaDesk itself is proprietary and not covered by this license.

---

## Contents

- [Install](#install)
- [Quickstart: TypeScript](#quickstart-typescript)
- [Quickstart: Python](#quickstart-python)
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
   npm install @gaiadesk/sdk     # TypeScript / JavaScript
   pip install gaiadesk          # Python
   ```

## Quickstart: TypeScript

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
```

## Quickstart: Python

```python
from gaiadesk import GaiaDesk, RefusedError

gd = GaiaDesk(token_file="~/.config/gaiadesk/bot.token")

for d in gd.devices()["devices"]:
    print(d["desk_id"], d["name"], d["online"])

r = gd.exec("392586273", "uname -a", shell="sh", timeout=60)
print(r["exit"], r["stdout"], r["route"])

try:
    gd.upload("./dist", "392586273", "deploy/", recursive=True)
except RefusedError as e:
    print("the token lacks the cp scope:", e)

s = gd.exec_stream("392586273", ["npm", "test"])
for stream, text in s.text():
    print(text, end="")
print("exit", s.wait().exit_code)
```

asyncio:

```python
import asyncio
from gaiadesk import AsyncGaiaDesk

async def main():
    gd = AsyncGaiaDesk(token_file="/home/me/.config/gaiadesk/bot.token")
    results = await asyncio.gather(*(gd.exec(d, "hostname") for d in ["392586273", "608876148"]))
    for r in results:
        print(r["desk"], r["stdout"].strip())

asyncio.run(main())
```

## Credentials

Credentials are always passed to `gaiadesk-cli` through its environment,
never on its command line (other users on a machine can read command lines).
`gaiadesk-cli` never prompts when run by the SDK (there is no terminal), so a
missing credential fails fast with a `UsageError`.

| Option (TS / Python) | Environment variable | Use |
|---|---|---|
| `tokenFile` / `token_file` | `GAIADESK_TOKEN_FILE` | **Recommended.** A scoped, expiring agent token file from `gaiadesk-cli token create --out <file>` (mode 0600). |
| `code` / `code` | `GAIADESK_CODE` | The desk's code or unattended password. Needed for token administration (`createToken`, `listTokens`, `revokeToken`, `audit`), which only the desk's owner may do. An explicit `code` overrides an inherited `GAIADESK_TOKEN_FILE`. |
| `accountToken` / `account_token` | `GAIADESK_TOKEN` | A GaiaDesk account session. Optional: by default the CLI uses its own sign-in (`gaiadesk-cli login`), which lists your account's desks and enables `--account` revokes and audits. |
| `agentToken` / `agent_token` | `GAIADESK_AGENT_TOKEN` | An agent token with the `screen` scope, for `agentConnect` and the MCP screen tools. |
| `server` / `server` | `GAIADESK_SERVER` | Signaling server (`wss://…/ws`); default `wss://gaiadesk.net/ws`. Also passed as `--server` to `mcp` and `agent-connect`. |
| `persist` / `persist` | `GAIADESK_PERSIST` | How long a desk connection is held for later commands (default `10m`; `0` = none). |
| `env` / `env` | | The base environment (default: this process's). |
| `cli` / `cli` | `GAIADESK_CLI` | Path to `gaiadesk-cli`, or a command vector. |

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

TypeScript names first, Python in parentheses. Every result is the CLI's
JSON, with the CLI's field names (types in `typescript/src/types.ts` and
`python/src/gaiadesk/types.py`).

| Method | CLI | Returns |
|---|---|---|
| `version()` | `--version` | `"gaiadesk-cli X.Y.Z"` |
| `devices({probe?, deskId?})` (`devices(probe=, desk_id=)`) | `devices --json [--probe] [-d]` | `{devices[], sources[], notes[]}`; with `probe`, unreachable desks have `reachable: false` |
| `probe(deskId)` | `devices --probe -d` | one device row with `probe` |
| `exec(deskId, command, opts)` | `exec --json` | `{exit, remote_code, stdout, stderr, duration_ms, desk, route, mode, shell, timed_out, error, notes, truncated}` |
| `execStream(deskId, command, opts)` (`exec_stream`) | `exec` | a stream of stdout/stderr chunks, then the exit code |
| `shell(deskId, script, opts)` | `shell --json`, script on stdin | as `exec` |
| `shellStream(deskId, script?, opts)` (`shell_stream`) | `shell` | stream; without a script, stdin stays open for `write()`/`end()` |
| `upload(local, deskId, remote, {recursive})` | `cp --json <local> <desk>:<remote>` | `{direction, desk, destination, files, dirs, bytes, resumed_bytes, failed[], seconds}` |
| `download(deskId, remote, local, {recursive})` | `cp --json <desk>:<remote> <local>` | as above |
| `runJob(deskId, name, command, {priority, cpu, mem, keepAwake})` (`run_job`) | `run --detach --json` | job `{name, command, state, pid, exit_code, started_at_ms, ended_at_ms, log_bytes, by, limits, enforcement}` |
| `jobs(deskId)` | `ps --json` | job[] |
| `jobLogs(deskId, name, {tail})` (`job_logs`) | `logs` | output text |
| `followJobLogs(deskId, name)` (`follow_job_logs`) | `logs -f` | stream |
| `killJob(deskId, name)` (`kill_job`) | `kill --json` | job |
| `stats(deskId)` | `stats --json` | `{desk, hostname, os, os_version, cpu_percent, cpus, load, mem_total_mb, mem_free_mb, disks[], uptime_secs, jobs_running}` |
| `measure(deskId, {count})` | `measure --json` | `{desk, sent, rtt_ms{n,p50,p95,max}, clock_offset_ms, clock_uncertainty_ms}` |
| `createToken({desks, name, expires, scopes, cwd, lowPriv, out})` (`create_token`) | `token create --json` | `{tokens[{desk, token, secret?}], file?}` |
| `listTokens(deskId)` (`list_tokens`) | `token list --json` | token[] `{label, id, scopes, issued_at_ms, expires_at_ms, revoked, last_used_ms, cwd, low_priv}` |
| `revokeToken(deskId, nameOrId \| {all:true}, {account})` (`revoke_token(desk, name, all_for_desk=, account=)`) | `token revoke --json` | `{revoked, stopped_sessions}` or (account) `{desk, ok, message}` |
| `audit(deskId, {token, limit, account})` | `audit --json` | event[] `{at_ms, desk, token, token_id, action, detail, bytes, cwd, exit_code, duration_ms}` |
| `meshStatus()` (`mesh_status`) | `mesh status --json` | `{self, peers[]}` |
| `meshIp(deskId)` (`mesh_ip`) | `mesh ip` | the address |
| `disconnect(deskId?)` | `disconnect --desk-id \| --all` | nothing |
| `forward(deskId, spec \| spec[])` | `forward --json` | handle with `listening[]` and `close()`; Python: a context manager |
| `agentConnect(deskId)` (`agent_connect`) | `agent-connect` | the CLI's confirmation line |
| `mcp({auditDir, allowDomains})` | `mcp` (stdio) | an MCP client: `listTools()`, `callTool(name, args)`, `close()` |
| `raw(args, {input})` | anything | `{code, stdout, stderr}`: the escape hatch |

`exec`/`shell` options: `shell` (`default` \| `none` \| `sh` \| `cmd` \|
`pwsh`), `timeout` (seconds or `"10m"`; `0` = none; CLI default 30m),
`connectTimeout` (default 60s), `persist`, `verbose`, `stdin` (text or
bytes; default closed), `check` (throw `CommandError` on a non-zero exit).
TS also takes `signal` (an `AbortSignal`): aborting sends SIGINT, which
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

Every tool and its arguments are listed in the `gaiadesk-mcp` repository's
README ("The tools"), and `listTools()` returns their schemas.

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

Every error carries `exitCode`/`exit_code`, `kind`, `stderr`, `argv` and the
parsed `json` when there was one.

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
| `exec-on-a-desk.mjs`, `exec_on_a_desk.py` | find a reachable desk, run a command, handle the outcomes |
| `copy-a-file.mjs`, `copy_a_file.py` | upload, run, download, resume |
| `run-a-job.mjs`, `run_a_job.py` | a background job with caps; poll, follow its log, stop it |
| `mcp-vs-sdk.md` | when to give a model the MCP server and when to use the SDK |

## Known gaps

Things the CLI does not (yet) offer, so neither does the SDK:

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
   print bare arrays. The SDK normalizes these into the errors above.
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
cd typescript && npm ci && npm test       # tsc build, then node:test against a fake gaiadesk-cli
cd python && python -m unittest discover -s tests
```

The tests never touch a real desk: `typescript/test-fixtures/fake-cli.mjs` and
`python/tests/fixtures/fake_cli.py` print the JSON shapes the real CLI
documents and record the argv and environment they were given. CI runs both
on Linux, macOS and Windows (`.github/workflows/ci.yml`).
