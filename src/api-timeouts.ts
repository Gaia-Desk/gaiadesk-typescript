// How long the /v1 transports (api, local, lan) wait on the network before
// giving up, so a server or proxy that stops answering (a connection dropped
// but never closed, a half-open socket, a stalled proxy) is a typed error,
// never a hang:
//
// - responseTimeoutMs bounds the wait for an answer to BEGIN (status and
//   headers), sending the request included: an UnreachableError, kind `timeout`.
// - idleTimeoutMs bounds EVERY read of a body (JSON, error bodies, downloads
//   plain and sealed, event streams, held waits): a ConnectionLostError, kind
//   `timeout`. It is an inactivity limit, not a deadline: a body that keeps
//   flowing never times out.
//
// Both abort the request's AbortController, so the connection is abandoned
// (fetch and node:http destroy a socket whose request was aborted), never
// returned to a pool. Works over any FetchLike: the race below does not rely
// on the fetch honouring its signal.

import { ConnectionLostError, GaiaDeskError, UnreachableError, UsageError } from './errors.js';
import type { ByteStreamLike } from './api-stream.js';
import type { ResponseLike } from './api.js';

/** Network timeouts of the api, local and lan transports, in milliseconds; `null` (or `Infinity`): no limit. */
export interface TimeoutOptions {
  /**
   * The longest wait for an answer to begin (its status and headers), sending
   * the request included. Default 16 minutes: above the API's 15-minute limit
   * on a call (a buffered exec answers when its command ends). Exceeded: an
   * `UnreachableError`, kind `timeout`.
   */
  responseTimeoutMs?: number | null;
  /**
   * The longest silence while reading an answer's body (a JSON result, a
   * download, an event stream, a held wait). Default 90 s: the API's streams
   * and held waits send a keep-alive every 15 s. Exceeded: a
   * `ConnectionLostError`, kind `timeout`.
   */
  idleTimeoutMs?: number | null;
}

export const DEFAULT_RESPONSE_TIMEOUT_MS = 16 * 60_000;
export const DEFAULT_IDLE_TIMEOUT_MS = 90_000;
/** The longest a timer can wait (setTimeout's limit, about 24.8 days). */
const MAX_MS = 2_147_483_647;

/** The checked timeouts: milliseconds, or null for no limit. */
export interface Timeouts {
  responseMs: number | null;
  idleMs: number | null;
}

function one(v: unknown, fallback: number, name: string): number | null {
  if (v === undefined) return fallback;
  if (v === null || v === Infinity) return null;
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0 || v > MAX_MS) {
    throw new UsageError(`timeouts.${name} must be a positive number of milliseconds, at most ${MAX_MS} (or null for no limit), not ${String(v)}`, { kind: 'usage' });
  }
  return v;
}

/** The timeouts from the options (defaults filled in); a bad value is a UsageError. */
export function resolveTimeouts(t: TimeoutOptions | undefined): Timeouts {
  if (t !== undefined && (typeof t !== 'object' || t === null)) throw new UsageError('timeouts must be an object: { responseTimeoutMs?, idleTimeoutMs? }', { kind: 'usage' });
  return {
    responseMs: one(t?.responseTimeoutMs, DEFAULT_RESPONSE_TIMEOUT_MS, 'responseTimeoutMs'),
    idleMs: one(t?.idleTimeoutMs, DEFAULT_IDLE_TIMEOUT_MS, 'idleTimeoutMs'),
  };
}

function secs(ms: number): string {
  return `${Number((ms / 1000).toFixed(3))} s`;
}

/** Everything one request's guard needs: its controller, and the errors it reports. */
export interface Guard {
  ctrl: AbortController;
  where: string;
  op: string;
  timeouts: Timeouts;
  /** The caller's abort (not one of ours). */
  interrupted(): GaiaDeskError;
  /** Called once the request is over (its body read, failed or cancelled): drop the caller's abort listeners. */
  done(): void;
}

/**
 * Race `p` against `ms` and the controller's abort: a timeout aborts the
 * request and rejects with `timedOut()`. Never leaves `p` unhandled.
 */
function bounded<T>(p: Promise<T>, g: Guard, ms: number | null, timedOut: () => GaiaDeskError, state: { failed: GaiaDeskError | null }): Promise<T> {
  p.catch(() => {});
  return new Promise<T>((resolve, reject) => {
    const sig = g.ctrl.signal;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const settle = () => {
      if (timer !== undefined) clearTimeout(timer);
      sig.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      settle();
      reject(state.failed ?? g.interrupted());
    };
    if (sig.aborted) return onAbort();
    sig.addEventListener('abort', onAbort, { once: true });
    if (ms !== null) {
      timer = setTimeout(() => {
        state.failed ??= timedOut();
        g.ctrl.abort(state.failed); // the connection is abandoned, never reused
      }, ms);
    }
    p.then(
      (v) => {
        settle();
        if (state.failed) reject(state.failed);
        else resolve(v);
      },
      (e) => {
        settle();
        reject(e);
      },
    );
  });
}

/** The fetch of one request, its answer bounded by `responseMs`. Throws the timeout's or the caller's error, else the fetch's own. */
export function boundedFetch(fetched: Promise<ResponseLike>, g: Guard, state: { failed: GaiaDeskError | null }): Promise<ResponseLike> {
  return bounded(fetched, g, g.timeouts.responseMs, () => new UnreachableError(`${g.where} did not answer ${g.op} within ${secs(g.timeouts.responseMs ?? 0)} (timeouts.responseTimeoutMs)`, {
    kind: 'timeout',
    reason: 'timeout',
    exitCode: 255,
    argv: [g.op],
  }), state);
}

/**
 * The answer with every read of its body bounded by `idleMs`: a stall is a
 * ConnectionLostError (kind `timeout`), any other failure mid-body a
 * ConnectionLostError (kind `network`), the caller's abort `interrupted()`.
 */
export function guardBody(res: ResponseLike, g: Guard, state: { failed: GaiaDeskError | null }): ResponseLike {
  const idle = () => new ConnectionLostError(`${g.where} stopped sending its answer to ${g.op}: nothing for ${secs(g.timeouts.idleMs ?? 0)} (timeouts.idleTimeoutMs)`, {
    kind: 'timeout',
    reason: 'timeout',
    exitCode: 255,
    argv: [g.op],
  });
  let over = false;
  const finish = () => {
    if (over) return;
    over = true;
    g.done();
  };
  const step = async <T>(p: Promise<T>): Promise<T> => {
    try {
      return await bounded(p, g, g.timeouts.idleMs, idle, state);
    } catch (e) {
      finish();
      if (state.failed) throw state.failed;
      if (g.ctrl.signal.aborted) throw g.interrupted();
      if (e instanceof GaiaDeskError) throw e;
      throw new ConnectionLostError(`${g.where} dropped its answer to ${g.op}: ${(e as Error)?.message ?? e}`, { kind: 'network', reason: 'network', exitCode: 255, argv: [g.op] });
    }
  };
  const inner = res.body;
  let reader: ReturnType<ByteStreamLike['getReader']> | null = null;
  const readerOf = () => (reader ??= (inner as ByteStreamLike).getReader());
  const read = async (): Promise<{ done: boolean; value?: Uint8Array }> => {
    const r = await step(readerOf().read());
    if (r.done) finish();
    return r;
  };
  const all = async (): Promise<Uint8Array> => {
    const parts: Uint8Array[] = [];
    let n = 0;
    for (;;) {
      const r = await read();
      if (r.done) break;
      if (r.value) {
        parts.push(r.value);
        n += r.value.byteLength;
      }
    }
    const out = new Uint8Array(n);
    let at = 0;
    for (const p of parts) {
      out.set(p, at);
      at += p.byteLength;
    }
    return out;
  };
  const body: ByteStreamLike | null = inner
    ? {
        getReader() {
          return {
            read,
            async cancel(reason?: unknown) {
              finish();
              await readerOf().cancel(reason).catch(() => {});
            },
          };
        },
      }
    : null;
  return {
    ok: res.ok,
    status: res.status,
    headers: res.headers,
    body,
    // A FetchLike with no body stream (a test double): its text, bounded as one read.
    text: async () => (inner ? new TextDecoder('utf-8').decode(await all()) : step(res.text()).finally(finish)),
    arrayBuffer: async () => {
      if (!inner) return step(res.arrayBuffer()).finally(finish);
      const b = await all();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}
