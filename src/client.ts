// The GaiaDesk client: each method runs one gaiadesk-cli command (with --json
// where the CLI has it) and returns the CLI's own JSON, typed.

import * as A from './args.js';
import { CommandError, GaiaDeskError, ProtocolError, RefusedError, UsageError, errorEnvelope, errorFromRun, lastStderrLine } from './errors.js';
import { locateCli } from './locate.js';
import { McpClient } from './mcp.js';
import { CliStream, runCli } from './proc.js';
import type { Completed, Exit, Invocation } from './proc.js';
import type {
  AbortSignalLike,
  AccountRevokeResult,
  AuditEvent,
  CpSummary,
  DeskStats,
  DevicesResult,
  ExecResult,
  ForwardListening,
  JobInfo,
  MeasureResult,
  MeshStatus,
  TokenCreateResult,
  TokenInfo,
  TokenRevokeResult,
} from './types.js';

export interface GaiaDeskOptions {
  /**
   * gaiadesk-cli: a path, or a command vector (e.g. `[process.execPath, 'fake-cli.mjs']`).
   * Default: $GAIADESK_CLI, then PATH, then the standard install locations.
   */
  cli?: string | readonly string[];
  /** A scoped agent token file (`gaiadesk-cli token create --out`). Sets GAIADESK_TOKEN_FILE. */
  tokenFile?: string;
  /**
   * The desk's code or unattended password. Sets GAIADESK_CODE (never argv).
   * Token administration (createToken, listTokens, revokeToken, audit) needs the unattended password.
   */
  code?: string;
  /** A GaiaDesk account session token. Sets GAIADESK_TOKEN. Default: the CLI's own `gaiadesk-cli login`. */
  accountToken?: string;
  /** An agent token for screen tools (mcp, agentConnect). Sets GAIADESK_AGENT_TOKEN. */
  agentToken?: string;
  /** Signaling server URL (`wss://…/ws`). Sets GAIADESK_SERVER and is passed as --server to mcp/agent-connect. */
  server?: string;
  /** How long a desk connection is held for later commands (`10m` default, 0 = none). Sets GAIADESK_PERSIST. */
  persist?: number | string;
  /** The environment gaiadesk-cli starts from (default: this process's). */
  env?: Record<string, string | undefined>;
  /** Working directory for gaiadesk-cli (relative local paths in copies resolve here). */
  cwd?: string;
}

export interface CallOptions {
  signal?: AbortSignalLike;
}

export interface ExecOptions extends A.RunShapeOptions, CallOptions {
  /** Text or bytes for the command's stdin (then end of input). Default: stdin closed. */
  stdin?: string | Uint8Array;
  /** Throw CommandError when the command exits non-zero (or times out). Default false. */
  check?: boolean;
}

export interface StreamExecOptions extends A.RunShapeOptions, CallOptions {
  /** Data for stdin, or `true` to keep stdin open for `stream.write()` / `stream.end()`. */
  stdin?: string | Uint8Array | true;
}

/** A running `gaiadesk-cli forward`. */
export interface Forward {
  /** One entry per forward, once each is listening (the real local port, after a 0). */
  readonly listening: ForwardListening[];
  /** Stop forwarding (SIGINT) and wait for gaiadesk-cli to exit. */
  close(): Promise<Exit>;
  /** Resolves when forwarding ends for any reason (exit 254: the desk refused; 255: connection lost). */
  readonly done: Promise<Exit>;
}

function parseJson(stdout: string): unknown {
  const t = stdout.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    // One object per line for forward; elsewhere the last line is the JSON.
    const last = t.split(/\r?\n/).pop() ?? '';
    try {
      return JSON.parse(last);
    } catch {
      return undefined;
    }
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

export class GaiaDesk {
  private readonly opts: GaiaDeskOptions;
  private cliCommand?: readonly string[];

  constructor(opts: GaiaDeskOptions = {}) {
    this.opts = { ...opts };
  }

  /** The command vector used to run gaiadesk-cli. */
  get cli(): readonly string[] {
    if (!this.cliCommand) {
      const c = this.opts.cli;
      this.cliCommand = c === undefined ? [locateCli(this.opts.env ?? process.env)] : typeof c === 'string' ? [c] : [...c];
      if (this.cliCommand.length === 0) throw new UsageError('cli must not be empty', { kind: 'usage' });
    }
    return this.cliCommand;
  }

  /** The environment gaiadesk-cli runs with: the base env plus the configured credentials. */
  environment(): Record<string, string | undefined> {
    const o = this.opts;
    const env: Record<string, string | undefined> = { ...(o.env ?? process.env) };
    if (o.tokenFile !== undefined) env.GAIADESK_TOKEN_FILE = o.tokenFile;
    if (o.code !== undefined) {
      env.GAIADESK_CODE = o.code;
      // An explicit code must not lose to an inherited token file (the CLI's
      // rule tries $GAIADESK_TOKEN_FILE first).
      if (o.tokenFile === undefined) delete env.GAIADESK_TOKEN_FILE;
    }
    if (o.accountToken !== undefined) env.GAIADESK_TOKEN = o.accountToken;
    if (o.agentToken !== undefined) env.GAIADESK_AGENT_TOKEN = o.agentToken;
    if (o.server !== undefined) env.GAIADESK_SERVER = o.server;
    if (o.persist !== undefined) env.GAIADESK_PERSIST = A.duration(o.persist, 'persist');
    for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
    return env;
  }

  private inv(args: readonly string[], input?: string | Uint8Array, signal?: AbortSignalLike): Invocation {
    return { command: this.cli, args, env: this.environment(), cwd: this.opts.cwd, input, signal };
  }

  /** Run any gaiadesk-cli command and collect its output, exit code untouched. The escape hatch. */
  raw(args: readonly string[], opts: CallOptions & { input?: string | Uint8Array } = {}): Promise<Completed> {
    return runCli(this.inv(args, opts.input, opts.signal));
  }

  /** The error for a failed run (see errorFromRun: the one place that reads the CLI's error envelopes). */
  private failure(done: Completed, args: readonly string[], json: unknown): GaiaDeskError {
    return errorFromRun(done, args, json);
  }

  /** Run a --json desk operation; `ok` lists the exit codes whose JSON is a result. */
  private async op<T>(args: string[], ok: number[] = [0], c: CallOptions = {}, input?: string | Uint8Array): Promise<T> {
    const done = await runCli(this.inv(args, input, c.signal));
    const json = parseJson(done.stdout);
    if (done.code !== null && ok.includes(done.code) && json !== undefined && errorEnvelope(json) === null) return json as T;
    if (done.code === 0 && json === undefined) {
      throw new ProtocolError('gaiadesk-cli printed no JSON', { exitCode: 0, stderr: done.stderr, argv: args, kind: 'protocol' });
    }
    throw this.failure(done, args, json);
  }

  // ───────────────────────────── version ─────────────────────────────

  /** `gaiadesk-cli --version` (e.g. "gaiadesk-cli 0.1.0"). */
  async version(): Promise<string> {
    const done = await runCli(this.inv(['--version']));
    if (done.code !== 0) throw this.failure(done, ['--version'], undefined);
    return done.stdout.trim();
  }

  // ───────────────────────────── devices ─────────────────────────────

  /**
   * `devices --json [--probe] [-d <id>]`. With `probe`, each desk is dialled
   * now; a desk that could not be reached has `reachable: false` (the CLI
   * exits 1 then, which is not an error here).
   */
  devices(o: { probe?: boolean; deskId?: string } & CallOptions = {}): Promise<DevicesResult> {
    return this.op<DevicesResult>(A.devicesArgs(o), [0, 1], o);
  }

  /** `devices --probe -d <id>`: is this desk reachable right now? */
  async probe(deskId: string, c: CallOptions = {}): Promise<DevicesResult['devices'][number]> {
    const r = await this.devices({ probe: true, deskId, signal: c.signal });
    const row = r.devices.find((d) => d.desk_id === deskId) ?? r.devices[0];
    if (!row) throw new ProtocolError(`devices --probe listed no row for ${deskId}`, { kind: 'protocol', json: r });
    return row;
  }

  // ───────────────────────────── exec / shell ─────────────────────────────

  private execOutcome(done: Completed, args: readonly string[], check: boolean | undefined): ExecResult {
    const json = parseJson(done.stdout);
    if (!isObj(json) || typeof json.exit !== 'number') {
      if (done.code !== 0) throw this.failure(done, args, json);
      throw new ProtocolError('gaiadesk-cli printed no exec JSON', { exitCode: done.code, stderr: done.stderr, argv: args, kind: 'protocol' });
    }
    const r = json as unknown as ExecResult;
    const details = { exitCode: done.code, stderr: done.stderr, argv: args, json };
    const env = errorEnvelope(json);
    // A failure before the command ran: an envelope with a kind.
    if (env?.kind !== undefined) throw errorFromRun(done, args, json);
    // The desk refused the command itself (e.g. a token without `exec`): exit 254, it never ran.
    if (r.exit === 254 && (r.remote_code === -1 || r.remote_code === null)) {
      throw new RefusedError(env?.message || lastStderrLine(done.stderr) || 'the desk refused the command', { ...details, kind: 'refused' });
    }
    if (check && r.exit !== 0) {
      const why = r.timed_out ? 'timed out' : `exited ${r.exit}`;
      throw new CommandError(`command on desk ${r.desk} ${why}`, r, details);
    }
    return r;
  }

  /**
   * `exec --json`: run ONE command and return its exit code, stdout and
   * stderr. `command` as a string is one command line for the desk's shell;
   * as an array, separate arguments. A non-zero exit is a result, not an
   * error, unless `check: true`. Throws when the command never ran.
   */
  async exec(deskId: string, command: string | readonly string[], o: ExecOptions = {}): Promise<ExecResult> {
    const args = A.execArgs(deskId, command, { ...o, stdin: o.stdin !== undefined }, true);
    const done = await runCli(this.inv(args, o.stdin, o.signal));
    return this.execOutcome(done, args, o.check);
  }

  /** `exec` without --json: stdout/stderr arrive as the command writes them. */
  execStream(deskId: string, command: string | readonly string[], o: StreamExecOptions = {}): CliStream {
    const args = A.execArgs(deskId, command, { ...o, stdin: o.stdin !== undefined }, false);
    const input = o.stdin === true ? undefined : o.stdin;
    return new CliStream(this.inv(args, input, o.signal), o.stdin === true);
  }

  /**
   * `shell --json` with `script` on stdin: the script runs in the desk's
   * shell over plain pipes (handed whole to the shell on macOS/Linux; on
   * Windows cmd.exe reads it line by line). The exit code is the script's.
   */
  async shell(deskId: string, script: string, o: Omit<ExecOptions, 'stdin'> = {}): Promise<ExecResult> {
    const args = A.shellArgs(deskId, o, true);
    const done = await runCli(this.inv(args, script, o.signal));
    return this.execOutcome(done, args, o.check);
  }

  /**
   * `shell` (no --json), streaming. With `script`, it is written and stdin is
   * closed; without one, stdin stays open: `write()` lines, then `end()`.
   * Not a terminal: no prompt, no echo (an interactive PTY needs a real terminal).
   */
  shellStream(deskId: string, script?: string, o: A.RunShapeOptions & CallOptions = {}): CliStream {
    const args = A.shellArgs(deskId, o, false);
    return new CliStream(this.inv(args, script, o.signal), script === undefined);
  }

  // ───────────────────────────── cp ─────────────────────────────

  /** `cp --json <local> <desk>:<remote>`. Resumable; throws OperationFailedError (with the summary as `json`) if any file failed. */
  upload(local: string, deskId: string, remote: string, o: { recursive?: boolean } & CallOptions = {}): Promise<CpSummary> {
    return this.op<CpSummary>(A.cpArgs('upload', deskId, local, remote, !!o.recursive), [0], o);
  }

  /** `cp --json <desk>:<remote> <local>`. */
  download(deskId: string, remote: string, local: string, o: { recursive?: boolean } & CallOptions = {}): Promise<CpSummary> {
    return this.op<CpSummary>(A.cpArgs('download', deskId, local, remote, !!o.recursive), [0], o);
  }

  // ───────────────────────────── jobs ─────────────────────────────

  /** `run --detach --json`: start a named background job that outlives this connection. */
  runJob(deskId: string, name: string, command: string | readonly string[], o: A.JobOptions & CallOptions = {}): Promise<JobInfo> {
    return this.op<JobInfo>(A.runArgs(deskId, name, command, o), [0], o);
  }

  /** `ps --json`. */
  jobs(deskId: string, c: CallOptions = {}): Promise<JobInfo[]> {
    return this.op<JobInfo[]>(A.psArgs(deskId), [0], c);
  }

  /** `kill --json`: stop a job and everything it started. */
  killJob(deskId: string, name: string, c: CallOptions = {}): Promise<JobInfo> {
    return this.op<JobInfo>(A.killArgs(deskId, name), [0], c);
  }

  /** `logs <job>` (no --json exists): the job's output so far, stdout and stderr together. */
  async jobLogs(deskId: string, name: string, o: { tail?: number } & CallOptions = {}): Promise<string> {
    const args = A.logsArgs(deskId, name, { tail: o.tail });
    const done = await runCli(this.inv(args, undefined, o.signal));
    if (done.code !== 0) throw this.failure(done, args, undefined);
    return done.stdout;
  }

  /** `logs -f <job>`: follow until the job ends; `kill()` stops following (not the job). */
  followJobLogs(deskId: string, name: string, o: { tail?: number } & CallOptions = {}): CliStream {
    return new CliStream(this.inv(A.logsArgs(deskId, name, { tail: o.tail, follow: true }), undefined, o.signal));
  }

  // ───────────────────────────── stats / measure ─────────────────────────────

  /** `stats --json`: CPU, load, memory, disks, uptime, running jobs. */
  stats(deskId: string, c: CallOptions = {}): Promise<DeskStats> {
    return this.op<DeskStats>(A.statsArgs(deskId), [0], c);
  }

  /** `measure --json`: round trip and clock offset. `rtt_ms` is null if no ping came back (CLI exit 1). */
  measure(deskId: string, o: { count?: number } & CallOptions = {}): Promise<MeasureResult> {
    return this.op<MeasureResult>(A.measureArgs(deskId, o.count), [0, 1], o);
  }

  // ───────────────────────────── tokens / audit ─────────────────────────────

  /**
   * `token create --json`. Owner only: needs the desk's unattended password
   * (the `code` option). Without `out`, each entry carries the `secret`, shown once.
   */
  createToken(o: A.TokenCreateOptions & CallOptions): Promise<TokenCreateResult> {
    return this.op<TokenCreateResult>(A.tokenCreateArgs(o), [0], o);
  }

  /** `token list --json` (owner only). */
  listTokens(deskId: string, c: CallOptions = {}): Promise<TokenInfo[]> {
    return this.op<TokenInfo[]>(A.tokenListArgs(deskId), [0], c);
  }

  /**
   * `token revoke --json`: by name or id, or `{ all: true }`. With
   * `account: true` it goes through the GaiaDesk server as the signed-in
   * account (no desk password) and returns `{desk, ok, message}`.
   */
  revokeToken(deskId: string, which: string | { all: true }, o: { account?: boolean } & CallOptions = {}): Promise<TokenRevokeResult | AccountRevokeResult> {
    return this.op<TokenRevokeResult | AccountRevokeResult>(A.tokenRevokeArgs(deskId, which, !!o.account), [0], o);
  }

  /** `audit --json`: what agent tokens did on the desk, newest first. */
  audit(deskId: string, o: { token?: string; limit?: number; account?: boolean } & CallOptions = {}): Promise<AuditEvent[]> {
    return this.op<AuditEvent[]>(A.auditArgs(deskId, o), [0], o);
  }

  // ───────────────────────────── mesh / connections ─────────────────────────────

  /** `mesh status --json`. */
  meshStatus(c: CallOptions = {}): Promise<MeshStatus> {
    return this.op<MeshStatus>(['mesh', 'status', '--json'], [0], c);
  }

  /** `mesh ip <desk>` (plain text; no --json exists). */
  async meshIp(deskId: string, c: CallOptions = {}): Promise<string> {
    const args = ['mesh', 'ip', A.checkDesk(deskId)];
    const done = await runCli(this.inv(args, undefined, c.signal));
    if (done.code !== 0) throw this.failure(done, args, undefined);
    return done.stdout.trim();
  }

  /** `disconnect`: close the held connection to one desk, or to all (no argument). */
  async disconnect(deskId?: string, c: CallOptions = {}): Promise<void> {
    const args = A.disconnectArgs(deskId);
    const done = await runCli(this.inv(args, undefined, c.signal));
    if (done.code !== 0) throw this.failure(done, args, undefined);
  }

  // ───────────────────────────── forward ─────────────────────────────

  /**
   * `forward --json`: listen on localhost here and carry each connection to
   * a port on (or near) the desk. Resolves once every forward is listening.
   */
  async forward(deskId: string, specs: A.ForwardSpec | readonly A.ForwardSpec[], c: CallOptions = {}): Promise<Forward> {
    const list = Array.isArray(specs) ? (specs as readonly A.ForwardSpec[]) : [specs as A.ForwardSpec];
    const args = A.forwardArgs(deskId, list);
    const stream = new CliStream(this.inv(args, undefined, c.signal));
    const listening: ForwardListening[] = [];
    const dec = new TextDecoder('utf-8');
    let buf = '';
    let stderr = '';
    const ready = new Promise<void>((resolve) => {
      void (async () => {
        for await (const ch of stream) {
          if (ch.stream === 'stderr') {
            stderr += dec.decode(ch.data);
            continue;
          }
          buf += dec.decode(ch.data, { stream: true });
          let i: number;
          while ((i = buf.indexOf('\n')) >= 0) {
            const line = buf.slice(0, i).trim();
            buf = buf.slice(i + 1);
            const ev = parseJson(line);
            if (isObj(ev) && ev.event === 'listening') {
              listening.push(ev as unknown as ForwardListening);
              if (listening.length === list.length) resolve();
            }
          }
        }
      })();
    });
    const exited = stream.wait();
    const first = await Promise.race([ready.then(() => null), exited.then((e) => e)]);
    if (first !== null) {
      const done: Completed = { code: first.exitCode, signal: first.signal, stdout: '', stderr };
      throw this.failure(done, args, undefined);
    }
    return {
      listening,
      done: exited,
      close: async () => {
        stream.kill('SIGINT');
        return exited;
      },
    };
  }

  // ───────────────────────────── Agent Access (screen) ─────────────────────────────

  /**
   * `agent-connect`: prove an agent token opens a screen session on the desk
   * (one screenshot round trip). Needs `agentToken` (or $GAIADESK_AGENT_TOKEN).
   * Returns the CLI's line, e.g. "agent session open on desk N: screenshot 1280x800".
   */
  async agentConnect(deskId: string, c: CallOptions = {}): Promise<string> {
    const args = A.agentConnectArgs(deskId, this.opts.server);
    const done = await runCli(this.inv(args, undefined, c.signal));
    if (done.code !== 0) throw this.failure(done, args, undefined);
    return done.stdout.trim();
  }

  /**
   * Start `gaiadesk-cli mcp` (stdio) and return a client for it: the way to
   * use the screen tools (gaiadesk.open_session, screenshot, click, ...) from
   * code. Desk tools there use tokenFile/code; screen tools need agentToken.
   */
  mcp(o: A.McpServerOptions = {}): McpClient {
    return new McpClient(this.inv(A.mcpArgs(o, this.opts.server)));
  }
}
