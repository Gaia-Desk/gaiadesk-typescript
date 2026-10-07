// The native backend: GaiaDesk's client library as a prebuilt binary
// (`@gaiadesk/sdk-native`, an optional dependency), used instead of spawning
// gaiadesk-cli when it is installed. Same public API, same result shapes (the
// binary returns the CLI's --json objects) and the same error classes and
// kinds. This file is the only place that knows the native package's surface.

import { createRequire } from 'node:module';

import {
  CommandError,
  ConnectionLostError,
  GaiaDeskError,
  OperationFailedError,
  ProtocolError,
  RefusedError,
  UnreachableError,
  UsageError,
} from './errors.js';
import type { ErrorDetails, ErrorKind } from './errors.js';
import type { Chunk, Exit, OutputStream } from './proc.js';
import type { AbortSignalLike, ExecResult } from './types.js';

// ───────────────────────────── the native package, structurally ─────────────────────────────

/** Credentials and settings, as @gaiadesk/sdk-native's `Client` takes them. */
export interface NativeClientOptions {
  tokenFile?: string;
  code?: string;
  accountToken?: string;
  agentToken?: string;
  server?: string;
  persist?: number | string;
  cwd?: string;
}

export interface NativeCallOptions {
  signal?: AbortSignalLike;
  input?: string | Uint8Array;
}

export type NativeEvent = { type: 'stdout' | 'stderr'; data: Uint8Array } | { type: 'exit'; result: Record<string, unknown> };

export interface NativeOutputStream extends AsyncIterable<NativeEvent> {
  write(data: string | Uint8Array): void;
  end(): void;
  stop(): void;
  wait(): Promise<Record<string, unknown>>;
}

export interface NativeForwardHandle {
  readonly listening: Array<Record<string, unknown>>;
  readonly done: Promise<Record<string, unknown>>;
  close(): Promise<Record<string, unknown>>;
}

export interface NativeScreenHandle {
  screenshot(o?: { signal?: AbortSignalLike }): Promise<{ png: Uint8Array; width: number; height: number }>;
  close(): Promise<void>;
}

export interface NativeClientLike {
  readonly backend: string;
  call(op: string, args?: Record<string, unknown>, o?: NativeCallOptions): Promise<unknown>;
  stream(op: string, args: Record<string, unknown>, o?: { signal?: AbortSignalLike; stdin?: string | Uint8Array | true }): Promise<NativeOutputStream>;
  desk(id: string): {
    forward(specs: Array<Record<string, unknown>>, o?: { signal?: AbortSignalLike }): Promise<NativeForwardHandle>;
    screen(o?: { signal?: AbortSignalLike }): Promise<NativeScreenHandle>;
  };
}

/** What `require('@gaiadesk/sdk-native')` gives (or a test's stand-in). */
export interface NativeModule {
  Client: new (opts?: NativeClientOptions) => NativeClientLike;
  /** Forces the platform binary to load; throws when there is none for this machine. */
  buildInfo?: () => { version: string; backend: string };
}

/**
 * @gaiadesk/sdk-native when it is installed and has a binary for this
 * machine; else null with the reason. `req` is for tests.
 */
export function loadNative(req: (id: string) => unknown = createRequire(import.meta.url)): { module: NativeModule | null; why?: string } {
  try {
    const m = req('@gaiadesk/sdk-native') as NativeModule;
    m.buildInfo?.();
    return { module: m };
  } catch (e) {
    return { module: null, why: (e as Error).message };
  }
}

// ───────────────────────────── errors ─────────────────────────────

const SDK_KINDS: ReadonlySet<string> = new Set([
  'usage', 'offline', 'unknown_desk', 'not_online', 'refused', 'network', 'not_signed_in', 'timeout',
  'connection_lost', 'local', 'failed', 'interrupted', 'protocol', 'unreachable',
]);

/** gaiadesk-cli's exit code for the same failure (exitCode on the error). */
export function exitFor(kind: string): number {
  if (kind === 'refused') return 254;
  if (kind === 'connection_lost') return 253;
  if (kind === 'failed') return 1;
  if (kind === 'interrupted') return 130;
  return 255;
}

/**
 * The SDK error for a native one: the class from its `kind` (the same class
 * the CLI backend throws), the SDK kind from its finer `reason` when it has
 * one (`offline`, `unknown_desk`, ...), so both backends report the same kinds.
 */
export function fromNative(e: unknown, op: string): GaiaDeskError {
  if (e instanceof GaiaDeskError) return e;
  const n = (e ?? {}) as { kind?: unknown; reason?: unknown; json?: unknown; message?: unknown };
  const message = typeof n.message === 'string' ? n.message : String(e);
  const kind = typeof n.kind === 'string' ? n.kind : 'protocol';
  const reason = typeof n.reason === 'string' && SDK_KINDS.has(n.reason) ? n.reason : undefined;
  const sdkKind = (reason ?? (SDK_KINDS.has(kind) ? kind : 'protocol')) as ErrorKind;
  const d: ErrorDetails = { kind: sdkKind, exitCode: exitFor(kind), argv: [op], json: n.json ?? undefined };
  switch (kind) {
    case 'usage':
      return new UsageError(message, d);
    case 'refused':
      return new RefusedError(message, d);
    case 'unreachable':
      return new UnreachableError(message, d);
    case 'connection_lost':
      return new ConnectionLostError(message, d);
    case 'failed':
      return new OperationFailedError(message, d);
    case 'protocol':
      return new ProtocolError(message, d);
    default:
      return new GaiaDeskError(message, d);
  }
}

// ───────────────────────────── streams ─────────────────────────────

/**
 * A native stream with CliStream's shape: chunks, `wait()` → Exit (exitCode =
 * what gaiadesk-cli would exit with), `write` / `end` / `kill`. The native
 * stream starts asynchronously; writes before it is ready are queued.
 */
export class NativeStream implements OutputStream {
  readonly argv: readonly string[];
  private native?: NativeOutputStream;
  private pending: Array<(s: NativeOutputStream) => void> = [];
  private readonly queue: Chunk[] = [];
  private waiters: Array<() => void> = [];
  private done = false;
  private tail = '';
  private readonly exited: Promise<Exit>;

  constructor(op: string, start: Promise<NativeOutputStream>) {
    this.argv = [op];
    this.exited = this.run(start);
  }

  private async run(start: Promise<NativeOutputStream>): Promise<Exit> {
    const dec = new TextDecoder('utf-8');
    try {
      const s = await start;
      this.native = s;
      for (const f of this.pending.splice(0)) f(s);
      let exit: Exit = { exitCode: 0, signal: null, stderrTail: '' };
      for await (const ev of s) {
        if (ev.type === 'exit') {
          const code = typeof ev.result.exit === 'number' ? ev.result.exit : 0;
          const err = typeof ev.result.error === 'string' ? ev.result.error : '';
          exit = { exitCode: code, signal: null, stderrTail: lastLine(this.tail) || err };
          continue;
        }
        if (ev.type === 'stderr') this.tail = (this.tail + dec.decode(ev.data)).slice(-4096);
        this.queue.push({ stream: ev.type, data: ev.data });
        this.wake();
      }
      return exit;
    } catch (e) {
      // As gaiadesk-cli would: the failure is the exit code and the last stderr line.
      const err = fromNative(e, this.argv[0]);
      return { exitCode: err.exitCode, signal: null, stderrTail: err.message };
    } finally {
      this.done = true;
      this.wake();
    }
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private withNative(f: (s: NativeOutputStream) => void): void {
    if (this.native) f(this.native);
    else this.pending.push(f);
  }

  write(data: string | Uint8Array): void {
    this.withNative((s) => s.write(data));
  }

  end(): void {
    this.withNative((s) => s.end());
  }

  /** Stop the remote side (any signal: the native library has one way to stop). */
  kill(_signal?: string): void {
    this.withNative((s) => s.stop());
  }

  wait(): Promise<Exit> {
    return this.exited;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Chunk> {
    for (;;) {
      const c = this.queue.shift();
      if (c) {
        yield c;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  async *text(): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }> {
    const dec = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };
    for await (const c of this) {
      const t = dec[c.stream].decode(c.data, { stream: true });
      if (t) yield { stream: c.stream, text: t };
    }
  }
}

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return lines[lines.length - 1] ?? '';
}

// ───────────────────────────── the backend ─────────────────────────────

/** The credentials the CLI would have read from its environment, for the native client. */
export function nativeOptions(env: Record<string, string | undefined>, cwd?: string): NativeClientOptions {
  const o: NativeClientOptions = {};
  if (env.GAIADESK_TOKEN_FILE) o.tokenFile = env.GAIADESK_TOKEN_FILE;
  if (env.GAIADESK_CODE) o.code = env.GAIADESK_CODE;
  if (env.GAIADESK_TOKEN) o.accountToken = env.GAIADESK_TOKEN;
  if (env.GAIADESK_AGENT_TOKEN) o.agentToken = env.GAIADESK_AGENT_TOKEN;
  if (env.GAIADESK_SERVER) o.server = env.GAIADESK_SERVER;
  if (env.GAIADESK_PERSIST) o.persist = env.GAIADESK_PERSIST;
  if (cwd !== undefined) o.cwd = cwd;
  return o;
}

/** Each GaiaDesk operation on the native client: results as the CLI prints them. */
export class NativeBackend {
  constructor(readonly client: NativeClientLike) {}

  async call<T>(op: string, args: Record<string, unknown> = {}, o: NativeCallOptions = {}): Promise<T> {
    try {
      return (await this.client.call(op, args, o)) as T;
    } catch (e) {
      throw fromNative(e, op);
    }
  }

  stream(op: string, args: Record<string, unknown>, o: { signal?: AbortSignalLike; stdin?: string | Uint8Array | true } = {}): NativeStream {
    return new NativeStream(op, this.client.stream(op, args, o));
  }

  /** exec/shell: the result, or CommandError with `check` (as the CLI backend does). */
  async exec(op: 'exec' | 'shell', args: Record<string, unknown>, o: NativeCallOptions & { check?: boolean }): Promise<ExecResult> {
    const r = await this.call<ExecResult>(op, args, o);
    if (o.check && r.exit !== 0) {
      const why = r.timed_out ? 'timed out' : `exited ${r.exit}`;
      throw new CommandError(`command on desk ${r.desk} ${why}`, r, { exitCode: r.exit, argv: [op], json: r, kind: 'failed' });
    }
    return r;
  }

  /** cp: a summary with failed files is an OperationFailedError either way. */
  async cp<T extends { failed?: unknown[] }>(op: 'upload' | 'download', args: Record<string, unknown>, o: NativeCallOptions): Promise<T> {
    const r = await this.call<T>(op, args, o);
    if (Array.isArray(r.failed) && r.failed.length > 0) {
      throw new OperationFailedError(`${r.failed.length} file(s) failed to copy`, { exitCode: 1, argv: [op], json: r, kind: 'failed' });
    }
    return r;
  }

  async forward(deskId: string, specs: Array<Record<string, unknown>>, signal?: AbortSignalLike) {
    let f: NativeForwardHandle;
    try {
      f = await this.client.desk(deskId).forward(specs, { signal });
    } catch (e) {
      throw fromNative(e, 'forward');
    }
    const toExit = (r: Record<string, unknown>): Exit => ({
      exitCode: typeof r.exit === 'number' ? r.exit : 0,
      signal: null,
      stderrTail: typeof r.error === 'string' ? r.error : '',
    });
    const done = f.done.then(toExit);
    return { listening: f.listening, done, close: async () => toExit(await f.close()) };
  }

  async agentConnect(deskId: string, signal?: AbortSignalLike): Promise<string> {
    try {
      const s = await this.client.desk(deskId).screen({ signal });
      try {
        const shot = await s.screenshot({ signal });
        return `agent session open on desk ${deskId}: screenshot ${shot.width}x${shot.height}`;
      } finally {
        await s.close();
      }
    } catch (e) {
      throw fromNative(e, 'agent-connect');
    }
  }
}
