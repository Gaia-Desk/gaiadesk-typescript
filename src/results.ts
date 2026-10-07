// Results as gaiadesk-cli (and the native library) print them. Pure.

import { ProtocolError } from './errors.js';
import type { CliError, ExecResult, VersionInfo } from './types.js';

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** The list in a result: `{"jobs": [...]}`, `{"tokens": [...]}`, `{"events": [...]}`. Anything else is a ProtocolError. */
export function listOf<T>(json: unknown, key: 'jobs' | 'tokens' | 'events', argv: readonly string[] = []): T[] {
  if (isObj(json) && Array.isArray(json[key])) return json[key] as T[];
  throw new ProtocolError(`gaiadesk-cli printed no ${key} list`, { kind: 'protocol', argv, json });
}

/** `json[key]` of a text result (`{"output": ...}`, `{"mesh_ip": ...}`), or '' when it has none. */
export function textOf(json: unknown, key: string): string {
  return isObj(json) && typeof json[key] === 'string' ? (json[key] as string) : '';
}

/** An exec/shell result's `error`: null, or `{kind, message, reason?, desk?}`. */
export function execError(error: unknown): CliError | null {
  if (!isObj(error)) return null;
  const out: CliError = {
    kind: (typeof error.kind === 'string' ? error.kind : 'failed') as CliError['kind'],
    message: typeof error.message === 'string' ? error.message : '',
  };
  if (typeof error.reason === 'string') out.reason = error.reason;
  if (typeof error.desk === 'string') out.desk = error.desk;
  return out;
}

/** `gaiadesk-cli --version --json`, or null when the output is not that object. */
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
    mcp_protocol_versions: strings(v.mcp_protocol_versions),
  } as VersionInfo;
}

/** An exec/shell result with its `error` read by execError. */
export function normalizeExecResult(json: Record<string, unknown>): ExecResult {
  return { ...(json as unknown as ExecResult), error: execError(json.error) };
}

/**
 * Did the command never run? Its result says why in `error`, it has no code
 * of its own (`remote_code` null), and it did not merely run out of time.
 */
export function neverRan(r: { error?: unknown; remote_code?: number | null; timed_out?: boolean }): boolean {
  const noCode = r.remote_code === null || r.remote_code === undefined;
  return noCode && !r.timed_out && r.error !== null && r.error !== undefined;
}
