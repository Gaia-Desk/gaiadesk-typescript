// A FetchLike over node:http, for the transports that cannot use the global
// `fetch`: the `local` transport (HTTP/1.1 over the desk's Unix socket or
// Windows named pipe) and the `lan` transport (HTTPS to a self-signed gateway
// whose certificate is pinned before a byte of the request is sent). The
// ApiTransport runs on top of it unchanged: same requests, same results,
// same error envelopes, same SSE streams.
//
// Node modules are imported dynamically, as api.ts does, so a browser bundle
// that never uses these transports is not broken by a static import.

import type { Duplex } from 'node:stream';
import type { IncomingMessage } from 'node:http';
import type { ByteStreamLike } from './api-stream.js';
import type { FetchLike, ResponseLike } from './api.js';
import { markUnsent } from './api-retry.js';

/** How a request reaches the server, and the Host header it is sent with. */
export interface NodeFetchOptions {
  /** Opens the connection the request is written on (already verified, for a pinned TLS socket). */
  connect(url: URL, signal: AbortSignal | undefined): Promise<Duplex>;
  /** The Host header (default: the URL's host). */
  host?: string;
  /** The error for a connection that failed before any answer (never called for an abort). */
  unreachable(e: Error): Error;
}

function headersOf(res: IncomingMessage): { get(name: string): string | null } {
  return {
    get(name: string) {
      const v = res.headers[name.toLowerCase()];
      if (v === undefined) return null;
      return Array.isArray(v) ? v.join(', ') : String(v);
    },
  };
}

/** The response as a ResponseLike: its body read once, as a stream or whole. */
function responseOf(res: IncomingMessage): ResponseLike {
  const it = res[Symbol.asyncIterator]() as AsyncIterator<Buffer>;
  const body: ByteStreamLike = {
    getReader() {
      return {
        async read() {
          const r = await it.next();
          return r.done ? { done: true } : { done: false, value: new Uint8Array(r.value.buffer, r.value.byteOffset, r.value.byteLength) };
        },
        async cancel() {
          res.destroy();
        },
      };
    },
  };
  const all = async (): Promise<Buffer> => {
    const chunks: Buffer[] = [];
    for (;;) {
      const r = await it.next();
      if (r.done) break;
      chunks.push(r.value);
    }
    return Buffer.concat(chunks);
  };
  const status = res.statusCode ?? 0;
  return {
    ok: status >= 200 && status < 300,
    status,
    headers: headersOf(res),
    body,
    text: async () => (await all()).toString('utf8'),
    arrayBuffer: async () => {
      const b = await all();
      return b.buffer.slice(b.byteOffset, b.byteOffset + b.byteLength) as ArrayBuffer;
    },
  };
}

/** A FetchLike that writes each request on its own connection from `o.connect` (Connection: close). */
export function nodeFetch(o: NodeFetchOptions): FetchLike {
  return async (url, init) => {
    const http = await import('node:http');
    const u = new URL(url);
    const signal = init.signal;
    const aborted = () => Object.assign(new Error('aborted'), { name: 'AbortError' });
    if (signal?.aborted) throw aborted();
    let socket: Duplex;
    try {
      socket = await o.connect(u, signal);
    } catch (e) {
      if (signal?.aborted) throw aborted();
      // The connection was never made, so nothing was sent (sent again for any method) —
      // unless the transport refused it itself (lan: the pinned fingerprint did not match).
      const err = o.unreachable(e as Error);
      throw err === e ? err : markUnsent(err);
    }
    const body = init.body === undefined ? undefined : typeof init.body === 'string' ? Buffer.from(init.body, 'utf8') : Buffer.from(init.body.buffer, init.body.byteOffset, init.body.byteLength);
    const headers: Record<string, string> = { ...init.headers, Host: o.host ?? u.host };
    if (body !== undefined) headers['Content-Length'] = String(body.length);
    return new Promise<ResponseLike>((resolve, reject) => {
      let answered = false;
      const req = http.request({
        method: init.method,
        path: `${u.pathname}${u.search}`,
        headers,
        createConnection: () => socket as never,
      });
      const onAbort = () => req.destroy(aborted());
      signal?.addEventListener('abort', onAbort, { once: true });
      req.on('error', (e) => {
        if (answered) return;
        signal?.removeEventListener('abort', onAbort);
        reject(signal?.aborted ? aborted() : o.unreachable(e));
      });
      req.on('response', (res) => {
        answered = true;
        // An abort after the answer began ends its body (a stream's kill()).
        res.on('close', () => signal?.removeEventListener('abort', onAbort));
        signal?.addEventListener('abort', () => res.destroy(aborted()), { once: true });
        resolve(responseOf(res));
      });
      req.end(body);
    });
  };
}
