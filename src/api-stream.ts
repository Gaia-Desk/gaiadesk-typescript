// Streams over the hosted API: Server-Sent Events, read with nothing but
// `fetch` (Node 18+ and browsers).
//
// - SseParser: text in (any chunking: an event may be split anywhere, even
//   between `\r` and `\n`), events out. `:` lines are keep-alives.
// - ApiStream: `POST /desks/{id}/exec?stream=1` (ExecEvent objects) or
//   `GET /desks/{id}/jobs/{name}/logs?follow=1` (JobLogEvent objects) as the
//   same OutputStream the CLI transport gives: stdout/stderr chunks, then
//   wait() with the exit, its `result` and `error`.

import { ConnectionLostError, GaiaDeskError, OperationFailedError, ProtocolError, RefusedError, UnreachableError, UsageError, errorEnvelope } from './errors.js';
import { exitFromEvent, parseExecEvent } from './exec-stream.js';
import type { Chunk, Exit, OutputStream } from './proc.js';
import { execError } from './results.js';
import type { AbortSignalLike, ExecEvent } from './types.js';

/** One server-sent event: its `event:` name (default `message`) and its `data:` lines joined by `\n`. */
export interface SseEvent {
  event: string;
  data: string;
}

/** An incremental `text/event-stream` parser (the WHATWG rules: fields, comments, blank-line dispatch). */
export class SseParser {
  private buf = '';
  private event = '';
  private data: string[] = [];

  /** Feed decoded text; returns the events it completed. */
  feed(text: string): SseEvent[] {
    this.buf += text;
    const out: SseEvent[] = [];
    for (;;) {
      const m = /\r\n|\r|\n/.exec(this.buf);
      if (!m) break;
      // A trailing `\r` may be the first half of `\r\n`: wait for the next chunk.
      if (m[0] === '\r' && m.index === this.buf.length - 1) break;
      const line = this.buf.slice(0, m.index);
      this.buf = this.buf.slice(m.index + m[0].length);
      const ev = this.line(line);
      if (ev) out.push(ev);
    }
    return out;
  }

  /** The end of the stream: an event the server did not finish with a blank line is still delivered. */
  end(): SseEvent[] {
    const out: SseEvent[] = [];
    if (this.buf) {
      const ev = this.line(this.buf.replace(/\r$/, ''));
      this.buf = '';
      if (ev) out.push(ev);
    }
    const last = this.line('');
    if (last) out.push(last);
    return out;
  }

  private line(line: string): SseEvent | null {
    if (line === '') {
      if (this.data.length === 0) {
        this.event = '';
        return null;
      }
      const ev = { event: this.event || 'message', data: this.data.join('\n') };
      this.event = '';
      this.data = [];
      return ev;
    }
    if (line.startsWith(':')) return null; // a comment: keep-alive
    const i = line.indexOf(':');
    const field = i < 0 ? line : line.slice(0, i);
    let value = i < 0 ? '' : line.slice(i + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    return null;
  }
}

/** Minimal shape of a fetch Response body (a WHATWG ReadableStream of bytes). */
export interface ByteStreamLike {
  getReader(): { read(): Promise<{ done: boolean; value?: Uint8Array }>; cancel(reason?: unknown): Promise<void>; releaseLock?(): void };
}

/** The events of a `text/event-stream` body, as they arrive. */
export async function* sseEvents(body: ByteStreamLike): AsyncGenerator<SseEvent> {
  const reader = body.getReader();
  const dec = new TextDecoder('utf-8');
  const p = new SseParser();
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) yield* p.feed(dec.decode(value, { stream: true }));
    }
    yield* p.feed(dec.decode());
    yield* p.end();
  } finally {
    reader.cancel().catch(() => {});
  }
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** gaiadesk-cli's exit code for a desk operation that failed with this kind (0 done, 1 failed, 254 refused, 255 the rest). */
export function deskOpExit(kind: string): number {
  if (kind === 'refused') return 254;
  if (kind === 'failed') return 1;
  if (kind === 'interrupted') return 130;
  return 255;
}

/** The error kind (one of the six, by the error's class) a stream's exit reports for an error with no envelope. */
function streamKind(e: GaiaDeskError): string {
  if (e instanceof ProtocolError) return 'protocol';
  if (e instanceof ConnectionLostError) return 'connection_lost';
  if (e instanceof UnreachableError) return 'unreachable';
  if (e instanceof RefusedError) return 'refused';
  if (e instanceof OperationFailedError) return 'failed';
  if (e instanceof UsageError) return 'usage';
  return e.kind === 'network' ? 'unreachable' : e.kind;
}

/** The Exit for an error that ended (or prevented) a stream. */
export function exitForError(e: GaiaDeskError): Exit {
  const exit: Exit = { exitCode: e.exitCode, signal: null, stderrTail: e.message };
  const env = errorEnvelope(e.json);
  const error = env
    ? execError({ kind: env.kind, message: env.message || e.message, reason: env.reason, desk: env.desk })
    : execError({ kind: streamKind(e), message: e.message, reason: e.reason ?? undefined, desk: e.desk ?? undefined });
  if (error) exit.error = error;
  return exit;
}

/** A started stream: its body, and (end-to-end encrypted) how its sealed events open into the plaintext ones. */
export interface StreamStart {
  body: ByteStreamLike | null;
  unseal?: (events: AsyncIterable<SseEvent>) => AsyncIterable<SseEvent>;
}

/**
 * An SSE stream from the API as an OutputStream. `start` makes the request
 * (it throws the typed error for an HTTP failure); `kind` says which events
 * the stream carries.
 */
export class ApiStream implements OutputStream {
  readonly argv: readonly string[];
  private readonly queue: Chunk[] = [];
  private waiters: Array<() => void> = [];
  private done = false;
  private killed = false;
  private readonly ctrl = new AbortController();
  private readonly exited: Promise<Exit>;
  private readonly enc = new TextEncoder();

  constructor(
    op: string,
    private readonly kind: 'exec' | 'logs',
    start: (signal: AbortSignal) => Promise<StreamStart>,
    signal?: AbortSignalLike,
    private readonly jobName = '',
  ) {
    this.argv = [op];
    if (signal) {
      if (signal.aborted) this.kill();
      else signal.addEventListener('abort', () => this.kill(), { once: true });
    }
    this.exited = this.run(start);
    this.exited.catch(() => {});
  }

  private push(stream: 'stdout' | 'stderr', text: string) {
    this.queue.push({ stream, data: this.enc.encode(text) });
    const w = this.waiters;
    this.waiters = [];
    for (const f of w) f();
  }

  private async run(start: (signal: AbortSignal) => Promise<StreamStart>): Promise<Exit> {
    try {
      const res = await start(this.ctrl.signal);
      if (!res.body) throw new GaiaDeskError('the GaiaDesk API sent an event stream with no body', { kind: 'protocol', argv: this.argv });
      const events = res.unseal ? res.unseal(sseEvents(res.body)) : sseEvents(res.body);
      return this.kind === 'exec' ? await this.execEvents(events) : await this.logEvents(events);
    } catch (e) {
      if (this.killed) return { exitCode: 130, signal: null, stderrTail: 'interrupted' };
      const err = e instanceof GaiaDeskError ? e : new UnreachableError(`the GaiaDesk API could not be reached: ${(e as Error)?.message ?? e}`, { kind: 'network', reason: 'network', exitCode: 255, argv: this.argv });
      return exitForError(err);
    } finally {
      this.done = true;
      const w = this.waiters;
      this.waiters = [];
      for (const f of w) f();
    }
  }

  /** The ExecEvent of one SSE event: its JSON, with the SSE name as its `event` when the JSON has none. */
  private static object(ev: SseEvent): Record<string, unknown> | null {
    let v: unknown;
    try {
      v = JSON.parse(ev.data);
    } catch {
      return null;
    }
    if (!isObj(v)) return null;
    if (typeof v.event !== 'string') v = { ...v, event: ev.event };
    return v as Record<string, unknown>;
  }

  private async execEvents(events: AsyncIterable<SseEvent>): Promise<Exit> {
    let last: ExecEvent | null = null;
    for await (const sse of events) {
      const o = ApiStream.object(sse);
      const ev = o ? parseExecEvent(JSON.stringify(o)) : null;
      if (!ev) continue;
      if ((ev.event === 'stdout' || ev.event === 'stderr') && typeof ev.data === 'string') this.push(ev.event, ev.data);
      else if (ev.event === 'exit' || ev.event === 'error') last = ev;
    }
    if (!last) return lostExit('the event stream ended before the command did');
    return exitFromEvent({ exitCode: null, signal: null, stderrTail: '' }, last);
  }

  private async logEvents(events: AsyncIterable<SseEvent>): Promise<Exit> {
    for await (const sse of events) {
      const o = ApiStream.object(sse);
      if (!o) continue;
      if (o.event === 'output' && typeof o.data === 'string') {
        this.push('stdout', o.data);
      } else if (o.event === 'end') {
        const job = isObj(o.job) ? o.job : {};
        const name = typeof job.name === 'string' ? job.name : this.jobName;
        const tail = typeof job.exit_code === 'number' ? `job ${name} exited (exit ${job.exit_code})` : `job ${name} ${String(job.state ?? 'ended')}`;
        return { exitCode: 0, signal: null, stderrTail: tail };
      } else if (o.event === 'interrupted') {
        return { exitCode: 0, signal: null, stderrTail: 'stopped following; the job goes on' };
      } else if (o.event === 'error') {
        const error = execError(o.error) ?? { kind: 'protocol', message: 'the desk reported an error' };
        return { exitCode: deskOpExit(error.kind), signal: null, stderrTail: error.message, error } as Exit;
      }
    }
    return lostExit('the event stream ended before the job did');
  }

  write(_data: string | Uint8Array): void {
    throw new GaiaDeskError('stdin cannot be written to a command over the API transport (give `stdin` as text up front)', { kind: 'usage', argv: this.argv });
  }

  end(): void {
    /* stdin is closed from the start over the API */
  }

  /** Stop: closes the request (the server stops the command, or stops following the job). */
  kill(_signal?: string): void {
    this.killed = true;
    this.ctrl.abort();
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

function lostExit(message: string): Exit {
  return { exitCode: 255, signal: null, stderrTail: message, error: { kind: 'connection_lost', message } };
}
