// End-to-end encryption on the hosted API transport: whether and to which
// key an operation is sealed (the desk's `e2e_pub` from `GET /desks/{id}`,
// cached; pinned keys; the `e2e` mode; a wake when a desk that must be
// sealed to lists no key), the one retry each for `e2e_required` and
// `e2e_decrypt_failed`, and turning sealed answers back into exactly what the
// plaintext call answers: JSON results, error envelopes, SSE events (as the
// server maps a desk's events: protocol/src/desk_op_http.rs) and file bytes.
// The crypto itself is e2e.ts.

import { ConnectionLostError, E2eError, GaiaDeskError, ProtocolError, RefusedError, UsageError, errorEnvelope, errorForKind, sdkKind } from './errors.js';
import type { SseEvent } from './api-stream.js';
import { E2eOpenError, INPUT_CHUNK, b64decode, deskKey, sealRequest } from './e2e.js';
import type { CallerSeal, DeskEvent, SealedRequest } from './e2e.js';

/** `auto` (default): seal when the desk lists a key; `require`: never send in the clear; `off`: never seal. */
export type E2eMode = 'auto' | 'require' | 'off';

export interface E2eOptions {
  /** End-to-end encryption of desk operations (API transport): `auto` (default), `require` or `off`. */
  e2e?: E2eMode;
  /** Pinned desk keys, `{deskId: e2e_pub}` (base64url): a different key from the server is refused. */
  e2eKeys?: Readonly<Record<string, string>>;
  /** Where the SDK's warnings go (default: `console.warn`). */
  onWarning?: (message: string) => void;
}

/** An operation, sealed: its request envelope, and the seal for its input and events. */
export interface Sealed {
  request: SealedRequest;
  seal: CallerSeal;
}

/** What the desk lookup said. */
interface DeskKeyInfo {
  pub: Uint8Array | null;
  required: boolean;
  /** Why there is no key (for the warning or the error). */
  why: string;
}

/** How the layer reaches the API for its own calls (the desk lookup, a wake). */
export type ApiJson = (method: string, path: string, r: { deskToken?: string; signal?: unknown; json?: unknown }) => Promise<unknown>;

/** Per-call options the layer reads. */
export interface E2eCall {
  deskToken?: string;
  signal?: unknown;
  wake?: number;
}

const KEY_TTL_MS = 5 * 60_000;
const NO_KEY_TTL_MS = 30_000;
const DEFAULT_WAKE_S = 30;
const warned = new Set<string>();

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function same(a: Uint8Array, b: Uint8Array): boolean {
  return a.length === b.length && a.every((x, i) => x === b[i]);
}

export function checkE2eOptions(o: E2eOptions): void {
  const usage = (m: string) => new UsageError(m, { kind: 'usage' });
  if (o.e2e !== undefined && o.e2e !== 'auto' && o.e2e !== 'require' && o.e2e !== 'off') throw usage(`e2e is auto, require or off (not ${JSON.stringify(o.e2e)})`);
  if (o.e2eKeys !== undefined) {
    if (!isObj(o.e2eKeys)) throw usage('e2eKeys is an object of desk ids to e2e_pub keys');
    for (const [d, k] of Object.entries(o.e2eKeys)) {
      if (!deskKey(k)) throw usage(`e2eKeys[${JSON.stringify(d)}] is not a 32-byte base64url X25519 key`);
    }
  }
  if (o.onWarning !== undefined && typeof o.onWarning !== 'function') throw usage('onWarning must be a function');
}

export class E2eLayer {
  readonly mode: E2eMode;
  private readonly pins = new Map<string, Uint8Array>();
  private readonly cache = new Map<string, { at: number; info: DeskKeyInfo }>();
  private readonly warn: (m: string) => void;

  constructor(o: E2eOptions, private readonly api: ApiJson, private readonly baseUrl: string) {
    checkE2eOptions(o);
    this.mode = o.e2e ?? 'auto';
    for (const [d, k] of Object.entries(o.e2eKeys ?? {})) this.pins.set(d, deskKey(k) as Uint8Array);
    this.warn = o.onWarning ?? ((m) => console.warn(m));
  }

  /** Forget what the lookup said about `desk` (its key may have rotated). */
  forget(desk: string): void {
    this.cache.delete(desk);
  }

  /** `GET /desks/{id}`: the desk's key and whether it requires sealing (cached; `fresh` asks again). */
  private async info(desk: string, c: E2eCall, fresh: boolean): Promise<DeskKeyInfo> {
    const hit = this.cache.get(desk);
    if (!fresh && hit && Date.now() - hit.at < (hit.info.pub ? KEY_TTL_MS : NO_KEY_TTL_MS)) return hit.info;
    let d: unknown;
    try {
      d = await this.api('GET', `/desks/${encodeURIComponent(desk)}`, { deskToken: c.deskToken, signal: c.signal });
    } catch (e) {
      if (e instanceof GaiaDeskError && e.kind === 'interrupted') throw e;
      return { pub: null, required: false, why: `its key could not be read (GET /desks/${desk}: ${(e as Error).message})` };
    }
    const o = isObj(d) ? d : {};
    const pub = deskKey(o.e2e_pub);
    const required = o.e2e_required === true;
    const why = pub ? '' : o.online === false ? 'it is offline, and lists its key only while online' : 'it lists no end-to-end key (a GaiaDesk from before end-to-end encryption?)';
    const info = { pub, required, why };
    this.cache.set(desk, { at: Date.now(), info });
    return info;
  }

  /** The server's key for `desk`, refused when a pinned key differs. */
  private checked(desk: string, info: DeskKeyInfo): Uint8Array | null {
    const pin = this.pins.get(desk);
    if (info.pub && pin && !same(info.pub, pin)) {
      this.forget(desk);
      throw new E2eError(`the GaiaDesk API lists a different end-to-end key for desk ${desk} than the pinned one (e2eKeys); nothing was sent`, {
        kind: 'refused', reason: 'e2e_key_mismatch', desk, exitCode: 254,
      });
    }
    return info.pub ?? pin ?? null;
  }

  /**
   * The key to seal `desk`'s next operation to, or null to send it in the
   * clear (auto, no key: warned once). `insist`: it must be sealed (the API
   * said `e2e_required`). A desk that must be sealed to and lists no key is
   * woken and asked again; still none is an E2eError.
   */
  async key(desk: string, c: E2eCall, insist = false): Promise<Uint8Array | null> {
    let info = await this.info(desk, c, insist);
    const pub = this.checked(desk, info);
    if (pub) return pub;
    if (this.mode !== 'require' && !info.required && !insist) {
      const id = `${this.baseUrl} ${desk}`;
      if (!warned.has(id)) {
        warned.add(id);
        this.warn(`GaiaDesk: operations on desk ${desk} are not end-to-end encrypted: ${info.why}. The API relays them in the clear (pass e2e: 'require' to refuse that).`);
      }
      return null;
    }
    await this.api('POST', `/desks/${encodeURIComponent(desk)}/wake`, { deskToken: c.deskToken, signal: c.signal, json: { wait_s: Math.min(90, c.wake ?? DEFAULT_WAKE_S) } }).catch((e) => {
      if (e instanceof GaiaDeskError && e.kind === 'interrupted') throw e;
    });
    info = await this.info(desk, c, true);
    const woke = this.checked(desk, info);
    if (woke) return woke;
    throw new E2eError(`desk ${desk} must be reached end-to-end encrypted, but ${info.why}; nothing was sent`, { kind: 'refused', reason: 'e2e_unavailable', desk, exitCode: 254 });
  }

  /**
   * Run one desk operation: `attempt` sends it (sealed, or in the clear when
   * given null) and returns the response. A plaintext call the API refuses
   * `e2e_required` is sealed and sent again; a sealed one the desk could not
   * open (`e2e_decrypt_failed`: its key rotated) is sealed to the key asked
   * for again, once.
   */
  async call<T>(desk: string, op: string, request: Record<string, unknown>, c: E2eCall, attempt: (s: Sealed | null) => Promise<T>): Promise<T> {
    if (this.mode === 'off') return attempt(null);
    const seal = async (pub: Uint8Array) => sealRequest(pub, desk, op, request);
    const pub = await this.key(desk, c);
    try {
      return await attempt(pub ? await seal(pub) : null);
    } catch (e) {
      if (!pub && e instanceof RefusedError && e.reason === 'e2e_required') {
        this.forget(desk);
        return attempt(await seal((await this.key(desk, c, true)) as Uint8Array));
      }
      if (pub && e instanceof RefusedError && !(e instanceof E2eError) && e.reason === 'e2e_decrypt_failed') {
        this.forget(desk);
        const again = await this.key(desk, c);
        if (!again) throw e;
        return attempt(await seal(again));
      }
      throw e;
    }
  }
}

// ───────────────────────────── opening answers ─────────────────────────────

/** A sealed event opened, or the ProtocolError for one that does not. */
function open(seal: CallerSeal, frame: unknown, argv: readonly string[]): DeskEvent {
  try {
    return seal.openDeskEvent(frame);
  } catch (e) {
    const reason = e instanceof E2eOpenError ? e.reason : 'e2e_malformed';
    throw new ProtocolError(`the desk's end-to-end encrypted answer did not open: ${(e as Error).message}`, { kind: 'protocol', reason, argv, exitCode: 255 });
  }
}

function eventsOf(json: Record<string, unknown>): unknown[] | null {
  const e = isObj(json.e2e) ? json.e2e : isObj(json.error) && isObj(json.error.e2e) ? json.error.e2e : null;
  return e && Array.isArray(e.events) ? e.events : null;
}

/**
 * An error envelope with the desk's real message: a desk's error comes with
 * a placeholder `message` and `e2e.events`, whose last opens to the `error`.
 * An envelope without events (the server's own error) is as it is.
 */
export function openErrorEnvelope(json: unknown, seal: CallerSeal, argv: readonly string[]): unknown {
  if (!isObj(json) || !isObj(json.error)) return json;
  const events = eventsOf(json);
  if (!events) return json;
  const { e2e: _inner, ...error } = json.error;
  let last: DeskEvent | null = null;
  try {
    for (const f of events) last = open(seal, f, argv);
  } catch {
    last = null;
  }
  const message = last?.event === 'error' ? last.message : `${String(error.message ?? 'the desk reported an error')} (its end-to-end encrypted message did not open)`;
  const { e2e: _outer, ...rest } = json;
  return { ...rest, error: { ...error, message } };
}

/** A sealed JSON answer (`{"e2e": {"events"}}`): the result the plaintext call answers; a held body's envelope, opened. */
export function openAnswer(json: unknown, seal: CallerSeal, argv: readonly string[]): unknown {
  if (errorEnvelope(json)) return openErrorEnvelope(json, seal, argv);
  const events = isObj(json) ? eventsOf(json) : null;
  if (!events || events.length === 0) {
    throw new ProtocolError('the GaiaDesk API answered an end-to-end encrypted operation without sealed events', { kind: 'protocol', reason: 'e2e_unsealed_answer', argv, json, exitCode: 255 });
  }
  let last: DeskEvent | null = null;
  for (const f of events) last = open(seal, f, argv);
  if (last?.event === 'exit') return last.result;
  if (last?.event === 'error') throw deskError(last, seal.desk, argv);
  throw new ProtocolError('the desk\'s sealed answer has no result', { kind: 'protocol', reason: 'e2e_malformed', argv, exitCode: 255 });
}

/** The HTTP status `/v1` gives a desk's error (protocol desk_op_http.rs `desk_error_status`). */
export function deskErrorStatus(kind: string, reason?: string): { status: number; kind: string } {
  if (kind === 'usage') return { status: 400, kind };
  if (kind === 'refused') return { status: reason === 'desk_busy' ? 429 : reason === 'e2e_required' ? 409 : 403, kind };
  if (kind === 'unreachable') return { status: 409, kind };
  if (kind === 'connection_lost' || kind === 'protocol') return { status: 502, kind };
  return { status: 422, kind: 'failed' };
}

/** A desk's opened `error` event as the error the plaintext call throws. */
function deskError(e: Extract<DeskEvent, { event: 'error' }>, desk: string, argv: readonly string[]): GaiaDeskError {
  const { status, kind } = deskErrorStatus(e.kind, e.reason);
  const reason = e.reason ?? kind;
  const json = { error: { kind, message: e.message, reason, desk } };
  const exitCode = kind === 'refused' ? 254 : kind === 'failed' ? 1 : 255;
  return errorForKind(kind, e.message, { kind: sdkKind(kind, reason), reason, desk, status, argv, json, exitCode });
}

/** A sealed download (`application/x-ndjson`, one sealed event per line): the file's bytes. */
export function openDownload(text: string, seal: CallerSeal, argv: readonly string[]): Uint8Array {
  const parts: Uint8Array[] = [];
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    let frame: unknown;
    try {
      frame = JSON.parse(line);
    } catch {
      throw new ProtocolError('a sealed download has a line that is not JSON', { kind: 'protocol', reason: 'e2e_malformed', argv, exitCode: 255 });
    }
    const e = open(seal, frame, argv);
    if (e.event === 'stdout') {
      const b = b64decode(e.data);
      if (!b) throw new ProtocolError('a sealed download carries bytes that are not base64', { kind: 'protocol', reason: 'e2e_malformed', argv, exitCode: 255 });
      parts.push(b);
    } else if (e.event === 'error') {
      throw deskError(e, seal.desk, argv);
    } else if (e.event === 'exit') {
      const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
      let at = 0;
      for (const p of parts) {
        out.set(p, at);
        at += p.length;
      }
      return out;
    }
  }
  throw new ConnectionLostError('the download ended before the desk said it was complete', { kind: 'connection_lost', reason: 'incomplete', argv, desk: seal.desk, exitCode: 255 });
}

/** An upload's body, sealed: one input frame per line, at most 48 KiB of the file each, the last flagged. */
export async function sealUpload(seal: CallerSeal, bytes: Uint8Array): Promise<string> {
  const lines: string[] = [];
  let at = 0;
  do {
    const chunk = bytes.subarray(at, at + INPUT_CHUNK);
    at += chunk.length;
    lines.push(JSON.stringify(await seal.sealInput(at >= bytes.length, chunk)));
  } while (at < bytes.length);
  return `${lines.join('\n')}\n`;
}

// ───────────────────────────── sealed streams ─────────────────────────────

function sse(name: string, v: unknown): SseEvent {
  return { event: name, data: JSON.stringify(v) };
}

function errorObject(e: Extract<DeskEvent, { event: 'error' }>, desk: string): Record<string, unknown> {
  const o: Record<string, unknown> = { kind: e.kind, message: e.message, desk };
  if (e.reason !== undefined) o.reason = e.reason;
  return o;
}

/**
 * A sealed SSE stream as the plaintext one: each `sealed` event opened (in
 * order) and mapped as the API maps a desk's events (`exec`: stdout, stderr,
 * exit, error; `logs`: output, end, interrupted, error), split UTF-8
 * characters carried. A plaintext `error` (the server's: the desk was lost)
 * passes; any other plaintext output in a sealed stream is refused.
 */
export async function* unsealSse(events: AsyncIterable<SseEvent>, seal: CallerSeal, kind: 'exec' | 'logs', argv: readonly string[]): AsyncGenerator<SseEvent> {
  const dec = { stdout: new TextDecoder('utf-8'), stderr: new TextDecoder('utf-8') };
  const flush = (s: 'stdout' | 'stderr') => dec[s].decode();
  for await (const ev of events) {
    if (ev.event === 'error') {
      yield ev;
      continue;
    }
    if (ev.event !== 'sealed') {
      if (['stdout', 'stderr', 'exit', 'output', 'end', 'interrupted', 'message'].includes(ev.event)) {
        throw new ProtocolError(`the GaiaDesk API sent a plaintext \`${ev.event}\` event in an end-to-end encrypted stream`, { kind: 'protocol', reason: 'e2e_unsealed_answer', argv, exitCode: 255 });
      }
      continue;
    }
    let frame: unknown;
    try {
      frame = JSON.parse(ev.data);
    } catch {
      frame = null;
    }
    // Its data names it too (`"event": "sealed"`), as every /v1 SSE event's does.
    if (isObj(frame) && frame.event !== undefined && frame.event !== 'sealed') frame = null;
    const e = open(seal, frame, argv);
    if (e.event === 'stdout' || e.event === 'stderr') {
      const b = b64decode(e.data);
      if (!b) continue; // not base64: the desk's bug, dropped (as the server does)
      const stream = kind === 'logs' ? 'stdout' : e.event;
      const text = dec[stream].decode(b, { stream: true });
      if (text) yield kind === 'logs' ? sse('output', { event: 'output', data: text }) : sse(e.event, { event: e.event, data: text });
    } else if (e.event === 'exit') {
      const result = isObj(e.result) ? e.result : {};
      if (kind === 'exec') {
        for (const s of ['stdout', 'stderr'] as const) {
          const t = flush(s);
          if (t) yield sse(s, { event: s, data: t });
        }
        const { stdout: _o, stderr: _e, truncated: _t, ...rest } = result;
        yield sse('exit', { ...rest, event: 'exit' });
      } else {
        const t = flush('stdout');
        if (t) yield sse('output', { event: 'output', data: t });
        yield result.interrupted === true ? sse('interrupted', { event: 'interrupted' }) : sse('end', { event: 'end', job: result.job });
      }
    } else if (e.event === 'error') {
      const error = errorObject(e, seal.desk);
      yield kind === 'exec' ? sse('error', { event: 'error', exit: e.kind === 'refused' ? 254 : 255, error }) : sse('error', { event: 'error', error });
    }
  }
}
