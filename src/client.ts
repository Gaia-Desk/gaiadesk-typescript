// The GaiaDesk client: each method runs one gaiadesk-cli command with --json
// and returns the CLI's own JSON, typed. When the native library (@gaiadesk/sdk-native, an optional dependency) is installed,
// the same methods run on it instead: no gaiadesk-cli needed, same results,
// same errors (see `backend`).

import * as A from './args.js';
import {
  CliNotFoundError,
  CommandError,
  GaiaDeskError,
  ProtocolError,
  UsageError,
  errorEnvelope,
  errorForKind,
  errorFromRun,
  lastStderrLine,
  sdkKind,
} from './errors.js';
import { DeferredStream, JsonExecStream } from './exec-stream.js';
import { NEEDS, cliVersionInfo, requireFeature } from './features.js';
import { locateCli } from './locate.js';
import { McpClient } from './mcp.js';
import * as N from './native-args.js';
import { NativeBackend, fromNative, loadNative, nativeOptions } from './native.js';
import type { NativeModule } from './native.js';
import { CliStream, runCli } from './proc.js';
import type { Completed, Exit, Invocation, OutputStream } from './proc.js';
import { listOf, neverRan, normalizeExecResult, textOf } from './results.js';
import type {
  AbortSignalLike,
  AccountRevokeResult,
  AgentCheck,
  AuditEvent,
  CpSummary,
  DeskStats,
  DevicesResult,
  Disconnected,
  ExecResult,
  ForwardListening,
  JobInfo,
  JobLogs,
  MeasureResult,
  MeshIp,
  MeshStatus,
  MintResult,
  TokenCreateResult,
  TokenFileResult,
  TokenInfo,
  TokenRevokeResult,
  VersionInfo,
} from './types.js';

export interface GaiaDeskOptions {
  /**
   * gaiadesk-cli: a path, or a command vector (e.g. `[process.execPath, 'fake-cli.mjs']`).
   * Default: $GAIADESK_CLI, then the binary of @gaiadesk/cli (an optional dependency), then PATH, then the standard install locations.
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
  /**
   * `auto` (default): the native library when @gaiadesk/sdk-native is
   * installed and has a binary for this machine, else gaiadesk-cli. An
   * explicit `cli` option means gaiadesk-cli. `native` / `cli` force one
   * (`native` throws if the library is not usable). Default from
   * $GAIADESK_SDK_BACKEND. `raw()` and `mcp()` always run gaiadesk-cli.
   */
  backend?: 'auto' | 'native' | 'cli';
  /** The native module to use instead of `require('@gaiadesk/sdk-native')` (tests, custom builds). */
  native?: NativeModule;
}

export interface CallOptions {
  signal?: AbortSignalLike;
}

export interface ExecOptions extends A.RunShapeOptions, CallOptions {
  /** Text or bytes for the command's stdin (then end of input). Default: stdin closed. */
  stdin?: string | Uint8Array;
  /**
   * The directory the command starts in on the desk (relative: from the desk
   * user's home, or a confined token's folder). A gaiadesk-cli without the
   * `exec_cwd` feature is a UsageError saying to update it, never ignored.
   */
  cwd?: string;
  /** Throw CommandError when the command exits non-zero (or times out). Default false. */
  check?: boolean;
}

export interface StreamExecOptions extends A.RunShapeOptions, CallOptions {
  /** Data for stdin, or `true` to keep stdin open for `stream.write()` / `stream.end()`. */
  stdin?: string | Uint8Array | true;
  /** The directory the command starts in on the desk (as ExecOptions.cwd). */
  cwd?: string;
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
  private nativeBackend?: NativeBackend | null;

  constructor(opts: GaiaDeskOptions = {}) {
    this.opts = { ...opts };
  }

  /** The native backend when this client uses it (decided once, on first use). */
  private nat(): NativeBackend | null {
    if (this.nativeBackend !== undefined) return this.nativeBackend;
    const o = this.opts;
    const want = o.backend ?? (o.env ?? process.env).GAIADESK_SDK_BACKEND ?? 'auto';
    if (want !== 'auto' && want !== 'native' && want !== 'cli') {
      throw new UsageError(`backend is auto, native or cli (not ${JSON.stringify(want)})`, { kind: 'usage' });
    }
    let mod: NativeModule | null = null;
    let why = 'not wanted';
    if (want === 'native' || (want === 'auto' && o.cli === undefined)) {
      if (o.native) mod = o.native;
      else ({ module: mod, why = '' } = loadNative());
    }
    if (!mod && want === 'native') {
      throw new CliNotFoundError(`backend: 'native', but @gaiadesk/sdk-native is not usable here: ${why}`, { kind: 'not_found' });
    }
    if (!mod) return (this.nativeBackend = null);
    try {
      return (this.nativeBackend = new NativeBackend(new mod.Client(nativeOptions(this.environment(), o.cwd))));
    } catch (e) {
      throw fromNative(e, 'client');
    }
  }

  /** Which backend runs the operations: `native` (@gaiadesk/sdk-native) or `cli` (gaiadesk-cli). */
  get backend(): 'native' | 'cli' {
    return this.nat() ? 'native' : 'cli';
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

  /** Run any gaiadesk-cli command and collect its output, exit code untouched. The escape hatch (always gaiadesk-cli). */
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

  /**
   * `gaiadesk-cli --version --json` (always gaiadesk-cli, like raw()): its
   * release, `features` and MCP protocol revisions; null for a CLI too old
   * to answer it. Asked once per CLI path in this process.
   */
  versionInfo(): Promise<VersionInfo | null> {
    return cliVersionInfo(this.cli, () => runCli(this.inv(['--version', '--json'])));
  }

  /** The features gaiadesk-cli lists in `--version --json`. */
  async features(): Promise<ReadonlySet<string>> {
    return new Set((await this.versionInfo())?.features ?? []);
  }

  /** A UsageError unless gaiadesk-cli has `feature` (an option it would not understand must not be dropped). */
  private async require(feature: keyof typeof NEEDS): Promise<void> {
    requireFeature(await this.versionInfo(), feature);
  }

  /** `gaiadesk-cli --version` (e.g. "gaiadesk-cli 0.10.324"); on the native backend "gaiadesk-native <version>". */
  async version(): Promise<string> {
    const n = this.nat();
    if (n) return `gaiadesk-native ${(await n.call<{ version: string }>('version')).version}`;
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
    const n = this.nat();
    if (n) return n.call<DevicesResult>('devices', N.devices(o), o);
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
    const r = normalizeExecResult(json);
    const details = { exitCode: done.code, stderr: done.stderr, argv: args, json };
    // It never ran (unreachable, refused, a cwd that is not there, ...): the error, typed by its kind.
    if (neverRan(r) && r.error) {
      const e = r.error;
      const msg = e.message || lastStderrLine(done.stderr) || 'the command did not run';
      throw errorForKind(e.kind, msg, { ...details, kind: sdkKind(e.kind, e.reason), reason: e.reason ?? null, desk: e.desk ?? r.desk });
    }
    if (check && r.exit !== 0) {
      const why = r.timed_out ? 'timed out' : `exited ${r.exit}`;
      throw new CommandError(`command on desk ${r.desk} ${why}`, r, { ...details, desk: r.desk });
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
    const n = this.nat();
    if (n) return n.exec('exec', N.exec(deskId, command, o), { input: o.stdin, signal: o.signal, check: o.check });
    const args = A.execArgs(deskId, command, { ...o, stdin: o.stdin !== undefined }, true);
    if (o.cwd !== undefined) await this.require('exec_cwd');
    const done = await runCli(this.inv(args, o.stdin, o.signal));
    return this.execOutcome(done, args, o.check);
  }

  /**
   * `exec`, streaming: stdout/stderr arrive as the command writes them, then
   * `wait()` gives the exit. It runs `exec --json-stream`, so the exit also
   * carries the run's `result` (and `error` when it never ran). A usage error
   * found only once the CLI is known (`cwd` on a CLI without `exec_cwd`) is
   * thrown by iteration and wait().
   */
  execStream(deskId: string, command: string | readonly string[], o: StreamExecOptions = {}): OutputStream {
    const n = this.nat();
    if (n) return n.stream('exec', N.exec(deskId, command, o), { stdin: o.stdin, signal: o.signal });
    const args = A.execArgs(deskId, command, { ...o, stdin: o.stdin !== undefined }, 'stream');
    const open = () => new JsonExecStream(this.inv(args, o.stdin === true ? undefined : o.stdin, o.signal), o.stdin === true);
    if (o.cwd === undefined) return open();
    return new DeferredStream(args, this.require('exec_cwd').then(open));
  }

  /**
   * `shell --json` with `script` on stdin: the script runs in the desk's
   * shell over plain pipes (handed whole to the shell on macOS/Linux; on
   * Windows cmd.exe reads it line by line). The exit code is the script's.
   * `cwd`: where it starts on the desk (`shell --cwd`; a gaiadesk-cli without
   * the `shell_cwd` feature is a UsageError).
   */
  async shell(deskId: string, script: string, o: Omit<ExecOptions, 'stdin'> = {}): Promise<ExecResult> {
    const n = this.nat();
    if (n) return n.exec('shell', N.shell(deskId, script, o), { signal: o.signal, check: o.check });
    const args = A.shellArgs(deskId, o, true);
    if (o.cwd !== undefined) await this.require('shell_cwd');
    const done = await runCli(this.inv(args, script, o.signal));
    return this.execOutcome(done, args, o.check);
  }

  /**
   * `shell` (no --json), streaming. With `script`, it is written and stdin is
   * closed; without one, stdin stays open: `write()` lines, then `end()`.
   * Not a terminal: no prompt, no echo (an interactive PTY needs a real terminal).
   * `cwd` as for shell() (without `shell_cwd`: a UsageError from iteration and wait()).
   */
  shellStream(deskId: string, script?: string, o: A.RunShapeOptions & CallOptions & { cwd?: string } = {}): OutputStream {
    const n = this.nat();
    if (n) return n.stream('shell', N.shellStream(deskId, o), { stdin: script ?? true, signal: o.signal });
    const args = A.shellArgs(deskId, o, false);
    if (o.cwd === undefined) return new CliStream(this.inv(args, script, o.signal), script === undefined);
    const start = this.require('shell_cwd').then(() => new CliStream(this.inv(args, script, o.signal), script === undefined));
    return new DeferredStream(args, start);
  }

  // ───────────────────────────── cp ─────────────────────────────

  /** `cp --json <local> <desk>:<remote>`. Resumable; throws OperationFailedError (with the summary as `json`) if any file failed. */
  upload(local: string, deskId: string, remote: string, o: { recursive?: boolean } & CallOptions = {}): Promise<CpSummary> {
    const n = this.nat();
    if (n) return n.cp<CpSummary>('upload', N.cp('upload', deskId, local, remote, !!o.recursive), o);
    return this.op<CpSummary>(A.cpArgs('upload', deskId, local, remote, !!o.recursive), [0], o);
  }

  /** `cp --json <desk>:<remote> <local>`. */
  download(deskId: string, remote: string, local: string, o: { recursive?: boolean } & CallOptions = {}): Promise<CpSummary> {
    const n = this.nat();
    if (n) return n.cp<CpSummary>('download', N.cp('download', deskId, local, remote, !!o.recursive), o);
    return this.op<CpSummary>(A.cpArgs('download', deskId, local, remote, !!o.recursive), [0], o);
  }

  // ───────────────────────────── jobs ─────────────────────────────

  /**
   * `run --detach --json`: start a named background job that outlives this
   * connection. `cwd` (the directory it starts in) needs the `run_cwd`
   * feature (or the native library).
   */
  async runJob(deskId: string, name: string, command: string | readonly string[], o: A.JobOptions & CallOptions = {}): Promise<JobInfo> {
    const n = this.nat();
    if (n) return n.call<JobInfo>('job_run', N.runJob(deskId, name, command, o), o);
    const args = A.runArgs(deskId, name, command, o);
    if (o.cwd !== undefined) await this.require('run_cwd');
    return this.op<JobInfo>(args, [0], o);
  }

  /** `ps --json`: the `jobs` of `{"jobs": [...]}`. */
  async jobs(deskId: string, c: CallOptions = {}): Promise<JobInfo[]> {
    const n = this.nat();
    if (n) return listOf<JobInfo>(await n.call('job_list', N.desk(deskId), c), 'jobs', ['job_list']);
    const args = A.psArgs(deskId);
    return listOf<JobInfo>(await this.op<unknown>(args, [0], c), 'jobs', args);
  }

  /** `kill --json`: stop a job and everything it started. */
  killJob(deskId: string, name: string, c: CallOptions = {}): Promise<JobInfo> {
    const n = this.nat();
    if (n) return n.call<JobInfo>('job_kill', N.job(deskId, name), c);
    return this.op<JobInfo>(A.killArgs(deskId, name), [0], c);
  }

  /** `logs <job> --json`: the job's output so far, stdout and stderr together. */
  async jobLogs(deskId: string, name: string, o: { tail?: number } & CallOptions = {}): Promise<string> {
    const n = this.nat();
    if (n) return textOf(await n.call('job_logs', N.logs(deskId, name, o.tail), o), 'output');
    return textOf(await this.op<JobLogs>(A.logsArgs(deskId, name, { tail: o.tail }), [0], o), 'output');
  }

  /**
   * `logs -f --json <job>`: follow until the job ends; `kill()` stops
   * following (not the job). A failure's `{kind, message}` is on wait()'s `error`.
   */
  followJobLogs(deskId: string, name: string, o: { tail?: number } & CallOptions = {}): OutputStream {
    const n = this.nat();
    if (n) return n.stream('job_follow', N.logs(deskId, name, o.tail), { signal: o.signal });
    return new JsonExecStream(this.inv(A.logsArgs(deskId, name, { tail: o.tail, follow: true }), undefined, o.signal), false, 'logs');
  }

  // ───────────────────────────── stats / measure ─────────────────────────────

  /** `stats --json`: CPU, load, memory, disks, uptime, running jobs. */
  stats(deskId: string, c: CallOptions = {}): Promise<DeskStats> {
    const n = this.nat();
    if (n) return n.call<DeskStats>('stats', N.desk(deskId), c);
    return this.op<DeskStats>(A.statsArgs(deskId), [0], c);
  }

  /** `measure --json`: round trip and clock offset. `rtt_ms` is null if no ping came back (CLI exit 1). */
  measure(deskId: string, o: { count?: number } & CallOptions = {}): Promise<MeasureResult> {
    const n = this.nat();
    if (n) return n.call<MeasureResult>('measure', N.measure(deskId, o.count), o);
    return this.op<MeasureResult>(A.measureArgs(deskId, o.count), [0, 1], o);
  }

  // ───────────────────────────── tokens / audit ─────────────────────────────

  /**
   * `token create --json`. Owner only: needs the desk's unattended password
   * (the `code` option). Without `out`, each entry carries the `secret`, shown
   * once (a `MintResult`); with `out`, the secrets are only in that file and
   * the result is a `TokenFileResult` (`{tokens[{desk, token}], file}`).
   */
  createToken(o: A.TokenCreateOptions & { out: string } & CallOptions): Promise<TokenFileResult>;
  createToken(o: A.TokenCreateOptions & { out?: undefined } & CallOptions): Promise<MintResult>;
  createToken(o: A.TokenCreateOptions & CallOptions): Promise<TokenCreateResult>;
  createToken(o: A.TokenCreateOptions & CallOptions): Promise<TokenCreateResult> {
    const n = this.nat();
    if (n) return n.call<TokenCreateResult>('token_mint', N.tokenCreate(o), o);
    return this.op<TokenCreateResult>(A.tokenCreateArgs(o), [0], o);
  }

  /** `token list --json` (owner only): the `tokens` of `{"tokens": [...]}`. */
  async listTokens(deskId: string, c: CallOptions = {}): Promise<TokenInfo[]> {
    const n = this.nat();
    if (n) return listOf<TokenInfo>(await n.call('token_list', N.desk(deskId), c), 'tokens', ['token_list']);
    const args = A.tokenListArgs(deskId);
    return listOf<TokenInfo>(await this.op<unknown>(args, [0], c), 'tokens', args);
  }

  /**
   * `token revoke --json`: by name or id, or `{ all: true }`. With
   * `account: true` it goes through the GaiaDesk server as the signed-in
   * account (no desk password) and returns `{desk, ok, message}`.
   */
  revokeToken(deskId: string, which: string | { all: true }, o: { account?: boolean } & CallOptions = {}): Promise<TokenRevokeResult | AccountRevokeResult> {
    const n = this.nat();
    if (n) return n.call<TokenRevokeResult | AccountRevokeResult>('token_revoke', N.tokenRevoke(deskId, which, !!o.account), o);
    return this.op<TokenRevokeResult | AccountRevokeResult>(A.tokenRevokeArgs(deskId, which, !!o.account), [0], o);
  }

  /** `audit --json`: what agent tokens did on the desk, newest first (the `events` of `{"events": [...]}`). */
  async audit(deskId: string, o: { token?: string; limit?: number; account?: boolean } & CallOptions = {}): Promise<AuditEvent[]> {
    const n = this.nat();
    if (n) return listOf<AuditEvent>(await n.call('audit', N.audit(deskId, o), o), 'events', ['audit']);
    const args = A.auditArgs(deskId, o);
    return listOf<AuditEvent>(await this.op<unknown>(args, [0], o), 'events', args);
  }

  // ───────────────────────────── mesh / connections ─────────────────────────────

  /** `mesh status --json`. */
  meshStatus(c: CallOptions = {}): Promise<MeshStatus> {
    const n = this.nat();
    if (n) return n.call<MeshStatus>('mesh_status', {}, c);
    return this.op<MeshStatus>(['mesh', 'status', '--json'], [0], c);
  }

  /** `mesh ip <desk> --json`: the desk's Mesh address. */
  async meshIp(deskId: string, c: CallOptions = {}): Promise<string> {
    const n = this.nat();
    if (n) return textOf(await n.call('mesh_ip', N.desk(deskId), c), 'mesh_ip');
    return textOf(await this.op<MeshIp>(A.meshIpArgs(deskId), [0], c), 'mesh_ip');
  }

  /** `disconnect --json`: close the held connection to one desk, or to all (no argument): `{closed: [desk ids]}`. */
  disconnect(deskId?: string, c: CallOptions = {}): Promise<Disconnected> {
    const n = this.nat();
    if (n) return n.call<Disconnected>('disconnect', N.disconnect(deskId), c);
    return this.op<Disconnected>(A.disconnectArgs(deskId), [0], c);
  }

  // ───────────────────────────── forward ─────────────────────────────

  /**
   * `forward --json`: listen on localhost here and carry each connection to
   * a port on (or near) the desk. Resolves once every forward is listening.
   */
  async forward(deskId: string, specs: A.ForwardSpec | readonly A.ForwardSpec[], c: CallOptions = {}): Promise<Forward> {
    const list = Array.isArray(specs) ? (specs as readonly A.ForwardSpec[]) : [specs as A.ForwardSpec];
    const n = this.nat();
    if (n) {
      const f = await n.forward(deskId, N.forward(deskId, list), c.signal);
      return { listening: f.listening as unknown as ForwardListening[], done: f.done, close: f.close };
    }
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
   * Returns a line made from `agent-connect --json`, e.g. "agent session open
   * on desk N: screenshot 1280x800"; a refusal is typed by the error envelope.
   */
  async agentConnect(deskId: string, c: CallOptions = {}): Promise<string> {
    const n = this.nat();
    if (n) return n.agentConnect(A.checkDesk(deskId), c.signal);
    const r = await this.op<AgentCheck>(A.agentConnectArgs(deskId, this.opts.server), [0], c);
    return `agent session open on desk ${r.desk_id}: screenshot ${r.screenshot.width}x${r.screenshot.height}`;
  }

  /**
   * Start `gaiadesk-cli mcp` (stdio) and return a client for it: the way to
   * use the screen tools (gaiadesk_open_session, gaiadesk_screenshot,
   * gaiadesk_click, ...) from code. Desk tools there use tokenFile/code; screen tools need agentToken.
   */
  mcp(o: A.McpServerOptions = {}): McpClient {
    return new McpClient(this.inv(A.mcpArgs(o, this.opts.server)));
  }
}
