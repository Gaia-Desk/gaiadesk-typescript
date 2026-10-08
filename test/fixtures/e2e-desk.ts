// A desk's side of end-to-end encrypted desk operations, for the tests only:
// open a sealed request with the desk's static secret, seal events back,
// open input frames. Built from the SDK's own primitives (dist/e2e.js), in
// the order the protocol's crypto.rs gives, so a mock API can act as a desk.
import { aeadOpen, aeadSeal, associatedData, b64decode, b64url, deriveKeys, randomBytes, utf8, x25519, x25519Public } from '../../dist/e2e.js';
import type { OpKeys, SealedFrame, SealedRequest } from '../../dist/e2e.js';

export class DeskSeal {
  private nextInput = 0;
  private nextEvent = 0;
  constructor(private readonly keys: OpKeys, readonly desk: string, readonly op: string) {}

  sealEventWith(nonce: Uint8Array, plaintext: Uint8Array): SealedFrame {
    const seq = this.nextEvent++;
    const ct = aeadSeal(this.keys.event, nonce, associatedData('event', this.desk, this.op, seq), plaintext);
    return { seq, nonce: b64url(nonce), ciphertext: b64url(ct) };
  }

  /** Seal a desk event (`{"event": …}`) as JSON. */
  async sealEvent(event: unknown): Promise<SealedFrame> {
    return this.sealEventWith(await randomBytes(24), utf8(JSON.stringify(event)));
  }

  /** The caller's next input frame: `(last, bytes)`. */
  openInput(f: SealedFrame): { last: boolean; data: Uint8Array } {
    if (f.seq !== this.nextInput) throw new Error('input out of order');
    const plain = aeadOpen(this.keys.input, f.nonce, f.ciphertext, associatedData('input', this.desk, this.op, f.seq));
    this.nextInput++;
    if (plain[0] !== 0 && plain[0] !== 1) throw new Error('bad input flag');
    return { last: plain[0] === 1, data: plain.subarray(1) };
  }
}

/** Open a sealed request to `desk` as `op` with the desk's secret: its plaintext and the seal for the rest. */
export async function openRequest(deskSecret: Uint8Array, desk: string, op: string, req: SealedRequest): Promise<{ plain: Uint8Array; seal: DeskSeal }> {
  if (req.v !== 1) throw new Error('bad version');
  const ephPub = b64decode(req.pub);
  if (!ephPub || ephPub.length !== 32) throw new Error('bad pub');
  const deskPub = await x25519Public(deskSecret);
  const keys = await deriveKeys(await x25519(deskSecret, ephPub), ephPub, deskPub);
  const plain = aeadOpen(keys.request, req.nonce, req.ciphertext, associatedData('request', desk, op));
  return { plain, seal: new DeskSeal(keys, desk, op) };
}

