// The API transport on its own: choosing it, what it sends (headers, bodies,
// query), error envelopes, SSE parsing, and the operations it does not serve.
// (Behaviour shared with the CLI transport is in transports.test.ts.)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { DEFAULT_API_URL, GaiaDesk, GaiaDeskError, ProtocolError, RefusedError, UnreachableError, UsageError } from '../dist/index.js';
import type { GaiaDeskOptions } from '../dist/index.js';
import { SseParser } from '../dist/api-stream.js';
import { seconds } from '../dist/api.js';
import { HTML_DESK, LIMITED_DESK, startMockApi } from './fixtures/mock-api.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.js', import.meta.url));
const OK = '123456789';
const OFFLINE = 'offline-desk';
const USAGE = 'usage-desk';
const PLAIN = 'plain-desk';

const api = await startMockApi();
after(() => api.close());

const apiGd = (o: GaiaDeskOptions = {}) => new GaiaDesk({ apiKey: 'ak_test', deskToken: 'gdagt_test', baseUrl: api.url, ...o });
const last = () => api.requests[api.requests.length - 1];
const body = () => JSON.parse(last().body.toString('utf8'));

// ───────────────────────────── choosing the transport ─────────────────────────────

test('without apiKey the client keeps the CLI transport, and no HTTP request is made', async () => {
  const before = api.requests.length;
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-'));
  const gd = new GaiaDesk({ cli: [process.execPath, FAKE], env: { PATH: process.env.PATH, FAKE_LOG: join(dir, 'calls.jsonl') } });
  assert.equal(gd.backend, 'cli');
  assert.equal((await gd.exec(OK, 'hostname')).stdout, 'ran: hostname\n');
  assert.equal(await gd.version(), 'gaiadesk-cli 0.10.324');
  assert.equal(new GaiaDesk({ env: { PATH: process.env.PATH } }).backend, 'cli', 'the default is unchanged');
  assert.equal(api.requests.length, before);
});

test('apiKey selects the api transport; its options need it and exclude the CLI ones', () => {
  assert.equal(apiGd().backend, 'api');
  assert.equal(DEFAULT_API_URL, 'https://api.gaiadesk.net/v1');
  assert.throws(() => new GaiaDesk({ deskToken: 'gdagt_x' }), UsageError);
  assert.throws(() => new GaiaDesk({ baseUrl: 'http://x/v1' }), UsageError);
  assert.throws(() => new GaiaDesk({ apiKey: 'ak_x', cli: '/x/gaiadesk-cli' }), UsageError);
  assert.throws(() => new GaiaDesk({ apiKey: 'ak_x', backend: 'cli' }), UsageError);
  assert.throws(() => new GaiaDesk({ apiKey: '' }), UsageError);
  assert.throws(() => new GaiaDesk({ apiKey: 'ak_x', baseUrl: 'ftp://x' }), UsageError);
});

// ───────────────────────────── what goes over the wire ─────────────────────────────

test('every request carries the API key and the desk token; a call may override the token and wake the desk', async () => {
  const gd = apiGd();
  await gd.stats(OK);
  assert.equal(last().headers.authorization, 'Bearer ak_test');
  assert.equal(last().headers['x-gaiadesk-desk-token'], 'gdagt_test');
  assert.equal(last().path, `/v1/desks/${OK}/stats`);
  await gd.stats(OK, { deskToken: 'gdagt_other', wake: 30 });
  assert.equal(last().headers['x-gaiadesk-desk-token'], 'gdagt_other');
  assert.deepEqual(last().query, { wake_s: '30' });
  await assert.rejects(gd.stats(OK, { wake: 121 }), UsageError);
  await new GaiaDesk({ apiKey: 'session-person', baseUrl: api.url }).listTokens(OK);
  assert.equal(last().headers['x-gaiadesk-desk-token'], undefined, 'no desk token unless one is given');
});

test('exec sends an ExecSpec', async () => {
  const gd = apiGd();
  await gd.exec(OK, 'hostname', { shell: 'sh', timeout: '10m', cwd: '/srv', stdin: new TextEncoder().encode('in') });
  assert.equal(last().method, 'POST');
  assert.equal(last().headers['content-type'], 'application/json');
  assert.deepEqual(body(), { command: 'hostname', shell: 'sh', cwd: '/srv', timeout_secs: 600, stdin: 'in' });
  await gd.exec(OK, ['ls', '-l']);
  assert.deepEqual(body(), { argv: ['ls', '-l'] });
  const s = gd.execStream(OK, 'x');
  await s.wait();
  assert.deepEqual(last().query, { stream: '1' });
  assert.equal(last().headers.accept, 'text/event-stream');
});

test('runJob sends a JobSpec, createToken a MintSpec per desk, logs its tail', async () => {
  const gd = apiGd();
  await gd.runJob(OK, 'build', 'make all', { priority: 'low', cpu: 50, mem: '2G', keepAwake: true, cwd: 'src' });
  assert.deepEqual(body(), { name: 'build', command: ['make all'], limits: { priority: 'low', cpu_percent: 50, mem_mb: 2048, keep_awake: true }, cwd: 'src' });
  await gd.jobLogs(OK, 'build', { tail: 10 });
  assert.deepEqual([last().path, last().query], [`/v1/desks/${OK}/jobs/build/logs`, { tail: '10' }]);
  const owner = new GaiaDesk({ apiKey: 'session-person', baseUrl: api.url });
  await owner.createToken({ desks: OK, name: 'bot', expires: '24h', cwd: '/srv', lowPriv: true });
  assert.deepEqual(body(), { name: 'bot', expires_secs: 86400, scopes: ['exec', 'cp', 'jobs'], cwd: '/srv', low_priv: true });
  await owner.revokeToken(OK, '9f3a1c2b7d004e11');
  assert.deepEqual([last().method, last().path], ['DELETE', `/v1/desks/${OK}/tokens/9f3a1c2b7d004e11`]);
});

test('files: raw bytes up, raw bytes down', async () => {
  const gd = apiGd();
  const r = await gd.uploadBytes('hello', OK, 'notes/a.txt');
  assert.deepEqual([last().method, last().query, last().headers['content-type'], last().body.toString()], ['PUT', { path: 'notes/a.txt' }, 'application/octet-stream', 'hello']);
  assert.equal(r.direction, 'upload');
  assert.equal(new TextDecoder().decode(await gd.downloadBytes(OK, 'notes/a.txt')), 'contents of notes/a.txt\n');
  const cli = new GaiaDesk({ cli: [process.execPath, FAKE], env: {} });
  await assert.rejects(cli.uploadBytes('x', OK, 'a'), UsageError);
  await assert.rejects(cli.downloadBytes(OK, 'a'), UsageError);
});

test('seconds: durations as the API takes them', () => {
  assert.deepEqual([seconds(90, 't'), seconds(1.2, 't'), seconds('30s', 't'), seconds('10m', 't'), seconds('1h30m', 't'), seconds('7d', 't'), seconds('2w', 't')], [90, 2, 30, 600, 5400, 604800, 1209600]);
  assert.throws(() => seconds('5 fortnights', 't'), UsageError);
});

// ───────────────────────────── errors ─────────────────────────────

test('error envelopes: refused 403, unreachable 409 with its reason, usage 400, request ids kept', async () => {
  const noToken = new GaiaDesk({ apiKey: 'ak_test', baseUrl: api.url });
  await assert.rejects(noToken.stats(OK), (e) => {
    assert.ok(e instanceof RefusedError);
    assert.deepEqual([e.kind, e.reason, e.status, e.exitCode, e.desk], ['refused', 'desk_token_required', 403, 254, OK]);
    assert.match(e.requestId ?? '', /^req_[0-9a-f]{24}$/);
    return true;
  });
  await assert.rejects(new GaiaDesk({ apiKey: 'ak_test', baseUrl: api.url }).listTokens(OK), (e) => e instanceof RefusedError && /signed-in person/.test(e.message));
  await assert.rejects(apiGd().exec(OFFLINE, 'x'), (e) => e instanceof UnreachableError && e.status === 409 && e.kind === 'offline' && e.reason === 'offline' && e.desk === OFFLINE);
  await assert.rejects(apiGd().exec(USAGE, 'x'), (e) => e instanceof UsageError && e.status === 400 && e.kind === 'usage');
  await assert.rejects(apiGd().stats(PLAIN), (e) => e instanceof UnreachableError && e.status === 504 && e.kind === 'timeout');
});

test('429 keeps Retry-After; a body that is not an envelope is a ProtocolError; no connection is unreachable/network', async () => {
  await assert.rejects(apiGd().stats(LIMITED_DESK), (e) => e instanceof RefusedError && e.status === 429 && e.reason === 'rate_limited' && e.retryAfter === 7);
  await assert.rejects(apiGd().stats(HTML_DESK), (e) => e instanceof ProtocolError && e.kind === 'protocol' && e.status === 500 && /no error envelope/.test(e.message));
  const down = new GaiaDesk({ apiKey: 'ak_test', baseUrl: 'http://127.0.0.1:1/v1' });
  await assert.rejects(down.stats(OK), (e) => e instanceof UnreachableError && e.kind === 'network' && e.reason === 'network' && e.exitCode === 255);
  const s = down.execStream(OK, 'x');
  const exit = await s.wait();
  assert.deepEqual([exit.exitCode, exit.error?.kind, exit.error?.reason], [255, 'unreachable', 'network']);
});

test('a stream refused before it starts ends with the typed error; kill() stops it', async () => {
  const s = new GaiaDesk({ apiKey: 'ak_test', baseUrl: api.url }).execStream(OK, 'x');
  const chunks = [];
  for await (const c of s) chunks.push(c);
  assert.equal(chunks.length, 0);
  const exit = await s.wait();
  assert.deepEqual([exit.exitCode, exit.error?.kind, exit.error?.reason], [254, 'refused', 'desk_token_required']);
  const f = apiGd().followJobLogs(OK, 'build');
  f.kill();
  assert.equal((await f.wait()).exitCode, 130);
  const ac = new AbortController();
  ac.abort();
  await assert.rejects(apiGd().stats(OK, { signal: ac.signal }), (e) => e instanceof GaiaDeskError && e.kind === 'interrupted');
});

// ───────────────────────────── SSE ─────────────────────────────

test('SseParser: events split anywhere, CRLF across chunks, comments, multi-line data, an unterminated last event', () => {
  const text = ': keep-alive\r\nevent: stdout\r\ndata: {"event":"stdout","data":"a"}\r\n\r\n:ping\n\nevent: x\ndata: line1\ndata: line2\n\ndata: {"event":"exit","exit":0}';
  for (const size of [1, 2, 3, 7, text.length]) {
    const p = new SseParser();
    const got = [];
    for (let i = 0; i < text.length; i += size) got.push(...p.feed(text.slice(i, i + size)));
    got.push(...p.end());
    assert.deepEqual(got, [
      { event: 'stdout', data: '{"event":"stdout","data":"a"}' },
      { event: 'x', data: 'line1\nline2' },
      { event: 'message', data: '{"event":"exit","exit":0}' },
    ], `chunks of ${size}`);
  }
  const p = new SseParser();
  assert.deepEqual(p.feed('data: a\r'), []);
  assert.deepEqual(p.feed('\ndata:b\r\r'), [], 'a trailing \\r may be half of \\r\\n');
  assert.deepEqual(p.feed('\n'), [{ event: 'message', data: 'a\nb' }]);
});

// ───────────────────────────── not served by the API ─────────────────────────────

test('operations the API does not serve are UsageErrors that say so, and send nothing', async () => {
  const own = await startMockApi(); // its own server: nothing else in flight
  const gd = new GaiaDesk({ apiKey: 'ak_test', deskToken: 'gdagt_test', baseUrl: own.url });
  const notServed = (e: unknown) => e instanceof UsageError && e.kind === 'usage' && /not available over the API transport/.test(e.message);
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-'));
  for (const call of [
    () => gd.shell(OK, 'ls'),
    () => gd.measure(OK),
    () => gd.meshStatus(),
    () => gd.meshIp(OK),
    () => gd.disconnect(OK),
    () => gd.forward(OK, { remotePort: 22 }),
    () => gd.agentConnect(OK),
    () => gd.audit(OK),
    () => gd.version(),
    () => gd.versionInfo(),
    () => gd.features(),
    () => gd.raw(['devices']),
    () => gd.probe(OK),
    () => gd.devices({ probe: true }),
    () => gd.upload(dir, OK, 'x/', { recursive: true }),
    () => gd.upload(dir, OK, 'x/'),
    () => gd.download(OK, 'x/', dir, { recursive: true }),
    () => gd.createToken({ desks: OK, name: 'bot', out: '/tmp/bot.token' }),
    () => gd.revokeToken(OK, { all: true }),
    () => gd.revokeToken(OK, 'bot', { account: true }),
  ]) {
    await assert.rejects(call(), notServed);
  }
  assert.throws(() => gd.shellStream(OK), notServed);
  assert.throws(() => gd.mcp(), notServed);
  assert.throws(() => gd.execStream(OK, 'cat', { stdin: true }), notServed);
  assert.equal(own.requests.length, 0);
  await own.close();
});
