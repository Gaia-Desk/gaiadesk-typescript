// A fake `gaiadesk-cli` for the tests: prints the JSON shapes the real CLI
// documents, chosen by the desk id. Every run appends {argv, env, stdin} to
// $FAKE_LOG so tests can check exactly what the SDK sent.
//
// Desk ids: 100000001 fine; 100000002 offline (exec error kind); 100000003
// the desk refuses; 100000004 usage error; 100000005 a plain-stderr failure.
import { appendFileSync } from 'node:fs';

const argv = process.argv.slice(2);
const OK = '100000001';
const OFFLINE = '100000002';
const REFUSED = '100000003';
const USAGE = '100000004';
const PLAIN = '100000005';

const out = (v) => process.stdout.write((typeof v === 'string' ? v : JSON.stringify(v)) + '\n');
const err = (s) => process.stderr.write(s + '\n');
const flag = (name) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};
const has = (name) => argv.includes(name);
const afterDashes = () => {
  const i = argv.indexOf('--');
  return i >= 0 ? argv.slice(i + 1) : [];
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function readStdin() {
  const chunks = [];
  for await (const c of process.stdin) chunks.push(c);
  return Buffer.concat(chunks).toString('utf8');
}

function log(stdin) {
  if (!process.env.FAKE_LOG) return;
  const env = {};
  for (const k of ['GAIADESK_TOKEN_FILE', 'GAIADESK_CODE', 'GAIADESK_TOKEN', 'GAIADESK_AGENT_TOKEN', 'GAIADESK_SERVER', 'GAIADESK_PERSIST']) {
    if (process.env[k] !== undefined) env[k] = process.env[k];
  }
  appendFileSync(process.env.FAKE_LOG, JSON.stringify({ argv, env, stdin }) + '\n');
}

function job(name, extra = {}) {
  return { name, command: 'make', state: 'running', pid: 4242, started_at_ms: 1700000000000, log_bytes: 0, by: 'owner', ...extra };
}

function execJson(desk, cmd, stdin, exit = 0) {
  return {
    exit,
    remote_code: exit,
    stdout: `ran: ${cmd.join(' ')}${stdin ? `\nstdin: ${stdin}` : ''}\n`,
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

function failJson(desk, kind, message, exit) {
  return { exit, remote_code: null, stdout: '', stderr: '', duration_ms: 3, desk, route: null, mode: null, shell: null, timed_out: kind === 'timeout', error: { kind, message }, notes: [], truncated: false };
}

async function execLike(desk, cmd, stdin, json) {
  if (desk === OFFLINE) {
    if (json) out(failJson(desk, 'offline', `desk ${desk} is offline (last seen 4 min ago)`, 255));
    else err(`gaiadesk-cli: desk ${desk} is offline (last seen 4 min ago)`);
    return 255;
  }
  if (desk === USAGE) {
    if (json) out(failJson(desk, 'usage', 'no credential: set GAIADESK_TOKEN_FILE or GAIADESK_CODE', 255));
    return 255;
  }
  if (desk === PLAIN) {
    err('gaiadesk-cli: something odd');
    return 255;
  }
  if (desk === REFUSED) {
    if (json) out({ ...execJson(desk, cmd, ''), exit: 254, remote_code: -1, stdout: '', stderr: '', error: 'this agent token does not have the `exec` scope' });
    return 254;
  }
  const line = cmd.join(' ');
  const code = /^exit (\d+)$/.test(line) ? Number(line.slice(5)) : line === 'sleep' ? 124 : 0;
  if (json) {
    const r = execJson(desk, cmd, stdin, code);
    if (line === 'sleep') r.timed_out = true;
    out(r);
    return code;
  }
  process.stdout.write('part1 ');
  await sleep(30);
  process.stdout.write(`part2 ${line}\n`);
  if (stdin) process.stdout.write(`stdin: ${stdin}\n`);
  process.stderr.write('warn\n');
  return code;
}

async function mcp() {
  let buf = '';
  for await (const c of process.stdin) {
    buf += c.toString('utf8');
    let i;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.id === undefined) continue;
      const meta = m.params?._meta ?? {};
      if (meta['io.modelcontextprotocol/protocolVersion'] !== '2026-07-28' || !meta['io.modelcontextprotocol/clientCapabilities']) {
        out({ jsonrpc: '2.0', id: m.id, error: { code: -32602, message: '_meta is required on every request' } });
        continue;
      }
      if (m.method === 'tools/list') {
        out({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', tools: [{ name: 'gaiadesk.exec', inputSchema: { type: 'object' } }, { name: 'gaiadesk.screenshot', inputSchema: { type: 'object' } }], argv } });
      } else if (m.method === 'tools/call' && m.params.name === 'gaiadesk.exec') {
        const s = execJson(m.params.arguments.desk_id, [m.params.arguments.command], '');
        out({ jsonrpc: '2.0', id: m.id, result: { resultType: 'complete', content: [{ type: 'text', text: 'exit 0' }], structuredContent: s, isError: false } });
      } else if (m.method === 'tools/call' && m.params.name === 'gaiadesk.screenshot') {
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

async function main() {
  const cmd = argv[0];
  if (cmd === 'mcp') {
    log('');
    return mcp();
  }
  const stdin = await readStdin();
  log(stdin);
  const desk = flag('--desk-id') ?? flag('--desk');
  switch (cmd) {
    case '--version':
      out('gaiadesk-cli 0.1.0');
      return 0;
    case 'devices': {
      const rows = [
        { desk_id: OK, name: 'office-pc', online: true, os: 'windows', app_version: '0.10.323', owner: 'you', last_seen: 1700000000, sources: ['account'], last_ok: { at: 1700000000, route: 'LAN' }, last_failure: null, reachable: null },
        { desk_id: '999999999', name: 'nas', online: false, os: 'linux', app_version: null, owner: 'you', last_seen: null, sources: ['mesh'], last_ok: null, last_failure: { at: 1, kind: 'no_route', message: 'not found' }, reachable: null },
      ];
      let list = desk ? rows.filter((r) => r.desk_id === desk) : rows;
      if (has('--probe')) list = list.map((r) => ({ ...r, reachable: r.desk_id === OK, probe: r.desk_id === OK ? { ok: true, dialled: true, route: 'LAN', rtt_ms: 4 } : { ok: false, dialled: true, kind: 'no_route' } }));
      out({ devices: list, sources: ['account', 'mesh'], notes: [] });
      return list.some((r) => r.reachable === false) ? 1 : 0;
    }
    case 'exec':
      return execLike(desk, afterDashes(), has('--stdin') ? stdin : '', has('--json'));
    case 'shell':
      return execLike(desk, [`script:${stdin.trim()}`], '', has('--json'));
    case 'cp': {
      const pos = argv.slice(1).filter((a) => !a.startsWith('-'));
      const [src, dst] = pos;
      const remote = src.match(/^(\d{9}):/) ? src : dst;
      const d = remote.split(':')[0];
      if (d === REFUSED) {
        out({ refused: 'file transfer is turned off for you' });
        return 254;
      }
      if (d === PLAIN) {
        err('gaiadesk-cli: desk 100000005 is offline (last seen 2 h ago)');
        return 255;
      }
      const up = remote === dst;
      const failed = src.includes('fail') || dst.includes('fail') ? [{ path: 'a.txt', message: 'permission denied' }] : [];
      out({ direction: up ? 'upload' : 'download', desk: d, destination: up ? remote.slice(10) : dst, files: 2, dirs: has('--recursive') ? 1 : 0, bytes: 2048, resumed_bytes: 0, failed, seconds: 0.5 });
      return failed.length ? 1 : 0;
    }
    case 'run':
      if (desk === REFUSED) {
        out({ error: 'this agent token does not have the `jobs` scope' });
        return 254;
      }
      out(job(flag('--name'), { command: afterDashes().join(' ') }));
      return 0;
    case 'ps':
      if (desk === PLAIN) {
        out('NAME  STATE');
        return 0;
      }
      out([job('build'), job('old', { state: 'exited', exit_code: 0 })]);
      return 0;
    case 'kill': {
      const name = argv[1];
      if (name === 'nope') {
        out({ error: 'no job named nope' });
        err('gaiadesk-cli: no job named nope');
        return 1;
      }
      out(job(name, { state: 'killed' }));
      return 0;
    }
    case 'logs':
      if (has('--follow')) {
        for (const l of ['one', 'two', 'three']) {
          out(l);
          await sleep(20);
        }
        err(`job ${argv[1]} exited (exit 0)`);
        return 0;
      }
      if (argv[1] === 'nope') {
        err('gaiadesk-cli: no job named nope');
        return 1;
      }
      process.stdout.write(flag('--tail') ? 'tail\n' : 'line1\nline2\n');
      return 0;
    case 'stats':
      if (desk === PLAIN) {
        out({ desk, error: 'the desk did not answer' });
        err('gaiadesk-cli: the desk did not answer');
        return 255;
      }
      out({ desk, hostname: 'office-pc', os: 'windows', os_version: 'Windows 11 Pro', cpu_percent: 37.5, cpus: 8, load: null, mem_total_mb: 16384, mem_free_mb: 4096, disks: [{ mount: 'C:\\', total_mb: 512000, free_mb: 64000 }], uptime_secs: 3600, jobs_running: 2 });
      return 0;
    case 'measure':
      out({ desk, sent: Number(flag('--count') ?? 20), rtt_ms: desk === OK ? { n: 20, p50: 4, p95: 9, max: 12 } : null, clock_offset_ms: desk === OK ? 1.5 : null, clock_uncertainty_ms: desk === OK ? 0.5 : null });
      return desk === OK ? 0 : 1;
    case 'token': {
      const sub = argv[1];
      const info = { label: 'bot', id: '9f3a1c2b7d004e11', scopes: ['exec', 'cp'], issued_at_ms: 1, expires_at_ms: 2, revoked: false };
      if (!process.env.GAIADESK_CODE) {
        out({ error: 'token administration needs the desk\'s unattended password' });
        return 254;
      }
      if (sub === 'create') {
        const desks = flag('--desk').split(',');
        const file = flag('--out');
        out(file ? { tokens: desks.map((d) => ({ desk: d, token: info })), file } : { tokens: desks.map((d) => ({ desk: d, token: info, secret: `gdagt_${d}_${'a'.repeat(64)}` })) });
        return 0;
      }
      if (sub === 'list') {
        out([info]);
        return 0;
      }
      if (sub === 'revoke') {
        if (has('--account')) {
          out({ desk, ok: true, message: 'revoked through your account' });
          return 0;
        }
        const name = argv.slice(2).find((a, i, all) => !a.startsWith('-') && all[i - 1] !== '--desk');
        if (name === 'ghost') {
          out({ revoked: '', stopped_sessions: 0 });
          err('gaiadesk-cli: there was no live token on the desk to revoke');
          return 1;
        }
        out({ revoked: has('--all-for-desk') ? 'bot' : name, stopped_sessions: 1 });
        return 0;
      }
      return 255;
    }
    case 'audit':
      out([{ at_ms: 5, desk, token: 'bot', token_id: '9f3a', action: 'exec.end', detail: 'make test', bytes: 0, exit_code: 0, duration_ms: 900 }]);
      return 0;
    case 'mesh':
      if (argv[1] === 'status') {
        out({ self: { desk_id: '111111111', mesh_ip: '100.64.0.1' }, peers: [{ desk_id: OK, mesh_ip: '100.64.0.2', online: true, os: 'windows' }] });
        return 0;
      }
      if (argv[2] === OK) {
        out('100.64.0.2');
        return 0;
      }
      err(`gaiadesk-cli: desk ${argv[2]} is not on this machine's GaiaDesk Mesh`);
      return 1;
    case 'disconnect':
      err('gaiadesk-cli: closed the held connection to desk ' + (desk ?? 'all'));
      return 0;
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
        err('gaiadesk-cli: an agent token is required (--token, or $GAIADESK_AGENT_TOKEN)');
        return 255;
      }
      out(`agent session open on desk ${desk}: screenshot 1280x800`);
      return 0;
    default:
      err(`gaiadesk-cli: unknown subcommand ${JSON.stringify(cmd)}`);
      return 255;
  }
}

main().then((code) => process.exit(code));
