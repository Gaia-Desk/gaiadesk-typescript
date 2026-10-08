// End-to-end encrypted desk operations, v1: the caller's side of the
// sealing the GaiaDesk API relays without reading (the contract:
// docs/api/README.md "End-to-end encryption"; the reference: the protocol
// crate's e2e.rs, whose fixed test vectors this module reproduces).
//
// Per operation: an ephemeral X25519 key pair; shared = X25519(eph, desk);
// prk = HKDF-SHA256-Extract("gaiadesk desk-op e2e v1", shared); one key per
// use (`request`, `input`, `event`) = HKDF-Expand(prk, label 0x00 eph_pub
// desk_pub, 32). Every message is XChaCha20-Poly1305 with a random 24-byte
// nonce and associated data naming the use, the desk, the operation and (for
// the streams) the message's place.
//
// Nothing here is home-made: X25519, HKDF and randomness come from the
// platform (node:crypto, else WebCrypto); XChaCha20-Poly1305, which neither
// has, from @noble/ciphers (MIT, audited, no dependencies).

import { xchacha20poly1305 } from '@noble/ciphers/chacha';

export const E2E_FEATURE = 'desk_op_e2e';
export const E2E_VERSION = 1;
/** The HTTP header that carries a sealed request on a call without a JSON body. */
export const E2E_HEADER = 'GaiaDesk-E2E';
export const E2E_FRAMES_CONTENT_TYPE = 'application/x-ndjson';
export const HKDF_SALT = 'gaiadesk desk-op e2e v1';
/** The most file bytes one sealed input frame carries. */
export const INPUT_CHUNK = 48 * 1024;

export type Use = 'request' | 'input' | 'event';

/** A sealed request: `{"e2e": …}` of a POST body, or the GaiaDesk-E2E header's JSON. */
export interface SealedRequest {
  v: number;
  pub: string;
  nonce: string;
  ciphertext: string;
}

/** A sealed frame after the request: an event coming back or a piece of input going up. */
export interface SealedFrame {
  seq: number;
  nonce: string;
  ciphertext: string;
}

/** Why a sealed message did not open (the protocol's reasons). */
export class E2eOpenError extends Error {
  constructor(readonly reason: 'e2e_malformed' | 'e2e_decrypt_failed' | 'e2e_weak_key', message: string) {
    super(message);
    this.name = 'E2eOpenError';
  }
}

// ───────────────────────────── bytes ─────────────────────────────

const enc = new TextEncoder();

export function utf8(s: string): Uint8Array {
  return enc.encode(s);
}

export function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

export function hex(s: string): Uint8Array {
  if (!/^(?:[0-9a-f]{2})*$/i.test(s)) throw new Error('not hex');
  const out = new Uint8Array(s.length / 2);
  for (let i = 0; i < out.length; i++) out[i] = parseInt(s.slice(i * 2, i * 2 + 2), 16);
  return out;
}

const B64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

/** Standard base64 with padding (a desk event's `data`). */
export function b64encode(b: Uint8Array): string {
  let out = '';
  for (let i = 0; i < b.length; i += 3) {
    const n = (b[i] << 16) | ((b[i + 1] ?? 0) << 8) | (b[i + 2] ?? 0);
    out += B64[(n >> 18) & 63] + B64[(n >> 12) & 63];
    out += i + 1 < b.length ? B64[(n >> 6) & 63] : '=';
    out += i + 2 < b.length ? B64[n & 63] : '=';
  }
  return out;
}

/** Standard or url-safe base64, padded or not; null when it is not base64. */
export function b64decode(s: string): Uint8Array | null {
  const t = s.trim().replace(/-/g, '+').replace(/_/g, '/').replace(/=+$/, '');
  if (!/^[A-Za-z0-9+/]*$/.test(t) || t.length % 4 === 1) return null;
  const out = new Uint8Array(Math.floor((t.length * 3) / 4));
  let bits = 0;
  let acc = 0;
  let at = 0;
  for (const c of t) {
    acc = (acc << 6) | B64.indexOf(c);
    bits += 6;
    if (bits >= 8) {
      bits -= 8;
      out[at++] = (acc >> bits) & 0xff;
    }
  }
  return out;
}

/** base64url without padding: every binary field of the envelope. */
export function b64url(b: Uint8Array): string {
  return b64encode(b).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ───────────────────────────── primitives ─────────────────────────────

/** X25519 and HKDF-SHA256, from node:crypto or WebCrypto. */
export interface Primitives {
  publicOf(secret: Uint8Array): Promise<Uint8Array>;
  x25519(secret: Uint8Array, pub: Uint8Array): Promise<Uint8Array>;
  hkdf(ikm: Uint8Array, salt: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array>;
  random(n: number): Uint8Array;
}

// RFC 8410 DER wrappers for a raw X25519 key.
const PKCS8_PREFIX = hex('302e020100300506032b656e04220420');
const SPKI_PREFIX = hex('302a300506032b656e032100');

type NodeCrypto = typeof import('node:crypto');

export function nodePrimitives(c: NodeCrypto): Primitives {
  const priv = (s: Uint8Array) => c.createPrivateKey({ key: Buffer.from(concat(PKCS8_PREFIX, s)), format: 'der', type: 'pkcs8' });
  return {
    async publicOf(secret) {
      const der = c.createPublicKey(priv(secret)).export({ format: 'der', type: 'spki' });
      return new Uint8Array(der.subarray(der.length - 32));
    },
    async x25519(secret, pub) {
      const publicKey = c.createPublicKey({ key: Buffer.from(concat(SPKI_PREFIX, pub)), format: 'der', type: 'spki' });
      return new Uint8Array(c.diffieHellman({ privateKey: priv(secret), publicKey }));
    },
    async hkdf(ikm, salt, info, length) {
      return new Uint8Array(c.hkdfSync('sha256', ikm, salt, info, length));
    },
    random: (n) => new Uint8Array(c.randomBytes(n)),
  };
}

interface SubtleLike {
  importKey(format: string, data: unknown, alg: unknown, extractable: boolean, usages: string[]): Promise<unknown>;
  exportKey(format: string, key: unknown): Promise<unknown>;
  deriveBits(alg: unknown, key: unknown, length: number): Promise<ArrayBuffer>;
}

export function webPrimitives(wc: { subtle: SubtleLike; getRandomValues(b: Uint8Array): Uint8Array }): Primitives {
  const s = wc.subtle;
  const priv = (secret: Uint8Array) => s.importKey('pkcs8', concat(PKCS8_PREFIX, secret), { name: 'X25519' }, true, ['deriveBits']);
  return {
    async publicOf(secret) {
      const jwk = (await s.exportKey('jwk', await priv(secret))) as { x?: string };
      const x = jwk.x ? b64decode(jwk.x) : null;
      if (!x || x.length !== 32) throw new Error('WebCrypto gave no X25519 public key');
      return x;
    },
    async x25519(secret, pub) {
      const publicKey = await s.importKey('raw', pub, { name: 'X25519' }, false, []);
      return new Uint8Array(await s.deriveBits({ name: 'X25519', public: publicKey }, await priv(secret), 256));
    },
    async hkdf(ikm, salt, info, length) {
      const k = await s.importKey('raw', ikm, 'HKDF', false, ['deriveBits']);
      return new Uint8Array(await s.deriveBits({ name: 'HKDF', hash: 'SHA-256', salt, info }, k, length * 8));
    },
    random: (n) => wc.getRandomValues(new Uint8Array(n)),
  };
}

let primitives: Promise<Primitives> | undefined;

/** node:crypto where there is one (Node, Deno, Bun), else the platform's WebCrypto. */
function prims(): Promise<Primitives> {
  primitives ??= (async () => {
    try {
      return nodePrimitives(await import('node:crypto'));
    } catch {
      const wc = (globalThis as { crypto?: { subtle?: SubtleLike; getRandomValues?(b: Uint8Array): Uint8Array } }).crypto;
      if (!wc?.subtle || !wc.getRandomValues) throw new Error('end-to-end encryption needs node:crypto or WebCrypto (X25519, HKDF)');
      return webPrimitives(wc as { subtle: SubtleLike; getRandomValues(b: Uint8Array): Uint8Array });
    }
  })();
  return primitives;
}

/** `n` random bytes from the platform. */
export async function randomBytes(n: number): Promise<Uint8Array> {
  return (await prims()).random(n);
}

/** The X25519 public key of a 32-byte secret. */
export async function x25519Public(secret: Uint8Array): Promise<Uint8Array> {
  return (await prims()).publicOf(secret);
}

/** X25519, refusing a non-contributory (all-zero) result. */
export async function x25519(secret: Uint8Array, pub: Uint8Array): Promise<Uint8Array> {
  let shared: Uint8Array;
  try {
    shared = await (await prims()).x25519(secret, pub);
  } catch {
    // OpenSSL refuses the all-zero result itself.
    throw new E2eOpenError('e2e_weak_key', 'the key exchange gave no shared secret (a low-order key)');
  }
  if (shared.every((b) => b === 0)) throw new E2eOpenError('e2e_weak_key', 'the key exchange gave no shared secret (a low-order key)');
  return shared;
}

/** The associated data: `"gaiadesk-e2e/v1 <use>" 0 desk 0 op`, then `0 seq` (u64 big-endian) for input and events. */
export function associatedData(use: Use, desk: string, op: string, seq?: number): Uint8Array {
  const head = concat(utf8(`gaiadesk-e2e/v1 ${use}`), Uint8Array.of(0), utf8(desk), Uint8Array.of(0), utf8(op));
  if (seq === undefined) return head;
  const s = new Uint8Array(8);
  new DataView(s.buffer).setBigUint64(0, BigInt(seq));
  return concat(head, Uint8Array.of(0), s);
}

/** One operation's three keys. */
export interface OpKeys {
  request: Uint8Array;
  input: Uint8Array;
  event: Uint8Array;
}

/** The keys from the exchange's shared secret and both public keys. */
export async function deriveKeys(shared: Uint8Array, ephPub: Uint8Array, deskPub: Uint8Array): Promise<OpKeys> {
  const p = await prims();
  const salt = utf8(HKDF_SALT);
  const key = (label: Use) => p.hkdf(shared, salt, concat(utf8(label), Uint8Array.of(0), ephPub, deskPub), 32);
  return { request: await key('request'), input: await key('input'), event: await key('event') };
}

/** XChaCha20-Poly1305 encryption: the ciphertext and its tag. */
export function aeadSeal(key: Uint8Array, nonce: Uint8Array, aad: Uint8Array, plaintext: Uint8Array): Uint8Array {
  return xchacha20poly1305(key, nonce, aad).encrypt(plaintext);
}

/** XChaCha20-Poly1305 decryption of base64url fields; E2eOpenError when it does not authenticate. */
export function aeadOpen(key: Uint8Array, nonce: string, ciphertext: string, aad: Uint8Array): Uint8Array {
  const n = b64decode(nonce);
  const c = b64decode(ciphertext);
  if (!n || n.length !== 24 || !c || c.length < 16) throw new E2eOpenError('e2e_malformed', 'a sealed message is malformed');
  try {
    return xchacha20poly1305(key, n, aad).decrypt(c);
  } catch {
    throw new E2eOpenError('e2e_decrypt_failed', 'a sealed message did not open: it was altered, reordered, or sealed for another desk or operation');
  }
}

// ───────────────────────────── the caller ─────────────────────────────

/** The caller's side of one operation after its request is sealed: its input going up, the desk's events coming back. */
export class CallerSeal {
  private nextInput = 0;
  private nextEvent = 0;

  constructor(private readonly keys: OpKeys, readonly desk: string, readonly op: string) {}

  /** The next piece of input (`last` on the final one, which may be empty), with a given nonce. */
  sealInputWith(nonce: Uint8Array, last: boolean, data: Uint8Array): SealedFrame {
    const seq = this.nextInput++;
    const ct = aeadSeal(this.keys.input, nonce, associatedData('input', this.desk, this.op, seq), concat(Uint8Array.of(last ? 1 : 0), data));
    return { seq, nonce: b64url(nonce), ciphertext: b64url(ct) };
  }

  async sealInput(last: boolean, data: Uint8Array): Promise<SealedFrame> {
    return this.sealInputWith(await randomBytes(24), last, data);
  }

  /** Open the desk's next event (it must be the next in order): its plaintext. */
  openEvent(f: unknown): Uint8Array {
    const fr = f as Partial<SealedFrame> | null;
    if (!fr || typeof fr !== 'object' || typeof fr.seq !== 'number' || typeof fr.nonce !== 'string' || typeof fr.ciphertext !== 'string') {
      throw new E2eOpenError('e2e_malformed', 'a sealed event is malformed');
    }
    if (fr.seq !== this.nextEvent) throw new E2eOpenError('e2e_decrypt_failed', `a sealed event is out of order (got ${fr.seq}, expected ${this.nextEvent})`);
    const plain = aeadOpen(this.keys.event, fr.nonce, fr.ciphertext, associatedData('event', this.desk, this.op, fr.seq));
    this.nextEvent++;
    return plain;
  }

  /** Open the next event as the desk event it carries (`{"event": "stdout" | "stderr" | "exit" | "error", …}`). */
  openDeskEvent(f: unknown): DeskEvent {
    const plain = this.openEvent(f);
    let v: unknown;
    try {
      v = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(plain));
    } catch {
      throw new E2eOpenError('e2e_malformed', 'a sealed event is not JSON');
    }
    const e = v as DeskEvent;
    if (typeof v !== 'object' || v === null || !['stdout', 'stderr', 'exit', 'error'].includes((e as { event?: string }).event ?? '')) {
      throw new E2eOpenError('e2e_malformed', 'a sealed event is not a desk event');
    }
    return e;
  }
}

/** What a sealed event opens to: the desk's own event. */
export type DeskEvent =
  | { event: 'stdout' | 'stderr'; data: string }
  | { event: 'exit'; result: unknown }
  | { event: 'error'; kind: string; message: string; reason?: string };

/**
 * Seal `plaintext` (the inner request's JSON) for desk `desk` (its key
 * `deskPub`) as operation `op`, with a given ephemeral secret and nonce: the
 * test vectors' entry point. Never reuse either.
 */
export async function sealRequestWith(eph: Uint8Array, nonce: Uint8Array, deskPub: Uint8Array, desk: string, op: string, plaintext: Uint8Array): Promise<{ request: SealedRequest; seal: CallerSeal }> {
  const ephPub = await x25519Public(eph);
  const keys = await deriveKeys(await x25519(eph, deskPub), ephPub, deskPub);
  const ct = aeadSeal(keys.request, nonce, associatedData('request', desk, op), plaintext);
  return { request: { v: E2E_VERSION, pub: b64url(ephPub), nonce: b64url(nonce), ciphertext: b64url(ct) }, seal: new CallerSeal(keys, desk, op) };
}

/** Seal a desk operation's request (`{"op": …}`) now: `{"v":1,"ts":<now>,"request":…}` under a fresh ephemeral key. */
export async function sealRequest(deskPub: Uint8Array, desk: string, op: string, request: Record<string, unknown>, now = Date.now()): Promise<{ request: SealedRequest; seal: CallerSeal }> {
  const inner = utf8(JSON.stringify({ v: E2E_VERSION, ts: Math.floor(now / 1000), request }));
  return sealRequestWith(await randomBytes(32), await randomBytes(24), deskPub, desk, op, inner);
}

/** The GaiaDesk-E2E header value of a sealed request: base64url of its JSON. */
export function requestHeader(r: SealedRequest): string {
  return b64url(utf8(JSON.stringify({ v: r.v, pub: r.pub, nonce: r.nonce, ciphertext: r.ciphertext })));
}

/** A desk key as given (`e2e_pub`, base64url): its 32 bytes, or null. */
export function deskKey(s: unknown): Uint8Array | null {
  if (typeof s !== 'string') return null;
  const k = b64decode(s);
  return k && k.length === 32 ? k : null;
}
