// A minimal MCP client for `gaiadesk-cli mcp` over stdio. This is how the
// SDK reaches the SCREEN tools (open_session, screenshot, click, ...), which
// gaiadesk-cli exposes only through its MCP server.
//
// gaiadesk-cli mcp speaks the stateless MCP revision 2026-07-28: no
// `initialize`, and every request carries the protocol version and client
// capabilities in params._meta.

import { CliStream } from './proc.js';
import type { Invocation } from './proc.js';
import { GaiaDeskError } from './errors.js';

export const MCP_PROTOCOL_VERSION = '2026-07-28';

/**
 * Every request's params with the stateless protocol's `_meta` fields added
 * (a value the caller set wins). The one place the handshake lives.
 */
export function withProtocolMeta(params: Record<string, unknown> = {}): Record<string, unknown> {
  const own = params._meta && typeof params._meta === 'object' ? (params._meta as Record<string, unknown>) : {};
  return {
    ...params,
    _meta: {
      'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION,
      'io.modelcontextprotocol/clientCapabilities': {},
      ...own,
    },
  };
}

/**
 * The other spelling of a GaiaDesk tool name: `gaiadesk.exec` <-> `gaiadesk_exec`.
 * (Some model providers allow only `[A-Za-z0-9_-]` in function names.) null for
 * a name that is not a GaiaDesk tool.
 */
export function toolNameAlias(name: string): string | null {
  const m = /^gaiadesk([._])(.+)$/.exec(name);
  if (!m) return null;
  return `gaiadesk${m[1] === '.' ? '_' : '.'}${m[2]}`;
}

/**
 * The name to send for `name`: itself if the server advertises it, else its
 * alias if the server advertises that, else itself (the server's error then
 * says the tool is unknown). Callers may use either spelling.
 */
export function resolveToolName(name: string, advertised?: ReadonlySet<string>): string {
  if (!advertised || advertised.has(name)) return name;
  const alias = toolNameAlias(name);
  return alias !== null && advertised.has(alias) ? alias : name;
}

export interface McpTool {
  name: string;
  title?: string;
  description?: string;
  inputSchema: Record<string, unknown>;
}

export type McpContent =
  | { type: 'text'; text: string }
  | { type: 'image'; data: string; mimeType: string }
  | { type: string; [k: string]: unknown };

export interface McpToolResult {
  content: McpContent[];
  structuredContent?: Record<string, unknown>;
  isError: boolean;
  [k: string]: unknown;
}

/** A JSON-RPC error from the server (e.g. -32602 unknown tool or missing _meta, -41001 no credential in the server environment). */
export class McpError extends GaiaDeskError {
  readonly code: number;
  readonly data: unknown;
  constructor(code: number, message: string, data?: unknown) {
    super(message, { kind: 'protocol' });
    this.code = code;
    this.data = data;
  }
}

type Pending = { resolve: (v: Record<string, unknown>) => void; reject: (e: Error) => void };

export class McpClient {
  private readonly stream: CliStream;
  private readonly pending = new Map<number, Pending>();
  private nextId = 1;
  private buf = '';
  private closed = false;
  private readonly dec = new TextDecoder('utf-8');
  /** Tool names the server advertised (from the last listTools()). */
  private toolNames?: Set<string>;

  constructor(inv: Invocation) {
    this.stream = new CliStream(inv, true);
    void this.pump();
    this.stream.wait().then(
      (exit) => this.fail(new GaiaDeskError(`gaiadesk-cli mcp exited (${exit.exitCode ?? exit.signal}): ${exit.stderrTail}`, { exitCode: exit.exitCode })),
      (e: Error) => this.fail(e),
    );
  }

  private fail(e: Error) {
    this.closed = true;
    for (const p of this.pending.values()) p.reject(e);
    this.pending.clear();
  }

  private async pump() {
    for await (const c of this.stream) {
      if (c.stream !== 'stdout') continue;
      this.buf += this.dec.decode(c.data, { stream: true });
      let i: number;
      while ((i = this.buf.indexOf('\n')) >= 0) {
        const line = this.buf.slice(0, i).trim();
        this.buf = this.buf.slice(i + 1);
        if (line) this.onLine(line);
      }
    }
  }

  private onLine(line: string) {
    let msg: { id?: number; result?: Record<string, unknown>; error?: { code: number; message: string; data?: unknown } };
    try {
      msg = JSON.parse(line);
    } catch {
      return;
    }
    if (typeof msg.id !== 'number') return;
    const p = this.pending.get(msg.id);
    if (!p) return;
    this.pending.delete(msg.id);
    if (msg.error) p.reject(new McpError(msg.error.code, msg.error.message, msg.error.data));
    else p.resolve(msg.result ?? {});
  }

  /** Send one request; resolves with its `result`. */
  request(method: string, params: Record<string, unknown> = {}): Promise<Record<string, unknown>> {
    if (this.closed) return Promise.reject(new GaiaDeskError('the MCP server is not running'));
    const id = this.nextId++;
    const body = JSON.stringify({ jsonrpc: '2.0', id, method, params: withProtocolMeta(params) });
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.stream.write(body + '\n');
    });
  }

  /** `server/discover`: supported versions, capabilities, instructions. */
  discover(): Promise<Record<string, unknown>> {
    return this.request('server/discover');
  }

  /** The tools this server offers with the credentials it was started with. */
  async listTools(): Promise<McpTool[]> {
    const r = await this.request('tools/list');
    const tools = (r.tools as McpTool[]) ?? [];
    this.toolNames = new Set(tools.map((t) => t.name));
    return tools;
  }

  /**
   * Call a tool. A tool-level failure (a refused scope, a bad argument the
   * tool caught, a non-zero exit) is a result with `isError: true`, not a
   * thrown error; protocol errors throw McpError.
   *
   * `name` may be spelled `gaiadesk.exec` or `gaiadesk_exec`: the client sends
   * the spelling the server advertises (it fetches the tool list once if
   * listTools() has not been called).
   */
  async callTool(name: string, args: Record<string, unknown> = {}): Promise<McpToolResult> {
    if (!this.toolNames && toolNameAlias(name) !== null) {
      try {
        await this.listTools();
      } catch (e) {
        if (!(e instanceof McpError)) throw e;
        // No list (e.g. no credential): send the name as given.
      }
    }
    const r = await this.request('tools/call', { name: resolveToolName(name, this.toolNames), arguments: args });
    return { content: [], isError: false, ...r } as McpToolResult;
  }

  /** Close stdin; the server exits. */
  async close(): Promise<void> {
    this.closed = true;
    this.stream.end();
    try {
      await this.stream.wait();
    } catch {
      /* already reported */
    }
  }
}

/** All text content of a tool result, joined. */
export function toolText(r: McpToolResult): string {
  return r.content
    .filter((c): c is { type: 'text'; text: string } => c.type === 'text' && typeof (c as { text?: unknown }).text === 'string')
    .map((c) => c.text)
    .join('\n');
}

/** The first image of a tool result (`gaiadesk.screenshot`): its MIME type and base64 data. */
export function toolImage(r: McpToolResult): { mimeType: string; base64: string } | null {
  const c = r.content.find((x) => x.type === 'image') as { data: string; mimeType: string } | undefined;
  return c ? { mimeType: c.mimeType, base64: c.data } : null;
}


