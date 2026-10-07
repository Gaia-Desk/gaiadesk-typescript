// Typed errors, mapped from what gaiadesk-cli reports.
//
// Exit codes (gaiadesk-cli --help, "exit codes"):
//   exec/shell: 0-255 the remote command's own; 124 --timeout ran out;
//               130 interrupted; 253 (shell) remote error / connection lost;
//               254 the desk refused; 255 gaiadesk-cli's own error.
//   desk operations (cp, run, ps, logs, kill, stats, token, audit, ...):
//               0 done; 1 ran and did not succeed; 254 refused; 255 own error.
// `exec --json` / `shell --json` failures before the command ran carry
// "error": {"kind", "message"} with kind one of: usage, offline,
// unknown_desk, not_online, refused, network, not_signed_in, timeout,
// connection_lost, local.

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
  | 'protocol';

export interface ErrorDetails {
  /** gaiadesk-cli's exit code, when it ran. */
  exitCode?: number | null;
  kind?: ErrorKind;
  /** What gaiadesk-cli wrote on stderr (credentials never appear in argv). */
  stderr?: string;
  /** The arguments gaiadesk-cli was run with. */
  argv?: readonly string[];
  /** The parsed --json output, when there was one. */
  json?: unknown;
}

export class GaiaDeskError extends Error {
  readonly exitCode: number | null;
  readonly kind: ErrorKind;
  readonly stderr: string;
  readonly argv: readonly string[];
  readonly json: unknown;

  constructor(message: string, details: ErrorDetails = {}) {
    super(message);
    this.name = new.target.name;
    this.exitCode = details.exitCode ?? null;
    this.kind = details.kind ?? 'cli_error';
    this.stderr = details.stderr ?? '';
    this.argv = details.argv ?? [];
    this.json = details.json;
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

/** `exec`/`shell` with `check: true`: the remote command exited non-zero (or timed out). */
export class CommandError extends GaiaDeskError {
  readonly result: unknown;
  constructor(message: string, result: unknown, details: ErrorDetails = {}) {
    super(message, details);
    this.result = result;
  }
}

const UNREACHABLE = new Set(['offline', 'unknown_desk', 'not_online', 'network', 'not_signed_in', 'timeout']);

/** The error class for a `kind` from `exec --json`'s error object. */
export function errorForKind(kind: string, message: string, details: ErrorDetails): GaiaDeskError {
  const d = { ...details, kind: kind as ErrorKind };
  if (kind === 'usage') return new UsageError(message, d);
  if (kind === 'refused') return new RefusedError(message, d);
  if (kind === 'connection_lost') return new ConnectionLostError(message, d);
  if (UNREACHABLE.has(kind)) return new UnreachableError(message, d);
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

/** The last thing gaiadesk-cli said on stderr, without its `gaiadesk-cli: ` prefix. */
export function lastStderrLine(stderr: string): string {
  const lines = stderr
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l && !l.startsWith('(see `gaiadesk-cli'));
  const last = lines[lines.length - 1] ?? '';
  return last.replace(/^gaiadesk-cli:\s*/, '');
}
