// A fake `gaiadesk-cli` for the tests: prints the JSON shapes the real CLI
// documents, chosen by the desk id. Every run appends {argv, env, stdin} to
// $FAKE_LOG so tests can check exactly what the SDK sent.
// Compiled to dist-test/fixtures/fake-cli.js and run with `node`.
//
// Two CLIs in one file:
//   fake-cli.js       gaiadesk-cli: `--version --json`, one error envelope
//                     {"error": {kind, message, reason?, desk?}},
//                     {"jobs"}/{"tokens"}/{"events"} objects, `exec
//                     --json-stream`, `--cwd` (exec, run, shell), `--json`
//                     on logs / mesh ip / disconnect / agent-connect, MCP
//                     tools named gaiadesk_*.
//   fake-cli-old.js   a CLI too old to answer `--version --json` (sets
//                     FAKE_CLI=old, then runs this file): its version as
//                     text, and `--cwd` is an unknown flag.
// They are two paths, as two installed CLIs would be (the SDK caches what a
// CLI supports per path).
//
// Desk ids: 123456789 fine; 234567890 a second desk (offline in `devices`);
// 345678901 this machine on the Mesh; offline-desk offline; refused-desk the
// desk refuses; usage-desk a usage error; plain-desk a failure with only text
// on stderr.
import { appendFileSync } from 'node:fs';

const OLD = process.env.FAKE_CLI === 'old';
const argv = process.argv.slice(2);
const OK = '123456789';
const OTHER = '234567890';
const SELF = '345678901';
const OFFLINE = 'offline-desk';
const REFUSED = 'refused-desk';
const USAGE = 'usage-desk';
const PLAIN = 'plain-desk';

type Json = Record<string, any>;

const out = (v: unknown) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v)) + '\n');
const err = (s: string) => process.stderr.write(s + '\n');
const flag = (name: string): string | undefined => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name: string) => argv.includes(name);
const afterDashes = (): string[] => {
  const i = argv.indexOf('--');
  return i >= 0 ? argv.slice(i + 1) : [];
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** A failure as the CLI prints it: the envelope, and the sentence on stderr. */
function fail(kind: string, message: string, exit: number, extra: { reason?: string; desk?: string } = {}): number {
  if (has('--json')) out({ error: { kind, message, ...extra } });
  err(`gaiadesk-cli: ${message}`);
  return exit;
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function log(stdin: string) {
  if (!process.env.FAKE_LOG) return;
  const env: Record<string, string> = {};
  for (const k of ['GAIADESK_TOKEN_FILE', 'GAIADESK_CODE', 'GAIADESK_TOKEN', 'GAIADESK_AGENT_TOKEN', 'GAIADESK_SERVER', 'GAIADESK_PERSIST']) {
    const v = process.env[k];
    if (v !== undefined) env[k] = v;
  }
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, env, stdin }) + '\n');
}

function job(name: string | undefined, extra: Json = {}): Json {
  return { name, command: 'make', state: 'running', pid: 4242, started_at_ms: 1700000000000, log_bytes: 0, by: 'owner', ...extra };
}

function execOutput(cmd: string[], stdin: string, cwd?: string): string {
  return `ran: ${cmd.join(' ')}${cwd ? `\nin: ${cwd}` : ''}${stdin ? `\nstdin: ${stdin}` : ''}\n`;
}

function execJson(desk: string | undefined, cmd: string[], stdin: string, exit = 0, cwd?: string): Json {
  return {
    exit,
    remote_code: exit,
    stdout: execOutput(cmd, stdin, cwd),
    stderr: 'warn\n',
    duration_ms: 12,
    desk,
    route: 'LAN',
    mode: 'pipes',
    shell: '/bin/zsh -l -c',
    timed_out: false,
    error: null,
    notes: [],
    truncated: false,
  };
}

/** exec/shell when the command never ran: its error object. */
function notRun(desk: string | undefined, kind: string, reason: string | undefined, message: string, exit: number, mode: 'json' | 'stream' | 'plain'): number {
  const error = { kind, message, ...(reason ? { reason } : {}), desk };
  if (mode === 'stream') out({ event: 'error', exit, error });
  if (mode === 'json') out({ exit, remote_code: null, stdout: '', stderr: '', duration_ms: 3, desk, route: null, mode: null, shell: null, timed_out: false, error, notes: [], truncated: false });
  err(`gaiadesk-cli: ${message}`);
  return exit;
}

async function execLike(desk: string | undefined, cmd: string[], stdin: string, mode: 'json' | 'stream' | 'plain', cwd?: string): Promise<number> {
  if (desk === OFFLINE) return notRun(desk, 'unreachable', 'offline', `desk ${desk} is offline (last seen 4 min ago)`, 255, mode);
  if (desk === USAGE) return notRun(desk, 'usage', undefined, 'no credential: set GAIADESK_TOKEN_FILE or GAIADESK_CODE', 255, mode);
  if (desk === PLAIN) {
    err('gaiadesk-cli: something odd');
    return 255;
  }
  if (desk === REFUSED) return notRun(desk, 'refused', undefined, 'this agent token does not have the `exec` scope', 254, mode);
  if (cwd === '/missing') return notRun(desk, 'failed', undefined, 'no such directory on the desk: /missing', 1, mode);
  const line = cmd.join(' ');
  const code = /^exit (\d+)$/.test(line) ? Number(line.slice(5)) : line === 'sleep' ? 124 : 0;
  const timedOut = line === 'sleep';
  const stoppedError = timedOut ? { kind: 'failed', message: 'the command ran past --timeout and was stopped' } : null;
  if (mode === 'json') {
    const r = execJson(desk, cmd, stdin, code, cwd);
    if (timedOut) Object.assign(r, { timed_out: true, remote_code: null, error: stoppedError });
    out(r);
    return code;
  }
  if (mode === 'stream') {
    out({ event: 'stdout', data: 'part1 ' });
    await sleep(30);
    out({ event: 'stdout', data: `part2 ${line}\n${cwd ? `in: ${cwd}\n` : ''}` });
    if (stdin) out({ event: 'stdout', data: `stdin: ${stdin}\n` });
    out({ event: 'stderr', data: 'warn\n' });
    err('gaiadesk-cli: (this line is the CLI talking, not the command)');
    const { stdout: _o, stderr: _e, truncated: _t, ...exit } = execJson(desk, cmd, stdin, code, cwd);
    out({ event: 'exit', ...exit, ...(timedOut ? { timed_out: true, remote_code: null, error: stoppedError } : {}) });
    return code;
  }
  process.stdout.write('part1 ');
  await sleep(30);
  process.stdout.write(`part2 ${line}\n`);
  if (cwd) process.stdout.write(`in: ${cwd}\n`);
  if (stdin) process.stdout.write(`stdin: ${stdin}\n`);
  process.stderr.write('warn\n');
  return code;
}

const tool = (name: string) => `gaiadesk_${name}`;
const isTool = (sent: string, name: string) => sent === tool(name);

async function mcp(): Promise<number> {
  let buf = '';
  for await (const c of process.stdin) {
    buf += (c as Buffer).toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line) as Json;
      if (m.id === undefined) continue;
      const meta = m.params?._meta ?? {};
      if (meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' || !meta['io.modelcontextprotocol/clientCapabilities']) {
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: '_meta is required on every request' } });
        continue;
      }
      if (m.method === 'tools/list') {
        out({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [{ name: tool('exec'), inputSchema: { type: 'object' } }, { name: tool('screenshot'), inputSchema: { type: 'object' } }], argv } });
      } else if (m.method === 'tools/call' && isTool(m.params.name, 'exec')) {
        const s = execJson(m.params.arguments.desk_id, [m.params.arguments.command], '');
        out({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'exit 0' }], structuredContent: s, isError: false, called: m.params.name } });
      } else if (m.method === 'tools/call' && isTool(m.params.name, 'screenshot')) {
        out({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', content: [{ type: 'image', data: 'iVBORw0K', mimeType: 'image/png' }], isError: false } });
      } else if (m.method === 'tools/call') {
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: `Unknown tool: ${m.params.name}` } });
      } else {
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32601, message: `Method not found: ${m.method}` } });
      }
    }
  }
  return 0;
}

/** A CLI too old for `--cwd` does not know it. */
function unknownFlag(): number | null {
  if (!OLD || !has('--cwd')) return null;
  err('gaiadesk-cli: unknown flag --cwd');
  return 255;
}

async function main(): Promise<number> {
  const cmd = argv[0];
  if (cmd === 'mcp') {
    log('');
    return mcp();
  }
  const stdin = await readStdin();
  log(stdin);
  const unknown = unknownFlag();
  if (unknown !== null) return unknown;
  const desk = flag('--desk-id') ?? flag('--desk');
  switch (cmd) {
    case '--version':
      if (has('--json') && !OLD) {
        out({
          name: 'gaiadesk-cli',
          version: '0.10.324',
          features: [
            'json_error_envelope', 'exec_json_stream', 'exec_cwd', 'run_cwd', 'shell_cwd',
            'logs_json', 'mesh_ip_json', 'disconnect_json', 'agent_connect_json', 'mcp_lifecycle', 'mcp_underscore_tool_names',
          ],
          mcp_protocol_versions: ['2026-07-28', '2025-11-25', '2025-06-18', '2025-03-26', '2024-11-05'],
        });
        return 0;
      }
      out(OLD ? 'gaiadesk-cli 0.10.300' : 'gaiadesk-cli 0.10.324');
      return 0;
    case 'devices': {
      const rows: Json[] = [
        { desk_id: OK, name: 'office-pc', online: true, os: 'windows', app_version: '0.10.323', owner: 'you', last_seen: 1700000000, sources: ['account'], last_ok: { at: 1700000000, route: 'LAN' }, last_failure: null, reachable: null },
        { desk_id: OTHER, name: 'nas', online: false, os: 'linux', app_version: null, owner: 'you', last_seen: null, sources: ['mesh'], last_ok: null, last_failure: { at: 1, kind: 'no_route', message: 'not found' }, reachable: null },
      ];
      let list: Json[] = desk ? rows.filter((r) => r.desk_id === desk) : rows;
      if (has('--probe')) list = list.map((r) => ({ ...r, reachable: r.desk_id === OK, probe: r.desk_id === OK ? { ok: true, dialled: true, route: 'LAN', rtt_ms: 4 } : { ok: false, dialled: true, kind: 'no_route' } }));
      out({ devices: list, sources: ['account', 'mesh'], notes: [] });
      return list.some((r) => r.reachable === false) ? 1 : 0;
    }
    case 'exec': {
      const mode = has('--json-stream') ? 'stream' : has('--json') ? 'json' : 'plain';
      return execLike(desk, afterDashes(), has('--stdin') ? stdin : '', mode, flag('--cwd'));
    }
    case 'shell':
      return execLike(desk, [`script:${stdin.trim()}`], '', has('--json') ? 'json' : 'plain', flag('--cwd'));
    case 'cp': {
      const pos = argv.slice(1).filter((a) => !a.startsWith('-'));
      const [src, dst] = pos;
      const remote = /^[\w-]+:/.test(src) ? src : dst;
      const d = remote.slice(0, remote.indexOf(':'));
      if (d === REFUSED) return fail('refused', 'file transfer is turned off for you', 254, { desk: d });
      if (d === PLAIN) {
        err(`gaiadesk-cli: desk ${d} is offline (last seen 2 h ago)`);
        return 255;
      }
      const up = remote === dst;
      const failed = src.includes('fail') || dst.includes('fail') ? [{ path: 'a.txt', message: 'permission denied' }] : [];
      out({ direction: up ? 'upload' : 'download', desk: d, destination: up ? remote.slice(d.length + 1) : dst, files: 2, dirs: has('--recursive') ? 1 : 0, bytes: 2048, resumed_bytes: 0, failed, seconds: 0.5 });
      return failed.length ? 1 : 0;
    }
    case 'run':
      if (desk === REFUSED) {
        return fail('refused', 'this agent token does not have the `jobs` scope', 254, { desk });
      }
      out(job(flag('--name'), { command: afterDashes().join(' ') }));
      return 0;
    case 'ps': {
      if (desk === PLAIN) {
        out('NAME  STATE');
        return 0;
      }
      const jobs = [job('build'), job('old', { state: 'exited', exit_code: 0 })];
      out({ jobs });
      return 0;
    }
    case 'kill': {
      const name = argv[1];
      if (name === 'nope') return fail('failed', 'no job named nope', 1, { desk });
      out(job(name, { state: 'killed' }));
      return 0;
    }
    case 'logs':
      if (argv[1] === 'nope') return fail('failed', 'no job named nope', 1, { desk });
      if (has('--follow')) {
        for (const l of ['one', 'two', 'three']) {
          out({ event: 'output', data: `${l}\n` });
          await sleep(20);
        }
        if (argv[1] === 'lost') return fail('connection_lost', 'the connection to the desk was lost', 255, { desk });
        out({ event: 'end', job: job(argv[1], { state: 'exited', exit_code: 0 }) });
        err(`job ${argv[1]} exited (exit 0)`);
        return 0;
      }
      out({ job: job(argv[1]), output: flag('--tail') ? 'tail\n' : 'line1\nline2\n' });
      return 0;
    case 'stats':
      if (desk === PLAIN) return fail('unreachable', 'the desk did not answer', 255, { reason: 'timeout', desk });
      out({ desk, hostname: 'office-pc', os: 'windows', os_version: 'Windows 11 Pro', cpu_percent: 37.5, cpus: 8, load: null, mem_total_mb: 16384, mem_free_mb: 4096, disks: [{ mount: 'C:\\', total_mb: 512000, free_mb: 64000 }], uptime_secs: 3600, jobs_running: 2 });
      return 0;
    case 'measure':
      out({ desk, sent: Number(flag('--count') ?? 20), rtt_ms: desk === OK ? { n: 20, p50: 4, p95: 9, max: 12 } : null, clock_offset_ms: desk === OK ? 1.5 : null, clock_uncertainty_ms: desk === OK ? 0.5 : null });
      return desk === OK ? 0 : 1;
    case 'token': {
      const sub = argv[1];
      const info = { label: 'bot', id: '9f3a1c2b7d004e11', scopes: ['exec', 'cp'], issued_at_ms: 1, expires_at_ms: 2, revoked: false };
      if (!process.env.GAIADESK_CODE) {
        return fail('refused', "token administration needs the desk's unattended password", 254, { desk });
      }
      if (sub === 'create') {
        const desks = (flag('--desk') ?? '').split(',');
        const file = flag('--out');
        out(file ? { tokens: desks.map((d) => ({ desk: d, token: info })), file } : { tokens: desks.map((d) => ({ desk: d, token: info, secret: `gdagt_${d}_${'a'.repeat(64)}` })) });
        return 0;
      }
      if (sub === 'list') {
        out({ tokens: [info] });
        return 0;
      }
      if (sub === 'revoke') {
        if (has('--account')) {
          out({ desk, ok: true, message: 'revoked through your account' });
          return 0;
        }
        const name = argv.slice(2).find((a, i, all) => !a.startsWith('-') && all[i - 1] !== '--desk');
        if (name === 'ghost') {
          return fail('failed', 'there was no live token on the desk to revoke', 1, { desk });
        }
        out({ revoked: has('--all-for-desk') ? 'bot' : name, stopped_sessions: 1 });
        return 0;
      }
      return 255;
    }
    case 'audit': {
      const events = [{ at_ms: 5, desk, token: 'bot', token_id: '9f3a', action: 'exec.end', detail: 'make test', bytes: 0, exit_code: 0, duration_ms: 900 }];
      out({ events });
      return 0;
    }
    case 'mesh':
      if (argv[1] === 'status') {
        out({ self: { desk_id: SELF, mesh_ip: '100.64.0.1' }, peers: [{ desk_id: OK, mesh_ip: '100.64.0.2', online: true, os: 'windows' }] });
        return 0;
      }
      if (argv[2] === OK) {
        out(has('--json') ? { desk_id: OK, mesh_ip: '100.64.0.2', renamed_to: null } : '100.64.0.2');
        return 0;
      }
      return fail('failed', `desk ${argv[2]} is not on this machine's GaiaDesk Mesh`, 1, { desk: argv[2] });
    case 'disconnect': {
      const closed = [desk ?? OK];
      out({ closed });
      return 0;
    }
    case 'forward': {
      const pairs = argv.slice(1).filter((a) => a !== '--json');
      const d = pairs[0].split(':')[0];
      if (d === REFUSED) {
        err('gaiadesk-cli: the desk refused the forward: no `forward` scope');
        return 254;
      }
      for (let i = 0; i < pairs.length; i += 2) {
        const parts = pairs[i].split(':');
        const remote_port = Number(parts[parts.length - 1]);
        const remote_host = parts.length === 3 ? parts[1] : '127.0.0.1';
        const lp = Number(pairs[i + 1].split(':')[1]) || 40000 + i;
        out({ event: 'listening', local_port: lp, desk: d, remote_host, remote_port });
      }
      await new Promise((resolve) => {
        process.on('SIGINT', resolve);
        process.on('SIGTERM', resolve);
        setTimeout(resolve, 10000);
      });
      return 0;
    }
    case 'agent-connect':
      if (!process.env.GAIADESK_AGENT_TOKEN) {
        return fail('usage', 'an agent token is required (--token, or $GAIADESK_AGENT_TOKEN)', 255);
      }
      if (desk === REFUSED) return fail('refused', 'the desk refused the agent session: no `screen` scope', 254, { desk });
      out({ desk_id: desk, ok: true, screenshot: { width: 1280, height: 800 } });
      return 0;
    default:
      err(`gaiadesk-cli: unknown subcommand ${JSON.stringify(cmd)}`);
      return 255;
  }
}

void main().then((code) => process.exit(code));
