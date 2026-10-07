// The local transport on its own: the desk's /v1 API over a Unix socket (a
// named pipe on Windows), the default paths, the admin token from its file,
// an agent token instead, typed errors, streams, and a missing socket.
// (Behaviour shared with the other transports is in transports.test.ts.)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GaiaDesk, GaiaDeskError, RefusedError, UnreachableError, UsageError, localApiDir, localPipeName, localSocketPath, localTokenPath, pipeUser } from '../dist/index.js';
import type { GaiaDeskOptions } from '../dist/index.js';
import { startMockApi } from './fixtures/mock-api.js';

const OK = '123456789';
const OFFLINE = 'offline-desk';
const WIN = process.platform === 'win32';
const ADMIN = `gdlocal_${'0123456789abcdef'.repeat(4)}`;

// GAIADESK_API_DIR is a temp dir holding the socket and the admin token file
// (on Windows the pipe is named by GAIADESK_API_PIPE; the token file is still there).
const dir = mkdtempSync(join(tmpdir(), 'gd-'));
writeFileSync(join(dir, 'api-token'), `${ADMIN}\n`);
const pipe = `\\\\.\\pipe\\gaiadesk-sdk-local-${process.pid}-${Date.now()}`;
const env: Record<string, string> = WIN ? { GAIADESK_API_DIR: dir, GAIADESK_API_PIPE: pipe } : { GAIADESK_API_DIR: dir };
const desk = await startMockApi({ desk: 'local', socketPath: WIN ? pipe : join(dir, 'api.sock') });
after(() => desk.close());

const localGd = (o: GaiaDeskOptions = {}) => new GaiaDesk({ transport: 'local', env, ...o });
const last = () => desk.requests[desk.requests.length - 1];

// ───────────────────────────── pure helpers ─────────────────────────────

test('pipeUser: lowercased, [a-z0-9._-] kept, the rest _, at most 64, `user` if empty', () => {
  assert.equal(pipeUser('Charlie'), 'charlie');
  assert.equal(pipeUser('Charlie Brown'), 'charlie_brown');
  assert.equal(pipeUser('DOMAIN\\Ana.Lee-2'), 'domain_ana.lee-2');
  assert.equal(pipeUser('Élodie'), '_lodie');
  assert.equal(pipeUser('x'.repeat(100)), 'x'.repeat(64));
  assert.equal(pipeUser(''), 'user');
});

test('localPipeName: $GAIADESK_API_PIPE, else gaiadesk-api-<$USERNAME, else the account name>', () => {
  assert.equal(localPipeName({ USERNAME: 'Bob Smith' }), '\\\\.\\pipe\\gaiadesk-api-bob_smith');
  assert.equal(localPipeName({}, 'Alice'), '\\\\.\\pipe\\gaiadesk-api-alice');
  assert.equal(localPipeName({ USERNAME: 'bob' }, 'alice'), '\\\\.\\pipe\\gaiadesk-api-bob', '$USERNAME first');
  assert.equal(localPipeName({}), '\\\\.\\pipe\\gaiadesk-api-user');
  assert.equal(localPipeName({ GAIADESK_API_PIPE: '\\\\.\\pipe\\custom', USERNAME: 'bob' }), '\\\\.\\pipe\\custom');
});

test('the socket and token paths: $GAIADESK_API_DIR when absolute, else ~/.gaiadesk', () => {
  assert.equal(localSocketPath({}, '/home/ana', 'linux'), '/home/ana/.gaiadesk/api.sock');
  assert.equal(localTokenPath({}, '/Users/ana', 'darwin'), '/Users/ana/.gaiadesk/api-token');
  assert.equal(localSocketPath({ GAIADESK_API_DIR: '/run/gd/' }, '/home/ana', 'linux'), '/run/gd/api.sock');
  assert.equal(localApiDir({ GAIADESK_API_DIR: 'relative/dir' }, '/home/ana', 'linux'), '/home/ana/.gaiadesk', 'a relative dir is not used');
  assert.equal(localTokenPath({}, 'C:\\Users\\ana', 'win32'), 'C:\\Users\\ana\\.gaiadesk\\api-token');
  assert.equal(localTokenPath({ GAIADESK_API_DIR: 'D:\\gd' }, 'C:\\Users\\ana', 'win32'), 'D:\\gd\\api-token');
});

// ───────────────────────────── choosing it ─────────────────────────────

test("transport: 'local' is the local backend; its options are checked", () => {
  assert.equal(localGd().backend, 'local');
  assert.throws(() => new GaiaDesk({ transport: 'local', apiKey: 'ak_x' }), UsageError);
  assert.throws(() => new GaiaDesk({ transport: 'local', baseUrl: 'http://x/v1' }), UsageError);
  assert.throws(() => new GaiaDesk({ transport: 'local', fingerprint: 'ab' }), UsageError);
  assert.throws(() => new GaiaDesk({ transport: 'local', cli: '/x/gaiadesk-cli' }), UsageError);
  assert.throws(() => new GaiaDesk({ transport: 'local', token: '' }), UsageError);
  assert.throws(() => new GaiaDesk({ transport: 'local', socketPath: ' ' }), UsageError);
  assert.throws(() => new GaiaDesk({ socketPath: '/x.sock' }), UsageError, 'socketPath needs transport: local');
  assert.throws(() => new GaiaDesk({ token: ADMIN }), UsageError);
  assert.throws(() => new GaiaDesk({ transport: 'bogus' as 'local' }), UsageError);
  assert.equal(new GaiaDesk({ transport: 'direct', env: { PATH: process.env.PATH } }).backend === 'api', false);
});

// ───────────────────────────── credentials ─────────────────────────────

test('exec round trip with the admin token read from its file, as Bearer', async () => {
  const r = await localGd().exec(OK, 'hostname');
  assert.deepEqual([r.exit, r.stdout, r.desk], [0, 'ran: hostname\n', OK]);
  assert.deepEqual([last().method, last().path], ['POST', `/v1/desks/${OK}/exec`]);
  assert.equal(last().headers.authorization, `Bearer ${ADMIN}`, 'trimmed of its newline');
  assert.equal(last().headers['x-gaiadesk-desk-token'], undefined);
  assert.equal(last().headers.host, 'localhost');
});

test('an agent token is sent as X-GaiaDesk-Desk-Token instead, with no Authorization; per call too', async () => {
  await localGd({ deskToken: 'gdagt_local' }).stats(OK);
  assert.equal(last().headers['x-gaiadesk-desk-token'], 'gdagt_local');
  assert.equal(last().headers.authorization, undefined);
  await localGd().stats(OK, { deskToken: 'gdagt_call' });
  assert.equal(last().headers['x-gaiadesk-desk-token'], 'gdagt_call');
  assert.equal(last().headers.authorization, undefined);
  await localGd({ token: 'gdlocal_given' }).stats(OK);
  assert.equal(last().headers.authorization, 'Bearer gdlocal_given', 'an explicit token, not the file');
});

test('a 401 envelope is the typed error; a refused token route too', async () => {
  await assert.rejects(localGd({ token: 'not-an-admin-token' }).stats(OK), (e) => {
    assert.ok(e instanceof RefusedError);
    assert.deepEqual([e.kind, e.reason, e.status, e.exitCode], ['refused', 'unauthenticated', 401, 254]);
    assert.match(e.requestId ?? '', /^req_/);
    return true;
  });
  await assert.rejects(localGd({ deskToken: 'gdagt_x' }).listTokens(OK), RefusedError);
  assert.equal((await localGd().listTokens(OK))[0].id, '9f3a1c2b7d004e11', 'the admin token administers tokens');
  await assert.rejects(localGd().exec(OFFLINE, 'x'), (e) => e instanceof UnreachableError && e.status === 409 && e.kind === 'offline');
});

// ───────────────────────────── streams, files, held waits ─────────────────────────────

test('streamed exec over the socket', async () => {
  const s = localGd().execStream(OK, 'exit 2', { cwd: '/srv' });
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'part1 part2 exit 2\nin: /srv\n');
  const exit = await s.wait();
  assert.deepEqual([exit.exitCode, exit.result?.remote_code, exit.error], [2, 2, undefined]);
  assert.equal(last().headers.accept, 'text/event-stream');
  const f = localGd().followJobLogs(OK, 'build');
  let logs = '';
  for await (const c of f.text()) logs += c.text;
  assert.equal(logs, 'one\ntwo\nthree\n');
  const k = localGd().followJobLogs(OK, 'build');
  k.kill();
  assert.equal((await k.wait()).exitCode, 130);
});

test('bytes up and down, and a held wait, over the socket', async () => {
  const gd = localGd();
  await gd.uploadBytes('hello socket', OK, 'notes/a.txt');
  assert.deepEqual([last().method, last().query, last().body.toString()], ['PUT', { path: 'notes/a.txt' }, 'hello socket']);
  assert.equal(new TextDecoder().decode(await gd.downloadBytes(OK, 'notes/a.txt')), 'contents of notes/a.txt\n');
  assert.equal((await gd.waitJob(OK, 'held')).job.name, 'held');
  await assert.rejects(gd.waitJob(OK, 'held-fail'), (e) => e instanceof GaiaDeskError && e.kind === 'connection_lost');
});

// ───────────────────────────── not there ─────────────────────────────

test('a missing socket is UnreachableError local_api_unavailable, saying how to turn the API on', async () => {
  const gone = WIN ? `\\\\.\\pipe\\gaiadesk-sdk-none-${process.pid}` : join(dir, 'no.sock');
  const gd = new GaiaDesk({ transport: 'local', socketPath: gone, token: ADMIN });
  await assert.rejects(gd.stats(OK), (e) => {
    assert.ok(e instanceof UnreachableError);
    assert.deepEqual([e.kind, e.reason, e.exitCode], ['unreachable', 'local_api_unavailable', 255]);
    assert.match(e.message, /GaiaDesk is not serving its local API here: is the app running, and is Settings → GaiaDesk API → Local API on\?/);
    assert.ok(e.message.includes(gone));
    return true;
  });
  const exit = await gd.execStream(OK, 'x').wait();
  assert.deepEqual([exit.exitCode, exit.error?.kind, exit.error?.reason], [255, 'unreachable', 'local_api_unavailable']);
});

test('no token file and no agent token: the same clear error, and nothing is sent', async () => {
  const empty = mkdtempSync(join(tmpdir(), 'gd-'));
  const before = desk.requests.length;
  const gd = new GaiaDesk({ transport: 'local', socketPath: desk.socketPath, env: { GAIADESK_API_DIR: empty } });
  await assert.rejects(gd.stats(OK), (e) => e instanceof UnreachableError && e.reason === 'local_api_unavailable' && /deskToken/.test(e.message));
  assert.equal(desk.requests.length, before);
});

test('hosted-only operations are UsageErrors naming the local transport', async () => {
  const notServed = (e: unknown) => e instanceof UsageError && /not available over the local transport/.test(e.message);
  await assert.rejects(localGd().devices({ probe: true }), notServed);
  await assert.rejects(localGd().measure(OK), notServed);
  assert.throws(() => localGd().mcp(), notServed);
});
