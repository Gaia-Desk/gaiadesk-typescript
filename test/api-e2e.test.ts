// End-to-end encryption on the API transport, against a mock API that is
// also the desk (fixtures/mock-e2e.ts): every operation sealed gives exactly
// what it gives in the clear, the API never sees the command, env, stdin,
// path or file bytes, and the modes, pins and retries behave.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { ConnectionLostError, E2eError, GaiaDesk, GaiaDeskError, ProtocolError, RefusedError, UsageError } from '../dist/index.js';
import type { GaiaDeskOptions, OutputStream } from '../dist/index.js';
import { b64url, hex, x25519Public } from '../dist/e2e.js';
import { startMockE2e } from './fixtures/mock-e2e.js';

const CANARY = 'canary-7f3a9';
const KEY = hex('0102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f20');
const KEY2 = hex('2122232425262728292a2b2c2d2e2f303132333435363738393a3b3c3d3e3f40');
const PUB = b64url(await x25519Public(KEY));
const PUB2 = b64url(await x25519Public(KEY2));

const SEALED = '111111111';
const OLD = '222222222'; // no end-to-end key
const MUST = '333333333'; // requires it
const ASLEEP = '444444444'; // requires it, offline until woken
const GONE = '555555555'; // offline, no wake path
const STALE = '666666666'; // requires it; the first lookup lists no key
const ROTATED = '777777777';

const api = await startMockE2e({
  [SEALED]: { secret: KEY },
  [OLD]: {},
  [MUST]: { secret: KEY, required: true },
  [ASLEEP]: { secret: KEY, required: true, online: false, wakeable: true },
  [GONE]: { secret: KEY, online: false },
  [STALE]: { secret: KEY, required: true, hideKeyLookups: 1 },
  [ROTATED]: { secret: KEY },
});
after(() => api.close());

const warnings: string[] = [];
const gd = (o: GaiaDeskOptions = {}) => new GaiaDesk({ apiKey: 'ak_test', deskToken: 'gdagt_test', baseUrl: api.url, onWarning: (m) => warnings.push(m), ...o });
const sealedGd = gd();
const plainGd = gd({ e2e: 'off' });

/** Run `f`, and assert the API saw nothing of the canary in any request it made. */
async function blind<T>(f: () => Promise<T>): Promise<T> {
  const before = api.requests.length;
  const r = await f();
  const seen = api.requests.slice(before);
  assert.ok(seen.length > 0);
  for (const q of seen) {
    const raw = JSON.stringify([q.path, q.query, q.headers, q.body]);
    assert.ok(!raw.includes(CANARY), `the API saw the canary in ${q.method} ${q.path}: ${raw.slice(0, 300)}`);
  }
  return r;
}

/** The same call sealed (asserting the API saw none of it) and in the clear: equal answers. */
async function same<T>(f: (g: GaiaDesk) => Promise<T>): Promise<T> {
  const before = api.sealed.length;
  const sealed = await blind(() => f(sealedGd));
  assert.ok(api.sealed.length > before, 'it went sealed');
  const plain = await f(plainGd);
  assert.deepEqual(sealed, plain);
  return sealed;
}

async function drain(s: OutputStream): Promise<{ out: string; err: string; exit: unknown }> {
  let out = '';
  let err = '';
  for await (const c of s.text()) {
    if (c.stream === 'stdout') out += c.text;
    else err += c.text;
  }
  return { out, err, exit: await s.wait() };
}

function errorShape(e: unknown) {
  assert.ok(e instanceof GaiaDeskError, String(e));
  return { cls: e.constructor.name, kind: e.kind, reason: e.reason, status: e.status, message: e.message, desk: e.desk, exitCode: e.exitCode };
}

async function sameError(f: (g: GaiaDesk) => Promise<unknown>) {
  const sealed = await blind(() => f(sealedGd).then(() => assert.fail('no error'), (e) => errorShape(e)));
  const plain = await f(plainGd).then(() => assert.fail('no error'), (e) => errorShape(e));
  assert.deepEqual(sealed, plain);
  return sealed;
}

test('exec: sealed in a POST body {"e2e"}, the same result as in the clear; the desk key is looked up once', async () => {
  const lookups = () => api.requests.filter((r) => r.method === 'GET' && r.path === `/v1/desks/${SEALED}`).length;
  const r = await same((g) => g.exec(SEALED, `echo ${CANARY}`, { env: { SECRET: CANARY }, stdin: CANARY, cwd: `/srv/${CANARY}`, timeout: 30 }));
  assert.equal(r.stdout, `ran: echo ${CANARY} é\nenv: SECRET=${CANARY}\nstdin: ${CANARY}\n`);
  const sent = api.requests.filter((q) => q.path === `/v1/desks/${SEALED}/exec`).at(-2)!;
  const body = JSON.parse(sent.body);
  assert.deepEqual(Object.keys(body), ['e2e']);
  assert.deepEqual(Object.keys(body.e2e).sort(), ['ciphertext', 'nonce', 'pub', 'v']);
  const n = lookups();
  await sealedGd.exec(SEALED, 'again');
  assert.equal(lookups(), n, 'cached');
});

test('execStream: sealed SSE events open into the same chunks and exit (a split character carried)', async () => {
  const r = await same(async (g) => drain(g.execStream(SEALED, `echo ${CANARY}`, { env: { K: CANARY } })));
  assert.equal(r.out, `ran: echo ${CANARY} é\nenv: K=${CANARY}\n`);
  assert.equal(r.err, 'warn\n');
  assert.equal((r.exit as { exitCode: number }).exitCode, 0);
  // The desk lost mid-stream: the server's plaintext error event still ends it.
  const lost = await same(async (g) => drain(g.execStream(SEALED, 'lose')));
  assert.equal((lost.exit as { error?: { kind: string } }).error?.kind, 'connection_lost');
});

test('jobs, logs (tail and follow), wait, kill, stats: the same answers sealed', async () => {
  await same((g) => g.runJob(SEALED, 'build', `make ${CANARY}`, { env: { CI: CANARY }, shell: 'bash', cwd: CANARY }));
  await same((g) => g.jobs(SEALED));
  assert.equal(await same((g) => g.jobLogs(SEALED, 'build', { tail: 10 })), 'tail 10\n');
  const f = await same(async (g) => drain(g.followJobLogs(SEALED, 'build')));
  assert.equal(f.out, 'line1\nline2 é\n');
  assert.deepEqual(await same((g) => g.waitJob(SEALED, 'build', { timeout: 60 })), { job: { name: 'build', state: 'exited', exit_code: 3 }, timed_out: false });
  const held = await same((g) => g.waitJob(SEALED, 'held'));
  assert.equal(held.job.name, 'held');
  await same((g) => g.killJob(SEALED, 'build'));
  await same((g) => g.stats(SEALED));
  const tail = api.requests.filter((q) => q.path.endsWith('/logs')).at(-4)!;
  assert.deepEqual(tail.query, {}, 'tail travels inside the sealed request');
  assert.ok(tail.headers['gaiadesk-e2e']);
});

test('desk errors: the sealed envelope\'s placeholder becomes the desk\'s own message; same class, kind, reason, status', async () => {
  const e = await sameError((g) => g.exec(SEALED, 'refuse'));
  assert.deepEqual([e.cls, e.kind, e.reason, e.status, e.desk], ['RefusedError', 'refused', 'token_refused', 403, SEALED]);
  assert.match(e.message, /no exec scope/);
  const w = await sameError((g) => g.waitJob(SEALED, 'held-gone'));
  assert.deepEqual([w.cls, w.kind], ['OperationFailedError', 'failed']);
  assert.match(w.message, /no job named "held-gone"/);
  const l = await sameError((g) => g.jobLogs(SEALED, 'missing'));
  assert.equal(l.message, 'no job named "missing"');
  const s = await same(async (g) => drain(g.followJobLogs(SEALED, 'missing')));
  assert.equal((s.exit as { error?: { message: string } }).error?.message, 'no job named "missing"');
});

test('files: upload as sealed NDJSON input frames, download as sealed NDJSON events; same results and bytes', async () => {
  const big = new Uint8Array(150 * 1024).map((_, i) => i % 251);
  const marked = new TextEncoder().encode(`${CANARY} file\n`);
  const up = await same((g) => g.uploadBytes(marked, SEALED, `docs/${CANARY}.txt`));
  assert.equal(up.bytes, marked.length);
  const put = api.requests.filter((q) => q.method === 'PUT').at(-2)!;
  assert.equal(put.headers['content-type'], 'application/x-ndjson');
  assert.deepEqual(put.query, {}, 'the path travels sealed');
  await blind(() => sealedGd.uploadBytes(big, SEALED, 'big.bin'));
  const frames = api.requests.filter((q) => q.method === 'PUT').at(-1)!.body.trim().split('\n');
  assert.equal(frames.length, 4, '48 KiB per frame');
  assert.deepEqual(await blind(() => sealedGd.downloadBytes(SEALED, 'big.bin')), big);
  assert.deepEqual(await same((g) => g.downloadBytes(SEALED, `docs/${CANARY}.txt`)), marked);
  await sameError((g) => g.downloadBytes(SEALED, 'missing'));
  await assert.rejects(sealedGd.downloadBytes(SEALED, 'truncated'), (e) => e instanceof ConnectionLostError && e.reason === 'incomplete');
});

test('tokens: mint, list, revoke sealed', async () => {
  const owner = (o: GaiaDeskOptions) => new GaiaDesk({ apiKey: 'session-person', baseUrl: api.url, onWarning: () => {}, ...o });
  const mint = (g: GaiaDesk) => g.createToken({ desks: SEALED, name: `bot-${CANARY}`, expires: '1h' });
  const sealedMint = await blind(() => mint(owner({})));
  assert.deepEqual(sealedMint, await mint(owner({ e2e: 'off' })));
  assert.equal((sealedMint.tokens[0] as unknown as { name: string }).name, `bot-${CANARY}`);
  assert.deepEqual(await owner({}).listTokens(SEALED), await owner({ e2e: 'off' }).listTokens(SEALED));
  assert.deepEqual(await owner({}).revokeToken(SEALED, 'tok1'), await owner({ e2e: 'off' }).revokeToken(SEALED, 'tok1'));
  assert.equal(api.sealed.filter((o) => o.startsWith('token_')).length, 3);
});

test('auto, no key: in the clear, warned once per desk', async () => {
  const seen: string[] = [];
  const g = gd({ onWarning: (m) => seen.push(m) });
  const before = api.plain.length;
  await g.stats(OLD);
  await g.stats(OLD);
  assert.equal(api.plain.length, before + 2);
  const mine = [...seen, ...warnings].filter((w) => w.includes(OLD));
  assert.equal(mine.length, 1, `one warning: ${mine}`);
  assert.match(mine[0], /not end-to-end encrypted/);
});

test('require: never in the clear; a desk without a key is woken and asked again, else E2eError and nothing sent', async () => {
  const before = api.requests.length;
  await assert.rejects(gd({ e2e: 'require' }).exec(OLD, `echo ${CANARY}`), (e) => e instanceof E2eError && e instanceof RefusedError && e.reason === 'e2e_unavailable' && e.desk === OLD);
  await assert.rejects(gd({ e2e: 'require' }).stats(GONE), (e) => e instanceof E2eError && /offline/.test(e.message));
  const sent = api.requests.slice(before);
  assert.ok(sent.every((q) => q.path.endsWith('/wake') || /^\/v1\/desks\/\d+$/.test(q.path)), 'only lookups and wakes');
  assert.ok(api.wakes.includes(OLD) && api.wakes.includes(GONE));
  // Asleep, but woken: then sealed.
  const r = await blind(() => gd({ e2e: 'require' }).exec(ASLEEP, `echo ${CANARY}`));
  assert.equal(r.exit, 0);
  assert.ok(api.wakes.includes(ASLEEP));
});

test('a desk that requires it: sealed in auto too; a plaintext call refused e2e_required is sealed and retried once', async () => {
  const before = api.sealed.length;
  await gd().stats(MUST);
  assert.equal(api.sealed.length, before + 1);
  // STALE's first lookup listed no key: the plaintext call is refused e2e_required, the key fetched again, the call sealed.
  const plainBefore = api.requests.filter((q) => q.path === `/v1/desks/${STALE}/stats`).length;
  const r = await gd().stats(STALE);
  assert.equal(r.cpu_percent, 5);
  assert.equal(api.requests.filter((q) => q.path === `/v1/desks/${STALE}/stats`).length, plainBefore + 2, 'refused once, then sealed');
  assert.equal(api.sealed.at(-1), 'stats');
  // Off means off: the refusal is the error.
  await assert.rejects(gd({ e2e: 'off' }).stats(MUST), (e) => e instanceof RefusedError && e.reason === 'e2e_required' && e.status === 409);
});

test('a rotated key: the desk refuses e2e_decrypt_failed, the key is fetched again and the call sealed again once', async () => {
  const g = gd();
  await g.stats(ROTATED);
  api.desks[ROTATED].secret = KEY2; // rotated, the old key forgotten
  const n = api.requests.filter((q) => q.path === `/v1/desks/${ROTATED}/stats`).length;
  assert.equal((await g.stats(ROTATED)).cpu_percent, 5);
  assert.equal(api.requests.filter((q) => q.path === `/v1/desks/${ROTATED}/stats`).length, n + 2);
});

test('pinned keys: a different key from the server is refused before anything is sent; the pin seals while no key is listed', async () => {
  const before = api.requests.length;
  await assert.rejects(gd({ e2eKeys: { [SEALED]: PUB2 } }).exec(SEALED, `echo ${CANARY}`), (e) => e instanceof E2eError && e.reason === 'e2e_key_mismatch');
  assert.ok(api.requests.slice(before).every((q) => q.path === `/v1/desks/${SEALED}`), 'only the lookup');
  assert.equal((await gd({ e2eKeys: { [SEALED]: PUB } }).stats(SEALED)).cpu_percent, 5);
  // GONE lists no key while offline: the pinned key seals anyway.
  const r = await blind(() => gd({ e2e: 'require', e2eKeys: { [GONE]: PUB } }).exec(GONE, `echo ${CANARY}`));
  assert.equal(r.exit, 0);
  assert.throws(() => gd({ e2eKeys: { [SEALED]: 'short' } }), UsageError);
  assert.throws(() => gd({ e2e: 'always' as never }), UsageError);
  assert.throws(() => new GaiaDesk({ e2e: 'require' }), UsageError, 'api transport only');
});

test('a hostile server: altered events, or a plaintext answer to a sealed call, are refused', async () => {
  api.tamper = 'flip';
  try {
    await assert.rejects(sealedGd.stats(SEALED), (e) => e instanceof ProtocolError && e.reason === 'e2e_decrypt_failed');
    const s = await drain(sealedGd.execStream(SEALED, 'x'));
    assert.equal((s.exit as { error?: { kind: string } }).error?.kind, 'protocol');
    const e = await sealedGd.exec(SEALED, 'refuse').catch((x) => x);
    assert.ok(e instanceof RefusedError && /did not open/.test(e.message), 'the placeholder, said to be unopened');
    api.tamper = 'plaintext';
    await assert.rejects(sealedGd.stats(SEALED), (x) => x instanceof ProtocolError && x.reason === 'e2e_unsealed_answer');
    const p = await drain(sealedGd.execStream(SEALED, 'x'));
    assert.equal(p.out, '', 'no forged output');
    assert.equal((p.exit as { error?: { kind: string } }).error?.kind, 'protocol');
  } finally {
    api.tamper = null;
  }
  assert.equal((await sealedGd.stats(SEALED)).cpu_percent, 5, "honest again, fine again");
});
