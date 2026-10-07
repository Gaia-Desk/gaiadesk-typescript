// A stand-in for @gaiadesk/sdk-native (the native backend), for the tests:
// the same fake desks as fake-cli.ts, answering with the same JSON shapes,
// failing with the native library's errors ({kind, reason, json}, `json`
// being the error envelope {"error": {kind, message, reason?, desk?}}).
// Every call is recorded in `calls`.
//
// Results are the CLI's shapes: {"jobs"}, {"tokens"}, {"events"},
// {"job", "output"}, {"mesh_ip"}, {"closed"}.
//
// Desk ids: 123456789 fine; offline-desk offline; refused-desk refuses;
// usage-desk usage error; lost-desk connection lost.
import type {
  NativeCallOptions,
  NativeClientLike,
  NativeClientOptions,
  NativeEvent,
  NativeForwardHandle,
  NativeModule,
  NativeOutputStream,
} from '../../dist/index.js';

export const OK = '123456789';
export const OFFLINE = 'offline-desk';
export const REFUSED = 'refused-desk';
export const USAGE = 'usage-desk';
export const LOST = 'lost-desk';

type Json = Record<string, any>;

export interface Call {
  op: string;
  args: Json;
  input?: string;
  signal?: boolean;
}

function nativeError(kind: string, message: string, reason?: string, json?: unknown, desk?: string): Error {
  const envelope = { error: { kind, message, ...(reason ? { reason } : {}), ...(desk ? { desk } : {}) } };
  return Object.assign(new Error(message), { name: 'NativeError', kind, reason: reason ?? null, json: json ?? envelope });
}

function reach(desk: string): void {
  if (desk === OFFLINE) throw nativeError('unreachable', `desk ${desk} is offline (last seen 4 min ago)`, 'offline', undefined, desk);
  if (desk === REFUSED) throw nativeError('refused', 'this agent token does not have the `exec` scope', undefined, undefined, desk);
  if (desk === USAGE) throw nativeError('usage', 'no credential: set GAIADESK_TOKEN_FILE or GAIADESK_CODE');
  if (desk === LOST) throw nativeError('connection_lost', `the connection to desk ${desk} was lost`, undefined, undefined, desk);
}

const text = (d: string | Uint8Array | undefined) => (d === undefined ? undefined : typeof d === 'string' ? d : Buffer.from(d).toString('utf8'));

function execResult(desk: string, line: string, stdin?: string, cwd?: string): Json {
  const exit = /^exit (\d+)$/.test(line) ? Number(line.slice(5)) : line === 'sleep' ? 124 : 0;
  return {
    exit,
    remote_code: exit,
    stdout: `ran: ${line}\n${cwd ? `in: ${cwd}\n` : ''}${stdin ? `stdin: ${stdin}\n` : ''}`,
    stderr: 'warn\n',
    duration_ms: 12,
    desk,
    route: 'LAN',
    mode: 'pipes',
    shell: '/bin/zsh -l -c',
    timed_out: line === 'sleep',
    error: null,
    notes: [],
    truncated: false,
  };
}

class MockStream implements NativeOutputStream {
  private events: NativeEvent[] = [];
  private waiters: Array<() => void> = [];
  private closed = false;
  stopped = false;
  written = '';

  push(ev: NativeEvent) {
    this.events.push(ev);
    this.wake();
  }
  finish() {
    this.closed = true;
    this.wake();
  }
  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }
  write(d: string | Uint8Array) {
    this.written += text(d);
  }
  end() {
    this.push({ type: 'stdout', data: Buffer.from(`stdin: ${this.written}`) });
    this.push({ type: 'exit', result: { exit: 0 } });
    this.finish();
  }
  stop() {
    this.stopped = true;
    this.push({ type: 'exit', result: { exit: 130, error: { kind: 'failed', message: 'interrupted' } } });
    this.finish();
  }
  async wait() {
    return { exit: 0 };
  }
  async *[Symbol.asyncIterator](): AsyncIterator<NativeEvent> {
    for (;;) {
      const e = this.events.shift();
      if (e) {
        yield e;
        continue;
      }
      if (this.closed) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }
}

export function makeMock() {
  const calls: Call[] = [];
  const clients: NativeClientOptions[] = [];
  const streams: MockStream[] = [];

  class Client implements NativeClientLike {
    readonly backend = 'mock';
    constructor(opts: NativeClientOptions = {}) {
      if (opts.persist === 'forever') throw nativeError('usage', 'options: persist: not a duration');
      clients.push(opts);
    }

    async call(op: string, args: Json = {}, o: NativeCallOptions = {}): Promise<unknown> {
      calls.push({ op, args, input: text(o.input), signal: !!o.signal });
      if (o.signal?.aborted) throw nativeError('interrupted', 'interrupted');
      const d = args.desk_id as string;
      switch (op) {
        case 'version':
          return { version: '0.10.323', backend: 'client' };
        case 'devices':
          return { devices: [{ desk_id: OK, name: 'office-pc', online: true, reachable: args.probe ? true : null }], sources: ['account'], notes: [] };
        case 'exec':
          reach(d);
          return execResult(d, typeof args.command === 'string' ? args.command : args.command.join(' '), text(o.input), args.cwd);
        case 'shell':
          reach(d);
          return execResult(d, `script:${args.script.trim()}`, undefined, args.cwd);
        case 'upload':
        case 'download': {
          reach(d);
          const failed = String(args.local).includes('fail') || String(args.remote).includes('fail') ? [{ path: 'a.txt', message: 'permission denied' }] : [];
          const sum = { direction: op, desk: d, destination: op === 'upload' ? args.remote : args.local, files: 2, dirs: args.recursive ? 1 : 0, bytes: 2048, resumed_bytes: 0, failed, seconds: 0.5 };
          if (failed.length) throw nativeError('failed', '1 file failed to copy', undefined, sum, d);
          return sum;
        }
        case 'job_run':
          reach(d);
          return { name: args.name, command: args.command, state: 'running', pid: 4242, started_at_ms: 1700000000000, log_bytes: 0, by: 'owner' };
        case 'job_wait': {
          reach(d);
          if (args.name === 'nope') throw nativeError('failed', 'no job named nope', undefined, undefined, d);
          const running = args.name === 'slow' && args.timeout !== undefined;
          const job = { name: args.name, command: 'make', state: running ? 'running' : 'exited', started_at_ms: 1, log_bytes: 0, by: 'owner', ...(running ? {} : { exit_code: 0 }) };
          return { job, timed_out: running };
        }
        case 'whoami':
          return { source: 'app', account: 'you@example.com' };
        case 'job_list': {
          reach(d);
          const jobs = [{ name: 'build', command: 'make', state: 'running', started_at_ms: 1, log_bytes: 0, by: 'owner' }];
          return { jobs };
        }
        case 'job_kill':
          reach(d);
          if (args.name === 'nope') throw nativeError('failed', 'no job named nope', undefined, undefined, d);
          return { name: args.name, command: 'make', state: 'killed', started_at_ms: 1, log_bytes: 0, by: 'owner' };
        case 'job_logs':
          reach(d);
          return { job: { name: args.name, command: 'make', state: 'running', started_at_ms: 1 }, output: 'line 1\nline 2\n' };
        case 'stats':
          reach(d);
          return { desk: d, hostname: 'office-pc', os: 'windows', os_version: '11', cpu_percent: 3, cpus: 8, load: null, mem_total_mb: 1, mem_free_mb: 1, disks: [], uptime_secs: 1, jobs_running: 0 };
        case 'measure':
          reach(d);
          return { desk: d, sent: args.count ?? 10, rtt_ms: null, clock_offset_ms: null, clock_uncertainty_ms: null };
        case 'token_mint':
          return { tokens: args.desks.map((k: string) => ({ desk: k, token: { label: args.name ?? 'agent', id: 't1', scopes: args.scopes ?? [], issued_at_ms: 1, expires_at_ms: 2, revoked: false }, secret: 'gdagt_x' })) };
        case 'token_list': {
          const tokens = [{ label: 'bot', id: 't1', scopes: ['exec'], issued_at_ms: 1, expires_at_ms: 2, revoked: false }];
          return { tokens };
        }
        case 'token_revoke':
          return args.account ? { desk: d, ok: true, message: 'revoked' } : { revoked: args.which ?? 'all', stopped_sessions: 0 };
        case 'audit': {
          const events = [{ at_ms: 5, desk: d, token: 'bot', token_id: 't1', action: 'exec.end', detail: 'make test', bytes: 0, exit_code: 0 }];
          return { events };
        }
        case 'mesh_status':
          return { self: null, peers: [] };
        case 'mesh_ip':
          return { desk_id: d, mesh_ip: '100.64.0.1', renamed_to: null };
        case 'disconnect':
          return { closed: d ? [d] : [] };
        default:
          throw nativeError('usage', `unknown op ${op}`);
      }
    }

    async stream(op: string, args: Json, o: { signal?: unknown; stdin?: string | Uint8Array | true } = {}): Promise<NativeOutputStream> {
      calls.push({ op: `stream:${op}`, args, input: o.stdin === true ? '<open>' : text(o.stdin) });
      reach(args.desk_id);
      const s = new MockStream();
      streams.push(s);
      if (op === 'job_follow') {
        if (args.name === 'forever') {
          s.push({ type: 'stdout', data: Buffer.from('line 1\n') });
          return s; // until stop()
        }
        s.push({ type: 'stdout', data: Buffer.from('line 1\nline 2\n') });
        s.push({ type: 'exit', result: { exit: 0 } });
        s.finish();
        return s;
      }
      if (o.stdin === true) return s; // shell/exec with stdin open: output on end()
      const line = op === 'shell' ? 'shell' : typeof args.command === 'string' ? args.command : args.command.join(' ');
      setTimeout(() => {
        s.push({ type: 'stdout', data: Buffer.from(`part1 part2 ${line}\n${args.cwd ? `in: ${args.cwd}\n` : ''}`) });
        s.push({ type: 'stderr', data: Buffer.from('warn\n') });
        const { stdout: _o, stderr: _e, truncated: _t, ...exit } = execResult(args.desk_id, line);
        if (line === 'sleep') Object.assign(exit, { timed_out: true, remote_code: null, error: { kind: 'failed', message: 'the command ran past --timeout and was stopped' } });
        s.push({ type: 'exit', result: exit });
        s.finish();
      }, 5);
      return s;
    }

    desk(id: string) {
      return {
        forward: async (specs: Json[]): Promise<NativeForwardHandle> => {
          calls.push({ op: 'forward', args: { desk_id: id, specs } });
          reach(id);
          let resolveDone!: (v: Json) => void;
          const done = new Promise<Json>((r) => (resolveDone = r));
          return {
            listening: specs.map((s) => ({ event: 'listening', local_port: s.local_port || 54321, desk: id, remote_host: s.remote_host ?? 'localhost', remote_port: s.remote_port })),
            done,
            close: async () => {
              resolveDone({ exit: 0, error: null });
              return done;
            },
          };
        },
        screen: async () => {
          calls.push({ op: 'screen', args: { desk_id: id } });
          reach(id);
          return { screenshot: async () => ({ png: Buffer.from('png'), width: 1280, height: 800 }), close: async () => {} };
        },
      };
    }
  }

  const module: NativeModule = { Client, buildInfo: () => ({ version: '0.10.323', backend: 'client' }) };
  return { module, calls, clients, streams };
}
