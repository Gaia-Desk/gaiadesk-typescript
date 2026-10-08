// A raw TCP "HTTP server" (node:net, no HTTP module in between) for the ways a
// real server or proxy fails: accept a request and close the socket before any
// response byte (FIN or RST, with or without reading the body), answer the
// headers and part of the body and then go silent with the socket open, or
// never answer at all. It proves what the SDK does on the wire itself, not
// what a test harness happens to do. One request per connection.

import { createServer } from 'node:net';
import type { Server, Socket } from 'node:net';

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
  | 'trickle';

export interface RawServer {
  /** `http://127.0.0.1:<port>/v1` (TCP), or the socket path (`listen` given a path). */
  readonly url: string;
  mode: RawMode;
  /** Requests received with this method. */
  count(method: string): number;
  close(): Promise<void>;
}

const EVENT = 'event: stdout\ndata: {"event":"stdout","data":"hi"}\n\n';

/** A raw server on 127.0.0.1 (or on the Unix socket `path`). */
export async function startRawServer(mode: RawMode, path?: string): Promise<RawServer> {
  const counts = new Map<string, number>();
  const open = new Set<Socket>();
  const state = { mode };

  const serve = (s: Socket) => {
    open.add(s);
    s.on('close', () => open.delete(s));
    s.on('error', () => {});
    let buf = Buffer.alloc(0);
    let head: string | null = null;
    let need = -1; // Content-Length body bytes still to read (closeAfterBody), -2: chunked
    let acted = false;
    const act = (m: RawMode) => {
      acted = true;
      switch (m) {
        case 'closeBeforeResponse':
          s.end(); // FIN; any body still arriving is discarded
          s.on('data', () => {});
          return;
        case 'resetBeforeResponse':
          if (path) s.destroy(); // a Unix socket has no RST
          else s.resetAndDestroy();
          return;
        case 'closeAfterBody':
          s.destroy();
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
    s.on('data', (d: Buffer) => {
      if (acted) return; // whatever else arrives (a body we do not read) is dropped
      buf = Buffer.concat([buf, d]);
      if (head === null) {
        const at = buf.indexOf('\r\n\r\n');
        if (at < 0) return;
        head = buf.subarray(0, at).toString('latin1');
        buf = buf.subarray(at + 4);
        const method = head.split(' ')[0];
        counts.set(method, (counts.get(method) ?? 0) + 1);
        const m = state.mode;
        if (m !== 'closeAfterBody') return act(m);
        const len = /^content-length:\s*(\d+)/im.exec(head);
        need = len ? Number(len[1]) : /^transfer-encoding:\s*chunked/im.test(head) ? -2 : 0;
      }
      // closeAfterBody: the whole body first.
      if (need === -2 ? buf.includes('\r\n0\r\n\r\n') || buf.subarray(0, 5).toString() === '0\r\n\r\n' : buf.length >= need) act('closeAfterBody');
    });
  };

  const server: Server = createServer(serve);
  await new Promise<void>((resolve) => (path ? server.listen(path, resolve) : server.listen(0, '127.0.0.1', resolve)));
  const addr = server.address();
  const url = path ?? `http://127.0.0.1:${typeof addr === 'object' && addr ? addr.port : 0}/v1`;
  return {
    url,
    get mode() {
      return state.mode;
    },
    set mode(m: RawMode) {
      state.mode = m;
    },
    count: (method) => counts.get(method) ?? 0,
    close: () =>
      new Promise<void>((resolve) => {
        for (const s of open) s.destroy();
        server.close(() => resolve());
      }),
  };
}
