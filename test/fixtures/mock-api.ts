// A mock of GaiaDesk's hosted API (phase 2 desk operations) for the tests,
// on node:http in this process. It answers every route by running the fake
// gaiadesk-cli (fake-cli.js) with the matching arguments, so the API
// transport sees exactly the data the CLI transport does, as the real API
// relays the desk's answers in the CLI's JSON shapes:
//
//   GET    /desks                          devices --json
//   POST   /desks/{id}/exec[?stream=1]     exec --json | --json-stream (as SSE)
//   POST   /desks/{id}/jobs                run --detach --json            201
//   GET    /desks/{id}/jobs                ps --json
//   DELETE /desks/{id}/jobs/{name}         kill --json
//   GET    /desks/{id}/jobs/{name}/logs    logs --json [--tail] [--follow → SSE]
//   GET    /desks/{id}/stats               stats --json
//   PUT    /desks/{id}/files?path=         cp --json <the body as a file> <id>:<path>
//   GET    /desks/{id}/files?path=         cp --json (for errors), then the bytes
//   POST   /desks/{id}/tokens              token create --json            201
//   GET    /desks/{id}/tokens              token list --json
//   DELETE /desks/{id}/tokens/{token_id}   token revoke --json
//
// Failures are the API's envelope with a request id, and the status by kind
// (400 usage, 401/403 refused, 409/504 unreachable, 422 failed, 502
// connection_lost/protocol). Credentials: `Authorization: Bearer <key>` is
// required; a key starting `ak_` is an API key, which needs
// X-GaiaDesk-Desk-Token for desk operations and may not administer tokens;
// anything else is a person's session (token routes run with the desk's
// password, as `code` does on the CLI). Streams are written in small pieces
// with keep-alive comments, to exercise the client's SSE parser.
//
// Desk ids only the API has: 999999990 answers HTML (no envelope),
// 999999991 is rate limited (429, Retry-After: 7).
import { spawn } from 'node:child_process';
import { createServer } from 'node:http';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { AddressInfo } from 'node:net';

const FAKE = fileURLToPath(new URL('./fake-cli.js', import.meta.url));
export const HTML_DESK = '999999990';
export const LIMITED_DESK = '999999991';

export interface Recorded {
  method: string;
  path: string;
  query: Record<string, string>;
  headers: Record<string, string | undefined>;
  body: Buffer;
}

export interface MockApi {
  /** The base URL, `http://127.0.0.1:<port>/v1`. */
  url: string;
  requests: Recorded[];
  close(): Promise<void>;
}

type Json = Record<string, any>;

interface Ran {
  code: number | null;
  stdout: string;
  stderr: string;
}

function runFake(args: string[], o: { input?: string; cwd?: string; code?: string } = {}): Promise<Ran> {
  return new Promise((resolve) => {
    const env: Record<string, string | undefined> = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    if (o.code) env.GAIADESK_CODE = o.code;
    const child = spawn(process.execPath, [FAKE, ...args], { env, cwd: o.cwd, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (c) => (stdout += c));
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(o.input ?? '');
  });
}

/** Run the fake CLI and hand each stdout line to `onLine` as it comes. */
function streamFake(args: string[], onLine: (line: string) => Promise<void>, input = ''): Promise<Ran> {
  return new Promise((resolve) => {
    const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };
    const child = spawn(process.execPath, [FAKE, ...args], { env, stdio: ['pipe', 'pipe', 'pipe'] });
    let buf = '';
    let stderr = '';
    let chain = Promise.resolve();
    child.stdout.on('data', (c) => {
      buf += c;
      let i: number;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (line.trim()) chain = chain.then(() => onLine(line));
      }
    });
    child.stderr.on('data', (c) => (stderr += c));
    child.on('close', (code) => {
      void chain.then(() => resolve({ code, stdout: '', stderr }));
    });
    child.stdin.end(input);
  });
}

let reqSeq = 0;
const requestId = () => `req_${(++reqSeq).toString(16).padStart(24, '0')}`;

function statusFor(kind: string, reason?: string): number {
  if (kind === 'usage') return 400;
  if (kind === 'refused') return reason === 'unauthenticated' ? 401 : reason === 'rate_limited' ? 429 : 403;
  if (kind === 'unreachable') return reason === 'timeout' ? 504 : 409;
  if (kind === 'failed') return 422;
  return 502;
}

function lastLine(s: string): string {
  const lines = s.split(/\r?\n/).map((l) => l.trim()).filter(Boolean);
  return (lines[lines.length - 1] ?? '').replace(/^gaiadesk-cli:\s*/, '');
}

function parse(s: string): unknown {
  const t = s.trim();
  if (!t) return undefined;
  try {
    return JSON.parse(t);
  } catch {
    try {
      return JSON.parse(t.split(/\r?\n/).pop() ?? '');
    } catch {
      return undefined;
    }
  }
}

const isObj = (v: unknown): v is Json => typeof v === 'object' && v !== null && !Array.isArray(v);

function sendError(res: ServerResponse, error: Json, extraHeaders: Record<string, string> = {}): void {
  const id = requestId();
  const body = JSON.stringify({ error: { ...error, request_id: id } });
  res.writeHead(statusFor(error.kind, error.reason), { 'Content-Type': 'application/json', 'X-Request-Id': id, ...extraHeaders });
  res.end(body);
}

function sendJson(res: ServerResponse, status: number, v: unknown): void {
  res.writeHead(status, { 'Content-Type': 'application/json', 'X-Request-Id': requestId() });
  res.end(JSON.stringify(v));
}

/** A CLI failure with no envelope (text on stderr only), as the API would report it. */
function plainError(ran: Ran): Json {
  const message = lastLine(ran.stderr) || `exit ${ran.code}`;
  if (ran.code === 254) return { kind: 'refused', message };
  if (ran.code === 1) return { kind: 'failed', message };
  if (ran.code === 0) return { kind: 'protocol', message: 'the desk answered something that is not JSON' };
  return { kind: 'unreachable', message };
}

/** A desk operation's answer: its JSON (`ok` exit codes), or the error envelope. */
function relay(res: ServerResponse, ran: Ran, ok: number[] = [0], status = 200): void {
  const json = parse(ran.stdout);
  if (isObj(json) && isObj(json.error)) return sendError(res, json.error);
  if (ran.code !== null && ok.includes(ran.code) && json !== undefined) return sendJson(res, status, json);
  sendError(res, plainError(ran));
}

const tick = () => new Promise((r) => setTimeout(r, 2));

/** Write one SSE event in pieces (split mid-line, `\r\n` across writes), with a keep-alive comment first. */
async function sse(res: ServerResponse, name: string, data: string): Promise<void> {
  const text = `: keep-alive\r\nevent: ${name}\r\ndata: ${data}\r\n\r\n`;
  const cuts = [3, Math.floor(text.length / 2), text.length - 1];
  let at = 0;
  for (const c of cuts) {
    res.write(text.slice(at, c));
    at = c;
    await tick();
  }
  res.write(text.slice(at));
}

function readBody(req: IncomingMessage): Promise<Buffer> {
  return new Promise((resolve) => {
    const chunks: Buffer[] = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => resolve(Buffer.concat(chunks)));
  });
}

async function handle(res: ServerResponse, rec: Recorded): Promise<void> {
  const auth = rec.headers.authorization ?? '';
  const key = auth.startsWith('Bearer ') ? auth.slice(7) : '';
  if (!key) return sendError(res, { kind: 'refused', reason: 'unauthenticated', message: 'Sign in, or send an API key as `Authorization: Bearer ak_…`.' });
  const isKey = key.startsWith('ak_');
  const deskToken = rec.headers['x-gaiadesk-desk-token'];
  const m = /^\/v1\/desks(?:\/([^/]+)(\/.*)?)?$/.exec(rec.path);
  if (!m) return sendError(res, { kind: 'usage', message: `no route ${rec.method} ${rec.path}` });
  if (!m[1]) {
    if (rec.method !== 'GET') return sendError(res, { kind: 'usage', message: 'method not allowed' });
    return relay(res, await runFake(['devices', '--json']), [0, 1]);
  }
  const desk = decodeURIComponent(m[1]);
  const rest = m[2] ?? '';
  if (desk === HTML_DESK) {
    res.writeHead(500, { 'Content-Type': 'text/html' });
    return void res.end('<html><body>Internal Server Error</body></html>');
  }
  if (desk === LIMITED_DESK) {
    return sendError(res, { kind: 'refused', reason: 'rate_limited', message: 'Too many requests for this key; try again in 7 s.' }, { 'Retry-After': '7' });
  }
  const tokens = rest.startsWith('/tokens');
  if (tokens && isKey) {
    return sendError(res, { kind: 'refused', reason: 'session_required', message: "token administration over the API works only for a signed-in person's own desk", desk });
  }
  if (!tokens && isKey && !deskToken) {
    return sendError(res, { kind: 'refused', reason: 'desk_token_required', message: 'from an API key, desk operations need a scoped agent token in X-GaiaDesk-Desk-Token', desk });
  }
  const q = rec.query;
  const json = (): Json => (rec.body.length ? JSON.parse(rec.body.toString('utf8')) : {});

  if (rest === '/exec' && rec.method === 'POST') {
    const spec = json();
    const args = ['exec', '--desk-id', desk, '--quiet', q.stream === '1' ? '--json-stream' : '--json', typeof spec.stdin === 'string' ? '--stdin' : '--no-stdin'];
    if (spec.shell) args.push('--shell', spec.shell);
    if (typeof spec.timeout_secs === 'number') args.push('--timeout', String(spec.timeout_secs));
    if (spec.cwd) args.push('--cwd', spec.cwd);
    args.push('--', ...(Array.isArray(spec.argv) ? spec.argv : [spec.command]));
    if (q.stream === '1') {
      res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': requestId() });
      let ended = false;
      const ran = await streamFake(args, async (line) => {
        const ev = parse(line);
        if (!isObj(ev) || typeof ev.event !== 'string') return;
        if (ev.event === 'exit' || ev.event === 'error') ended = true;
        await sse(res, ev.event, JSON.stringify(ev));
      }, spec.stdin ?? '');
      if (!ended) await sse(res, 'error', JSON.stringify({ event: 'error', exit: ran.code ?? 255, error: plainError(ran) }));
      return void res.end();
    }
    const ran = await runFake(args, { input: spec.stdin });
    const r = parse(ran.stdout);
    if (isObj(r) && typeof r.exit === 'number') {
      const neverRan = r.remote_code === null && !r.timed_out && isObj(r.error);
      if (neverRan) return sendError(res, r.error);
      return sendJson(res, 200, r);
    }
    return sendError(res, plainError(ran));
  }

  if (rest === '/jobs' && rec.method === 'POST') {
    const spec = json();
    const args = ['run', '--detach', '--name', spec.name, '--desk-id', desk];
    const l = spec.limits ?? {};
    if (l.priority) args.push('--priority', l.priority);
    if (l.cpu_percent !== undefined) args.push('--cpu', String(l.cpu_percent));
    if (l.mem_mb !== undefined) args.push('--mem', String(l.mem_mb));
    if (l.keep_awake === true) args.push('--keep-awake');
    if (l.keep_awake === false) args.push('--no-keep-awake');
    if (spec.cwd) args.push('--cwd', spec.cwd);
    args.push('--json', '--', ...spec.command);
    return relay(res, await runFake(args), [0], 201);
  }
  if (rest === '/jobs' && rec.method === 'GET') return relay(res, await runFake(['ps', '--desk-id', desk, '--json']));
  const job = /^\/jobs\/([^/]+)(\/logs)?$/.exec(rest);
  if (job && !job[2] && rec.method === 'DELETE') return relay(res, await runFake(['kill', decodeURIComponent(job[1]), '--desk-id', desk, '--json']));
  if (job && job[2] && rec.method === 'GET') {
    const name = decodeURIComponent(job[1]);
    const args = ['logs', name, '--desk-id', desk];
    if (q.follow === '1') args.push('--follow');
    args.push('--json');
    if (q.tail !== undefined) args.push('--tail', q.tail);
    if (q.follow !== '1') return relay(res, await runFake(args));
    res.writeHead(200, { 'Content-Type': 'text/event-stream', 'X-Request-Id': requestId() });
    await streamFake(args, async (line) => {
      const ev = parse(line);
      if (!isObj(ev)) return;
      // The CLI's failure envelope is the stream's `error` event.
      const out = typeof ev.event === 'string' ? ev : { event: 'error', error: ev.error };
      await sse(res, String(out.event), JSON.stringify(out));
    });
    return void res.end();
  }
  if (rest === '/stats' && rec.method === 'GET') return relay(res, await runFake(['stats', '--desk-id', desk, '--json']));

  if (rest === '/files') {
    const path = q.path;
    if (!path) return sendError(res, { kind: 'usage', message: 'path is required' });
    const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-mock-api-'));
    const name = path.split('/').filter(Boolean).pop() || 'file';
    if (rec.method === 'PUT') {
      writeFileSync(join(dir, name), rec.body);
      const ran = await runFake(['cp', '--json', name, `${desk}:${path}`], { cwd: dir });
      // A summary with failed files is still the summary (the client makes it an error).
      return relay(res, ran, [0, 1]);
    }
    if (rec.method === 'GET') {
      const ran = await runFake(['cp', '--json', `${desk}:${path}`, name], { cwd: dir });
      if (ran.code !== 0) return relay(res, ran);
      res.writeHead(200, { 'Content-Type': 'application/octet-stream', 'X-Request-Id': requestId() });
      return void res.end(Buffer.from(`contents of ${path}\n`));
    }
  }

  if (tokens) {
    const code = 'session-owner';
    if (rest === '/tokens' && rec.method === 'POST') {
      const spec = json();
      const args = ['token', 'create', '--desk', desk, '--name', spec.name, '--expires', `${spec.expires_secs}s`, '--scope', spec.scopes.join(',')];
      if (spec.cwd) args.push('--cwd', spec.cwd);
      if (spec.low_priv) args.push('--low-priv');
      args.push('--json');
      return relay(res, await runFake(args, { code }), [0], 201);
    }
    if (rest === '/tokens' && rec.method === 'GET') return relay(res, await runFake(['token', 'list', '--desk', desk, '--json'], { code }));
    const t = /^\/tokens\/([^/]+)$/.exec(rest);
    if (t && rec.method === 'DELETE') return relay(res, await runFake(['token', 'revoke', '--desk', desk, decodeURIComponent(t[1]), '--json'], { code }));
  }
  return sendError(res, { kind: 'usage', message: `no route ${rec.method} ${rec.path}` });
}

export async function startMockApi(): Promise<MockApi> {
  const requests: Recorded[] = [];
  const server = createServer((req, res) => {
    void (async () => {
      const u = new URL(req.url ?? '/', 'http://127.0.0.1');
      const body = await readBody(req);
      const rec: Recorded = {
        method: req.method ?? 'GET',
        path: u.pathname,
        query: Object.fromEntries(u.searchParams),
        headers: {
          authorization: req.headers.authorization,
          'x-gaiadesk-desk-token': req.headers['x-gaiadesk-desk-token'] as string | undefined,
          'content-type': req.headers['content-type'],
          accept: req.headers.accept,
        },
        body,
      };
      requests.push(rec);
      try {
        await handle(res, rec);
      } catch (e) {
        if (!res.headersSent) sendError(res, { kind: 'protocol', message: `mock API: ${(e as Error).message}` });
        else res.end();
      }
    })();
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/v1`,
    requests,
    close: () =>
      new Promise<void>((r) => {
        server.closeAllConnections?.();
        server.close(() => r());
      }),
  };
}
