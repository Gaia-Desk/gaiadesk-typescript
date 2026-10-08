// When the /v1 transports (api, local, lan) send a request again. Exactly
// this, in every GaiaDesk SDK:
//
// 1. The connection was never made (DNS, refused, the socket or pipe missing,
//    a TLS handshake cut off): any method, since nothing was sent. Not a
//    connect timeout, not a certificate / pin failure.
// 2. The connection was lost after sending (closed or reset before any
//    answer), or the answer was 502, 503 or 504: GETs only. A 503 saying the
//    API or desk operations are switched off is final.
// 3. 429 (`rate_limited`, `desk_busy`) and 409 `idempotency_key_in_flight`:
//    any method, since the server refused it before acting.
// 4. Nothing else: no timeout, nothing whose answer has begun, no POST / PUT /
//    DELETE that may have reached the server. An Idempotency-Key never makes
//    a call retryable.
//
// 429 and 503 wait for `Retry-After` (one longer than maxRetryWaitMs is not
// waited for: the error, carrying it, is thrown at once); otherwise the wait
// is min(maxDelayMs, baseDelayMs * 2^n) times a random 0.5-1.0.

import { GaiaDeskError, UnreachableError, UsageError } from './errors.js';
import type { AbortSignalLike } from './types.js';

/** Retries of the api, local and lan transports. */
export interface RetryOptions {
  /** How many times a request may be sent again (default 2: three attempts in all); 0 turns retries off. */
  maxRetries?: number;
  /** The first backoff wait, in milliseconds (default 250), doubling each retry. */
  baseDelayMs?: number;
  /** The longest backoff wait, in milliseconds (default 8000). */
  maxDelayMs?: number;
  /** The longest `Retry-After` (429, 503) waited for, in milliseconds (default 60000); a longer one is thrown at once. */
  maxRetryWaitMs?: number;
}

export const DEFAULT_RETRY: Readonly<Required<RetryOptions>> = Object.freeze({ maxRetries: 2, baseDelayMs: 250, maxDelayMs: 8000, maxRetryWaitMs: 60_000 });

/** The 503 reasons that say a service is switched off: not retried. */
const PERMANENT_503 = new Set(['api_disabled', 'desk_ops_disabled', 'local_api_off']);

/** The retry options with the defaults filled in; a bad value is a UsageError. */
export function resolveRetry(o: RetryOptions | undefined): Required<RetryOptions> {
  if (o !== undefined && (typeof o !== 'object' || o === null)) throw new UsageError('retry must be an object: { maxRetries?, baseDelayMs?, maxDelayMs?, maxRetryWaitMs? }', { kind: 'usage' });
  const r = { ...DEFAULT_RETRY };
  for (const k of Object.keys(DEFAULT_RETRY) as (keyof RetryOptions)[]) {
    const v = o?.[k];
    if (v === undefined) continue;
    const ok = typeof v === 'number' && Number.isFinite(v) && v >= 0 && (k !== 'maxRetries' || Number.isInteger(v)) && v <= 2_147_483_647;
    if (!ok) throw new UsageError(`retry.${k} must be ${k === 'maxRetries' ? 'a whole number' : 'a number of milliseconds'}, 0 or more, not ${String(v)}`, { kind: 'usage' });
    r[k] = v;
  }
  return r;
}

/** Errors for a request that was never sent: its connection was never made. */
const unsent = new WeakSet<object>();
/** Errors a retry loop already gave up on (an inner request's): never retried again by an outer one. */
const exhausted = new WeakSet<object>();

/** Mark `e` as a failure to connect: nothing of the request was sent. */
export function markUnsent<E extends object>(e: E): E {
  unsent.add(e);
  return e;
}

/** The causes that mean the connection was never made. */
const CONNECT_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'EAI_NONAME', 'EHOSTUNREACH', 'ENETUNREACH', 'EHOSTDOWN', 'ENETDOWN', 'EADDRNOTAVAIL', 'ENOENT']);

/**
 * How a fetch failure (its `cause` chain) went: `unsent` (the connection was
 * never made), `timeout` (connecting timed out), else `lost` (it may have been
 * sent: a reset or close after connecting cannot be told apart from one
 * during a TLS handshake, so it counts as sent).
 */
export function fetchFailure(e: unknown): 'unsent' | 'timeout' | 'lost' {
  for (let x = e as { code?: unknown; message?: unknown; cause?: unknown; errors?: unknown } | undefined, i = 0; x && i < 8; x = x.cause as typeof x, i++) {
    const codes = [x.code, ...(Array.isArray(x.errors) ? x.errors.map((y: { code?: unknown }) => y?.code) : [])];
    if (codes.includes('UND_ERR_CONNECT_TIMEOUT') || codes.includes('ETIMEDOUT')) return 'timeout';
    if (codes.some((c) => typeof c === 'string' && CONNECT_CODES.has(c))) return 'unsent';
    if (typeof x.message === 'string' && x.message.includes('before secure TLS connection was established')) return 'unsent';
  }
  return 'lost';
}

/**
 * How long to wait before sending `method` again after `e` (attempt `n`, 0
 * for the first retry), or null when it is not sent again.
 */
export function retryWait(e: unknown, method: string, n: number, r: Required<RetryOptions>, random: () => number = Math.random): number | null {
  if (n >= r.maxRetries || !(e instanceof GaiaDeskError) || exhausted.has(e)) return null;
  if (e.kind === 'timeout' || e.kind === 'interrupted') return null;
  const status = e.status;
  const nothingRan = unsent.has(e) || status === 429 || (status === 409 && e.reason === 'idempotency_key_in_flight');
  const read = method === 'GET' && (
    (status === null && e instanceof UnreachableError && e.kind === 'network') ||
    status === 502 || status === 504 ||
    (status === 503 && !PERMANENT_503.has(e.reason ?? '')));
  if (!nothingRan && !read) return null;
  if (e.retryAfter !== null && (status === 429 || status === 503)) {
    const ms = Math.max(0, e.retryAfter * 1000);
    return ms <= r.maxRetryWaitMs ? ms : null;
  }
  return backoffMs(n, r, random);
}

/** The backoff before retry `n` (0 first): min(maxDelayMs, baseDelayMs * 2^n) times a random 0.5-1.0. */
export function backoffMs(n: number, r: Pick<Required<RetryOptions>, 'baseDelayMs' | 'maxDelayMs'>, random: () => number = Math.random): number {
  return Math.min(r.maxDelayMs, r.baseDelayMs * 2 ** n) * (0.5 + 0.5 * random());
}

/** `e` is final: a retry loop gave up on it. */
export function giveUp(e: unknown): unknown {
  if (typeof e === 'object' && e !== null) exhausted.add(e);
  return e;
}

/** Wait `ms`; any of `signals` aborting ends the wait at once with `interrupted()`. */
export function sleep(ms: number, signals: (AbortSignalLike | undefined)[], interrupted: () => Error): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    const live = signals.filter((s): s is AbortSignalLike => s !== undefined);
    const off = () => {
      clearTimeout(timer);
      for (const s of live) s.removeEventListener('abort', onAbort);
    };
    const onAbort = () => {
      off();
      reject(interrupted());
    };
    const timer = setTimeout(() => {
      off();
      resolve();
    }, ms);
    for (const s of live) {
      if (s.aborted) return onAbort();
      s.addEventListener('abort', onAbort, { once: true });
    }
  });
}
