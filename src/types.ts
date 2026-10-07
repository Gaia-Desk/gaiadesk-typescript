// The JSON gaiadesk-cli prints with --json, typed from GaiaDesk's own JSON
// Schema of every shape: `types.generated.ts` is generated from it (never
// edit that file; regenerate it when the CLI's schema changes). Field names
// are the CLI's own (snake_case), so these types read the same as its docs
// (https://gaiadesk.net/docs/cli-for-agents).
//
// This file gives the generated types the SDK's public names (stable since
// 0.1.0), and holds the few SDK-only types.

import type * as G from './types.generated.js';

/** Every type of the CLI's schema, by its schema name (`Schema.ExecResult`, `Schema.Error`, ...). */
export type * as Schema from './types.generated.js';

/** Duck-typed AbortSignal (no DOM or @types/node needed). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** `--shell` (exec, shell). `default`: the desk's own (login shell on macOS/Linux, cmd.exe on Windows). */
export type Shell = G.Shell;

// ───────────────────────────── errors ─────────────────────────────

/**
 * What went wrong, as gaiadesk-cli 0.10.324+ reports it: the object inside
 * `{"error": {...}}` (and exec's `error`). `kind` is one of six; `reason` is
 * the finer cause (`offline`, `unknown_desk`, `not_online`, `network`,
 * `not_signed_in`, `timeout`, `local`, ...).
 */
export type CliError = G.Error;
/** The six kinds gaiadesk-cli 0.10.324+ puts in an error. */
export type CliErrorKind = G.ErrorKind;
/** `{"error": CliError}`: what every `--json` command prints when it fails (0.10.324+). */
export type CliErrorEnvelope = G.ErrorEnvelope;

// ───────────────────────────── exec ─────────────────────────────

/**
 * `exec --json` / `shell --json`: `{exit, remote_code, stdout, stderr,
 * duration_ms, desk, route, mode, shell, timed_out, error, notes, truncated}`.
 * `exit` is what gaiadesk-cli exits with (the command's code, 124 timed out,
 * 130 interrupted, 254 refused); `error` is null when the command ran and
 * ended on its own (an older CLI's text error is given as
 * `{kind: 'failed' | 'refused', message}`).
 */
export type ExecResult = G.ExecResult;

/** The end of a run without its output: `--json-stream`'s last `exit` event. */
export type ExecExit = G.ExecExit;

/**
 * One line of `exec --json-stream`: output as it comes, then `exit` (an
 * ExecExit) or, when the command never ran, `error`.
 */
// The generated ExecEvent drops `event: "exit"` from its ExecExit variant
// (the schema puts it beside a $ref), so the SDK spells the union itself.
export type ExecEvent = Exclude<G.ExecEvent, G.ExecExit> | (G.ExecExit & { event: 'exit' });

// ───────────────────────────── devices ─────────────────────────────

/** `devices --json`: `{devices, sources, notes}`. */
export type DevicesResult = G.DeviceList;
/** One desk in `devices --json`. Presence is `online`; reachability is `reachable` / `last_ok` / `last_failure`. */
export type DeviceRow = G.Device;
export type ReachSuccess = G.ReachSuccess;
export type ReachFailure = G.ReachFailure;
export type ProbeResult = G.ProbeResult;

// ───────────────────────────── cp ─────────────────────────────

/** `cp --json`: what a copy did. */
export type CpSummary = G.CopyResult;
export type CopyFailure = G.CopyFailure;

// ───────────────────────────── jobs ─────────────────────────────

/** A background job (`run --json`, `ps --json`, `kill --json`). */
export type JobInfo = G.Job;
export type JobLimits = G.JobLimits;
/** `ps --json` (0.10.324+; older CLIs print the bare array, which the SDK accepts too). */
export type JobList = G.JobList;
/** `logs --json`: a job and the end of its output. */
export type JobLogs = G.JobLogs;

// ───────────────────────────── stats / measure ─────────────────────────────

/** `stats --json`: the desk's CPU, load, memory, disks, uptime and running jobs, plus `desk`. */
export type DeskStats = G.StatsReport;
export type DiskStat = G.DiskStat;
/** `measure --json`: round trip and clock offset (`rtt_ms` null: no ping came back). */
export type MeasureResult = G.Measurement;

// ───────────────────────────── tokens / audit ─────────────────────────────

/** An agent token as the desk describes it (`token list --json`, `token create --json`). */
export type TokenInfo = G.TokenInfo;
/** `token list --json` (0.10.324+; older CLIs print the bare array). */
export type TokenList = G.TokenList;

/**
 * `token create --json`: one entry per desk. `secret` (the token, shown once)
 * only without `out`; with `out`, `file` names the file written instead.
 */
// Hand-written: the schema's MintResult is the `secret` form only.
export interface TokenCreateResult {
  tokens: Array<Omit<G.MintedToken, 'secret'> & { secret?: string }>;
  /** The `--out` file, when one was written. */
  file?: string;
}

/** `token revoke --json` against the desk. */
export type TokenRevokeResult = G.Revoked;
/** `token revoke --account --json` (through the GaiaDesk server). */
export type AccountRevokeResult = G.AccountRevoked;

/** One entry of a desk's agent audit log (`audit --json`). */
export type AuditEvent = G.AuditEvent;
/** `audit --json` (0.10.324+; older CLIs print the bare array). */
export type AuditLog = G.AuditLog;

// ───────────────────────────── mesh / forward / version ─────────────────────────────

/** `mesh status --json`. */
export type MeshStatus = G.MeshStatus;
/** `forward --json`: printed once per forward when it is listening. */
export type ForwardListening = G.ForwardListening;

/**
 * `gaiadesk-cli --version --json` (0.10.324+): its release, the `features`
 * an SDK can check before using a flag or a shape (`exec_json_stream`,
 * `exec_cwd`, `run_cwd`, `json_error_envelope`, `mcp_lifecycle`, ...), and
 * the MCP protocol revisions its server speaks.
 */
export type VersionInfo = G.VersionInfo;
