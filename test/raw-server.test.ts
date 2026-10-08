// A server or proxy that drops or stalls a connection, on a raw socket
// (node:net, no HTTP server module): the api transport (global fetch) and the
// local transport (node:http over a Unix socket) fail with a clear transport
// error within their timeouts and never hang, and requests are sent again
// exactly as the retry rule says (api-retry.ts): a connection never made, any
// method; lost after sending or 502/503/504, GETs only; 429 and 409
// idempotency_key_in_flight, any method; timeouts never. fetch (undici) itself
// re-sends nothing, with or without a body, on a pooled connection closed
// before any answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { ConnectionLostError, DEFAULT_IDLE_TIMEOUT_MS, DEFAULT_RESPONSE_TIMEOUT_MS, DEFAULT_RETRY, GaiaDesk, GaiaDeskError, ProtocolError, RefusedError, UnreachableError, UsageError } from '../dist/index.js';
import type { GaiaDeskOptions, RetryOptions, TimeoutOptions } from '../dist/index.js';
import { backoffMs, resolveRetry, retryWait } from '../dist/api-retry.js';
import { freePort, startRawServer } from './fixtures/raw-server.js';
import type { RawMode, RawServer } from './fixtures/raw-server.js';

const D = '123456789';
/** A hang shows as this, not as a stuck run. */
const BOUND = 10_000;

const gdOf = (s: RawServer | string, t: TimeoutOptions = {}, retry: RetryOptions = {}) =>
  new GaiaDesk({ apiKey: 'ak_t', deskToken: 'gdagt_t', baseUrl: typeof s === 'string' ? s : s.url, e2e: 'off', timeouts: { idleTimeoutMs: 1000, responseTimeoutMs: 30_000, ...t }, retry: { maxRetries: 2, baseDelayMs: 5, ...retry } });

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
  test(`${mode}: a read is tried 3 times, then UnreachableError (network); with retries 0, once`, () =>
    withServer(mode, async (s) => {
      const gd = gdOf(s);
      const { e, took } = await fails(UnreachableError, () => gd.downloadBytes(D, '/tmp/x'));
      assert.deepEqual([e.kind, e.reason, e.argv], ['network', 'network', ['GET /desks/123456789/files']]);
      assert.ok(took < 5000, `took ${took} ms`);
      assert.equal(s.count('GET'), 3); // the first try and two retries; fetch itself re-sends nothing
      await fails(UnreachableError, () => gd.stats(D));
      assert.equal(s.count('GET'), 6);
      await fails(UnreachableError, () => gdOf(s, {}, { maxRetries: 0 }).stats(D));
      assert.equal(s.count('GET'), 7);
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
      await fails(UnreachableError, () => gd.exec(D, 'deploy', { idempotencyKey: 'deploy-42' })); // a key never unlocks a retry
      assert.equal(s.count('POST'), 4);
      await fails(UnreachableError, () => gd.killJob(D, 'nightly'));
      assert.equal(s.count('DELETE'), 1);
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
    assert.equal(s.count('GET'), 1); // a timeout is never retried
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
    const gd = gdOf(s, {}, { maxRetries: 1 });
    const up = new Uint8Array(512 * 1024);
    const modes: RawMode[] = ['closeBeforeResponse', 'resetBeforeResponse', 'closeAfterBody'];
    for (let i = 0; i < 300; i++) {
      s.mode = modes[i % 3];
      const op = i % 2 === 0 ? gd.downloadBytes(D, '/tmp/x') : gd.uploadBytes(up, D, '/tmp/up');
      const { e } = await fails(UnreachableError, () => op);
      assert.equal(e.kind, 'network', `iteration ${i} (${s.mode})`);
    }
    assert.equal(s.count('PUT'), 150); // every upload sent exactly once
    assert.equal(s.count('GET'), 300); // every read tried twice
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
    new GaiaDesk({ transport: 'local', socketPath: s.url, token: 'gdlocal_t', timeouts: { idleTimeoutMs: 1000, responseTimeoutMs: 1000, ...t }, retry: { baseDelayMs: 5 } });
  await withServer('closeBeforeResponse', async (s) => {
    const { e } = await fails(UnreachableError, () => local(s).stats(D));
    assert.equal(e.kind, 'network');
    await fails(UnreachableError, () => local(s).uploadBytes(new Uint8Array(1024 * 1024), D, '/tmp/up'));
    assert.deepEqual([s.count('GET'), s.count('PUT')], [3, 1]);
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

// ───────────────────────────── retries ─────────────────────────────

test('a connection never made is sent again for any method: an exec reaches the server once, when it appears', async () => {
  const port = await freePort();
  const url = `http://127.0.0.1:${port}/v1`;
  let s: RawServer | null = null;
  const later = setTimeout(async () => {
    s = await startRawServer('ok', undefined, port);
  }, 100);
  try {
    const r = await within(gdOf(url, {}, { maxRetries: 6, baseDelayMs: 100, maxDelayMs: 200 }).exec(D, 'deploy'));
    assert.equal(r.stdout, 'ok');
    assert.equal((s as RawServer | null)?.count('POST'), 1);
  } finally {
    clearTimeout(later);
    await (s as RawServer | null)?.close();
  }
  const closed = await freePort();
  const { e, took } = await fails(UnreachableError, () => gdOf(`http://127.0.0.1:${closed}/v1`, {}, { maxRetries: 0, baseDelayMs: 10_000 }).exec(D, 'deploy'));
  assert.equal(e.kind, 'network');
  assert.match(e.message, /ECONNREFUSED/);
  assert.ok(took < 1000, `took ${took} ms`);
});

for (const status of [502, 503, 504]) {
  test(`${status}: a GET is tried 3 times, a POST once`, () =>
    withServer({ status }, async (s) => {
      const gd = gdOf(s);
      const { e } = await fails(GaiaDeskError, () => gd.stats(D));
      assert.equal(e.status, status);
      assert.equal(s.count('GET'), 3);
      await fails(GaiaDeskError, () => gd.exec(D, 'deploy'));
      assert.equal(s.count('POST'), 1);
    }));
}

test('503: a switched-off API is final; Retry-After is honoured; the caller aborts a wait at once', async () => {
  for (const reason of ['api_disabled', 'desk_ops_disabled', 'local_api_off']) {
    await withServer({ status: 503, reason }, async (s) => {
      const { e } = await fails(UnreachableError, () => gdOf(s).stats(D));
      assert.equal(e.reason, reason);
      assert.equal(s.count('GET'), 1);
    });
  }
  await withServer({ status: 503, retryAfter: 1 }, async (s) => {
    const { took } = await fails(UnreachableError, () => gdOf(s, {}, { maxRetries: 1 }).stats(D));
    assert.equal(s.count('GET'), 2);
    assert.ok(took >= 950, `waited only ${took} ms`);
  });
  await withServer({ status: 503, retryAfter: 30 }, async (s) => {
    const ctrl = new AbortController();
    setTimeout(() => ctrl.abort(), 150);
    const { e, took } = await fails(GaiaDeskError, () => gdOf(s).stats(D, { signal: ctrl.signal }));
    assert.equal(e.kind, 'interrupted');
    assert.ok(took < 2000, `took ${took} ms`);
    assert.equal(s.count('GET'), 1);
  });
});

test('429: any method is sent again after Retry-After; one longer than maxRetryWaitMs is thrown at once', async () => {
  await withServer({ status: 429, retryAfter: 0 }, async (s) => {
    const { e } = await fails(RefusedError, () => gdOf(s).exec(D, 'deploy'));
    assert.deepEqual([e.status, e.reason, e.retryAfter], [429, 'rate_limited', 0]);
    assert.equal(s.count('POST'), 3);
  });
  await withServer({ status: 429, retryAfter: 120, reason: 'desk_busy' }, async (s) => {
    const { e, took } = await fails(RefusedError, () => gdOf(s).exec(D, 'deploy'));
    assert.deepEqual([e.status, e.reason, e.retryAfter], [429, 'desk_busy', 120]);
    assert.ok(took < 1000, `took ${took} ms`);
    assert.equal(s.count('POST'), 1);
  });
});

test('409 idempotency_key_in_flight: any method is sent again (the server did not act)', () =>
  withServer({ status: 409 }, async (s) => {
    const gd = gdOf(s);
    const { e } = await fails(UsageError, () => gd.exec(D, 'deploy', { idempotencyKey: 'k1' }));
    assert.equal(e.reason, 'idempotency_key_in_flight');
    assert.equal(s.count('POST'), 3);
    await fails(UsageError, () => gd.uploadBytes('x', D, '/tmp/x'));
    assert.equal(s.count('PUT'), 3);
    await fails(UsageError, () => gd.killJob(D, 'nightly'));
    assert.equal(s.count('DELETE'), 3);
  }));

test('other statuses are never sent again', () =>
  withServer({ status: 500, kind: 'protocol', reason: 'internal' }, async (s) => {
    await fails(ProtocolError, () => gdOf(s).stats(D));
    assert.equal(s.count('GET'), 1);
  }));

test('a kept-alive connection dropped under the next request: a GET is sent again, a DELETE, POST or PUT never', () =>
  withServer('keepAliveThenClose', async (s) => {
    const gd = gdOf(s);
    const warm = async () => {
      const before = s.count('GET');
      await within(gd.stats(D));
      assert.equal(s.count('GET'), before + 1);
      await new Promise((r) => setTimeout(r, 30)); // fetch puts the connection back in its pool
    };
    await warm();
    const { e } = await fails(UnreachableError, () => gd.killJob(D, 'nightly'));
    assert.equal(e.kind, 'network');
    assert.equal(s.count('DELETE'), 1);
    await warm();
    await fails(UnreachableError, () => gd.exec(D, 'deploy'));
    assert.equal(s.count('POST'), 1);
    await warm();
    await fails(UnreachableError, () => gd.uploadBytes('x', D, '/tmp/x'));
    assert.equal(s.count('PUT'), 1);
    await warm();
    const before = s.count('GET');
    await within(gd.stats(D)); // dropped on the reused connection, then answered on a new one
    assert.equal(s.count('GET'), before + 2);
  }));

test('retries 0: every failure is sent exactly once', async () => {
  const modes: RawMode[] = ['closeBeforeResponse', 'resetBeforeResponse', 'closeAfterBody', { status: 502 }, { status: 503 }, { status: 504 }, { status: 429, retryAfter: 0 }, { status: 409 }];
  for (const mode of modes) {
    await withServer(mode, async (s) => {
      const gd = gdOf(s, {}, { maxRetries: 0 });
      await fails(GaiaDeskError, () => gd.stats(D));
      await fails(GaiaDeskError, () => gd.exec(D, 'deploy'));
      assert.deepEqual([s.count('GET'), s.count('POST')], [1, 1], JSON.stringify(mode));
    });
  }
});

test('the delays: backoff 250 ms doubling to 8 s times 0.5-1.0; Retry-After up to 60 s', () => {
  assert.deepEqual({ ...DEFAULT_RETRY }, { maxRetries: 2, baseDelayMs: 250, maxDelayMs: 8000, maxRetryWaitMs: 60_000 });
  const r = resolveRetry(undefined);
  assert.equal(backoffMs(0, r, () => 0), 125);
  assert.equal(backoffMs(0, r, () => 1), 250);
  assert.equal(backoffMs(3, r, () => 1), 2000);
  assert.equal(backoffMs(5, r, () => 1), 8000);
  assert.equal(backoffMs(10, r, () => 0), 4000);
  for (let i = 0; i < 200; i++) {
    const d = backoffMs(1, r);
    assert.ok(d >= 250 && d <= 500, String(d));
  }
  const limited = (retryAfter: number | null, status = 429) => new RefusedError('x', { kind: 'refused', reason: 'rate_limited', status, retryAfter });
  assert.equal(retryWait(limited(60), 'POST', 0, r), 60_000);
  assert.equal(retryWait(limited(61), 'POST', 0, r), null);
  assert.equal(retryWait(limited(null), 'POST', 1, r, () => 1), 500);
  assert.equal(retryWait(limited(0), 'POST', 2, r), null, 'after maxRetries');
  const lost = new UnreachableError('x', { kind: 'network', reason: 'network' });
  assert.equal(retryWait(lost, 'POST', 0, r), null);
  assert.equal(retryWait(lost, 'DELETE', 0, r), null);
  assert.equal(retryWait(lost, 'GET', 0, r, () => 0), 125);
  assert.equal(retryWait(new UnreachableError('x', { kind: 'timeout', reason: 'timeout' }), 'GET', 0, r), null);
  assert.equal(retryWait(new ConnectionLostError('x', { kind: 'network' }), 'GET', 0, r), null, 'an answer that began');
});

test('retry options are checked', () => {
  const o = (retry: unknown) => ({ apiKey: 'ak', retry } as GaiaDeskOptions);
  for (const bad of [{ maxRetries: -1 }, { maxRetries: 1.5 }, { baseDelayMs: Number.NaN }, { maxDelayMs: -5 }, { maxRetryWaitMs: '60' }, 3]) {
    assert.throws(() => new GaiaDesk(o(bad)), UsageError, JSON.stringify(bad));
  }
  new GaiaDesk(o({ maxRetries: 0, baseDelayMs: 0, maxDelayMs: 0, maxRetryWaitMs: 0 }));
  assert.throws(() => new GaiaDesk({ retry: { maxRetries: 1 } }), UsageError); // the direct transport has none
});

test('idempotencyKey: sent on a POST, checked, refused elsewhere', () =>
  withServer('ok', async (s) => {
    const gd = gdOf(s);
    await assert.rejects(gd.exec(D, 'x', { idempotencyKey: '' }), UsageError);
    await assert.rejects(gd.exec(D, 'x', { idempotencyKey: 'é' }), UsageError);
    await assert.rejects(gd.stats(D, { idempotencyKey: 'k' }), UsageError);
    assert.equal(s.count('POST') + s.count('GET'), 0);
    await within(gd.exec(D, 'x', { idempotencyKey: 'k-1' }));
    assert.equal(s.count('POST'), 1);
  }));

test('local transport: a socket that is not there yet is a connection never made, sent again for any method', { skip: !unix && 'Unix sockets' }, async () => {
  const path = join(mkdtempSync(join(tmpdir(), 'gdraw-')), 'late.sock');
  let s: RawServer | null = null;
  const later = setTimeout(async () => {
    s = await startRawServer('ok', path);
  }, 100);
  try {
    const gd = new GaiaDesk({ transport: 'local', socketPath: path, token: 'gdlocal_t', retry: { maxRetries: 6, baseDelayMs: 100, maxDelayMs: 200 } });
    const r = await within(gd.exec(D, 'deploy'));
    assert.equal(r.stdout, 'ok');
    assert.equal((s as RawServer | null)?.count('POST'), 1);
  } finally {
    clearTimeout(later);
    await (s as RawServer | null)?.close();
  }
});
