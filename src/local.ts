// The `local` transport: code running ON the desk talks to the GaiaDesk app's
// own /v1 API over a Unix socket (macOS, Linux) or a named pipe (Windows).
// Same operations, results and errors as the hosted API (the ApiTransport
// runs over it unchanged); only the connection and the credentials differ:
//
//   socket  $GAIADESK_API_DIR/api.sock, else ~/.gaiadesk/api.sock
//   pipe    $GAIADESK_API_PIPE, else \\.\pipe\gaiadesk-api-<user>
//   token   an agent token (deskToken) as X-GaiaDesk-Desk-Token, else the
//           desk's local admin token (gdlocal_…, $GAIADESK_API_DIR/api-token,
//           else ~/.gaiadesk/api-token) as `Authorization: Bearer`.

import { ApiTransport } from './api.js';
import type { TimeoutOptions } from './api-timeouts.js';
import type { RetryOptions } from './api-retry.js';
import { GaiaDeskError, UnreachableError, UsageError } from './errors.js';
import { nodeFetch } from './node-http.js';

export type Env = Record<string, string | undefined>;

/** What a missing socket or pipe means, as the error says it. */
export const LOCAL_API_UNAVAILABLE = 'GaiaDesk is not serving its local API here: is the app running, and is Settings → GaiaDesk API → Local API on?';

/** The pipe-name form of a user name: lowercased, `[a-z0-9._-]` kept, the rest `_`, at most 64 characters, `user` if empty. */
export function pipeUser(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9._-]/g, '_').slice(0, 64);
  return s || 'user';
}

/** The local API's Windows pipe: `$GAIADESK_API_PIPE`, else `\\.\pipe\gaiadesk-api-<user>` (`<user>`: $USERNAME, else `username`). */
export function localPipeName(env: Env, username = ''): string {
  if (env.GAIADESK_API_PIPE) return env.GAIADESK_API_PIPE;
  return `\\\\.\\pipe\\gaiadesk-api-${pipeUser(env.USERNAME || username)}`;
}

function isAbsolute(p: string, platform: string): boolean {
  return platform === 'win32' ? /^(?:[a-zA-Z]:[\\/]|[\\/]{2})/.test(p) : p.startsWith('/');
}

function joinPath(dir: string, name: string, platform: string): string {
  const sep = platform === 'win32' ? '\\' : '/';
  return `${dir.replace(/[\\/]+$/, '')}${sep}${name}`;
}

/** The directory of the local API's socket and token: `$GAIADESK_API_DIR` when it is absolute, else `<home>/.gaiadesk`. */
export function localApiDir(env: Env, home: string, platform: string): string {
  const d = env.GAIADESK_API_DIR;
  if (d && isAbsolute(d, platform)) return d;
  return joinPath(home, '.gaiadesk', platform);
}

/** The local API's Unix socket (macOS, Linux). */
export function localSocketPath(env: Env, home: string, platform: string): string {
  return joinPath(localApiDir(env, home, platform), 'api.sock', platform);
}

/** The file holding the desk's local admin token (`gdlocal_` + 64 hex digits). */
export function localTokenPath(env: Env, home: string, platform: string): string {
  return joinPath(localApiDir(env, home, platform), 'api-token', platform);
}

export interface LocalOptions {
  /** The socket path or pipe name (default: as above). */
  socketPath?: string;
  /** The desk's local admin token (default: read from its file on each request). */
  token?: string;
  /** An agent token (`gdagt_…`): sent instead of the admin token. */
  deskToken?: string;
  /** The environment the defaults are read from (default: this process's). */
  env?: Env;
  /** Network timeouts (as the API transport's). */
  timeouts?: TimeoutOptions;
  /** Retries (as the API transport's). */
  retry?: RetryOptions;
}

function nonEmpty(v: string | undefined, what: string): string | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== 'string' || !v.trim()) throw new UsageError(`${what} must be a non-empty string`, { kind: 'usage' });
  return v.trim();
}

/** The `local` transport: an ApiTransport over the desk's socket or pipe. */
export function localTransport(o: LocalOptions = {}): ApiTransport {
  const explicitPath = nonEmpty(o.socketPath, 'socketPath');
  const token = nonEmpty(o.token, 'token');
  const deskToken = nonEmpty(o.deskToken, 'deskToken');
  const env = o.env ?? process.env;
  let where: string | undefined = explicitPath;
  const target = async (): Promise<string> => {
    if (where) return where;
    const os = await import('node:os');
    if (process.platform === 'win32') {
      let user = '';
      try {
        user = os.userInfo().username;
      } catch {
        /* no user entry: `user` */
      }
      where = localPipeName(env, user);
    } else {
      where = localSocketPath(env, os.homedir(), process.platform);
    }
    return where;
  };
  const unavailable = (path: string, e?: Error) =>
    new UnreachableError(`${LOCAL_API_UNAVAILABLE} (${path}${e ? `: ${e.message}` : ''})`, { kind: 'unreachable', reason: 'local_api_unavailable', exitCode: 255 });

  const fetch = nodeFetch({
    host: 'localhost',
    async connect(_url, signal) {
      const net = await import('node:net');
      const path = await target();
      return new Promise((resolve, reject) => {
        const s = net.createConnection(path);
        const onAbort = () => s.destroy(new Error('aborted'));
        signal?.addEventListener('abort', onAbort, { once: true });
        s.once('connect', () => {
          signal?.removeEventListener('abort', onAbort);
          resolve(s);
        });
        s.once('error', (e) => {
          signal?.removeEventListener('abort', onAbort);
          reject(e);
        });
      });
    },
    unreachable(e) {
      const code = (e as NodeJS.ErrnoException).code;
      const path = where ?? 'the local API';
      if (code === 'ENOENT' || code === 'ECONNREFUSED' || code === 'ENOTSOCK') return unavailable(path);
      return new UnreachableError(`the desk's local API (${path}) could not be reached: ${e.message}`, { kind: 'network', reason: 'network', exitCode: 255 });
    },
  });

  const adminToken = async (): Promise<string> => {
    if (token) return token;
    const os = await import('node:os');
    const fs = await import('node:fs/promises');
    const file = localTokenPath(env, os.homedir(), process.platform);
    let t: string;
    try {
      t = (await fs.readFile(file, 'utf8')).trim();
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new UnreachableError(`${LOCAL_API_UNAVAILABLE} (no local admin token at ${file}; or give an agent token as deskToken)`, { kind: 'unreachable', reason: 'local_api_unavailable', exitCode: 255 });
      }
      throw new GaiaDeskError(`cannot read the local admin token ${file}: ${(e as Error).message}`, { kind: 'local', reason: 'local' });
    }
    if (!t) throw new GaiaDeskError(`the local admin token file ${file} is empty`, { kind: 'local', reason: 'local' });
    return t;
  };

  return new ApiTransport({
    transport: 'local',
    baseUrl: 'http://localhost/v1',
    where: 'the desk\'s local API',
    fetch,
    timeouts: o.timeouts,
    retry: o.retry,
    async credentials(callToken): Promise<Record<string, string>> {
      const t = callToken ?? deskToken;
      if (t) return { 'X-GaiaDesk-Desk-Token': t };
      return { Authorization: `Bearer ${await adminToken()}` };
    },
  });
}
