// A server or proxy that drops or stalls a connection, on a raw socket
// (node:net, no HTTP server module): the api transport (global fetch) and the
// local transport (node:http over a Unix socket) fail with a clear transport
// error within their timeouts and never hang. Requests are never re-sent: the
// SDK has no retry policy, and fetch (undici) does not silently re-send a
// request whose connection closed before any answer, with or without a body.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionLostError, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_RESPONSE_TIMEOUT_MS, GaiaDesk, GaiaDeskError, UnreachableError, UsageError } from '../dist/index.js';
import type { GaiaDeskOptions, TimeoutOptions } from '../dist/index.js';
import { startRawServer } from './fixtures/raw-server.js';
import type { RawMode, RawServer } from './fixtures/raw-server.js';

const D = '123456789';
/** A hang shows as this, not as a stuck run. */
const BOUND = 10_000;

const gdOf = (s: RawServer, t: TimeoutOptions = {}, o: GaiaDeskOptions = {}) =>
  new GaiaDesk({ apiKey: 'ak_t', deskToken: 'gdagt_t', baseUrl: s.url, e2e: 'off', timeouts: { idleTimeoutMs: 1000, responseTimeoutMs: 30_000, ...t }, ...o });

/** `p` settled within BOUND, else a failure saying the SDK hung. */
function within<T>(p: Promise<T>, what = 'the call'): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const hung = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new assert.AssertionError({ message: `${what}: no answer within ${BOUND / 1000} s: the SDK hung` })), BOUND);
  });
  return Promise.race([p, hung]).finally(() => clearTimeout(timer));
}

/** The error `f` fails with (of class `cls`), and how long it took. */
async function fails<E extends Error>(cls: new (...a: never[]) => E, f: () => Promise<unknown>): Promise<{ e: E; took: number }> {
  const t = Date.now();
  let r: { ok: true } | { ok: false; e: unknown };
  try {
    await within(f());
    r = { ok: true };
  } catch (e) {
    r = { ok: false, e };
  }
  if (r.ok) assert.fail(`expected a ${cls.name}, but the call succeeded`);
  if (r.e instanceof assert.AssertionError) throw r.e;
  assert.ok(r.e instanceof cls, `expected a ${cls.name}, got ${(r.e as Error)?.constructor?.name}: ${(r.e as Error)?.message}`);
  return { e: r.e as E, took: Date.now() - t };
}

async function withServer(mode: RawMode, f: (s: RawServer) => Promise<void>, path?: string): Promise<void> {
  const s = await startRawServer(mode, path);
  try {
    await f(s);
  } finally {
    await s.close();
  }
}

for (const mode of ['closeBeforeResponse', 'resetBeforeResponse'] as const) {
  test(`${mode}: a read fails at once as UnreachableError (network), sent exactly once`, () =>
    withServer(mode, async (s) => {
      const gd = gdOf(s);
      const { e, took } = await fails(UnreachableError, () => gd.downloadBytes(D, '/tmp/x'));
      assert.deepEqual([e.kind, e.reason, e.argv], ['network', 'network', ['GET /desks/123456789/files']]);
      assert.ok(took < 5000, `took ${took} ms`);
      assert.equal(s.count('GET'), 1);
      await fails(UnreachableError, () => gd.stats(D));
      assert.equal(s.count('GET'), 2); // no retry policy, and fetch re-sends nothing
    }));
}

for (const mode of ['closeBeforeResponse', 'resetBeforeResponse', 'closeAfterBody'] as const) {
  test(`${mode}: a large upload, an exec, a stream and a job each reach the server exactly once`, () =>
    withServer(mode, async (s) => {
      const gd = gdOf(s);
      const big = new Uint8Array(4 * 1024 * 1024);
      const { e } = await fails(UnreachableError, () => gd.uploadBytes(big, D, '/tmp/big'));
      assert.equal(e.kind, 'network');
      assert.equal(s.count('PUT'), 1);
      const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-raw-'));
      const file = join(dir, 'big.bin');
      writeFileSync(file, big);
      await fails(UnreachableError, () => gd.upload(file, D, '/tmp/'));
      assert.equal(s.count('PUT'), 2);
      await fails(UnreachableError, () => gd.exec(D, 'deploy'));
      assert.equal(s.count('POST'), 1);
      const exit = await within(gd.execStream(D, 'deploy').wait(), 'execStream');
      assert.equal(exit.error?.kind, 'unreachable');
      assert.equal(exit.exitCode, 255);
      assert.equal(s.count('POST'), 2);
      await fails(UnreachableError, () => gd.runJob(D, 'nightly', 'make'));
      assert.equal(s.count('POST'), 3);
      assert.equal(s.count('GET'), 0);
    }));
}

test('stalled mid-download: ConnectionLostError (timeout) within the idle timeout, and no file is left', () =>
  withServer('stallMidBody', async (s) => {
    const gd = gdOf(s);
    const { e, took } = await fails(ConnectionLostError, () => gd.downloadBytes(D, '/tmp/x'));
    assert.deepEqual([e.kind, e.reason, e.exitCode], ['timeout', 'timeout', 255]);
    assert.match(e.message, /idleTimeoutMs/);
    assert.ok(took < 5000, `took ${took} ms`);
    const file = join(mkdtempSync(join(tmpdir(), 'gaiadesk-raw-')), 'x');
    await fails(ConnectionLostError, () => gd.download(D, '/tmp/x', file));
    assert.equal(existsSync(file), false);
    assert.equal(s.count('GET'), 2); // an idle timeout is not retried
  }));

test('a body that keeps flowing never times out: the idle limit is per read, not a deadline', () =>
  withServer('trickle', async (s) => {
    const gd = gdOf(s, { idleTimeoutMs: 1000 });
    const t = Date.now();
    const bytes = await within(gd.downloadBytes(D, '/tmp/slow'));
    assert.equal(new TextDecoder().decode(bytes), 'xxxxxxxx');
    assert.ok(Date.now() - t > 1500, 'the body took longer than the idle timeout in all');
  }));

test('stalled mid-JSON: ConnectionLostError (timeout)', () =>
  withServer('stallMidJson', async (s) => {
    const { e, took } = await fails(ConnectionLostError, () => gdOf(s).stats(D));
    assert.equal(e.kind, 'timeout');
    assert.ok(took < 5000, `took ${took} ms`);
    assert.equal(s.count('GET'), 1);
  }));

test('stalled mid-stream: the stream ends with a connection_lost / timeout exit (255)', () =>
  withServer('stallMidEvents', async (s) => {
    const gd = gdOf(s);
    const st = gd.execStream(D, 'tail -f log');
    let out = '';
    await within((async () => {
      for await (const c of st.text()) out += c.text;
    })(), 'execStream');
    const exit = await within(st.wait());
    assert.equal(out, 'hi');
    assert.deepEqual([exit.error?.kind, exit.error?.reason, exit.exitCode], ['connection_lost', 'timeout', 255]);
    assert.match(exit.stderrTail, /idleTimeoutMs/);
    const logs = await within(gd.followJobLogs(D, 'build').wait(), 'followJobLogs');
    assert.equal(logs.error?.kind, 'connection_lost');
  }));

test('a silent server: UnreachableError (timeout) within the response timeout, not retried; the caller can still abort', () =>
  withServer('silent', async (s) => {
    const gd = gdOf(s, { responseTimeoutMs: 1000 });
    const { e, took } = await fails(UnreachableError, () => gd.stats(D));
    assert.deepEqual([e.kind, e.reason, e.exitCode], ['timeout', 'timeout', 255]);
    assert.match(e.message, /responseTimeoutMs/);
    assert.ok(took < 5000, `took ${took} ms`);
    await fails(UnreachableError, () => gd.uploadBytes(new Uint8Array(4 * 1024 * 1024), D, '/tmp/big'));
    assert.equal(s.count('GET'), 1);
    assert.equal(s.count('PUT'), 1);
    // The caller's abort wins over a long response timeout, and is reported as an interruption.
    const patient = gdOf(s, { responseTimeoutMs: 600_000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const { e: aborted, took: t2 } = await fails(GaiaDeskError, () => patient.stats(D, { signal: ctrl.signal }));
    assert.equal(aborted.kind, 'interrupted');
    assert.ok(t2 < 5000, `took ${t2} ms`);
  }));

test('the caller aborting mid-body is an interruption, not a timeout', () =>
  withServer('stallMidJson', async (s) => {
    const gd = gdOf(s, { idleTimeoutMs: 600_000 });
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 200);
    const { e } = await fails(GaiaDeskError, () => gd.stats(D, { signal: ctrl.signal }));
    assert.equal(e.kind, 'interrupted');
    assert.equal(e instanceof ConnectionLostError, false);
  }));

test('stress: 300 dropped requests (close, reset, close after the body) never hang; uploads are sent once', () =>
  withServer('closeBeforeResponse', async (s) => {
    const gd = gdOf(s);
    const up = new Uint8Array(512 * 1024);
    const modes: RawMode[] = ['closeBeforeResponse', 'resetBeforeResponse', 'closeAfterBody'];
    for (let i = 0; i < 300; i++) {
      s.mode = modes[i % 3];
      const op = i % 2 === 0 ? gd.downloadBytes(D, '/tmp/x') : gd.uploadBytes(up, D, '/tmp/up');
      const { e } = await fails(UnreachableError, () => op);
      assert.equal(e.kind, 'network', `iteration ${i} (${s.mode})`);
    }
    assert.equal(s.count('PUT'), 150);
    assert.equal(s.count('GET'), 150);
  }));

test('timeouts are checked: positive milliseconds, or null / Infinity for no limit', () => {
  const o = (timeouts: unknown) => ({ apiKey: 'ak', timeouts } as GaiaDeskOptions);
  for (const bad of [{ idleTimeoutMs: 0 }, { responseTimeoutMs: -2000 }, { idleTimeoutMs: Number.NaN }, { responseTimeoutMs: '5000' }, { idleTimeoutMs: 2 ** 31 }, 5]) {
    assert.throws(() => new GaiaDesk(o(bad)), UsageError, JSON.stringify(bad));
  }
  new GaiaDesk(o({ idleTimeoutMs: null, responseTimeoutMs: null }));
  new GaiaDesk(o({ idleTimeoutMs: Infinity, responseTimeoutMs: Infinity }));
  new GaiaDesk({ transport: 'local', socketPath: '/nonexistent.sock', token: 't', timeouts: { idleTimeoutMs: 5000 } });
  assert.throws(() => new GaiaDesk({ timeouts: { idleTimeoutMs: 5000 } }), UsageError); // the direct transport has none
  assert.equal(DEFAULT_RESPONSE_TIMEOUT_MS, 16 * 60_000);
  assert.equal(DEFAULT_IDLE_TIMEOUT_MS, 90_000);
});

// The local transport (node:http over the desk's Unix socket) shares the same guard.
const unix = process.platform !== 'win32';
test('local transport: dropped, stalled and silent answers fail within the timeouts', { skip: !unix && 'Unix sockets' }, async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gdraw-'));
  const local = (s: RawServer, t: TimeoutOptions = {}) =>
    new GaiaDesk({ transport: 'local', socketPath: s.url, token: 'gdlocal_t', timeouts: { idleTimeoutMs: 1000, responseTimeoutMs: 1000, ...t } });
  await withServer('closeBeforeResponse', async (s) => {
    const { e } = await fails(UnreachableError, () => local(s).stats(D));
    assert.equal(e.kind, 'network');
    await fails(UnreachableError, () => local(s).uploadBytes(new Uint8Array(1024 * 1024), D, '/tmp/up'));
    assert.deepEqual([s.count('GET'), s.count('PUT')], [1, 1]);
  }, join(dir, 'close.sock'));
  await withServer('silent', async (s) => {
    const { e } = await fails(UnreachableError, () => local(s).stats(D));
    assert.equal(e.kind, 'timeout');
    assert.match(e.message, /responseTimeoutMs/);
  }, join(dir, 'silent.sock'));
  await withServer('stallMidJson', async (s) => {
    const { e } = await fails(ConnectionLostError, () => local(s).stats(D));
    assert.equal(e.kind, 'timeout');
  }, join(dir, 'json.sock'));
  await withServer('stallMidBody', async (s) => {
    const { e } = await fails(ConnectionLostError, () => local(s).downloadBytes(D, '/tmp/x'));
    assert.equal(e.kind, 'timeout');
  }, join(dir, 'body.sock'));
  await withServer('stallMidEvents', async (s) => {
    const exit = await within(local(s).execStream(D, 'tail -f log').wait());
    assert.deepEqual([exit.error?.kind, exit.error?.reason, exit.exitCode], ['connection_lost', 'timeout', 255]);
  }, join(dir, 'events.sock'));
});
