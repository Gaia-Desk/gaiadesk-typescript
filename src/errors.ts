// Typed errors, mapped from what gaiadesk-cli reports.
//
// Exit codes (gaiadesk-cli --help, "exit codes"):
//   exec/shell: 0-255 the remote command's own; 124 --timeout ran out;
//               130 interrupted; 253 (shell) remote error / connection lost;
//               254 the desk refused; 255 gaiadesk-cli's own error.
//   desk operations (cp, run, ps, logs, kill, stats, token, audit, ...):
//               0 done; 1 ran and did not succeed; 254 refused; 255 own error.
//
// gaiadesk-cli prints ONE error envelope for every `--json` failure:
// {"error": {"kind", "message", "reason"?, "desk"?}} with kind one of usage,
// refused, unreachable, connection_lost, failed, protocol, and the finer cause
// in `reason` (offline, unknown_desk, not_online, network, not_signed_in,
// timeout, local, ...); errorEnvelope() reads it.
//
// The SDK's `kind` is the finest one known: the envelope's `reason` when it is
// one of the SDK kinds below (so `offline` stays `offline`), else its kind.
// The error CLASS follows the envelope's kind.

export type ErrorKind =
  | 'usage'
  | 'offline'
  | 'unknown_desk'
  | 'not_online'
  | 'refused'
  | 'network'
  | 'not_signed_in'
  | 'timeout'
  | 'connection_lost'
  | 'local'
  | 'cli_error'
  | 'failed'
  | 'interrupted'
  | 'not_found'
  | 'protocol'
  /** The native backend's kind for an unreachable desk when it gives no finer reason. */
  | 'unreachable';

export interface ErrorDetails {
  /** gaiadesk-cli's exit code, when it ran. */
  exitCode?: number | null;
  kind?: ErrorKind;
  /** The finer cause the CLI gave (`offline`, `timeout`, `local`, ...), when it gave one. */
  reason?: string | null;
  /** The desk the error concerned, when the CLI said. */
  desk?: string | null;
  /** What gaiadesk-cli wrote on stderr (credentials never appear in argv). */
  stderr?: string;
  /** The arguments gaiadesk-cli was run with. */
  argv?: readonly string[];
  /** The parsed --json output, when there was one. */
  json?: unknown;
  /** API transport: the request's id (`req_…`) from the error envelope, to quote to support. */
  requestId?: string | null;
  /** API transport: the HTTP status of the failed request. */
  status?: number | null;
  /** API transport: seconds to wait before retrying (a 429's `Retry-After`). */
  retryAfter?: number | null;
}

export class GaiaDeskError extends Error {
  readonly exitCode: number | null;
  readonly kind: ErrorKind;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly json: unknown;
  /** The finer cause (`offline`, `unknown_desk`, `timeout`, `local`, ...), or null. */
  readonly reason: string | null;
  /** The desk the error concerned, when the CLI or native library said; else null. */
  readonly desk: string | null;
  /** API transport: the request id (`req_…`) of the failed request; else null. */
  readonly requestId: string | null;
  /** API transport: the HTTP status of the failed request; else null. */
  readonly status: number | null;
  /** API transport: seconds to wait before retrying (429 `Retry-After`); else null. */
  readonly retryAfter: number | null;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.exitCode = details.exitCode ?? null;
    this.kind = details.kind ?? 'cli_error';
    this.reason = details.reason ?? null;
    this.desk = details.desk ?? null;
    this.stderr = details.stderr ?? '';
    this.argv = details.argv ?? [];
    this.json = details.json;
    this.requestId = details.requestId ?? null;
    this.status = details.status ?? null;
    this.retryAfter = details.retryAfter ?? null;
  }
}

/** gaiadesk-cli could not be started (not installed, wrong path). */
export class CliNotFoundError extends GaiaDeskError {}
/** Bad arguments (kind `usage`), caught by the SDK or by gaiadesk-cli. */
export class UsageError extends GaiaDeskError {}
/** The desk said no: wrong code, a token without the scope, expired or revoked, permission off (exit 254). */
export class RefusedError extends GaiaDeskError {}
/** The desk could not be reached: offline, unknown_desk, not_online, network, not_signed_in, timeout (connecting). */
export class UnreachableError extends GaiaDeskError {}
/** The connection went away mid-command (kind `connection_lost`, shell exit 253). */
export class ConnectionLostError extends GaiaDeskError {}
/** A desk operation ran and did not succeed (exit 1): a file failed to copy, no such job, ... */
export class OperationFailedError extends GaiaDeskError {}
/** gaiadesk-cli printed something that is not the JSON it documents. */
export class ProtocolError extends GaiaDeskError {}

/**
 * API transport, end-to-end encryption: the SDK would not send the operation
 * in the clear (reason `e2e_unavailable`: `e2e: 'require'`, or a desk that
 * requires it, and no key for the desk) or the server handed out a key other
 * than the pinned one (`e2e_key_mismatch`). Nothing was sent to the desk.
 */
export class E2eError extends RefusedError {}

/** `exec`/`shell` with `check: true`: the remote command exited non-zero (or timed out). */
export class CommandError extends GaiaDeskError {
  readonly result: unknown;
  constructor(message: string, result: unknown, details: ErrorDetails = {}) {
    super(message, details);
    this.result = result;
  }
}

/** The SDK's kinds: what `GaiaDeskError.kind` may be (besides `cli_error`, `not_found`). */
export const SDK_KINDS: ReadonlySet<string> = new Set([
  'usage', 'offline', 'unknown_desk', 'not_online', 'refused', 'network', 'not_signed_in', 'timeout',
  'connection_lost', 'local', 'failed', 'interrupted', 'protocol', 'unreachable',
]);

/** The SDK kind for an error's kind and reason: the reason when it is an SDK kind, else the kind. */
export function sdkKind(kind: string, reason?: string | null): ErrorKind {
  if (typeof reason === 'string' && SDK_KINDS.has(reason)) return reason as ErrorKind;
  return kind as ErrorKind;
}

/** The error class for an error's `kind` (one of the six). `details.kind` (the SDK kind) defaults to `kind`. */
export function errorForKind(kind: string, message: string, details: ErrorDetails): GaiaDeskError {
  const d = { ...details, kind: details.kind ?? (kind as ErrorKind) };
  if (kind === 'usage') return new UsageError(message, d);
  if (kind === 'refused') return new RefusedError(message, d);
  if (kind === 'connection_lost') return new ConnectionLostError(message, d);
  if (kind === 'failed') return new OperationFailedError(message, d);
  if (kind === 'protocol') return new ProtocolError(message, d);
  if (kind === 'unreachable') return new UnreachableError(message, d);
  return new GaiaDeskError(message, d);
}

/** The error class for an exit code when no kind was given. */
export function errorForExit(code: number | null, message: string, details: ErrorDetails): GaiaDeskError {
  if (code === 254) return new RefusedError(message, { ...details, kind: 'refused' });
  if (code === 253) return new ConnectionLostError(message, { ...details, kind: 'connection_lost' });
  if (code === 1) return new OperationFailedError(message, { ...details, kind: 'failed' });
  if (code === 130) return new GaiaDeskError(message, { ...details, kind: 'interrupted' });
  return new GaiaDeskError(message, { ...details, kind: details.kind ?? 'cli_error' });
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

/** What a gaiadesk-cli JSON output says went wrong. */
export interface ErrorEnvelope {
  /** One of the six: usage, refused, unreachable, connection_lost, failed, protocol. */
  kind: string;
  message: string;
  /** The finer cause: `offline`, `unknown_desk`, `timeout`, `local`, ... */
  reason?: string;
  /** The desk it concerned, when there was one. */
  desk?: string;
}

/**
 * THE place that knows how gaiadesk-cli spells an error in its JSON:
 * `{"error": {"kind", "message", "reason"?, "desk"?}}`. Every error path in
 * the SDK goes through here, so a change to the CLI's error envelope is a
 * change to this function only. Returns null when the JSON is not an error
 * (including exec's own `"error": null` on success).
 */
export function errorEnvelope(json: unknown): ErrorEnvelope | null {
  if (!isObj(json)) return null;
  const e = json.error;
  if (!isObj(e) || typeof e.kind !== 'string') return null;
  const env: ErrorEnvelope = { kind: e.kind, message: typeof e.message === 'string' ? e.message : '' };
  if (typeof e.reason === 'string' && e.reason) env.reason = e.reason;
  if (typeof e.desk === 'string' && e.desk) env.desk = e.desk;
  return env;
}

/** The details an envelope adds to an error: the SDK kind, reason and desk. */
export function envelopeDetails(env: ErrorEnvelope, details: ErrorDetails): ErrorDetails {
  const d: ErrorDetails = { ...details, kind: sdkKind(env.kind, env.reason) };
  if (env.reason !== undefined) d.reason = env.reason;
  if (env.desk !== undefined) d.desk = env.desk;
  return d;
}

/** A finished gaiadesk-cli run, as far as error mapping cares. */
export interface FailedRun {
  code: number | null;
  signal?: string | null;
  stderr: string;
}

/**
 * The typed error for a failed run: the JSON's error envelope, else the exit
 * code with the best message available (a `{"desk", "ok": false, "message"}`
 * reply, or stderr).
 */
export function errorFromRun(run: FailedRun, argv: readonly string[], json: unknown): GaiaDeskError {
  const details: ErrorDetails = { exitCode: run.code, stderr: run.stderr, argv, json };
  const fallback = lastStderrLine(run.stderr) || `gaiadesk-cli exited with ${run.code ?? run.signal}`;
  const env = errorEnvelope(json);
  if (env) return errorForKind(env.kind, env.message || fallback, envelopeDetails(env, details));
  const msg = isObj(json) && typeof json.message === 'string' && json.message ? json.message : fallback;
  return errorForExit(run.code, msg, details);
}

/** The last thing gaiadesk-cli said on stderr, without its `gaiadesk-cli: ` prefix. */
export function lastStderrLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('(see `gaiadesk-cli'));
  const last = lines[lines.length - 1] ?? '';
  return last.replace(/^gaiadesk-cli:\s*/, '');
}
