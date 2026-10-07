// Running gaiadesk-cli: collect its output, or stream it.

import { spawn } from 'node:child_process';
import type { ChildProcess } from 'node:child_process';

import { CliNotFoundError, GaiaDeskError } from './errors.js';
import type { AbortSignalLike, CliError, ExecExit } from './types.js';

export interface Invocation {
  /** The program and any arguments that come before gaiadesk-cli's own. */
  command: readonly string[];
  args: readonly string[];
  env: Record<string, string | undefined>;
  cwd?: string;
  /** Written to stdin, which is then closed. Omitted: stdin is closed at once. */
  input?: string | Uint8Array;
  signal?: AbortSignalLike;
}

export interface Completed {
  code: number | null;
  signal: string | null;
  stdout: string;
  stderr: string;
}

function concat(chunks: Uint8Array[]): Uint8Array {
  let n = 0;
  for (const c of chunks) n += c.length;
  const out = new Uint8Array(n);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

export function decode(u: Uint8Array): string {
  return new TextDecoder('utf-8').decode(u);
}

function start(inv: Invocation): ChildProcess {
  const [program, ...pre] = inv.command;
  return spawn(program, [...pre, ...inv.args], {
    env: inv.env,
    cwd: inv.cwd,
    stdio: ['pipe', 'pipe', 'pipe'],
    windowsHide: true,
  });
}

function spawnError(e: Error & { code?: string }, inv: Invocation): GaiaDeskError {
  if (e.code === 'ENOENT' || e.code === 'EACCES') {
    return new CliNotFoundError(
      `could not run ${JSON.stringify(inv.command[0])} (${e.code}). Install gaiadesk-cli (npm install @gaiadesk/cli, or GaiaDesk from https://gaiadesk.net/download), ` +
        'or pass the full path of gaiadesk-cli as the `cli` option (or set GAIADESK_CLI).',
      { kind: 'not_found', argv: inv.args },
    );
  }
  return new GaiaDeskError(`could not run gaiadesk-cli: ${e.message}`, { argv: inv.args });
}

/**
 * Abort: SIGINT, which gaiadesk-cli answers by stopping the remote command
 * (exec, logs -f, forward) and leaving the session cleanly.
 */
function wireAbort(child: ChildProcess, signal?: AbortSignalLike): () => void {
  if (!signal) return () => {};
  const onAbort = () => {
    try {
      child.kill('SIGINT');
    } catch {
      /* gone */
    }
  };
  if (signal.aborted) onAbort();
  else signal.addEventListener('abort', onAbort, { once: true });
  return () => signal.removeEventListener('abort', onAbort);
}

/** Run to completion and collect stdout and stderr. */
export function runCli(inv: Invocation): Promise<Completed> {
  return new Promise((resolve, reject) => {
    let child: ChildProcess;
    try {
      child = start(inv);
    } catch (e) {
      reject(spawnError(e as Error & { code?: string }, inv));
      return;
    }
    const out: Uint8Array[] = [];
    const err: Uint8Array[] = [];
    child.stdout?.on('data', (c) => out.push(c));
    child.stderr?.on('data', (c) => err.push(c));
    const unwire = wireAbort(child, inv.signal);
    let failed = false;
    child.on('error', (e) => {
      failed = true;
      unwire();
      reject(spawnError(e, inv));
    });
    child.stdin?.on('error', () => {
      /* it exited before reading stdin; the exit says why */
    });
    child.on('close', (code, sig) => {
      unwire();
      if (failed) return;
      resolve({ code, signal: sig, stdout: decode(concat(out)), stderr: decode(concat(err)) });
    });
    if (inv.input !== undefined) child.stdin?.end(inv.input);
    else child.stdin?.end();
  });
}

export interface Chunk {
  stream: 'stdout' | 'stderr';
  data: Uint8Array;
}

export interface Exit {
  /** gaiadesk-cli's exit code (see the README's exit-code table); null if killed by a signal. */
  exitCode: number | null;
  signal: string | null;
  /** The last line gaiadesk-cli wrote on stderr (its reason, when it failed). */
  stderrTail: string;
  /**
   * How the command ended, without its output (execStream / shellStream when
   * the backend reports it: gaiadesk-cli 0.10.324+ via `--json-stream`, and the
   * native library). Absent from a plain stream and when the command never ran.
   */
  result?: ExecExit;
  /** Why it never ran or was stopped (`{kind, message, reason?, desk?}`), when the backend said. */
  error?: CliError;
}

/**
 * A running command or log follow, whichever backend runs it (CliStream for
 * gaiadesk-cli, NativeStream for the native library): chunks as they come,
 * `wait()` for the exit.
 */
export interface OutputStream extends AsyncIterable<Chunk> {
  /** The gaiadesk-cli arguments (the operation's name on the native backend). */
  readonly argv: readonly string[];
  write(data: string | Uint8Array): void;
  end(): void;
  kill(signal?: string): void;
  wait(): Promise<Exit>;
  text(): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }>;
}

/**
 * A running gaiadesk-cli whose output arrives as it is produced:
 * `for await (const c of stream)` yields stdout/stderr chunks, `wait()`
 * resolves when it exits. Iterate or not; `wait()` works either way.
 */
export class CliStream implements OutputStream {
  readonly argv: readonly string[];
  private readonly child: ChildProcess;
  private readonly queue: Chunk[] = [];
  private waiters: Array<() => void> = [];
  private done = false;
  private tail = '';
  private readonly exited: Promise<Exit>;

  constructor(inv: Invocation, keepStdinOpen = false) {
    this.argv = inv.args;
    try {
      this.child = start(inv);
    } catch (e) {
      throw spawnError(e as Error & { code?: string }, inv);
    }
    const push = (stream: 'stdout' | 'stderr') => (data: Uint8Array) => {
      if (stream === 'stderr') this.tail = (this.tail + decode(data)).slice(-4096);
      this.queue.push({ stream, data });
      this.wake();
    };
    this.child.stdout?.on('data', push('stdout'));
    this.child.stderr?.on('data', push('stderr'));
    this.child.stdin?.on('error', () => {});
    const unwire = wireAbort(this.child, inv.signal);
    this.exited = new Promise((resolve, reject) => {
      let failed = false;
      this.child.on('error', (e) => {
        failed = true;
        unwire();
        this.finish();
        reject(spawnError(e, inv));
      });
      this.child.on('close', (code, signal) => {
        unwire();
        this.finish();
        if (!failed) resolve({ exitCode: code, signal, stderrTail: lastLine(this.tail) });
      });
    });
    // Unobserved rejections must not crash the host process; wait() rethrows.
    this.exited.catch(() => {});
    if (inv.input !== undefined) {
      if (keepStdinOpen) this.child.stdin?.write(inv.input);
      else this.child.stdin?.end(inv.input);
    } else if (!keepStdinOpen) {
      this.child.stdin?.end();
    }
  }

  private wake() {
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private finish() {
    this.done = true;
    this.wake();
  }

  /** Write to gaiadesk-cli's stdin (streams started with stdin open). */
  write(data: string | Uint8Array): void {
    this.child.stdin?.write(data);
  }

  /** Close gaiadesk-cli's stdin. */
  end(): void {
    this.child.stdin?.end();
  }

  /** Stop it: SIGINT by default, which gaiadesk-cli turns into a clean stop of the remote side. */
  kill(signal = 'SIGINT'): void {
    try {
      this.child.kill(signal as NodeJS.Signals);
    } catch {
      /* gone */
    }
  }

  /** Resolves when gaiadesk-cli exits. */
  wait(): Promise<Exit> {
    return this.exited;
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Chunk> {
    for (;;) {
      if (this.queue.length) {
        yield this.queue.shift() as Chunk;
        continue;
      }
      if (this.done) return;
      await new Promise<void>((r) => this.waiters.push(r));
    }
  }

  /** Text chunks instead of bytes (UTF-8, decoded per stream). */
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
  return (lines[lines.length - 1] ?? '').replace(/^gaiadesk-cli:\s*/, '');
}
