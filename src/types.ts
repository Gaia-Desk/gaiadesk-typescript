// The JSON gaiadesk-cli prints with --json, field for field. Field names are
// the CLI's own (snake_case) so these types read the same as the CLI's docs
// (`gaiadesk-cli <command> --help`, https://gaiadesk.net/docs/cli-for-agents).
// Where a shape is only partly documented, the README's "Known gaps" says so.

/** Duck-typed AbortSignal (no DOM or @types/node needed). */
export interface AbortSignalLike {
  readonly aborted: boolean;
  addEventListener(type: 'abort', listener: () => void, options?: { once?: boolean }): void;
  removeEventListener(type: 'abort', listener: () => void): void;
}

/** `--shell` (exec, shell). `default`: the desk's own (login shell on macOS/Linux, cmd.exe on Windows). */
export type Shell = 'default' | 'none' | 'sh' | 'cmd' | 'pwsh';

/** `exec --json` / `shell --json`: "one JSON object: {exit, remote_code, stdout, stderr, duration_ms, desk, route, mode, shell, timed_out, error, notes, truncated}". */
export interface ExecResult {
  /** What gaiadesk-cli exits with: the command's code, 124 timed out, 130 interrupted, 254 refused. */
  exit: number;
  /** The command's own exit code as the desk reported it (-1: it never ran). */
  remote_code: number | null;
  stdout: string;
  stderr: string;
  duration_ms: number;
  desk: string;
  /** How the desk was reached: `Mesh`, `LAN` or `the GaiaDesk server`. */
  route: string | null;
  /** `pipes`; `terminal` for a desk with an older GaiaDesk (stderr merged into stdout). */
  mode: 'pipes' | 'terminal' | null;
  /** The shell the desk actually used (`/bin/zsh -l -c`, `cmd.exe /d /v:off /s /c`, `none`), or null. */
  shell: string | null;
  timed_out: boolean;
  /** Why it never ran or was stopped, in the desk's words (a failure before the command ran is thrown instead). */
  error: string | null;
  notes: string[];
  /** A stream passed 16 MB and the rest was dropped. */
  truncated: boolean;
}

/** `devices --json`: `{devices: DeviceRow[], sources: string[], notes: string[]}`. */
export interface DevicesResult {
  devices: DeviceRow[];
  /** Which sources answered: `account`, `team`, `lan`, `mesh`, `recent`. */
  sources: string[];
  notes: string[];
}

export interface DeviceRow {
  desk_id: string;
  name: string | null;
  /** Presence only (null: unknown). Reachability is `reachable` / `last_ok` / `last_failure`. */
  online: boolean | null;
  os: string | null;
  app_version: string | null;
  /** "you", a teammate's email, or null. */
  owner: string | null;
  /** Seconds since the epoch. */
  last_seen: number | null;
  sources: string[];
  signal_idle_secs?: number;
  anytime?: boolean;
  last_ok: ReachSuccess | null;
  last_failure: ReachFailure | null;
  /** Only with `--probe` (else null). */
  reachable: boolean | null;
  probe?: ProbeResult;
}

export interface ReachSuccess {
  at: number;
  route: string;
  connect_ms?: number;
  rtt_ms?: number;
}

export interface ReachFailure {
  at: number;
  /** `no_route`, `relay_down`, `desk_not_answering`, `asleep`, `restarting`, `no_data_channel`, `agent_not_answering`, or an exec error kind. */
  kind: string;
  message: string;
}

export interface ProbeResult {
  ok: boolean;
  dialled: boolean;
  route?: string;
  connect_ms?: number;
  rtt_ms?: number;
  kind?: string;
  error?: string;
  hostname?: string;
  os?: string;
}

/** `cp --json`. */
export interface CpSummary {
  direction: 'upload' | 'download';
  desk: string;
  /** Where it landed: a desk path for an upload, a local one for a download. */
  destination: string;
  files: number;
  dirs: number;
  /** Bytes this run moved. */
  bytes: number;
  /** Bytes already there from an earlier, interrupted run. */
  resumed_bytes: number;
  failed: Array<{ path: string; message: string }>;
  seconds: number;
}

/** A background job (`run --json`, `ps --json`, `kill --json`). */
export interface JobInfo {
  name: string;
  command: string;
  /** `running`, `exited`, `killed` (e.g. `killed (memory limit 512 MB)` in `ps`), or `lost`. */
  state: string;
  pid?: number;
  exit_code?: number;
  started_at_ms: number;
  ended_at_ms?: number;
  log_bytes: number;
  /** The token's name, or `owner`. */
  by: string;
  limits?: JobLimits;
  /** How the desk enforces each cap, one line each, in its own words. */
  enforcement?: string[];
}

export interface JobLimits {
  priority?: 'low' | 'normal' | 'high';
  cpu_percent?: number;
  mem_mb?: number;
  keep_awake?: boolean;
}

/** `stats --json`: "hostname, os, os_version, cpu_percent, cpus, load, mem_total_mb, mem_free_mb, disks[{mount,total_mb,free_mb}], uptime_secs, jobs_running" plus `desk`. */
export interface DeskStats {
  desk: string;
  hostname: string;
  os: string;
  os_version: string;
  cpu_percent: number;
  cpus: number;
  /** 1, 5, 15 minute load average; null on Windows. */
  load: [number, number, number] | null;
  mem_total_mb: number;
  mem_free_mb: number;
  disks: Array<{ mount: string; total_mb: number; free_mb: number }>;
  uptime_secs: number;
  jobs_running: number;
}

/** `measure --json`. */
export interface MeasureResult {
  desk: string;
  sent: number;
  rtt_ms: { n: number; p50: number; p95: number; max: number } | null;
  clock_offset_ms: number | null;
  clock_uncertainty_ms: number | null;
}

/** An agent token as the desk describes it (`token list --json`, `token create --json`). */
export interface TokenInfo {
  label: string;
  /** The non-secret id (`token revoke` accepts it). */
  id: string;
  scopes: string[];
  issued_at_ms: number;
  expires_at_ms: number;
  revoked: boolean;
  last_used_ms?: number;
  cwd?: string;
  low_priv?: boolean;
}

/** `token create --json`: one entry per desk. `secret` only without `out` (the token is shown once). */
export interface TokenCreateResult {
  tokens: Array<{ desk: string; token: TokenInfo; secret?: string }>;
  /** The `--out` file, when one was written. */
  file?: string;
}

/** `token revoke --json` against the desk. */
export interface TokenRevokeResult {
  revoked: string;
  stopped_sessions: number;
}

/** `token revoke --account --json` (through the GaiaDesk server). */
export interface AccountRevokeResult {
  desk: string;
  ok: boolean;
  message: string;
}

/** One entry of a desk's agent audit log (`audit --json`). */
export interface AuditEvent {
  at_ms: number;
  desk: string;
  token: string;
  token_id: string;
  /** `connect`, `exec`, `exec.end`, `cp.upload`, `cp.download`, `forward`, `job.start`, `job.kill`, `refused`. */
  action: string;
  detail: string;
  bytes: number;
  cwd?: string;
  exit_code?: number;
  duration_ms?: number;
}

/** `mesh status --json`. */
export interface MeshStatus {
  self: { desk_id: string; mesh_ip: string | null } | null;
  peers: Array<{ desk_id: string; mesh_ip: string | null; online: boolean; os: string }>;
}

/** `forward --json`: printed once per forward when it is listening. */
export interface ForwardListening {
  event: 'listening';
  local_port: number;
  desk: string;
  remote_host: string;
  remote_port: number;
}
