// A raw TCP "HTTP server" (node:net, no HTTP module in between) for the ways a
// real server or proxy fails: accept a request and close the socket before any
// response byte (FIN or RST, with or without reading the body), answer the
// headers and part of the body and then go silent with the socket open, never
// answer at all, answer an error status (with Retry-After), or keep a
// connection alive and then drop it under the next request. It proves what
// the SDK does on the wire itself, not what a test harness happens to do.

import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

/** An error answer: its status, `Retry-After` (seconds) and envelope reason. */
export interface StatusMode {
  status: number;
  retryAfter?: number;
  reason?: string;
  kind?: string;
}

export type RawMode =
  /** Read the request's headers, then close (FIN) before any response byte, leaving the body unread. */
  | 'closeBeforeResponse'
  /** Read the headers, then reset the connection (RST) before any response byte. */
  | 'resetBeforeResponse'
  /** Read the whole request (Content-Length or chunked body), then close before any response byte. */
  | 'closeAfterBody'
  /** Send 200 headers and one chunk of a chunked body, then nothing, with the socket left open. */
  | 'stallMidBody'
  /** Send 200 headers with a Content-Length larger than what follows, then nothing, the socket open. */
  | 'stallMidJson'
  /** Send 200 text/event-stream headers and one stdout event, then nothing, the socket open. */
  | 'stallMidEvents'
  /** Read the request and never answer. */
  | 'silent'
  /** A healthy but slow download: 8 chunks of `x`, 300 ms apart, then the end (2.4 s in all). */
  | 'trickle'
  /** Answer 200 with OK_JSON (an exec result; any object will do for other calls), then close. */
  | 'ok'
  /** Answer the first request on a connection 200 (OK_JSON, keep-alive); close under the next one on it, unanswered. */
  | 'keepAliveThenClose'
  /** Answer this status with an error envelope (after reading the body), then close. */
  | StatusMode;

export const OK_JSON = JSON.stringify({ desk: '123456789', exit: 0, remote_code: 0, stdout: 'ok', stderr: '', timed_out: false, error: null });

export interface RawServer {
  /** `http://127.0.0.1:<port>/v1` (TCP), or the socket path (`listen` given a path). */
  readonly url: string;
  readonly port: number;
  mode: RawMode;
  /** Requests received with this method. */
  count(method: string): number;
  close(): Promise<void>;
}

const EVENT = 'event: stdout\ndata: {"event":"stdout","data":"hi"}\n\n';
const REASON: Record<number, string> = { 200: 'OK', 409: 'Conflict', 429: 'Too Many Requests', 502: 'Bad Gateway', 503: 'Service Unavailable', 504: 'Gateway Timeout' };

function answer(status: number, body: string, extra = '', keepAlive = false): string {
  return `HTTP/1.1 ${status} ${REASON[status] ?? 'Status'}\r\nContent-Type: application/json\r\nContent-Length: ${Buffer.byteLength(body)}\r\n${extra}Connection: ${keepAlive ? 'keep-alive' : 'close'}\r\n\r\n${body}`;
}

function statusAnswer(m: StatusMode): string {
  const kind = m.kind ?? (m.status === 429 ? 'refused' : m.status === 409 ? 'usage' : 'unreachable');
  const reason = m.reason ?? (m.status === 429 ? 'rate_limited' : m.status === 409 ? 'idempotency_key_in_flight' : 'unavailable');
  const body = JSON.stringify({ error: { kind, message: `status ${m.status}`, reason, request_id: 'req_raw' } });
  return answer(m.status, body, m.retryAfter === undefined ? '' : `Retry-After: ${m.retryAfter}\r\n`);
}

/** A raw server on 127.0.0.1 (on `port`, default any), or on the Unix socket `path`. */
export async function startRawServer(mode: RawMode, path?: string, port = 0): Promise<RawServer> {
  const counts = new Map<string, number>();
  const open = new Set<Socket>();
  const state = { mode };

  const serve = (s: Socket) => {
    open.add(s);
    s.on('close', () => open.delete(s));
    s.on('error', () => {});
    let buf = Buffer.alloc(0);
    let head: string | null = null;
    let m: RawMode = state.mode;
    let need = -1; // body bytes to read before acting; -2: chunked
    let served = 0; // requests answered on this connection
    let acted = false;
    const now = (mode: RawMode) => {
      acted = true;
      switch (mode) {
        case 'closeBeforeResponse':
          s.end(); // FIN; any body still arriving is discarded
          return;
        case 'resetBeforeResponse':
          if (path) s.destroy(); // a Unix socket has no RST
          else s.resetAndDestroy();
          return;
        case 'stallMidBody':
          s.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\n\r\n5\r\nhello\r\n');
          return;
        case 'stallMidJson':
          s.write('HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: 100\r\n\r\n{"desk":');
          return;
        case 'stallMidEvents':
          s.write(`HTTP/1.1 200 OK\r\nContent-Type: text/event-stream\r\nTransfer-Encoding: chunked\r\n\r\n${Buffer.byteLength(EVENT).toString(16)}\r\n${EVENT}\r\n`);
          return;
        case 'silent':
          return; // held open, silent, until the server closes
        case 'trickle': {
          s.write('HTTP/1.1 200 OK\r\nContent-Type: application/octet-stream\r\nTransfer-Encoding: chunked\r\nConnection: close\r\n\r\n');
          let n = 0;
          const t = setInterval(() => {
            if (s.destroyed) return clearInterval(t);
            if (++n <= 8) return void s.write('1\r\nx\r\n');
            clearInterval(t);
            s.end('0\r\n\r\n');
          }, 300);
          return;
        }
      }
    };
    /** Once the whole request is in: what the modes that read it do. */
    const afterBody = (): boolean => {
      if (m === 'closeAfterBody') s.destroy();
      else if (m === 'ok') s.end(answer(200, OK_JSON));
      else if (m === 'keepAliveThenClose') {
        if (served++ > 0) {
          s.destroy();
        } else {
          s.write(answer(200, OK_JSON, 'Keep-Alive: timeout=60\r\n', true));
          return true; // the next request on this connection
        }
      } else if (typeof m === 'object') s.end(statusAnswer(m));
      acted = true;
      return false;
    };
    s.on('data', (d: Buffer) => {
      if (acted) return; // whatever else arrives (a body we do not read) is dropped
      buf = Buffer.concat([buf, d]);
      for (;;) {
        if (head === null) {
          const at = buf.indexOf('\r\n\r\n');
          if (at < 0) return;
          head = buf.subarray(0, at).toString('latin1');
          buf = buf.subarray(at + 4);
          const method = head.split(' ')[0];
          counts.set(method, (counts.get(method) ?? 0) + 1);
          if (served === 0) m = state.mode;
          if (typeof m === 'string' && !['closeAfterBody', 'ok', 'keepAliveThenClose'].includes(m)) return now(m);
          const len = /^content-length:\s*(\d+)/im.exec(head);
          need = len ? Number(len[1]) : /^transfer-encoding:\s*chunked/im.test(head) ? -2 : 0;
        }
        const last = buf.indexOf('\r\n0\r\n\r\n');
        const chunkedEnd = buf.subarray(0, 5).toString() === '0\r\n\r\n' ? 5 : last >= 0 ? last + 7 : -1;
        const end = need === -2 ? chunkedEnd : buf.length >= need ? need : -1;
        if (end < 0) return;
        buf = buf.subarray(end);
        head = null;
        if (!afterBody()) return;
      }
    });
  };

  const server: Server = createServer(serve);
  await new Promise<void>((resolve) => (path ? server.listen(path, resolve) : server.listen(port, '127.0.0.1', resolve)));
  const addr = server.address();
  const bound = typeof addr === 'object' && addr ? addr.port : 0;
  const url = path ?? `http://127.0.0.1:${bound}/v1`;
  return {
    url,
    port: bound,
    get mode() {
      return state.mode;
    },
    set mode(v: RawMode) {
      state.mode = v;
    },
    count: (method) => counts.get(method) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port on 127.0.0.1 that nothing listens on (bound, then closed). */
export async function freePort(): Promise<number> {
  const s = createServer();
  await new Promise<void>((resolve) => s.listen(0, '127.0.0.1', resolve));
  const addr = s.address();
  await new Promise<void>((resolve) => s.close(() => resolve()));
  return typeof addr === 'object' && addr ? addr.port : 0;
}
