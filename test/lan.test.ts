// The lan transport on its own: a desk's LAN gateway over TLS with a
// self-signed certificate, pinned by its SHA-256 fingerprint before any
// request byte is sent; agent tokens only. (Behaviour shared with the other
// transports is in transports.test.ts.)
import { after, test } from 'node:test';
import assert from 'node:assert/strict';

import { FingerprintMismatchError, GaiaDesk, GaiaDeskError, UnreachableError, UsageError, normalizeFingerprint } from '../dist/index.js';
import type { GaiaDeskOptions } from '../dist/index.js';
import { startMockApi } from './fixtures/mock-api.js';
import { CERT, FINGERPRINT, KEY, OTHER_FINGERPRINT } from './fixtures/lan-cert.js';

const OK = '123456789';
const gw = await startMockApi({ desk: 'lan', tls: { key: KEY, cert: CERT } });
after(() => gw.close());

const lanGd = (o: GaiaDeskOptions = {}) => new GaiaDesk({ transport: 'lan', baseUrl: gw.url, fingerprint: FINGERPRINT, deskToken: 'gdagt_lan', ...o });
const last = () => gw.requests[gw.requests.length - 1];

test('normalizeFingerprint: with or without colons, any case, the same; anything else a UsageError', () => {
  const want = FINGERPRINT.toLowerCase();
  assert.match(want, /^([0-9a-f]{2}:){31}[0-9a-f]{2}$/);
  assert.equal(normalizeFingerprint(FINGERPRINT), want);
  assert.equal(normalizeFingerprint(want), want);
  assert.equal(normalizeFingerprint(FINGERPRINT.replace(/:/g, '')), want);
  assert.equal(normalizeFingerprint(FINGERPRINT.replace(/:/g, '').toLowerCase()), want);
  assert.equal(normalizeFingerprint(` ${FINGERPRINT.replace(/:/g, ' ')} `), want);
  assert.equal(normalizeFingerprint(`SHA256:${FINGERPRINT}`), want);
  for (const bad of ['', 'ab:cd', `${FINGERPRINT}:00`, FINGERPRINT.replace('7', 'g')]) assert.throws(() => normalizeFingerprint(bad), UsageError, bad);
});

test('the pinned fingerprint: the request goes through, with the agent token and no Authorization', async () => {
  const gd = lanGd();
  assert.equal(gd.backend, 'lan');
  const r = await gd.exec(OK, 'hostname');
  assert.deepEqual([r.exit, r.stdout], [0, 'ran: hostname\n']);
  assert.deepEqual([last().method, last().path], ['POST', `/v1/desks/${OK}/exec`]);
  assert.equal(last().headers['x-gaiadesk-desk-token'], 'gdagt_lan');
  assert.equal(last().headers.authorization, undefined);
  assert.equal(last().headers.host, new URL(gw.url).host);
  // Any spelling of the same fingerprint pins the same certificate.
  for (const fp of [FINGERPRINT.toLowerCase(), FINGERPRINT.replace(/:/g, ''), FINGERPRINT.replace(/:/g, '').toLowerCase()]) {
    assert.equal((await lanGd({ fingerprint: fp }).stats(OK)).desk, OK, fp);
  }
  // The per-call token wins.
  await gd.stats(OK, { deskToken: 'gdagt_call' });
  assert.equal(last().headers['x-gaiadesk-desk-token'], 'gdagt_call');
});

test('streams and files over the pinned connection', async () => {
  const s = lanGd().execStream(OK, 'exit 2');
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'part1 part2 exit 2\n');
  assert.equal((await s.wait()).exitCode, 2);
  await lanGd().uploadBytes('over the lan', OK, 'a.txt');
  assert.equal(last().body.toString(), 'over the lan');
  assert.equal(new TextDecoder().decode(await lanGd().downloadBytes(OK, 'a.txt')), 'contents of a.txt\n');
});

test('a wrong fingerprint: FingerprintMismatchError, and the gateway never received a request', async () => {
  const before = gw.requests.length;
  const conns = gw.connections;
  const gd = lanGd({ fingerprint: OTHER_FINGERPRINT });
  await assert.rejects(gd.exec(OK, 'rm -rf /'), (e) => {
    assert.ok(e instanceof FingerprintMismatchError);
    assert.ok(e instanceof UnreachableError, 'an UnreachableError too');
    assert.deepEqual([e.kind, e.reason, e.exitCode], ['unreachable', 'fingerprint_mismatch', 255]);
    assert.equal(e.expected, OTHER_FINGERPRINT.toLowerCase());
    assert.equal(e.actual, FINGERPRINT.toLowerCase());
    assert.match(e.message, /did not prove the pinned identity/);
    assert.match(e.message, /Do not proceed/);
    return true;
  });
  const exit = await gd.execStream(OK, 'x').wait();
  assert.deepEqual([exit.exitCode, exit.error?.reason], [255, 'fingerprint_mismatch']);
  assert.equal(gw.requests.length, before, 'no request reached the server');
  assert.ok(gw.connections > conns, 'the connection was made (the TLS handshake), then dropped');
});

test('no agent token is a UsageError (here or per call), and nothing is sent', async () => {
  const before = gw.requests.length;
  const gd = new GaiaDesk({ transport: 'lan', baseUrl: gw.url, fingerprint: FINGERPRINT });
  await assert.rejects(gd.stats(OK), (e) => e instanceof UsageError && /agent token/.test(e.message));
  assert.equal(gw.requests.length, before);
  assert.equal((await gd.stats(OK, { deskToken: 'gdagt_call' })).desk, OK, 'a per-call token is enough');
});

test("the lan transport's options are checked", () => {
  const base = { transport: 'lan' as const, baseUrl: gw.url, fingerprint: FINGERPRINT };
  assert.throws(() => new GaiaDesk({ ...base, baseUrl: gw.url.replace('https:', 'http:') }), UsageError, 'https only');
  assert.throws(() => new GaiaDesk({ transport: 'lan', fingerprint: FINGERPRINT }), UsageError, 'baseUrl required');
  assert.throws(() => new GaiaDesk({ transport: 'lan', baseUrl: gw.url }), UsageError, 'fingerprint required');
  assert.throws(() => new GaiaDesk({ ...base, fingerprint: 'abc' }), UsageError);
  assert.throws(() => new GaiaDesk({ ...base, token: 'gdlocal_x' }), UsageError, 'the admin token is local only');
  assert.throws(() => new GaiaDesk({ ...base, apiKey: 'ak_x' }), UsageError);
  assert.throws(() => new GaiaDesk({ ...base, socketPath: '/x' }), UsageError);
  assert.throws(() => new GaiaDesk({ ...base, deskToken: '' }), UsageError);
  assert.throws(() => new GaiaDesk({ fingerprint: FINGERPRINT }), UsageError, 'fingerprint needs transport: lan');
});

test('a gateway that is not there is UnreachableError/network; hosted-only operations are UsageErrors', async () => {
  const down = new GaiaDesk({ transport: 'lan', baseUrl: 'https://127.0.0.1:1/v1', fingerprint: FINGERPRINT, deskToken: 'gdagt_x' });
  await assert.rejects(down.stats(OK), (e) => e instanceof UnreachableError && !(e instanceof FingerprintMismatchError) && e.reason === 'network' && /LAN gateway/.test(e.message));
  await assert.rejects(lanGd().measure(OK), (e) => e instanceof GaiaDeskError && /not available over the lan transport/.test(e.message));
});
