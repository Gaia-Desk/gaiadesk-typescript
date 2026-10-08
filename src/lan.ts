// The `lan` transport: a desk's opt-in LAN gateway, `https://<desk>:7443/v1`,
// serving the same /v1 desk operations as the hosted API (the ApiTransport
// runs over it unchanged). Its certificate is self-signed, so the chain and
// the host name cannot be checked: the SHA-256 of the certificate is pinned
// instead (the fingerprint the desk shows in Settings), and checked after the
// TLS handshake and BEFORE any byte of the request is written. The gateway
// takes agent tokens only (the admin token is local-only), as
// X-GaiaDesk-Desk-Token.

import { ApiTransport } from './api.js';
import type { TimeoutOptions } from './api-timeouts.js';
import type { RetryOptions } from './api-retry.js';
import { UnreachableError, UsageError } from './errors.js';
import type { ErrorDetails } from './errors.js';
import { nodeFetch } from './node-http.js';

/** The LAN gateway's certificate did not match the pinned fingerprint: it is not the desk you pinned. Do not proceed. */
export class FingerprintMismatchError extends UnreachableError {
  /** The pinned fingerprint and the one the server presented (`ab:cd:…`). */
  readonly expected: string;
  readonly actual: string;
  constructor(message: string, expected: string, actual: string, details: ErrorDetails = {}) {
    super(message, details);
    this.expected = expected;
    this.actual = actual;
  }
}

/**
 * A SHA-256 certificate fingerprint as the desk shows it: 32 lowercase hex
 * pairs joined by `:`. Takes it with or without colons (or spaces), any
 * case; anything else is a UsageError.
 */
export function normalizeFingerprint(fp: string): string {
  if (typeof fp !== 'string') throw new UsageError('fingerprint must be a string (the SHA-256 the desk shows, ab:cd:…)', { kind: 'usage' });
  const hex = fp.trim().replace(/^sha-?256[:=\s]*/i, '').replace(/[:\s]/g, '').toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(hex)) {
    throw new UsageError(`fingerprint must be the certificate's SHA-256: 32 hex pairs (ab:cd:…), not ${JSON.stringify(fp)}`, { kind: 'usage' });
  }
  return hex.match(/../g)!.join(':');
}

export interface LanOptions {
  /** The gateway's base URL, `https://<host>:7443/v1`. */
  baseUrl: string;
  /** The gateway certificate's SHA-256 fingerprint, as the desk shows it. */
  fingerprint: string;
  /** The agent token (`gdagt_…`); required here or on each call. */
  deskToken?: string;
  /** Network timeouts (as the API transport's). */
  timeouts?: TimeoutOptions;
  /** Retries (as the API transport's). */
  retry?: RetryOptions;
}

/** The `lan` transport: an ApiTransport over pinned TLS to a desk's LAN gateway. */
export function lanTransport(o: LanOptions): ApiTransport {
  if (typeof o.baseUrl !== 'string' || !/^https:\/\/[^/]/i.test(o.baseUrl)) {
    throw new UsageError(`the lan transport needs an https:// baseUrl (https://<desk>:7443/v1), not ${JSON.stringify(o.baseUrl)}`, { kind: 'usage' });
  }
  if (o.fingerprint === undefined) throw new UsageError("the lan transport needs the gateway certificate's fingerprint (Settings → GaiaDesk API → LAN gateway)", { kind: 'usage' });
  const pinned = normalizeFingerprint(o.fingerprint);
  if (o.deskToken !== undefined && (typeof o.deskToken !== 'string' || !o.deskToken.trim())) {
    throw new UsageError('deskToken must be a non-empty string (a scoped agent token, gdagt_…)', { kind: 'usage' });
  }
  const deskToken = o.deskToken?.trim();
  const baseUrl = o.baseUrl.replace(/\/+$/, '');
  const origin = new URL(baseUrl).host;

  const fetch = nodeFetch({
    async connect(url, signal) {
      const tls = await import('node:tls');
      const net = await import('node:net');
      const host = url.hostname.replace(/^\[|\]$/g, '');
      const port = Number(url.port || 443);
      const socket = await new Promise<import('node:tls').TLSSocket>((resolve, reject) => {
        const s = tls.connect({ host, port, servername: net.isIP(host) ? undefined : host, rejectUnauthorized: false, ALPNProtocols: ['http/1.1'] });
        const onAbort = () => s.destroy(new Error('aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        s.once('secureConnect', () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(s);
        });
        s.once('error', (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        });
      });
      const raw = socket.getPeerCertificate()?.raw;
      const { createHash } = await import('node:crypto');
      const actual = raw && raw.length ? normalizeFingerprint(createHash('sha256').update(raw).digest('hex')) : '';
      if (actual !== pinned) {
        socket.destroy();
        throw new FingerprintMismatchError(
          `the desk at ${url.host} did not prove the pinned identity: its certificate's SHA-256 is ${actual || '(none)'}, not ${pinned}. ` +
            'Do not proceed: this may not be your desk. Check the fingerprint in its Settings → GaiaDesk API.',
          pinned,
          actual,
          { kind: 'unreachable', reason: 'fingerprint_mismatch', exitCode: 255 },
        );
      }
      return socket;
    },
    unreachable(e) {
      if (e instanceof FingerprintMismatchError) return e;
      return new UnreachableError(`the desk's LAN gateway (${origin}) could not be reached: ${e.message}`, { kind: 'network', reason: 'network', exitCode: 255 });
    },
  });

  return new ApiTransport({
    transport: 'lan',
    baseUrl,
    where: `the desk's LAN gateway (${origin})`,
    fetch,
    timeouts: o.timeouts,
    retry: o.retry,
    credentials(callToken) {
      const t = callToken ?? deskToken;
      if (!t) {
        throw new UsageError("the lan transport needs an agent token (deskToken, gdagt_…): a desk's LAN gateway does not take its admin token", { kind: 'usage' });
      }
      return { 'X-GaiaDesk-Desk-Token': t };
    },
  });
}
