// Streams for execStream on gaiadesk-cli:
//
// - JsonExecStream: `exec --json-stream` (gaiadesk-cli 0.10.324+, feature
//   `exec_json_stream`): one JSON event per line, turned back into the same
//   stdout/stderr chunks a plain stream gives, with the run's end (`exit` or
//   `error` event) on wait().
// - DeferredStream: an OutputStream whose real stream starts once something
//   asynchronous is known (which CLI features there are). Writes and kills
//   before then are queued.

import type { Chunk, Exit, Invocation, OutputStream } from './proc.js';
import { CliStream } from './proc.js';
import { execError } from './results.js';
import type { ExecEvent } from './types.js';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** Text chunks from byte chunks, decoded per stream. */
async function* textOf(chunks: AsyncIterable<Chunk>): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }> {
  const dec = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };
  for await (const c of chunks) {
    const t = dec[c.stream].decode(c.data, { stream: true });
    if (t) yield { stream: c.stream, text: t };
  }
}

/** One `--json-stream` line as an event, or null when it is not one. */
export function parseExecEvent(line: string): ExecEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return null;
  }
  if (!isObj(v) || typeof v.event !== 'string') return null;
  return v as unknown as ExecEvent;
}

/**
 * The Exit for a finished `--json-stream` run: the process's exit code (the
 * last event's when it was killed by a signal), the reason of an `error`
 * event or a failed run, and the run's end without its output.
 */
export function exitFromEvent(process: Exit, last: ExecEvent | null): Exit {
  if (!last) return process;
  if (last.event === 'exit') {
    const { event: _event, ...rest } = last;
    const error = execError(rest.error, rest.exit);
    const exit: Exit = {
      exitCode: process.exitCode ?? rest.exit,
      signal: process.signal,
      stderrTail: error?.message || process.stderrTail,
      result: { ...rest, error },
    };
    if (error) exit.error = error;
    return exit;
  }
  if (last.event === 'error') {
    const error = execError(last.error, last.exit) ?? undefined;
    return { exitCode: process.exitCode ?? last.exit, signal: process.signal, stderrTail: error?.message || process.stderrTail, error };
  }
  return process;
}

/** `exec --json-stream`, as an OutputStream. */
export class JsonExecStream implements OutputStream {
  readonly argv: readonly string[];
  private readonly inner: CliStream;
  private readonly queue: Chunk[] = [];
  private waiters: Array<() => void> = [];
  private done = false;
  private last: ExecEvent | null = null;
  private readonly exited: Promise<Exit>;

  constructor(inv: Invocation, keepStdinOpen = false) {
    this.argv = inv.args;
    this.inner = new CliStream(inv, keepStdinOpen);
    this.exited = this.run();
    this.exited.catch(() => {});
  }

  private onLine(line: string): void {
    if (!line.trim()) return;
    const ev = parseExecEvent(line);
    if (!ev) return;
    if ((ev.event === 'stdout' || ev.event === 'stderr') && typeof ev.data === 'string') {
      this.queue.push({ stream: ev.event, data: new TextEncoder().encode(ev.data) });
      this.wake();
    } else if (ev.event === 'exit' || ev.event === 'error') {
      this.last = ev;
    }
  }

  private async run(): Promise<Exit> {
    const dec = new TextDecoder('utf-8');
    let buf = '';
    try {
      for await (const c of this.inner) {
        // gaiadesk-cli's own stderr is not the command's: its reason ends up in stderrTail.
        if (c.stream !== 'stdout') continue;
        buf += dec.decode(c.data, { stream: true });
        let i: number;
        while ((i = buf.indexOf('\n')) >= 0) {
          this.onLine(buf.slice(0, i));
          buf = buf.slice(i + 1);
        }
      }
      this.onLine(buf + dec.decode());
      return exitFromEvent(await this.inner.wait(), this.last);
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

  write(data: string | Uint8Array): void {
    this.inner.write(data);
  }

  end(): void {
    this.inner.end();
  }

  kill(signal?: string): void {
    this.inner.kill(signal);
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

  text(): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }> {
    return textOf(this);
  }
}

/**
 * A stream that starts when `start` resolves. If it rejects (a usage error
 * found once the CLI's features are known, gaiadesk-cli missing), iterating
 * throws that error and wait() rejects with it.
 */
export class DeferredStream implements OutputStream {
  private inner?: OutputStream;
  private readonly pending: Array<(s: OutputStream) => void> = [];
  private readonly start: Promise<OutputStream>;

  constructor(
    private readonly plannedArgv: readonly string[],
    start: Promise<OutputStream>,
  ) {
    this.start = start.then((s) => {
      this.inner = s;
      for (const f of this.pending.splice(0)) f(s);
      return s;
    });
    this.start.catch(() => {});
  }

  /** The arguments gaiadesk-cli runs with (as planned until it has started). */
  get argv(): readonly string[] {
    return this.inner?.argv ?? this.plannedArgv;
  }

  private withInner(f: (s: OutputStream) => void): void {
    if (this.inner) f(this.inner);
    else this.pending.push(f);
  }

  write(data: string | Uint8Array): void {
    this.withInner((s) => s.write(data));
  }

  end(): void {
    this.withInner((s) => s.end());
  }

  kill(signal?: string): void {
    this.withInner((s) => s.kill(signal));
  }

  wait(): Promise<Exit> {
    return this.start.then((s) => s.wait());
  }

  async *[Symbol.asyncIterator](): AsyncIterator<Chunk> {
    const s = await this.start;
    yield* s;
  }

  text(): AsyncGenerator<{ stream: 'stdout' | 'stderr'; text: string }> {
    return textOf(this);
  }
}
