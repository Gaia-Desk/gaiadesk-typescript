// gaiadesk-cli argument vectors, built from options. Pure (no I/O), so every
// rule is unit-tested. Flags are exactly those in `gaiadesk-cli <cmd> --help`.
// Credentials never go in argv (every user on a machine can read a command
// line); the client passes them through the environment instead.

import { UsageError } from './errors.js';
import type { Shell } from './types.js';

const SHELLS: readonly Shell[] = ['default', 'none', 'sh', 'cmd', 'pwsh'];

/** A desk id: one token, no whitespace, not a flag. */
export function checkDesk(deskId: string): string {
  if (typeof deskId !== 'string' || !deskId.trim()) throw new UsageError('a desk id is required', { kind: 'usage' });
  const d = deskId.trim();
  if (/\s/.test(d) || d.startsWith('-')) throw new UsageError(`not a desk id: ${JSON.stringify(deskId)}`, { kind: 'usage' });
  return d;
}

/** A job name: `ps`, `logs` and `kill` take it as a positional, so it must not look like a flag. */
export function checkJobName(name: string): string {
  if (typeof name !== 'string' || !/^[A-Za-z0-9._][A-Za-z0-9._-]*$/.test(name)) {
    throw new UsageError(`a job name is letters, digits, . _ - (not starting with -): ${JSON.stringify(name)}`, { kind: 'usage' });
  }
  return name;
}

/**
 * A duration for gaiadesk-cli: a number is whole seconds (rounded up; the
 * CLI reads a bare integer as seconds), a string is passed as written
 * (`30s`, `10m`, `2h`).
 */
export function duration(v: number | string, flag: string): string {
  if (typeof v === 'number') {
    if (!Number.isFinite(v) || v < 0) throw new UsageError(`${flag} must be a number of seconds >= 0`, { kind: 'usage' });
    return String(Math.ceil(v));
  }
  if (!/^\s*\d+\s*[a-z]*(\s*\d+\s*[a-z]+)*\s*$/i.test(v)) throw new UsageError(`${flag}: not a duration: ${JSON.stringify(v)}`, { kind: 'usage' });
  return v.trim();
}

export interface RunShapeOptions {
  shell?: Shell;
  /** Seconds (0 = no limit) or a duration string. CLI default 30m. */
  timeout?: number | string;
  /** Seconds or a duration string. CLI default 60s. */
  connectTimeout?: number | string;
  /** Hold the connection this long for later commands (`--persist`). */
  persist?: number | string;
  /** `-v`: how it ran, on stderr. */
  verbose?: boolean;
}

function shapeFlags(o: RunShapeOptions): string[] {
  const a: string[] = [];
  if (o.shell !== undefined) {
    if (!SHELLS.includes(o.shell)) throw new UsageError(`shell is one of ${SHELLS.join(', ')}`, { kind: 'usage' });
    a.push('--shell', o.shell);
  }
  if (o.timeout !== undefined) a.push('--timeout', duration(o.timeout, '--timeout'));
  if (o.connectTimeout !== undefined) {
    const d = duration(o.connectTimeout, '--connect-timeout');
    if (d === '0') throw new UsageError('--connect-timeout must be more than 0', { kind: 'usage' });
    a.push('--connect-timeout', d);
  }
  if (o.persist !== undefined) a.push('--persist', duration(o.persist, '--persist'));
  if (o.verbose) a.push('--verbose');
  return a;
}

/**
 * A directory on the desk for `--cwd` (exec, run): as written (a relative one
 * is taken from the desk user's home, or a confined token's folder).
 */
export function checkCwd(cwd: string): string {
  if (typeof cwd !== 'string' || !cwd.trim() || cwd.includes('\0')) {
    throw new UsageError(`cwd is a directory on the desk: ${JSON.stringify(cwd)}`, { kind: 'usage' });
  }
  return cwd;
}

/**
 * `exec --desk-id <id> [flags] -- <command>`. A string is ONE command line
 * for the desk's shell, verbatim; an array is separate arguments, which the
 * desk quotes for its shell (`--shell none`: run directly). `json`: `true`
 * for `--json` (one object at the end), `'stream'` for `--json-stream` (one
 * event per line as it runs, gaiadesk-cli 0.10.324+), `false` for neither.
 */
export function execArgs(
  deskId: string,
  command: string | readonly string[],
  o: RunShapeOptions & { stdin?: boolean; cwd?: string },
  json: boolean | 'stream',
): string[] {
  const argv = typeof command === 'string' ? [command] : [...command];
  if (argv.length === 0 || (argv.length === 1 && !argv[0].trim())) throw new UsageError('exec needs a command', { kind: 'usage' });
  const a = ['exec', '--desk-id', checkDesk(deskId), '--quiet'];
  if (json === 'stream') a.push('--json-stream');
  else if (json) a.push('--json');
  a.push(o.stdin ? '--stdin' : '--no-stdin');
  a.push(...shapeFlags(o));
  if (o.cwd !== undefined) a.push('--cwd', checkCwd(o.cwd));
  a.push('--', ...argv);
  return a;
}

/** `shell --desk-id <id> [flags]`, with a script on stdin (non-interactive: plain pipes, like exec). */
export function shellArgs(deskId: string, o: RunShapeOptions, json: boolean): string[] {
  const a = ['shell', '--desk-id', checkDesk(deskId), '--quiet'];
  if (json) a.push('--json');
  a.push(...shapeFlags(o));
  return a;
}

export function devicesArgs(o: { probe?: boolean; deskId?: string }): string[] {
  const a = ['devices', '--json'];
  if (o.probe) a.push('--probe');
  if (o.deskId !== undefined) a.push('--desk-id', checkDesk(o.deskId));
  return a;
}

/**
 * A local path for `cp`: one that gaiadesk-cli would read as `<desk>:<path>`
 * (2+ letters or digits before a colon) or as a flag gets `./` in front.
 */
export function localPath(p: string): string {
  if (typeof p !== 'string' || !p) throw new UsageError('a local path is required', { kind: 'usage' });
  if (/^[A-Za-z0-9]{2,}:/.test(p) || p.startsWith('-')) return `./${p}`;
  return p;
}

export function cpArgs(dir: 'upload' | 'download', deskId: string, local: string, remote: string, recursive: boolean): string[] {
  const d = checkDesk(deskId);
  if (typeof remote !== 'string') throw new UsageError('a remote path is required', { kind: 'usage' });
  const a = ['cp'];
  if (recursive) a.push('--recursive');
  a.push('--json');
  const r = `${d}:${remote}`;
  const l = localPath(local);
  a.push(...(dir === 'upload' ? [l, r] : [r, l]));
  return a;
}

export interface JobOptions {
  priority?: 'low' | 'normal' | 'high';
  /** Share of the WHOLE machine, 1-100. */
  cpu?: number;
  /** Megabytes (at least the CLI's minimum), or a string like `2G`. */
  mem?: number | string;
  /** true: --keep-awake; false: --no-keep-awake; undefined: the desk's default. */
  keepAwake?: boolean;
  /** The directory the job starts in on the desk (`--cwd`; gaiadesk-cli 0.10.324+). */
  cwd?: string;
}

/** `run --detach --name <job> --desk-id <id> [caps] [--cwd <dir>] --json -- <command>`. */
export function runArgs(deskId: string, name: string, command: string | readonly string[], o: JobOptions): string[] {
  const argv = typeof command === 'string' ? [command] : [...command];
  if (argv.length === 0 || (argv.length === 1 && !argv[0].trim())) throw new UsageError('run needs a command', { kind: 'usage' });
  const a = ['run', '--detach', '--name', checkJobName(name), '--desk-id', checkDesk(deskId)];
  if (o.priority !== undefined) {
    if (!['low', 'normal', 'high'].includes(o.priority)) throw new UsageError('priority is low, normal or high', { kind: 'usage' });
    a.push('--priority', o.priority);
  }
  if (o.cpu !== undefined) {
    if (!Number.isInteger(o.cpu) || o.cpu < 1 || o.cpu > 100) throw new UsageError('cpu is a share of the whole machine, 1 to 100', { kind: 'usage' });
    a.push('--cpu', String(o.cpu));
  }
  if (o.mem !== undefined) a.push('--mem', String(o.mem));
  if (o.keepAwake === true) a.push('--keep-awake');
  if (o.keepAwake === false) a.push('--no-keep-awake');
  if (o.cwd !== undefined) a.push('--cwd', checkCwd(o.cwd));
  a.push('--json', '--', ...argv);
  return a;
}

export const psArgs = (deskId: string) => ['ps', '--desk-id', checkDesk(deskId), '--json'];
export const killArgs = (deskId: string, name: string) => ['kill', checkJobName(name), '--desk-id', checkDesk(deskId), '--json'];

export function logsArgs(deskId: string, name: string, o: { tail?: number; follow?: boolean }): string[] {
  const a = ['logs', checkJobName(name), '--desk-id', checkDesk(deskId)];
  if (o.follow) a.push('--follow');
  if (o.tail !== undefined) {
    if (!Number.isInteger(o.tail) || o.tail < 0) throw new UsageError('tail is a number of bytes', { kind: 'usage' });
    a.push('--tail', String(o.tail));
  }
  return a;
}

export const statsArgs = (deskId: string) => ['stats', '--desk-id', checkDesk(deskId), '--json'];

export function measureArgs(deskId: string, count?: number): string[] {
  const a = ['measure', '--desk-id', checkDesk(deskId)];
  if (count !== undefined) {
    if (!Number.isInteger(count) || count < 1 || count > 1000) throw new UsageError('count is 1-1000', { kind: 'usage' });
    a.push('--count', String(count));
  }
  a.push('--json');
  return a;
}

export interface TokenCreateOptions {
  /** One token per desk, under one name. */
  desks: string | readonly string[];
  name?: string;
  /** `30m`, `24h`, `7d`, `2w` (CLI default 7d). */
  expires?: string;
  /** Default (CLI): exec, cp, jobs. Any of screen, exec, shell, cp, forward, jobs. */
  scopes?: readonly string[];
  /** Confine the token's work to this directory on the desk. */
  cwd?: string;
  /** Run its work as the desk's low-privilege agent user, or refuse. */
  lowPriv?: boolean;
  /** Write the token(s) to this file (0600) instead of returning the secret. */
  out?: string;
}

export function tokenCreateArgs(o: TokenCreateOptions): string[] {
  const desks = (typeof o.desks === 'string' ? [o.desks] : [...o.desks]).map(checkDesk);
  if (desks.length === 0) throw new UsageError('at least one desk is required', { kind: 'usage' });
  const a = ['token', 'create', '--desk', desks.join(',')];
  if (o.name !== undefined) a.push('--name', o.name);
  if (o.expires !== undefined) a.push('--expires', o.expires);
  if (o.scopes !== undefined) {
    if (o.scopes.length === 0) throw new UsageError('scopes must not be empty', { kind: 'usage' });
    a.push('--scope', o.scopes.join(','));
  }
  if (o.cwd !== undefined) a.push('--cwd', o.cwd);
  if (o.lowPriv) a.push('--low-priv');
  if (o.out !== undefined) a.push('--out', o.out);
  a.push('--json');
  return a;
}

export const tokenListArgs = (deskId: string) => ['token', 'list', '--desk', checkDesk(deskId), '--json'];

export function tokenRevokeArgs(deskId: string, which: string | { all: true }, account: boolean): string[] {
  const a = ['token', 'revoke', '--desk', checkDesk(deskId)];
  if (typeof which === 'string') {
    if (!which || which.startsWith('-')) throw new UsageError('a token name or id is required', { kind: 'usage' });
    a.push(which);
  } else if (which && which.all === true) {
    a.push('--all-for-desk');
  } else {
    throw new UsageError('give a token name or id, or { all: true }', { kind: 'usage' });
  }
  if (account) a.push('--account');
  a.push('--json');
  return a;
}

export function auditArgs(deskId: string, o: { token?: string; limit?: number; account?: boolean }): string[] {
  const a = ['audit', '--desk', checkDesk(deskId)];
  if (o.token !== undefined) a.push('--token', o.token);
  if (o.limit !== undefined) {
    if (!Number.isInteger(o.limit) || o.limit < 1) throw new UsageError('limit is a positive number of entries', { kind: 'usage' });
    a.push('--limit', String(o.limit));
  }
  if (o.account) a.push('--account');
  a.push('--json');
  return a;
}

export interface ForwardSpec {
  remotePort: number;
  /** Where the desk connects (default: the desk itself). */
  remoteHost?: string;
  /** The localhost port here; 0 or absent picks a free one. */
  localPort?: number;
}

function port(v: number, min: number, what: string): number {
  if (!Number.isInteger(v) || v < min || v > 65535) throw new UsageError(`${what} must be ${min}-65535`, { kind: 'usage' });
  return v;
}

export function forwardArgs(deskId: string, specs: readonly ForwardSpec[]): string[] {
  const d = checkDesk(deskId);
  if (specs.length === 0) throw new UsageError('at least one forward is required', { kind: 'usage' });
  const a = ['forward', '--json'];
  for (const s of specs) {
    const rp = port(s.remotePort, 1, 'remotePort');
    const lp = port(s.localPort ?? 0, 0, 'localPort');
    if (s.remoteHost !== undefined && (!s.remoteHost || /[\s:]/.test(s.remoteHost))) {
      throw new UsageError('remoteHost is a host name or IPv4 address', { kind: 'usage' });
    }
    a.push(s.remoteHost ? `${d}:${s.remoteHost}:${rp}` : `${d}:${rp}`, `localhost:${lp}`);
  }
  return a;
}

export function disconnectArgs(deskId?: string): string[] {
  return deskId === undefined ? ['disconnect', '--all'] : ['disconnect', '--desk-id', checkDesk(deskId)];
}

export function agentConnectArgs(deskId: string, server?: string): string[] {
  const a = ['agent-connect', '--desk-id', checkDesk(deskId)];
  if (server) a.push('--server', server);
  return a;
}

export interface McpServerOptions {
  /** Where screen sessions are recorded (strongly recommended). */
  auditDir?: string;
  /** Domain allowlist for every screen session. */
  allowDomains?: readonly string[];
}

export function mcpArgs(o: McpServerOptions, server?: string): string[] {
  const a = ['mcp'];
  if (server) a.push('--server', server);
  for (const d of o.allowDomains ?? []) a.push('--allow-domain', d);
  if (o.auditDir) a.push('--audit-dir', o.auditDir);
  return a;
}
