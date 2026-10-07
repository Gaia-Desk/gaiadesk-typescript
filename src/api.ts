// The `api` transport: GaiaDesk's hosted HTTPS API (https://api.gaiadesk.net/v1),
// with nothing but the global `fetch` (Node 18+, browsers). Used when the
// client is given an `apiKey`. The answers are the CLI's own JSON shapes
// (the API's contract references the same schema), and failures the same
// error envelope, so every method returns and throws what it does on the CLI
// transport. Operations the API does not serve are a UsageError.
//
// No static import of a Node module here: local files (upload/download) are
// read and written through a dynamic `import('node:fs/promises')`.

import * as A from './args.js';
import { CommandError, GaiaDeskError, OperationFailedError, ProtocolError, UnreachableError, UsageError, errorEnvelope, envelopeDetails, errorForKind, sdkKind } from './errors.js';
import { ApiStream, deskOpExit } from './api-stream.js';
import type { ByteStreamLike } from './api-stream.js';
import { memMb } from './native-args.js';
import type { OutputStream } from './proc.js';
import { listOf, neverRan, normalizeExecResult, textOf } from './results.js';
import type { AbortSignalLike, CpSummary, DeskStats, DevicesResult, ExecResult, JobInfo, JobLogs, JobWaitResult, MintResult, TokenInfo, TokenRevokeResult } from './types.js';

export const DEFAULT_API_URL = 'https://api.gaiadesk.net/v1';
/** The most one file may be through the API (larger files go direct, through the CLI or native transport). */
export const API_FILE_LIMIT = 256 * 1024 * 1024;
/** The longest one `GET …/jobs/{name}/wait` holds, in seconds (the API's `timeout` maximum). */
export const API_WAIT_MAX = 870;

/** What the API transport needs from `fetch` (the global one by default). */
export type FetchLike = (url: string, init: {
  method: string;
  headers: Record<string, string>;
  body?: string | Uint8Array;
  signal?: AbortSignal;
}) => Promise<ResponseLike>;

export interface ResponseLike {
  readonly ok: boolean;
  readonly status: number;
  readonly headers: { get(name: string): string | null };
  readonly body: ByteStreamLike | null;
  text(): Promise<string>;
  arrayBuffer(): Promise<ArrayBuffer>;
}

export interface ApiOptions {
  apiKey: string;
  deskToken?: string;
  baseUrl?: string;
  fetch?: FetchLike;
}

/** Per call: the abort signal, a desk token for this call only, and how long to wait for a sleeping desk. */
export interface ApiCallOptions {
  signal?: AbortSignalLike;
  /** API transport: the scoped agent token (`gdagt_…`) for this call, instead of the client's `deskToken`. */
  deskToken?: string;
  /** API transport: if the desk is asleep, ring it and wait up to this many seconds (0-120; `wake_s`). */
  wake?: number;
}

interface Req extends ApiCallOptions {
  query?: Record<string, string | number | undefined>;
  json?: unknown;
  bytes?: Uint8Array;
  accept?: string;
}

/** The UsageError for an operation the API does not serve. */
export function notOverApi(what: string, hint = 'use the CLI or native transport (construct GaiaDesk without apiKey)'): UsageError {
  return new UsageError(`${what} is not available over the API transport; ${hint}`, { kind: 'usage', argv: [what] });
}

const UNITS: Record<string, number> = { s: 1, sec: 1, secs: 1, m: 60, min: 60, mins: 60, h: 3600, d: 86400, w: 604800 };

/** A duration as seconds: a number is seconds, a string `90`, `30s`, `10m`, `1h30m`, `7d`, `2w`. */
export function seconds(v: number | string, what: string): number {
  const d = A.duration(v, what);
  if (/^\d+$/.test(d)) return Number(d);
  let total = 0;
  for (const m of d.matchAll(/(\d+)\s*([a-z]+)/gi)) {
    const unit = UNITS[m[2].toLowerCase()];
    if (unit === undefined) throw new UsageError(`${what}: unknown unit in ${JSON.stringify(v)}`, { kind: 'usage' });
    total += Number(m[1]) * unit;
  }
  return total;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function basename(p: string): string {
  const parts = p.split(/[\\/]+/).filter(Boolean);
  return parts[parts.length - 1] ?? '';
}

/** The text of stdin for an ExecSpec (the API takes text). */
function stdinText(stdin: string | Uint8Array | undefined): string | undefined {
  if (stdin === undefined || typeof stdin === 'string') return stdin;
  return new TextDecoder('utf-8').decode(stdin);
}

export class ApiTransport {
  readonly baseUrl: string;
  private readonly key: string;
  private readonly deskToken?: string;
  private readonly fetcher: FetchLike;

  constructor(o: ApiOptions) {
    if (typeof o.apiKey !== 'string' || !o.apiKey.trim()) throw new UsageError('apiKey must be a non-empty string', { kind: 'usage' });
    if (o.deskToken !== undefined && (typeof o.deskToken !== 'string' || !o.deskToken.trim())) {
      throw new UsageError('deskToken must be a non-empty string (a scoped agent token, gdagt_…)', { kind: 'usage' });
    }
    this.key = o.apiKey.trim();
    this.deskToken = o.deskToken?.trim();
    this.baseUrl = (o.baseUrl ?? DEFAULT_API_URL).replace(/\/+$/, '');
    if (!/^https?:\/\//i.test(this.baseUrl)) throw new UsageError(`baseUrl must be an http(s) URL: ${JSON.stringify(o.baseUrl)}`, { kind: 'usage' });
    const f = o.fetch ?? (globalThis as { fetch?: FetchLike }).fetch;
    if (typeof f !== 'function') throw new UsageError('the API transport needs a global fetch (Node 18+ or a browser), or the `fetch` option', { kind: 'usage' });
    this.fetcher = f;
  }

  // ───────────────────────────── HTTP ─────────────────────────────

  private url(path: string, query: Record<string, string | number | undefined> = {}): string {
    const q = Object.entries(query)
      .filter(([, v]) => v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(String(v))}`)
      .join('&');
    return `${this.baseUrl}${path}${q ? `?${q}` : ''}`;
  }

  /** Every request's headers: the API key, and the desk token when there is one. */
  headers(deskToken?: string): Record<string, string> {
    const h: Record<string, string> = { Authorization: `Bearer ${this.key}` };
    const t = deskToken ?? this.deskToken;
    if (t) h['X-GaiaDesk-Desk-Token'] = t;
    return h;
  }

  /** One request; an HTTP failure is the typed error from its envelope. */
  async request(method: string, path: string, r: Req = {}, signal?: AbortSignal): Promise<ResponseLike> {
    const op = `${method} ${path}`;
    const query = { ...r.query };
    if (r.wake !== undefined) {
      if (!Number.isInteger(r.wake) || r.wake < 0 || r.wake > 120) throw new UsageError('wake is whole seconds, 0 to 120', { kind: 'usage', argv: [op] });
      query.wake_s = r.wake;
    }
    const headers = this.headers(r.deskToken);
    headers.Accept = r.accept ?? 'application/json';
    let body: string | Uint8Array | undefined;
    if (r.json !== undefined) {
      headers['Content-Type'] = 'application/json';
      body = JSON.stringify(r.json);
    } else if (r.bytes !== undefined) {
      headers['Content-Type'] = 'application/octet-stream';
      body = r.bytes;
    }
    const ctrl = new AbortController();
    const outer = r.signal;
    const onAbort = () => ctrl.abort();
    if (outer?.aborted) ctrl.abort();
    else outer?.addEventListener('abort', onAbort, { once: true });
    const inner = signal;
    if (inner?.aborted) ctrl.abort();
    else inner?.addEventListener('abort', onAbort, { once: true });
    let res: ResponseLike;
    try {
      res = await this.fetcher(this.url(path, query), { method, headers, body, signal: ctrl.signal });
    } catch (e) {
      if (ctrl.signal.aborted) throw new GaiaDeskError(`${op}: interrupted`, { kind: 'interrupted', exitCode: 130, argv: [op] });
      throw new UnreachableError(`the GaiaDesk API could not be reached (${this.baseUrl}): ${(e as Error)?.message ?? e}`, {
        kind: 'network',
        reason: 'network',
        exitCode: 255,
        argv: [op],
      });
    } finally {
      outer?.removeEventListener('abort', onAbort);
    }
    if (!res.ok) throw await apiError(res, op);
    return res;
  }

  /** A request answered with JSON. */
  async json<T>(method: string, path: string, r: Req = {}): Promise<T> {
    const op = `${method} ${path}`;
    const res = await this.request(method, path, r);
    const text = await res.text();
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ProtocolError(`the GaiaDesk API answered ${op} with something that is not JSON`, { kind: 'protocol', argv: [op], status: res.status, requestId: res.headers.get('x-request-id') });
    }
  }

  private desk(deskId: string): string {
    return `/desks/${encodeURIComponent(A.checkDesk(deskId))}`;
  }

  // ───────────────────────────── operations ─────────────────────────────

  /** `GET /desks`: `{devices, sources, notes}`, the CLI's `devices --json` shape (filtered to `deskId` when given). */
  async devices(o: { probe?: boolean; deskId?: string } & ApiCallOptions): Promise<DevicesResult> {
    A.devicesArgs(o);
    if (o.probe) throw notOverApi('devices({ probe: true })', 'the API lists desks without dialling them; probe through the CLI or native transport');
    const r = await this.json<DevicesResult>('GET', '/desks', o);
    if (!isObj(r) || !Array.isArray(r.devices)) throw new ProtocolError('the GaiaDesk API listed no devices', { kind: 'protocol', argv: ['GET /desks'], json: r });
    if (o.deskId === undefined) return r;
    const id = A.checkDesk(o.deskId);
    return { ...r, devices: r.devices.filter((d) => d.desk_id === id) };
  }

  private execSpec(deskId: string, command: string | readonly string[], o: A.RunShapeOptions & { cwd?: string; stdin?: string | Uint8Array; env?: Readonly<Record<string, string>> }) {
    A.execArgs(deskId, command, { ...o, stdin: o.stdin !== undefined }, true); // the same UsageErrors as the CLI transport
    const spec: Record<string, unknown> = typeof command === 'string' ? { command } : { argv: [...command] };
    if (o.shell !== undefined) spec.shell = A.wireShell(o.shell);
    if (o.env !== undefined) spec.env = A.checkEnv(o.env);
    if (o.cwd !== undefined) spec.cwd = A.checkCwd(o.cwd);
    if (o.timeout !== undefined) spec.timeout_secs = seconds(o.timeout, 'timeout');
    const stdin = stdinText(o.stdin);
    if (stdin !== undefined) spec.stdin = stdin;
    return spec;
  }

  /** `POST /desks/{id}/exec`: ExecResult; the command never running is its typed error; `check` as on the CLI. */
  async exec(deskId: string, command: string | readonly string[], o: A.RunShapeOptions & ApiCallOptions & { cwd?: string; stdin?: string | Uint8Array; check?: boolean; env?: Readonly<Record<string, string>> }): Promise<ExecResult> {
    const spec = this.execSpec(deskId, command, o);
    const path = `${this.desk(deskId)}/exec`;
    const json = await this.json<Record<string, unknown>>('POST', path, { ...o, json: spec });
    if (!isObj(json) || typeof json.exit !== 'number') throw new ProtocolError('the GaiaDesk API answered exec without a result', { kind: 'protocol', argv: [`POST ${path}`], json });
    const r = normalizeExecResult(json);
    const argv = [`POST ${path}`];
    if (neverRan(r) && r.error) {
      const e = r.error;
      throw errorForKind(e.kind, e.message || 'the command did not run', { kind: sdkKind(e.kind, e.reason), exitCode: r.exit, argv, json, reason: e.reason ?? null, desk: e.desk ?? r.desk });
    }
    if (o.check && r.exit !== 0) {
      const why = r.timed_out ? 'timed out' : `exited ${r.exit}`;
      throw new CommandError(`command on desk ${r.desk} ${why}`, r, { exitCode: r.exit, argv, json, desk: r.desk, kind: 'failed' });
    }
    return r;
  }

  /** `POST /desks/{id}/exec?stream=1`: the ExecEvents as an OutputStream. */
  execStream(deskId: string, command: string | readonly string[], o: A.RunShapeOptions & ApiCallOptions & { cwd?: string; stdin?: string | Uint8Array | true; env?: Readonly<Record<string, string>> }): OutputStream {
    if (o.stdin === true) throw notOverApi('execStream with stdin: true (writing stdin as it runs)', 'give `stdin` as text, or use the CLI or native transport');
    const spec = this.execSpec(deskId, command, { ...o, stdin: o.stdin as string | Uint8Array | undefined });
    const path = `${this.desk(deskId)}/exec`;
    const { signal, ...rest } = o;
    return new ApiStream(`POST ${path}`, 'exec', (s) => this.request('POST', path, { ...rest, json: spec, query: { stream: 1 }, accept: 'text/event-stream' }, s), signal);
  }

  /** `PUT /desks/{id}/files?path=`: one local file, at most 256 MB. A `remote` ending in `/` is a folder: the file keeps its name. */
  async upload(local: string, deskId: string, remote: string, o: { recursive?: boolean } & ApiCallOptions): Promise<CpSummary> {
    A.cpArgs('upload', deskId, local, remote, !!o.recursive);
    if (o.recursive) throw notOverApi('a recursive (folder) upload', 'the API copies single files; copy folders through the CLI or native transport');
    const fs = await import('node:fs/promises');
    const st = await fs.stat(local).catch((e: Error) => {
      throw new GaiaDeskError(`cannot read ${local}: ${e.message}`, { kind: 'local', argv: ['upload'] });
    });
    if (st.isDirectory()) throw notOverApi(`uploading the folder ${local}`, 'the API copies single files; copy folders through the CLI or native transport');
    if (st.size > API_FILE_LIMIT) throw new UsageError(`${local} is ${st.size} bytes; the API takes files up to 256 MB (copy larger ones through the CLI or native transport)`, { kind: 'usage', argv: ['upload'] });
    const bytes = new Uint8Array(await fs.readFile(local));
    const target = remote === '' || /[\\/]$/.test(remote) ? `${remote}${basename(local)}` : remote;
    return this.uploadBytes(bytes, deskId, target, o);
  }

  /** `PUT /desks/{id}/files?path=` with bytes in memory. */
  async uploadBytes(data: Uint8Array | string, deskId: string, remote: string, o: ApiCallOptions = {}): Promise<CpSummary> {
    if (typeof remote !== 'string' || !remote) throw new UsageError('a remote path is required', { kind: 'usage' });
    const bytes = typeof data === 'string' ? new TextEncoder().encode(data) : data;
    if (bytes.length > API_FILE_LIMIT) throw new UsageError('the API takes files up to 256 MB', { kind: 'usage', argv: ['upload'] });
    const path = `${this.desk(deskId)}/files`;
    const r = await this.json<CpSummary>('PUT', path, { ...o, query: { path: remote }, bytes });
    if (isObj(r) && Array.isArray(r.failed) && r.failed.length > 0) {
      throw new OperationFailedError(`${r.failed.length} file(s) failed to copy`, { exitCode: 1, argv: [`PUT ${path}`], json: r, kind: 'failed', desk: A.checkDesk(deskId) });
    }
    return r;
  }

  /** `GET /desks/{id}/files?path=`: the file's bytes. */
  async downloadBytes(deskId: string, remote: string, o: ApiCallOptions = {}): Promise<Uint8Array> {
    if (typeof remote !== 'string' || !remote) throw new UsageError('a remote path is required', { kind: 'usage' });
    const res = await this.request('GET', `${this.desk(deskId)}/files`, { ...o, query: { path: remote }, accept: 'application/octet-stream' });
    return new Uint8Array(await res.arrayBuffer());
  }

  /** `GET /desks/{id}/files?path=` into a local file (a `local` folder, or one ending in `/`, keeps the remote name). */
  async download(deskId: string, remote: string, local: string, o: { recursive?: boolean } & ApiCallOptions): Promise<CpSummary> {
    A.cpArgs('download', deskId, local, remote, !!o.recursive);
    if (o.recursive) throw notOverApi('a recursive (folder) download', 'the API copies single files; copy folders through the CLI or native transport');
    const started = Date.now();
    const bytes = await this.downloadBytes(deskId, remote, o);
    const fs = await import('node:fs/promises');
    const isDir = /[\\/]$/.test(local) || (await fs.stat(local).then((s) => s.isDirectory(), () => false));
    const dest = isDir ? `${local.replace(/[\\/]+$/, '')}/${basename(remote)}` : local;
    try {
      await fs.writeFile(dest, bytes);
    } catch (e) {
      throw new GaiaDeskError(`cannot write ${dest}: ${(e as Error).message}`, { kind: 'local', argv: ['download'] });
    }
    return { direction: 'download', desk: A.checkDesk(deskId), destination: dest, files: 1, dirs: 0, bytes: bytes.length, resumed_bytes: 0, failed: [], seconds: (Date.now() - started) / 1000 };
  }

  /** `POST /desks/{id}/jobs` with a JobSpec: 201 Job. */
  async runJob(deskId: string, name: string, command: string | readonly string[], o: A.JobOptions & ApiCallOptions): Promise<JobInfo> {
    A.runArgs(deskId, name, command, o);
    const limits: Record<string, unknown> = {};
    if (o.priority !== undefined) limits.priority = o.priority;
    if (o.cpu !== undefined) limits.cpu_percent = o.cpu;
    if (o.mem !== undefined) limits.mem_mb = memMb(o.mem);
    if (o.keepAwake !== undefined) limits.keep_awake = o.keepAwake;
    const spec: Record<string, unknown> = { name, command: typeof command === 'string' ? [command] : [...command], limits };
    if (o.cwd !== undefined) spec.cwd = o.cwd;
    if (o.shell !== undefined) spec.shell = A.wireShell(o.shell);
    if (o.env !== undefined) spec.env = A.checkEnv(o.env);
    return this.json<JobInfo>('POST', `${this.desk(deskId)}/jobs`, { ...o, json: spec });
  }

  /**
   * `GET /desks/{id}/jobs/{name}/wait`: `{job, timed_out}` once the job is no
   * longer running, as `gaiadesk-cli wait --json`. The API holds one wait at
   * most {@link API_WAIT_MAX} seconds, so a longer (or no) `timeout` waits
   * again until the job ends or the time is up. A held answer's body may
   * start with keep-alive spaces, and may be the error envelope.
   */
  async waitJob(deskId: string, name: string, o: { timeout?: number | string } & ApiCallOptions): Promise<JobWaitResult> {
    A.waitArgs(deskId, name, o); // the same UsageErrors as the CLI transport
    const path = `${this.desk(deskId)}/jobs/${encodeURIComponent(name)}/wait`;
    const total = o.timeout === undefined ? undefined : seconds(o.timeout, 'timeout');
    const started = Date.now();
    for (;;) {
      const left = total === undefined ? API_WAIT_MAX : Math.max(0, total - (Date.now() - started) / 1000);
      const json = await this.json<unknown>('GET', path, { ...o, query: { timeout: Math.min(API_WAIT_MAX, Math.ceil(left)) } });
      const env = errorEnvelope(json);
      // A held wait that failed after its 200 began: the envelope, in the body.
      if (env) throw errorForKind(env.kind, env.message || 'the wait failed', envelopeDetails(env, { argv: [`GET ${path}`], json }));
      if (!isObj(json) || !isObj(json.job) || typeof json.timed_out !== 'boolean') {
        throw new ProtocolError('the GaiaDesk API answered a wait without a job', { kind: 'protocol', argv: [`GET ${path}`], json });
      }
      const r = json as unknown as JobWaitResult;
      const over = total !== undefined && (Date.now() - started) / 1000 >= total;
      if (!r.timed_out || over || total === 0) return r;
    }
  }

  /** `GET /desks/{id}/jobs`: the list of the JobList. */
  async jobs(deskId: string, o: ApiCallOptions): Promise<JobInfo[]> {
    const path = `${this.desk(deskId)}/jobs`;
    return listOf<JobInfo>(await this.json('GET', path, o), 'jobs', [`GET ${path}`]);
  }

  /** `DELETE /desks/{id}/jobs/{name}`: the stopped Job. */
  async killJob(deskId: string, name: string, o: ApiCallOptions): Promise<JobInfo> {
    A.killArgs(deskId, name);
    return this.json<JobInfo>('DELETE', `${this.desk(deskId)}/jobs/${encodeURIComponent(name)}`, o);
  }

  /** `GET /desks/{id}/jobs/{name}/logs[?tail=]`: the output of the JobLogs. */
  async jobLogs(deskId: string, name: string, o: { tail?: number } & ApiCallOptions): Promise<string> {
    A.logsArgs(deskId, name, { tail: o.tail });
    return textOf(await this.json<JobLogs>('GET', `${this.desk(deskId)}/jobs/${encodeURIComponent(name)}/logs`, { ...o, query: { tail: o.tail } }), 'output');
  }

  /** `GET /desks/{id}/jobs/{name}/logs?follow=1`: the JobLogEvents as an OutputStream. */
  followJobLogs(deskId: string, name: string, o: { tail?: number } & ApiCallOptions): OutputStream {
    A.logsArgs(deskId, name, { tail: o.tail, follow: true });
    const path = `${this.desk(deskId)}/jobs/${encodeURIComponent(name)}/logs`;
    const { signal, ...rest } = o;
    return new ApiStream(`GET ${path}`, 'logs', (s) => this.request('GET', path, { ...rest, query: { follow: 1, tail: o.tail }, accept: 'text/event-stream' }, s), signal, name);
  }

  /** `GET /desks/{id}/stats`: the StatsReport. */
  async stats(deskId: string, o: ApiCallOptions): Promise<DeskStats> {
    return this.json<DeskStats>('GET', `${this.desk(deskId)}/stats`, o);
  }

  /**
   * `POST /desks/{id}/tokens` with a MintSpec, once per desk: a MintResult
   * with every desk's token. If a later desk fails, the error's `json`
   * carries the tokens already minted (`{error, tokens}`): their secrets are shown once.
   */
  async createToken(o: A.TokenCreateOptions & ApiCallOptions): Promise<MintResult> {
    A.tokenCreateArgs(o);
    if (o.out !== undefined) throw notOverApi('createToken({ out })', 'the API returns the secret; write it to a file yourself, or use the CLI or native transport');
    if (o.name === undefined || !o.name.trim()) throw new UsageError('createToken needs a name over the API transport', { kind: 'usage' });
    const desks = (typeof o.desks === 'string' ? [o.desks] : [...o.desks]).map(A.checkDesk);
    const spec: Record<string, unknown> = {
      name: o.name,
      expires_secs: seconds(o.expires ?? '7d', 'expires'),
      scopes: o.scopes ? [...o.scopes] : ['exec', 'cp', 'jobs'],
    };
    if (o.cwd !== undefined) spec.cwd = o.cwd;
    if (o.lowPriv) spec.low_priv = true;
    const tokens: MintResult['tokens'] = [];
    for (const d of desks) {
      try {
        const r = await this.json<MintResult>('POST', `${this.desk(d)}/tokens`, { ...o, json: spec });
        tokens.push(...listOf<MintResult['tokens'][number]>(r, 'tokens', ['token_mint']));
      } catch (e) {
        if (tokens.length > 0 && e instanceof GaiaDeskError) {
          Object.defineProperty(e, 'json', { value: { ...(isObj(e.json) ? e.json : {}), tokens } });
        }
        throw e;
      }
    }
    return { tokens };
  }

  /** `GET /desks/{id}/tokens`: the list of the TokenList. */
  async listTokens(deskId: string, o: ApiCallOptions): Promise<TokenInfo[]> {
    const path = `${this.desk(deskId)}/tokens`;
    return listOf<TokenInfo>(await this.json('GET', path, o), 'tokens', [`GET ${path}`]);
  }

  /** `DELETE /desks/{id}/tokens/{token_id}`: Revoked. */
  async revokeToken(deskId: string, which: string | { all: true }, o: { account?: boolean } & ApiCallOptions): Promise<TokenRevokeResult> {
    A.tokenRevokeArgs(deskId, which, !!o.account);
    if (typeof which !== 'string') throw notOverApi('revokeToken({ all: true })', 'revoke each token by id (listTokens), or use the CLI or native transport');
    if (o.account) throw notOverApi('revokeToken({ account: true })', 'the API revokes on the desk; drop `account`');
    return this.json<TokenRevokeResult>('DELETE', `${this.desk(deskId)}/tokens/${encodeURIComponent(which)}`, o);
  }
}

/** The typed error for a failed HTTP request: its error envelope, else a ProtocolError. */
export async function apiError(res: ResponseLike, op: string): Promise<GaiaDeskError> {
  const text = await res.text().catch(() => '');
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = undefined;
  }
  const headerId = res.headers.get('x-request-id');
  const ra = Number(res.headers.get('retry-after'));
  const retryAfter = res.headers.get('retry-after') !== null && Number.isFinite(ra) ? ra : null;
  const env = errorEnvelope(json);
  if (!env) {
    return new ProtocolError(`the GaiaDesk API answered ${op} with HTTP ${res.status} and no error envelope`, {
      kind: 'protocol',
      exitCode: 255,
      argv: [op],
      json,
      stderr: text.slice(0, 4096),
      status: res.status,
      requestId: headerId,
      retryAfter,
    });
  }
  const e = (json as { error: Record<string, unknown> }).error;
  const requestId = typeof e.request_id === 'string' ? e.request_id : headerId;
  const details = envelopeDetails(env, { exitCode: deskOpExit(env.kind), argv: [op], json, status: res.status, requestId, retryAfter });
  return errorForKind(env.kind, env.message || `HTTP ${res.status}`, details);
}
