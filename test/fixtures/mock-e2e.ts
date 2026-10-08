// A mock of the hosted API AND the desks behind it, for end-to-end
// encryption: each desk holds an X25519 key (listed as `e2e_pub` while it is
// online), opens sealed requests with it (fixtures/e2e-desk.ts), runs the
// operation (canned answers), and the "API" answers as the real one does
// (signal/src/api_v1/desk_ops): plaintext JSON / SSE / bytes for a plaintext
// call; `{"e2e": {"events"}}`, the error envelope with a placeholder message
// and `e2e.events`, `sealed` SSE events and NDJSON downloads for a sealed one.
// Every request is recorded raw, so a test can prove what the API saw.
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

import { b64decode, b64encode, b64url, utf8, x25519Public } from '../../dist/e2e.js';
import type { SealedFrame, SealedRequest } from '../../dist/e2e.js';
import { openRequest } from './e2e-desk.js';
import type { DeskSeal } from './e2e-desk.js';

type Json = Record<string, any>;
type DeskEvent = { event: 'stdout' | 'stderr'; data: string } | { event: 'exit'; result: unknown } | { event: 'error'; kind: string; message: string; reason?: string };

export interface MockDesk {
  /** Its X25519 secret; none: a desk from before end-to-end encryption. */
  secret?: Uint8Array;
  /** Keys it still opens with after a rotation (the API lists only `secret`'s). */
  previous?: Uint8Array[];
  online?: boolean;
  /** "Require end-to-end encryption for API commands". */
  required?: boolean;
  /** Offline until woken (POST …/wake). */
  wakeable?: boolean;
  /** Lookups that list no key before it shows (a lookup taken while it was away). */
  hideKeyLookups?: number; // (a stale view: neither its key nor that it requires one)
}

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | string[] | undefined>;
  body: string;
}

export interface MockE2e {
  url: string;
  desks: Record<string, MockDesk>;
  requests: Recorded[];
  /** Ops the desks opened sealed / ran in the clear, by name. */
  sealed: string[];
  plain: string[];
  wakes: string[];
  /** Misbehave as a hostile server: flip a bit of each sealed event, or answer a sealed call in the clear. */
  tamper: null | 'flip' | 'plaintext';
  files: Map<string, Uint8Array>;
  close(): Promise<void>;
}

const READ_MS = 2;
const tick = () => new Promise((r) => setTimeout(r, READ_MS));
let rid = 0;
const requestId = () => `req_${(++rid).toString(16).padStart(24, '0')}`;

/** What the desk does: its events for one operation (canned, deterministic). */
function run(desk: string, req: Json, input: Uint8Array, files: Map<string, Uint8Array>): DeskEvent[] {
  const out = (s: string | Uint8Array): DeskEvent => ({ event: 'stdout', data: b64encode(typeof s === 'string' ? utf8(s) : s) });
  const exit = (result: unknown): DeskEvent => ({ event: 'exit', result });
  switch (req.op) {
    case 'exec': {
      const spec = req.spec ?? {};
      const cmd = spec.command ?? (spec.argv ?? []).join(' ');
      if (cmd === 'refuse') return [{ event: 'error', kind: 'refused', reason: 'token_refused', message: 'this token (bot) has no exec scope on desk ' + desk }];
      let text = `ran: ${cmd} é\n`;
      for (const [k, v] of Object.entries(spec.env ?? {})) text += `env: ${k}=${v}\n`;
      if (typeof spec.stdin === 'string') text += `stdin: ${spec.stdin}\n`;
      const result = { desk, exit: 0, remote_code: 0, duration_ms: 7, notes: [], stdout: text, stderr: 'warn\n', timed_out: false, truncated: false, error: null, mode: 'pipes', route: 'the GaiaDesk server', shell: spec.shell ?? null };
      if (!req.stream) return [exit(result)];
      // The output in pieces, a character split across two of them.
      const b = utf8(text);
      const cut = text.indexOf('é') + 1 + (b.length - text.length) - 1;
      const events: DeskEvent[] = [out(b.subarray(0, cut)), { event: 'stderr', data: b64encode(utf8('warn\n')) }, out(b.subarray(cut))];
      if (cmd === 'lose') return events; // the desk goes away (the server says so in the clear)
      return [...events, exit(result)];
    }
    case 'job_start':
      return [exit({ name: req.spec.name, state: 'running', pid: 42, command: req.spec.command, desk })];
    case 'job_list':
      return [exit({ jobs: [{ name: 'build', state: 'running', pid: 42 }] })];
    case 'job_kill':
      return [exit({ name: req.name, state: 'killed', desk })];
    case 'job_wait':
      if (req.name === 'held-gone') return [{ event: 'error', kind: 'failed', message: `no job named "${req.name}"` }];
      return [exit({ job: { name: req.name, state: 'exited', exit_code: 3 }, timed_out: false })];
    case 'job_logs':
      if (req.name === 'missing') return [{ event: 'error', kind: 'failed', message: 'no job named "missing"' }];
      if (!req.follow) return [exit({ name: req.name, output: `tail ${req.tail ?? 'all'}\n` })];
      return [out('line1\n'), out(utf8('line2 é').subarray(0, 7)), out(utf8('line2 é\n').subarray(7)), exit({ job: { name: req.name, state: 'exited', exit_code: 0 } })];
    case 'stats':
      return [exit({ desk, cpu_percent: 5, mem_used_mb: 1024 })];
    case 'file_put':
      files.set(req.path, input);
      return [exit({ direction: 'upload', desk, destination: req.path, files: 1, dirs: 0, bytes: input.length, resumed_bytes: 0, failed: [], seconds: 0 })];
    case 'file_get': {
      if (req.path === 'missing') return [{ event: 'error', kind: 'failed', reason: 'not_found', message: 'no such file: missing' }];
      const data = files.get(req.path) ?? utf8(`contents of ${req.path}\n`);
      const ev: DeskEvent[] = [];
      for (let i = 0; i < data.length; i += 48 * 1024) ev.push(out(data.subarray(i, i + 48 * 1024)));
      return [...ev, exit({ direction: 'download', desk, destination: req.path, files: 1, dirs: 0, bytes: data.length, resumed_bytes: 0, failed: [], seconds: 0 })];
    }
    case 'token_mint':
      return [exit({ tokens: [{ desk, id: 'tok1', name: req.spec.name, secret: 'gdagt_minted_secret' }] })];
    case 'token_list':
      return [exit({ tokens: [{ desk, id: 'tok1', name: 'bot' }] })];
    case 'token_revoke':
      return [exit({ desk, id: req.token, revoked: true })];
  }
  return [{ event: 'error', kind: 'protocol', reason: 'unknown_op', message: 'unknown operation' }];
}

/** The status `/v1` answers a desk's error with (protocol desk_op_http.rs). */
function statusOf(kind: string, reason?: string): number {
  if (kind === 'usage') return 400;
  if (kind === 'refused') return reason === 'desk_busy' ? 429 : reason === 'e2e_required' ? 409 : 403;
  if (kind === 'unreachable') return 409;
  if (kind === 'connection_lost' || kind === 'protocol') return 502;
  return 422;
}

/** The plaintext SSE events of a desk's events (as the server's ExecEvents / LogEvents). */
class PlainMap {
  private dec = { stdout: new TextDecoder(), stderr: new TextDecoder() };
  constructor(private readonly kind: 'exec' | 'logs', private readonly desk: string) {}
  map(e: DeskEvent): Array<[string, Json]> {
    if (e.event === 'stdout' || e.event === 'stderr') {
      const s = this.kind === 'logs' ? 'stdout' : e.event;
      const t = this.dec[s].decode(b64decode(e.data) as Uint8Array, { stream: true });
      if (!t) return [];
      return this.kind === 'logs' ? [['output', { event: 'output', data: t }]] : [[e.event, { event: e.event, data: t }]];
    }
    if (e.event === 'exit') {
      const r = e.result as Json;
      if (this.kind === 'logs') {
        const t = this.dec.stdout.decode();
        return [...(t ? [['output', { event: 'output', data: t }] as [string, Json]] : []), r.interrupted ? ['interrupted', { event: 'interrupted' }] : ['end', { event: 'end', job: r.job }]];
      }
      const v: Array<[string, Json]> = [];
      for (const s of ['stdout', 'stderr'] as const) {
        const t = this.dec[s].decode();
        if (t) v.push([s, { event: s, data: t }]);
      }
      const { stdout: _o, stderr: _e, truncated: _t, ...rest } = r;
      return [...v, ['exit', { ...rest, event: 'exit' }]];
    }
    if (e.event !== "error") return [];
    const error: Json = { kind: e.kind, message: e.message, desk: this.desk };
    if (e.reason) error.reason = e.reason;
    return [['error', this.kind === 'exec' ? { event: 'error', exit: e.kind === 'refused' ? 254 : 255, error } : { event: 'error', error }]];
  }
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

function send(res: ServerResponse, status: number, v: unknown, headers: Record<string, string> = {}): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': requestId(), ...headers });
  res.end(JSON.stringify(v));
}

function envelope(kind: string, message: string, reason: string | undefined, desk?: string): Json {
  const error: Json = { kind, message, reason: reason ?? kind, request_id: requestId() };
  if (desk) error.desk = desk;
  return { error };
}

/** The route's operation and its plaintext request. */
function routeOp(method: string, rest: string, q: Record<string, string>, body: Buffer): { op: string; req: Json; stream?: 'exec' | 'logs' } | null {
  const json = (): Json => (body.length ? JSON.parse(body.toString('utf8')) : {});
  if (rest === '/exec' && method === 'POST') return { op: 'exec', req: { op: 'exec', spec: json(), ...(q.stream === '1' ? { stream: true } : {}) }, stream: q.stream === '1' ? 'exec' : undefined };
  if (rest === '/jobs' && method === 'POST') return { op: 'job_start', req: { op: 'job_start', spec: json() } };
  if (rest === '/jobs' && method === 'GET') return { op: 'job_list', req: { op: 'job_list' } };
  if (rest === '/stats' && method === 'GET') return { op: 'stats', req: { op: 'stats' } };
  if (rest === '/files' && method === 'PUT') return { op: 'file_put', req: { op: 'file_put', path: q.path, size: body.length } };
  if (rest === '/files' && method === 'GET') return { op: 'file_get', req: { op: 'file_get', path: q.path } };
  if (rest === '/tokens' && method === 'POST') return { op: 'token_mint', req: { op: 'token_mint', spec: json() } };
  if (rest === '/tokens' && method === 'GET') return { op: 'token_list', req: { op: 'token_list' } };
  let m = /^\/tokens\/([^/]+)$/.exec(rest);
  if (m && method === 'DELETE') return { op: 'token_revoke', req: { op: 'token_revoke', token: decodeURIComponent(m[1]) } };
  m = /^\/jobs\/([^/]+)(\/logs|\/wait)?$/.exec(rest);
  if (!m) return null;
  const name = decodeURIComponent(m[1]);
  if (!m[2] && method === 'DELETE') return { op: 'job_kill', req: { op: 'job_kill', name } };
  if (m[2] === '/wait') return { op: 'job_wait', req: { op: 'job_wait', name, timeout_ms: q.timeout === undefined ? undefined : Number(q.timeout) * 1000 } };
  if (m[2] === '/logs') {
    const req: Json = { op: 'job_logs', name };
    if (q.tail !== undefined) req.tail = Number(q.tail);
    if (q.follow === '1') req.follow = true;
    return { op: 'job_logs', req, stream: q.follow === '1' ? 'logs' : undefined };
  }
  return null;
}

export async function startMockE2e(desks: Record<string, MockDesk>): Promise<MockE2e> {
  const m: MockE2e = { url: '', desks, requests: [], sealed: [], plain: [], wakes: [], tamper: null, files: new Map(), close: async () => {} };

  async function handle(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const u = new URL(req.url ?? '/', 'http://127.0.0.1');
    const body = await readBody(req);
    const rec: Recorded = { method: req.method ?? 'GET', path: u.pathname, query: Object.fromEntries(u.searchParams), headers: { ...req.headers }, body: body.toString('utf8') };
    m.requests.push(rec);
    const route = /^\/v1\/desks\/([^/]+)(\/.*)?$/.exec(rec.path);
    if (!route) return send(res, 400, envelope('usage', `no route ${rec.method} ${rec.path}`, 'no_route'));
    const id = decodeURIComponent(route[1]);
    const rest = route[2] ?? '';
    const d = desks[id];
    if (!d) return send(res, 404, envelope('unreachable', 'no such desk', 'unknown_desk', id));
    const online = d.online !== false;
    if (rest === '' && rec.method === 'GET') {
      const stale = !!d.hideKeyLookups && d.hideKeyLookups-- > 0;
      const listKey = online && d.secret && !stale;
      const o: Json = { desk_id: id, online, sources: ['account'], features: d.secret ? ['desk_op', 'desk_op_e2e'] : ['desk_op'], e2e_required: !!d.required && !stale };
      if (listKey) o.e2e_pub = b64url(await x25519Public(d.secret as Uint8Array));
      return send(res, 200, o);
    }
    if (rest === '/wake' && rec.method === 'POST') {
      m.wakes.push(id);
      if (d.wakeable) d.online = true;
      return send(res, 200, { rang: d.wakeable ? ['doorbell'] : [], woke: !!d.wakeable, online: d.online !== false });
    }
    // A sealed request: the POST body's `e2e`, or the header.
    let sealedReq: SealedRequest | null = null;
    let plainBody = body;
    if (rec.method === 'POST' && body.length) {
      const j = JSON.parse(body.toString('utf8'));
      if (j && typeof j === 'object' && j.e2e) sealedReq = j.e2e;
    }
    const h = req.headers['gaiadesk-e2e'];
    if (typeof h === 'string') sealedReq = JSON.parse(new TextDecoder().decode(b64decode(h) as Uint8Array));
    const r = routeOp(rec.method, rest, rec.query, sealedReq ? Buffer.alloc(0) : plainBody);
    if (!r) return send(res, 400, envelope('usage', 'no route', 'no_route'));
    if (!online && !sealedReq) d.online = true; // the API wakes it for the operation
    let op = r.req;
    let seal: DeskSeal | null = null;
    let input = new Uint8Array(body);
    if (sealedReq) {
      if (!d.secret) return send(res, 409, envelope('protocol', 'the desk cannot open end-to-end encrypted operations', 'e2e_unsupported', id));
      let opened: { plain: Uint8Array; seal: DeskSeal } | null = null;
      for (const k of [d.secret, ...(d.previous ?? [])]) {
        opened = await openRequest(k, id, r.op, sealedReq).catch(() => null);
        if (opened) break;
      }
      if (!opened) return send(res, 403, envelope('refused', 'the end-to-end encrypted request did not open: it was altered, or sealed to another key (fetch the desk\'s e2e_pub again)', 'e2e_decrypt_failed', id));
      const inner = JSON.parse(new TextDecoder().decode(opened.plain));
      if (inner.v !== 1 || Math.abs(inner.ts - Date.now() / 1000) > 600) return send(res, 403, envelope('refused', 'stale', 'e2e_stale', id));
      if (inner.request.op !== r.op) return send(res, 403, envelope('refused', 'op mismatch', 'e2e_op_mismatch', id));
      op = inner.request;
      seal = opened.seal;
      if (r.op === 'file_put') {
        const parts: Uint8Array[] = [];
        let last = false;
        for (const line of rec.body.split('\n').filter((l) => l.trim())) {
          const f = seal.openInput(JSON.parse(line) as SealedFrame);
          parts.push(f.data);
          last = f.last;
        }
        if (!last) return send(res, 400, envelope('usage', 'the upload ended early', 'body_interrupted', id));
        input = new Uint8Array(Buffer.concat(parts));
      }
      m.sealed.push(r.op);
    } else {
      if (d.required) return send(res, 409, envelope('refused', 'This desk requires end-to-end encryption for API commands.', 'e2e_required', id));
      m.plain.push(r.op);
    }
    const events = run(id, op, input, m.files);
    const s = seal;
    const sealOne = async (e: DeskEvent): Promise<SealedFrame> => {
      const f = await (s as DeskSeal).sealEvent(e);
      if (m.tamper === 'flip') {
        const c = b64decode(f.ciphertext) as Uint8Array;
        c[0] ^= 1;
        f.ciphertext = b64url(c);
      }
      return f;
    };
    const final = events[events.length - 1];
    const failed = final?.event === 'error' ? final : null;
    const errorAnswer = async (status: number, extra: Json = {}): Promise<Json> => {
      const e = failed as Extract<DeskEvent, { event: 'error' }>;
      const env = envelope(e.kind === 'refused' || e.kind === 'usage' || e.kind === 'protocol' || e.kind === 'unreachable' || e.kind === 'connection_lost' ? e.kind : 'failed', s ? 'The desk reported an error (end-to-end encrypted).' : e.message, e.reason, id);
      Object.assign(env.error, extra);
      if (s) env.e2e = { v: 1, events: await Promise.all(events.map(sealOne)) };
      void status;
      return env;
    };

    // Streams.
    if (r.stream) {
      if (events[0]?.event === 'error') return send(res, statusOf(events[0].kind, events[0].reason), await errorAnswer(0));
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': requestId() });
      const map = new PlainMap(r.stream, id);
      for (const e of events) {
        res.write(': keep-alive\n\n');
        if (s && m.tamper !== 'plaintext') {
          res.write(`event: sealed\ndata: ${JSON.stringify({ event: 'sealed', ...(await sealOne(e)) })}\n\n`);
        } else {
          for (const [name, v] of map.map(e)) res.write(`event: ${name}\ndata: ${JSON.stringify(v)}\n\n`);
        }
        await tick();
      }
      if (final?.event !== 'exit' && final?.event !== 'error') {
        const lost = { event: 'error', ...(r.stream === 'exec' ? { exit: 255 } : {}), error: { kind: 'connection_lost', message: 'The desk went away during this operation.', desk: id, reason: 'desk_disconnected' } };
        res.write(`event: error\ndata: ${JSON.stringify(lost)}\n\n`);
      }
      return void res.end();
    }

    // A download.
    if (r.op === 'file_get') {
      if (events[0]?.event === 'error') return send(res, statusOf(events[0].kind, events[0].reason), await errorAnswer(0));
      if (!s) {
        res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Request-Id': requestId() });
        for (const e of events) if (e.event === 'stdout') res.write(b64decode(e.data) as Uint8Array);
        return void res.end();
      }
      res.writeHead(200, { 'Content-Type': 'application/x-ndjson', 'X-Request-Id': requestId() });
      const keep = op.path === 'truncated' ? events.slice(0, -1) : events;
      for (const e of keep) res.write(`${JSON.stringify(await sealOne(e))}\n`);
      return void res.end();
    }

    const okStatus = r.op === 'job_start' || r.op === 'token_mint' ? 201 : 200;
    const held = r.op === 'job_wait' && (op.name === 'held' || op.name === 'held-gone');
    if (held) {
      res.writeHead(200, { 'Content-Type': 'application/json', 'X-Request-Id': requestId(), 'GaiaDesk-Held': '1' });
      for (let i = 0; i < 3; i++) {
        res.write(' ');
        await tick();
      }
      if (failed) return void res.end(JSON.stringify(await errorAnswer(0, { status: statusOf(failed.kind, failed.reason) })));
      const body2 = s ? { e2e: { v: 1, events: await Promise.all(events.map(sealOne)) } } : (final as { result: unknown }).result;
      return void res.end(JSON.stringify(body2));
    }
    if (failed) return send(res, statusOf(failed.kind, failed.reason), await errorAnswer(0));
    if (s && m.tamper !== 'plaintext') return send(res, okStatus, { e2e: { v: 1, events: await Promise.all(events.map(sealOne)) } });
    return send(res, okStatus, (final as { result: unknown }).result);
  }

  const server = createServer((req, res) => {
    handle(req, res).catch((e) => {
      res.writeHead(500);
      res.end(String(e?.stack ?? e));
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  m.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`;
  m.close = () => new Promise((r) => {
    server.closeAllConnections?.();
    server.close(() => r());
  });
  return m;
}
