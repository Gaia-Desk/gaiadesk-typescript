// Arguments for the native backend's operations (snake_case, as the native
// library takes them), built from the same options as the CLI's argv. Every
// builder first runs the CLI builder for the same call, so bad input is the
// same UsageError on both backends. Pure, like args.ts.

import * as A from './args.js';
import { UsageError } from './errors.js';

type Args = Record<string, unknown>;

function shape(o: A.RunShapeOptions): Args {
  const s: Args = {};
  if (o.shell !== undefined) s.shell = A.wireShell(o.shell);
  if (o.timeout !== undefined) s.timeout = A.duration(o.timeout, '--timeout');
  if (o.connectTimeout !== undefined) s.connect_timeout = A.duration(o.connectTimeout, '--connect-timeout');
  if (o.persist !== undefined) s.persist = A.duration(o.persist, '--persist');
  if (o.verbose) s.verbose = true;
  return s;
}

const command = (c: string | readonly string[]) => (typeof c === 'string' ? c : [...c]);

export function exec(deskId: string, cmd: string | readonly string[], o: A.RunShapeOptions & { cwd?: string; env?: Readonly<Record<string, string>> }): Args {
  A.execArgs(deskId, cmd, o, true);
  const a: Args = { desk_id: A.checkDesk(deskId), command: command(cmd), ...shape(o) };
  if (o.cwd !== undefined) a.cwd = o.cwd;
  if (o.env !== undefined) a.env = A.checkEnv(o.env);
  return a;
}

export function shell(deskId: string, script: string, o: A.RunShapeOptions & { cwd?: string }): Args {
  A.shellArgs(deskId, o, true);
  const a: Args = { desk_id: A.checkDesk(deskId), script, ...shape(o) };
  if (o.cwd !== undefined) a.cwd = o.cwd;
  return a;
}

/** The streaming shell: no script field (it is written to stdin). */
export function shellStream(deskId: string, o: A.RunShapeOptions & { cwd?: string }): Args {
  A.shellArgs(deskId, o, false);
  const a: Args = { desk_id: A.checkDesk(deskId), ...shape(o) };
  if (o.cwd !== undefined) a.cwd = o.cwd;
  return a;
}

export function devices(o: { probe?: boolean; deskId?: string }): Args {
  A.devicesArgs(o);
  const a: Args = { probe: !!o.probe };
  if (o.deskId !== undefined) a.desk_id = A.checkDesk(o.deskId);
  return a;
}

export function cp(dir: 'upload' | 'download', deskId: string, local: string, remote: string, recursive: boolean): Args {
  A.cpArgs(dir, deskId, local, remote, recursive);
  return { desk_id: A.checkDesk(deskId), local, remote, recursive };
}

/** `mem`: megabytes, or `"512M"` / `"4G"`, as `run --mem` takes it. */
export function memMb(mem: number | string): number {
  if (typeof mem === 'number') return mem;
  const m = /^\s*(\d+)\s*([MG])?B?\s*$/i.exec(mem);
  if (!m) throw new UsageError(`mem: not a size: ${JSON.stringify(mem)}`, { kind: 'usage' });
  return Number(m[1]) * (m[2]?.toUpperCase() === 'G' ? 1024 : 1);
}

export function runJob(deskId: string, name: string, cmd: string | readonly string[], o: A.JobOptions): Args {
  A.runArgs(deskId, name, cmd, o);
  const limits: Args = {};
  if (o.priority !== undefined) limits.priority = o.priority;
  if (o.cpu !== undefined) limits.cpu_percent = o.cpu;
  if (o.mem !== undefined) limits.mem_mb = memMb(o.mem);
  if (o.keepAwake !== undefined) limits.keep_awake = o.keepAwake;
  const a: Args = { desk_id: A.checkDesk(deskId), name, command: command(cmd), limits };
  if (o.cwd !== undefined) a.cwd = o.cwd;
  if (o.shell !== undefined) a.shell = A.wireShell(o.shell);
  if (o.env !== undefined) a.env = A.checkEnv(o.env);
  return a;
}

/** `job_wait`: `timeout` as a duration string (`"30"` is seconds). */
export function waitJob(deskId: string, name: string, timeout?: number | string): Args {
  A.waitArgs(deskId, name, { timeout });
  const a: Args = { desk_id: A.checkDesk(deskId), name };
  if (timeout !== undefined) a.timeout = A.duration(timeout, '--timeout');
  return a;
}

export function job(deskId: string, name: string): Args {
  A.killArgs(deskId, name);
  return { desk_id: A.checkDesk(deskId), name };
}

export function logs(deskId: string, name: string, tail?: number): Args {
  A.logsArgs(deskId, name, { tail });
  const a: Args = { desk_id: A.checkDesk(deskId), name };
  if (tail !== undefined) a.tail = tail;
  return a;
}

export function desk(deskId: string): Args {
  return { desk_id: A.checkDesk(deskId) };
}

export function measure(deskId: string, count?: number): Args {
  A.measureArgs(deskId, count);
  return count === undefined ? desk(deskId) : { ...desk(deskId), count };
}

export function tokenCreate(o: A.TokenCreateOptions): Args {
  A.tokenCreateArgs(o);
  const a: Args = { desks: (typeof o.desks === 'string' ? [o.desks] : [...o.desks]).map(A.checkDesk) };
  if (o.name !== undefined) a.name = o.name;
  if (o.expires !== undefined) a.expires = o.expires;
  if (o.scopes !== undefined) a.scopes = [...o.scopes];
  if (o.cwd !== undefined) a.cwd = o.cwd;
  if (o.lowPriv) a.low_priv = true;
  if (o.out !== undefined) a.out = o.out;
  return a;
}

export function tokenRevoke(deskId: string, which: string | { all: true }, account: boolean): Args {
  A.tokenRevokeArgs(deskId, which, account);
  return typeof which === 'string' ? { ...desk(deskId), which, account } : { ...desk(deskId), all: true, account };
}

export function audit(deskId: string, o: { token?: string; limit?: number; account?: boolean }): Args {
  A.auditArgs(deskId, o);
  const a: Args = { ...desk(deskId), account: !!o.account };
  if (o.token !== undefined) a.token = o.token;
  if (o.limit !== undefined) a.limit = o.limit;
  return a;
}

export function forward(deskId: string, specs: readonly A.ForwardSpec[]): Array<Record<string, unknown>> {
  A.forwardArgs(deskId, specs);
  return specs.map((s) => {
    const f: Args = { remote_port: s.remotePort };
    if (s.remoteHost !== undefined) f.remote_host = s.remoteHost;
    if (s.localPort !== undefined) f.local_port = s.localPort;
    return f;
  });
}

export function disconnect(deskId?: string): Args {
  A.disconnectArgs(deskId);
  return deskId === undefined ? {} : desk(deskId);
}
