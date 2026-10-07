// Results as gaiadesk-cli 0.10.324+ (and the native library) print them, read
// so that an older CLI's shapes come out the same: bare arrays where there is
// now an object, a text `error` where there is now an error object. Pure.

import { ProtocolError } from './errors.js';
import type { CliError, ExecResult, VersionInfo } from './types.js';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/**
 * The list in a result: `{"jobs": [...]}` (0.10.324+) or a bare array (older
 * CLIs, `--json=v1`). Anything else is a ProtocolError.
 */
export function listOf<T>(json: unknown, key: 'jobs' | 'tokens' | 'events', argv: readonly string[] = []): T[] {
  if (Array.isArray(json)) return json as T[];
  if (isObj(json) && Array.isArray(json[key])) return json[key] as T[];
  throw new ProtocolError(`gaiadesk-cli printed no ${key} list`, { kind: 'protocol', argv, json });
}

/** A text result: the text itself (older shapes), or `json[key]` of an object (`{"output": ...}`, `{"mesh_ip": ...}`). */
export function textOf(json: unknown, key: string): string {
  if (typeof json === 'string') return json;
  if (isObj(json) && typeof json[key] === 'string') return json[key] as string;
  return '';
}

/**
 * An exec/shell result's `error` as 0.10.324+ spells it: null, or
 * `{kind, message, reason?, desk?}`. An older CLI's text is `refused` when
 * the desk refused the command (exit 254), else `failed`; its finer kinds
 * (`offline`, `timeout`, ...) are kept as `reason` of the six kinds.
 */
export function execError(error: unknown, exit: unknown): CliError | null {
  if (error === null || error === undefined || error === '') return null;
  if (typeof error === 'string') return { kind: exit === 254 ? 'refused' : 'failed', message: error };
  if (!isObj(error)) return null;
  const message = typeof error.message === 'string' ? error.message : '';
  const kind = typeof error.kind === 'string' ? error.kind : 'failed';
  const out: CliError = { kind: SIX.has(kind) ? (kind as CliError['kind']) : OLD_KIND[kind] ?? 'failed', message };
  if (typeof error.reason === 'string') out.reason = error.reason;
  else if (!SIX.has(kind)) out.reason = kind;
  if (typeof error.desk === 'string') out.desk = error.desk;
  return out;
}

const SIX: ReadonlySet<string> = new Set(['usage', 'refused', 'unreachable', 'connection_lost', 'failed', 'protocol']);

/** An older CLI's exec error kinds, as the six. */
const OLD_KIND: Record<string, CliError['kind']> = {
  offline: 'unreachable',
  unknown_desk: 'unreachable',
  not_online: 'unreachable',
  network: 'unreachable',
  not_signed_in: 'unreachable',
  timeout: 'unreachable',
  local: 'failed',
};

/**
 * `gaiadesk-cli --version --json` (0.10.324+), or null when the output is not
 * that object (an older CLI prints its version as text, or fails on `--json`).
 */
export function parseVersionInfo(stdout: string): VersionInfo | null {
  let v: unknown;
  try {
    v = JSON.parse(stdout.trim());
  } catch {
    return null;
  }
  if (!isObj(v) || !Array.isArray(v.features)) return null;
  const strings = (x: unknown): string[] => (Array.isArray(x) ? x.filter((s): s is string => typeof s === 'string') : []);
  return {
    name: typeof v.name === 'string' ? v.name : 'gaiadesk-cli',
    version: typeof v.version === 'string' ? v.version : '',
    features: strings(v.features),
    json_shapes: strings(v.json_shapes),
    mcp_protocol_versions: strings(v.mcp_protocol_versions),
  };
}

/** An exec/shell result with its `error` in today's shape (see execError). */
export function normalizeExecResult(json: Record<string, unknown>): ExecResult {
  return { ...(json as unknown as ExecResult), error: execError(json.error, json.exit) };
}

/**
 * Did the command never run? Its result says why in `error`, and it has no
 * code of its own (`remote_code` null, or -1 from an older desk), and it did
 * not merely run out of time.
 */
export function neverRan(r: { error?: unknown; remote_code?: number | null; timed_out?: boolean }): boolean {
  const noCode = r.remote_code === null || r.remote_code === undefined || r.remote_code < 0;
  return noCode && !r.timed_out && r.error !== null && r.error !== undefined && r.error !== '';
}
