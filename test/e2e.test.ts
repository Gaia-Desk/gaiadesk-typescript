// End-to-end encryption's crypto: the protocol's fixed test vectors byte for
// byte (protocol/src/e2e/vectors.json, copied to fixtures/e2e-vectors.json),
// round trips, and every way a message must fail to open.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import {
  CallerSeal,
  E2eOpenError,
  associatedData,
  b64decode,
  b64encode,
  b64url,
  deskKey,
  hex,
  nodePrimitives,
  requestHeader,
  sealRequest,
  sealRequestWith,
  utf8,
  webPrimitives,
  x25519,
  x25519Public,
} from '../dist/e2e.js';
import { openRequest } from './fixtures/e2e-desk.js';

const V = JSON.parse(readFileSync(new URL('../test/fixtures/e2e-vectors.json', import.meta.url), 'utf8'));
const DESK_SECRET = hex(V.desk_secret_hex);
const dec = (b: Uint8Array) => new TextDecoder().decode(b);
const b = (s: string) => b64decode(s) as Uint8Array;
const toHex = (u: Uint8Array) => Array.from(u, (x) => x.toString(16).padStart(2, '0')).join('');

async function vectorSeal(): Promise<{ request: Awaited<ReturnType<typeof sealRequestWith>>['request']; seal: CallerSeal }> {
  const deskPub = await x25519Public(DESK_SECRET);
  return sealRequestWith(hex(V.eph_secret_hex), b(V.request.nonce), deskPub, V.desk_id, V.op, utf8(V.request_plaintext));
}

const isOpenError = (reason?: string) => (e: unknown) => e instanceof E2eOpenError && (reason === undefined || e.reason === reason);

test('vectors: the desk key, the sealed request and its header, byte for byte', async () => {
  assert.equal(b64url(await x25519Public(DESK_SECRET)), V.desk_pub);
  const { request } = await vectorSeal();
  assert.deepEqual(request, V.request);
  assert.equal(requestHeader(request), V.request_header);
});

test('vectors: associated data', () => {
  assert.equal(toHex(associatedData('request', V.desk_id, V.op)), V.aad_request_hex);
  assert.equal(toHex(associatedData('event', V.desk_id, V.op, 1)), V.aad_event_1_hex);
});

test('vectors: the events open, and the input frames seal to the same ciphertext', async () => {
  const { seal } = await vectorSeal();
  for (const e of V.events) assert.equal(dec(seal.openEvent(e)), e.plaintext);
  for (const i of V.inputs) assert.deepEqual(seal.sealInputWith(b(i.nonce), i.last, utf8(i.data)), { seq: i.seq, nonce: i.nonce, ciphertext: i.ciphertext });
  const again = (await vectorSeal()).seal;
  assert.deepEqual(again.openDeskEvent(V.events[0]), { event: 'stdout', data: 'dmVjdG9yCg==' });
  assert.deepEqual(again.openDeskEvent(V.events[1]), { event: 'exit', result: { exit: 0 } });
});

test('vectors: the desk side opens the request and the input frames', async () => {
  const { plain, seal } = await openRequest(DESK_SECRET, V.desk_id, V.op, V.request);
  assert.equal(dec(plain), V.request_plaintext);
  assert.deepEqual(seal.openInput(V.inputs[0]), { last: false, data: utf8('hello ') });
  assert.deepEqual(seal.openInput(V.inputs[1]), { last: true, data: utf8('world') });
  const ev = seal.sealEventWith(b(V.events[0].nonce), utf8(V.events[0].plaintext));
  assert.deepEqual(ev, { seq: 0, nonce: V.events[0].nonce, ciphertext: V.events[0].ciphertext });
});

test('round trip with fresh keys: request, input both ways, events in order', async () => {
  const deskPub = await x25519Public(DESK_SECRET);
  const { request, seal } = await sealRequest(deskPub, '123456789', 'file_put', { op: 'file_put', path: '/tmp/x', size: 3 });
  const desk = await openRequest(DESK_SECRET, '123456789', 'file_put', request);
  const inner = JSON.parse(dec(desk.plain));
  assert.equal(inner.v, 1);
  assert.ok(Math.abs(inner.ts - Date.now() / 1000) < 5);
  assert.deepEqual(inner.request, { op: 'file_put', path: '/tmp/x', size: 3 });
  const f = await seal.sealInput(true, utf8('abc'));
  assert.deepEqual(desk.seal.openInput(f), { last: true, data: utf8('abc') });
  for (const e of [{ event: 'stdout', data: b64encode(utf8('é')) }, { event: 'exit', result: { ok: 1 } }]) {
    assert.deepEqual(seal.openDeskEvent(await desk.seal.sealEvent(e)), e);
  }
  const other = await sealRequest(deskPub, '123456789', 'exec', { op: 'exec', spec: {} });
  assert.notEqual(other.request.pub, request.pub, 'a fresh ephemeral key per operation');
  assert.notEqual(other.request.nonce, request.nonce);
});

test('tampering: a flipped bit in the ciphertext, nonce or key does not open', async () => {
  const flip = (s: string, at = 0) => {
    const u = b(s);
    u[at] ^= 1;
    return b64url(u);
  };
  const { request } = await vectorSeal();
  for (const bad of [{ ...request, ciphertext: flip(request.ciphertext, 5) }, { ...request, nonce: flip(request.nonce) }, { ...request, pub: flip(request.pub, 3) }]) {
    await assert.rejects(openRequest(DESK_SECRET, V.desk_id, V.op, bad), isOpenError());
  }
  for (const e of [{ ...V.events[0], ciphertext: flip(V.events[0].ciphertext, 2) }, { ...V.events[0], nonce: flip(V.events[0].nonce, 23) }]) {
    const { seal } = await vectorSeal();
    assert.throws(() => seal.openEvent(e), isOpenError('e2e_decrypt_failed'));
  }
  const { seal } = await vectorSeal();
  assert.throws(() => seal.openEvent({ ...V.events[0], ciphertext: 'AAAA' }), isOpenError('e2e_malformed'));
  assert.throws(() => seal.openEvent({ seq: 0 }), isOpenError('e2e_malformed'));
});

test('associated data: another desk or another operation does not open', async () => {
  const { request } = await vectorSeal();
  await assert.rejects(openRequest(DESK_SECRET, '481902775', V.op, request), isOpenError('e2e_decrypt_failed'));
  await assert.rejects(openRequest(DESK_SECRET, V.desk_id, 'job_start', request), isOpenError('e2e_decrypt_failed'));
  const deskPub = await x25519Public(DESK_SECRET);
  const elsewhere = await sealRequestWith(hex(V.eph_secret_hex), b(V.request.nonce), deskPub, '481902775', V.op, utf8(V.request_plaintext));
  assert.throws(() => elsewhere.seal.openEvent(V.events[0]), isOpenError('e2e_decrypt_failed'), 'events for another desk');
  const otherOp = await sealRequestWith(hex(V.eph_secret_hex), b(V.request.nonce), deskPub, V.desk_id, 'stats', utf8(V.request_plaintext));
  assert.throws(() => otherOp.seal.openEvent(V.events[0]), isOpenError('e2e_decrypt_failed'), 'events for another operation');
});

test('event frames: reordered, replayed, renumbered or skipped do not open', async () => {
  const [e0, e1] = V.events;
  let { seal } = await vectorSeal();
  assert.throws(() => seal.openEvent(e1), isOpenError('e2e_decrypt_failed'), 'the second first');
  ({ seal } = await vectorSeal());
  seal.openEvent(e0);
  assert.throws(() => seal.openEvent(e0), isOpenError('e2e_decrypt_failed'), 'replayed');
  ({ seal } = await vectorSeal());
  assert.throws(() => seal.openEvent({ ...e1, seq: 0 }), isOpenError('e2e_decrypt_failed'), 'renumbered into place');
  ({ seal } = await vectorSeal());
  seal.openEvent(e0);
  assert.throws(() => seal.openEvent({ ...e0, seq: 1 }), isOpenError('e2e_decrypt_failed'), 'a replay renumbered');
  ({ seal } = await vectorSeal());
  seal.openEvent(e0);
  assert.equal(dec(seal.openEvent(e1)), e1.plaintext, 'in order it opens');
  // Input: the desk refuses a frame out of place too.
  const desk = await openRequest(DESK_SECRET, V.desk_id, V.op, V.request);
  assert.throws(() => desk.seal.openInput({ ...V.inputs[1], seq: 0 }));
});

test('keys: a low-order key gives no shared secret; deskKey reads 32 base64url bytes only', async () => {
  await assert.rejects(x25519(hex(V.eph_secret_hex), new Uint8Array(32)), isOpenError('e2e_weak_key'));
  assert.equal(deskKey(V.desk_pub)?.length, 32);
  assert.equal(deskKey(`${V.desk_pub}=`)?.length, 32, 'padding tolerated');
  assert.equal(deskKey('AAAA'), null);
  assert.equal(deskKey('not base64!'), null);
  assert.equal(deskKey(42), null);
});

test('base64: standard with padding, url-safe without', () => {
  for (const s of ['', 'f', 'fo', 'foo', 'foob', 'fooba', 'foobar']) {
    assert.equal(b64encode(utf8(s)), Buffer.from(s).toString('base64'));
    assert.equal(b64url(utf8(s)), Buffer.from(s).toString('base64url'));
    assert.equal(dec(b(Buffer.from(s).toString('base64'))), s);
  }
  assert.equal(b64decode('a'), null);
});

test('the WebCrypto path (browsers, serverless) gives what node:crypto gives', async (t) => {
  // Node 18 has no global WebCrypto (browsers and Node 19+ do): its node:crypto one then.
  type Wc = Parameters<typeof webPrimitives>[0];
  const wc = (globalThis as unknown as { crypto?: Wc }).crypto ?? ((await import('node:crypto')).webcrypto as unknown as Wc);
  const web = webPrimitives(wc);
  try {
    await web.publicOf(DESK_SECRET);
  } catch {
    return t.skip("this Node's WebCrypto has no X25519");
  }
  const node = nodePrimitives(await import('node:crypto'));
  const eph = hex(V.eph_secret_hex);
  assert.deepEqual(await web.publicOf(DESK_SECRET), await node.publicOf(DESK_SECRET));
  const deskPub = await node.publicOf(DESK_SECRET);
  const shared = await web.x25519(eph, deskPub);
  assert.deepEqual(shared, await node.x25519(eph, deskPub));
  const info = utf8('request\0info');
  assert.deepEqual(await web.hkdf(shared, utf8('salt'), info, 32), await node.hkdf(shared, utf8('salt'), info, 32));
  assert.equal(web.random(24).length, 24);
});
