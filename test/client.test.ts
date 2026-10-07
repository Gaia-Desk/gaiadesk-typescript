// The client against a fake gaiadesk-cli (test/fixtures/fake-cli.ts, compiled
// next to this file). fake-cli-old.js is a CLI too old to answer `--version
// --json`: only the cwd tests use it, for the "update gaiadesk-cli" error.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  GaiaDesk,
  CliNotFoundError,
  CommandError,
  GaiaDeskError,
  OperationFailedError,
  ProtocolError,
  RefusedError,
  UnreachableError,
  UsageError,
  McpError,
  toolText,
  toolImage,
} from '../dist/index.js';
import type { GaiaDeskOptions, AccountRevokeResult, CpSummary } from '../dist/index.js';

const NEW_CLI = fileURLToPath(new URL('./fixtures/fake-cli.js', import.meta.url));
const OLD_CLI = fileURLToPath(new URL('./fixtures/fake-cli-old.js', import.meta.url));
const OK = '123456789';
const OTHER = '234567890';
const OFFLINE = 'offline-desk';
const REFUSED = 'refused-desk';
const USAGE = 'usage-desk';
const PLAIN = 'plain-desk';

interface Call {
  argv: string[];
  env: Record<string, string>;
  stdin: string;
}

function setup(opts: GaiaDeskOptions = {}, extraEnv: Record<string, string> = {}, fake: string = NEW_CLI) {
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-'));
  const log = join(dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_LOG: log, ...extraEnv };
  const gd = new GaiaDesk({ cli: [process.execPath, fake], env, ...opts });
  const calls = (): Call[] => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l) as Call) : []);
  /** The calls other than the `--version --json` probe. */
  const ops = (): Call[] => calls().filter((c) => c.argv[0] !== '--version');
  return { gd, calls, ops };
}

// ───────────────────────────── version and features ─────────────────────────────

test('version: the CLI text', async () => {
  assert.equal(await setup().gd.version(), 'gaiadesk-cli 0.10.324');
});

test('versionInfo: --version --json; null for a CLI too old to answer it', async () => {
  const v = await setup().gd.versionInfo();
  assert.equal(v?.version, '0.10.324');
  assert.ok(v?.features.includes('exec_json_stream'));
  assert.ok(v?.mcp_protocol_versions.includes('2025-06-18'));
  assert.ok((await setup().gd.features()).has('exec_cwd'));
  assert.equal(await setup({}, {}, OLD_CLI).gd.versionInfo(), null);
});

test('features are asked once per CLI path', async () => {
  // A path no other test uses (the cache is per process).
  const once = [process.execPath, '--no-warnings', NEW_CLI];
  const a = setup({ cli: once });
  await a.gd.exec(OK, 'x', { cwd: '/srv' });
  await a.gd.runJob(OK, 'build', 'make', { cwd: '/srv' });
  const b = setup({ cli: once });
  await b.gd.exec(OK, 'y', { cwd: '/srv' });
  assert.equal(a.calls().filter((c) => c.argv[0] === '--version').length, 1);
  assert.equal(b.calls().filter((c) => c.argv[0] === '--version').length, 0, 'a second client reuses the answer');
});

test('a missing gaiadesk-cli is CliNotFoundError with the download link', async () => {
  const gd = new GaiaDesk({ cli: '/nonexistent/gaiadesk-cli', env: {} });
  await assert.rejects(gd.version(), (e) => e instanceof CliNotFoundError && e.message.includes('https://gaiadesk.net/download'));
  await assert.rejects(gd.exec(OK, 'x', { cwd: '/srv' }), CliNotFoundError);
  await assert.rejects(gd.execStream(OK, 'x').wait(), CliNotFoundError);
});

// ───────────────────────────── credentials ─────────────────────────────

test('credentials travel in the environment, never argv', async () => {
  const { gd, calls } = setup({ tokenFile: '/t/bot.token', accountToken: 'acct', agentToken: 'gdagt_x', server: 'wss://example.invalid/ws', persist: 30 });
  await gd.exec(OK, 'hostname');
  const c = calls()[0];
  assert.deepEqual(c.env, {
    GAIADESK_TOKEN_FILE: '/t/bot.token',
    GAIADESK_TOKEN: 'acct',
    GAIADESK_AGENT_TOKEN: 'gdagt_x',
    GAIADESK_SERVER: 'wss://example.invalid/ws',
    GAIADESK_PERSIST: '30',
  });
  assert.ok(!c.argv.some((a) => a.includes('bot.token') || a.includes('acct')));
});

test('an explicit code beats an inherited token file', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-'));
  const log = join(dir, 'calls.jsonl');
  const gd = new GaiaDesk({ cli: [process.execPath, NEW_CLI], env: { PATH: process.env.PATH, FAKE_LOG: log, GAIADESK_TOKEN_FILE: '/inherited' }, code: 'pw' });
  await gd.exec(OK, 'x');
  const c = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.deepEqual(c.env, { GAIADESK_CODE: 'pw' });
});

// ───────────────────────────── exec / shell ─────────────────────────────

test('exec: the CLI JSON, verbatim', async () => {
  const { gd, ops } = setup();
  const r = await gd.exec(OK, 'hostname', { shell: 'sh', timeout: 10 });
  assert.equal(r.exit, 0);
  assert.equal(r.remote_code, 0);
  assert.equal(r.stdout, 'ran: hostname\n');
  assert.equal(r.stderr, 'warn\n');
  assert.equal(r.route, 'LAN');
  assert.equal(r.shell, '/bin/zsh -l -c');
  assert.equal(r.error, null);
  assert.deepEqual(ops()[0].argv, ['exec', '--desk-id', OK, '--quiet', '--json', '--no-stdin', '--shell', 'sh', '--timeout', '10', '--', 'hostname']);
});

test('exec: stdin is sent, then closed', async () => {
  const { gd, ops } = setup();
  const r = await gd.exec(OK, ['wc', '-l'], { stdin: 'a\nb\n' });
  assert.match(r.stdout, /stdin: a\nb\n/);
  assert.ok(ops()[0].argv.includes('--stdin'));
});

test('exec: a non-zero exit or a timeout is a result; check:true makes it an error', async () => {
  const { gd } = setup();
  const r = await gd.exec(OK, 'exit 3');
  assert.equal(r.exit, 3);
  await assert.rejects(gd.exec(OK, 'exit 3', { check: true }), (e) => e instanceof CommandError && (e.result as { exit: number }).exit === 3 && e.desk === OK);
  const t = await gd.exec(OK, 'sleep');
  assert.equal(t.timed_out, true);
  assert.equal(t.exit, 124);
  assert.deepEqual(t.error, { kind: 'failed', message: 'the command ran past --timeout and was stopped' });
});

test('exec: failures before the command ran are typed by their kind', async () => {
  const { gd } = setup();
  await assert.rejects(gd.exec(OFFLINE, 'x'), (e) => e instanceof UnreachableError && e.kind === 'offline' && /offline/.test(e.message) && e.exitCode === 255 && e.desk === OFFLINE);
  await assert.rejects(gd.exec(USAGE, 'x'), (e) => e instanceof UsageError && e.kind === 'usage' && /no credential/.test(e.message));
  await assert.rejects(gd.exec(REFUSED, 'x'), (e) => e instanceof RefusedError && e.kind === 'refused' && /`exec` scope/.test(e.message) && e.exitCode === 254);
  await assert.rejects(gd.exec(PLAIN, 'x'), (e) => e instanceof GaiaDeskError && e.message === 'something odd');
});

test('exec: the reason is kept beside the kind', async () => {
  await assert.rejects(setup().gd.exec(OFFLINE, 'x'), (e) => e instanceof UnreachableError && e.reason === 'offline' && (e.json as { error: { kind: string } }).error.kind === 'unreachable');
});

test('shell: the script goes on stdin, the result is exec-shaped', async () => {
  const { gd, ops } = setup();
  const r = await gd.shell(OK, 'cd /tmp\nls\n', { shell: 'sh' });
  assert.equal(r.stdout, 'ran: script:cd /tmp\nls\n');
  assert.deepEqual(ops()[0].argv, ['shell', '--desk-id', OK, '--quiet', '--json', '--shell', 'sh']);
  assert.equal(ops()[0].stdin, 'cd /tmp\nls\n');
});

test('cwd: shell --cwd (shell and shellStream)', async () => {
  const { gd, ops } = setup();
  const r = await gd.shell(OK, 'make\n', { cwd: '/srv/app' });
  assert.equal(r.stdout, 'ran: script:make\nin: /srv/app\n');
  assert.deepEqual(ops()[0].argv, ['shell', '--desk-id', OK, '--quiet', '--json', '--cwd', '/srv/app']);
  const s = gd.shellStream(OK, 'make\n', { cwd: 'proj' });
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'part1 part2 script:make\nin: proj\n');
  assert.deepEqual(ops()[1].argv, ['shell', '--desk-id', OK, '--quiet', '--cwd', 'proj']);
});

test('cwd: shell on a CLI too old for it is a UsageError naming shell_cwd, and nothing runs', async () => {
  const { gd, ops } = setup({}, {}, OLD_CLI);
  await assert.rejects(gd.shell(OK, 'make', { cwd: '/srv/app' }), (e) => e instanceof UsageError && /shell_cwd/.test(e.message));
  await assert.rejects(gd.shellStream(OK, 'make', { cwd: '/srv/app' }).wait(), UsageError);
  await assert.rejects(gd.shell(OK, 'make', { cwd: ' ' }), UsageError);
  assert.deepEqual(ops(), []);
});

// ───────────────────────────── cwd ─────────────────────────────

test('cwd: exec --cwd and run --cwd', async () => {
  const { gd, ops } = setup();
  const r = await gd.exec(OK, 'make', { cwd: '/srv/app' });
  assert.equal(r.stdout, 'ran: make\nin: /srv/app\n');
  assert.deepEqual(ops()[0].argv, ['exec', '--desk-id', OK, '--quiet', '--json', '--no-stdin', '--cwd', '/srv/app', '--', 'make']);
  await gd.runJob(OK, 'build', 'make', { cwd: 'src', priority: 'low' });
  assert.deepEqual(ops()[1].argv, ['run', '--detach', '--name', 'build', '--desk-id', OK, '--priority', 'low', '--cwd', 'src', '--json', '--', 'make']);
});

test('cwd: a directory that is not there is an OperationFailedError (exit 1)', async () => {
  await assert.rejects(setup().gd.exec(OK, 'make', { cwd: '/missing' }), (e) => e instanceof OperationFailedError && e.kind === 'failed' && e.exitCode === 1 && /no such directory/.test(e.message));
});

test('cwd: a CLI too old for it is a UsageError saying to update, and nothing runs', async () => {
  const { gd, ops } = setup({}, {}, OLD_CLI);
  await assert.rejects(gd.exec(OK, 'make', { cwd: '/srv/app' }), (e) => e instanceof UsageError && /Update gaiadesk-cli/.test(e.message) && /exec_cwd/.test(e.message));
  await assert.rejects(gd.runJob(OK, 'build', 'make', { cwd: '/srv/app' }), (e) => e instanceof UsageError && /run_cwd/.test(e.message));
  const s = gd.execStream(OK, 'make', { cwd: '/srv/app' });
  await assert.rejects(s.wait(), UsageError);
  await assert.rejects((async () => {
    for await (const _ of s) {
      /* nothing */
    }
  })(), UsageError, 'iteration throws it too');
  assert.deepEqual(ops(), [], 'no exec or run reached the CLI');
});

test('cwd: bad values are refused before anything runs', async () => {
  const { gd, calls } = setup();
  await assert.rejects(gd.exec(OK, 'x', { cwd: '' }), UsageError);
  await assert.rejects(gd.runJob(OK, 'b', 'x', { cwd: ' ' }), UsageError);
  assert.throws(() => gd.execStream(OK, 'x', { cwd: '' }), UsageError);
  assert.deepEqual(calls(), []);
});

// ───────────────────────────── streaming ─────────────────────────────

test('execStream: chunks as they come, then the exit', async () => {
  const { gd } = setup();
  const s = gd.execStream(OK, 'exit 2');
  let out = '';
  let err = '';
  for await (const c of s.text()) {
    if (c.stream === 'stdout') out += c.text;
    else err += c.text;
  }
  const exit = await s.wait();
  assert.equal(out, 'part1 part2 exit 2\n');
  assert.equal(err, 'warn\n');
  assert.equal(exit.exitCode, 2);
});

test('execStream with stdin kept open', async () => {
  const { gd } = setup();
  const s = gd.execStream(OK, 'cat', { stdin: true });
  s.write('hello'); // before the CLI is known: queued
  s.end();
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.match(out, /stdin: hello/);
  assert.equal((await s.wait()).exitCode, 0);
});

test('execStream runs exec --json-stream; the exit carries the result', async () => {
  const { gd, ops } = setup();
  const s = gd.execStream(OK, 'exit 2', { cwd: '/srv' });
  let out = '';
  let err = '';
  for await (const c of s.text()) c.stream === 'stdout' ? (out += c.text) : (err += c.text);
  assert.equal(out, 'part1 part2 exit 2\nin: /srv\n');
  assert.equal(err, 'warn\n', "the command's stderr only, not the CLI's own lines");
  const exit = await s.wait();
  assert.equal(exit.exitCode, 2);
  assert.equal(exit.result?.remote_code, 2);
  assert.equal(exit.result?.route, 'LAN');
  assert.equal(exit.error, undefined);
  assert.deepEqual(ops()[0].argv, ['exec', '--desk-id', OK, '--quiet', '--json-stream', '--no-stdin', '--cwd', '/srv', '--', 'exit 2']);
  assert.deepEqual(s.argv, ops()[0].argv);
});

test('execStream: a command that never ran ends with its error', async () => {
  const s = setup().gd.execStream(OFFLINE, 'x');
  const chunks = [];
  for await (const c of s) chunks.push(c);
  assert.equal(chunks.length, 0);
  const exit = await s.wait();
  assert.equal(exit.exitCode, 255);
  assert.deepEqual(exit.error, { kind: 'unreachable', reason: 'offline', message: `desk ${OFFLINE} is offline (last seen 4 min ago)`, desk: OFFLINE });
  assert.match(exit.stderrTail, /is offline/);
  const t = await setup().gd.execStream(OK, 'sleep').wait();
  assert.equal(t.result?.timed_out, true);
  assert.equal(t.error?.kind, 'failed');
});

test('followJobLogs streams (logs -f --json)', async () => {
  const { gd, ops } = setup();
  const s = gd.followJobLogs(OK, 'build');
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'one\ntwo\nthree\n');
  const exit = await s.wait();
  assert.equal(exit.stderrTail, 'job build exited (exit 0)');
  assert.equal(exit.error, undefined);
  assert.deepEqual(ops()[0].argv, ['logs', 'build', '--desk-id', OK, '--follow', '--json']);
});

test('followJobLogs: a failure is typed on wait()', async () => {
  const s = setup().gd.followJobLogs(OK, 'lost');
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'one\ntwo\nthree\n');
  const exit = await s.wait();
  assert.equal(exit.exitCode, 255);
  assert.equal(exit.error?.kind, 'connection_lost');
});

// ───────────────────────────── desk operations ─────────────────────────────

test('devices and probe (exit 1 for an unreachable desk is still a result)', async () => {
  const { gd } = setup();
  const all = await gd.devices();
  assert.equal(all.devices.length, 2);
  assert.equal(all.devices[0].reachable, null);
  const probed = await gd.devices({ probe: true });
  assert.deepEqual(probed.devices.map((d) => d.reachable), [true, false]);
  const one = await gd.probe(OK);
  assert.equal(one.probe?.route, 'LAN');
});

test('cp: upload / download summaries; failures and refusals are typed', async () => {
  const { gd, ops } = setup();
  const up = await gd.upload('dist', OK, 'deploy/', { recursive: true });
  assert.equal(up.direction, 'upload');
  assert.equal(up.dirs, 1);
  assert.deepEqual(ops()[0].argv, ['cp', '--recursive', '--json', 'dist', `${OK}:deploy/`]);
  const down = await gd.download(OK, 'logs/app.log', './app.log');
  assert.equal(down.direction, 'download');
  await assert.rejects(gd.upload('fail.txt', OK, 'x/'), (e) => e instanceof OperationFailedError && (e.json as CpSummary).failed.length === 1);
  await assert.rejects(gd.upload('a', REFUSED, 'x/'), (e) => e instanceof RefusedError && /turned off/.test(e.message) && e.desk === REFUSED);
  await assert.rejects(gd.upload('a', PLAIN, 'x/'), (e) => e instanceof GaiaDeskError && /offline/.test(e.message) && e.exitCode === 255);
});

test('jobs: run, ps, logs, kill', async () => {
  const { gd, ops } = setup();
  const j = await gd.runJob(OK, 'build', ['make', '-j8'], { priority: 'low', cpu: 50 });
  assert.equal(j.name, 'build');
  assert.equal(j.state, 'running');
  await assert.rejects(gd.runJob(REFUSED, 'build', 'make'), (e) => e instanceof RefusedError && /`jobs` scope/.test(e.message));
  const list = await gd.jobs(OK);
  assert.deepEqual(list.map((x) => x.state), ['running', 'exited']);
  assert.equal(await gd.jobLogs(OK, 'build'), 'line1\nline2\n');
  assert.equal(await gd.jobLogs(OK, 'build', { tail: 10 }), 'tail\n');
  await assert.rejects(gd.jobLogs(OK, 'nope'), (e) => e instanceof OperationFailedError && e.message === 'no job named nope');
  const logs = ops().filter((c) => c.argv[0] === 'logs').map((c) => c.argv.includes('--json'));
  assert.deepEqual(logs, [true, true, true]);
  assert.equal((await gd.killJob(OK, 'build')).state, 'killed');
  await assert.rejects(gd.killJob(OK, 'nope'), (e) => e instanceof OperationFailedError && e.kind === 'failed' && e.message === 'no job named nope');
});

test('stats and measure', async () => {
  const { gd } = setup();
  const s = await gd.stats(OK);
  assert.equal(s.cpus, 8);
  assert.equal(s.desk, OK);
  await assert.rejects(gd.stats(PLAIN), (e) => {
    assert.ok(e instanceof GaiaDeskError && e.message === 'the desk did not answer');
    assert.ok(e instanceof UnreachableError && e.kind === 'timeout' && e.reason === 'timeout' && e.desk === PLAIN);
    return true;
  });
  assert.equal((await gd.measure(OK, { count: 5 })).sent, 5);
  assert.equal((await gd.measure(REFUSED)).rtt_ms, null, 'no ping back: exit 1, still a result');
});

test('tokens: owner password via code; create, list, revoke, audit', async () => {
  const { gd: anon } = setup();
  await assert.rejects(anon.listTokens(OK), (e) => e instanceof RefusedError && /unattended password/.test(e.message));
  const { gd, calls } = setup({ code: 'owner-pw' });
  const made = await gd.createToken({ desks: [OK, OTHER], name: 'bot', scopes: ['exec', 'cp'] });
  assert.equal(made.tokens.length, 2);
  assert.match(made.tokens[0].secret ?? '', /^gdagt_/);
  const toFile = await gd.createToken({ desks: OK, out: '/tmp/bot.token' });
  assert.equal(toFile.file, '/tmp/bot.token');
  assert.equal(toFile.tokens[0].desk, OK);
  assert.ok(!('secret' in toFile.tokens[0]), 'the secret is only in the file');
  assert.equal(calls()[0].env.GAIADESK_CODE, 'owner-pw');
  assert.equal((await gd.listTokens(OK))[0].id, '9f3a1c2b7d004e11');
  assert.deepEqual(await gd.revokeToken(OK, 'bot'), { revoked: 'bot', stopped_sessions: 1 });
  assert.deepEqual(await gd.revokeToken(OK, { all: true }), { revoked: 'bot', stopped_sessions: 1 });
  assert.equal(((await gd.revokeToken(OK, 'bot', { account: true })) as AccountRevokeResult).ok, true);
  await assert.rejects(gd.revokeToken(OK, 'ghost'), (e) => e instanceof OperationFailedError && /no live token/.test(e.message));
  assert.equal((await gd.audit(OK, { token: 'bot' }))[0].action, 'exec.end');
});

test('mesh and disconnect (--json)', async () => {
  const { gd, ops } = setup();
  assert.equal((await gd.meshStatus()).peers[0].mesh_ip, '100.64.0.2');
  assert.equal(await gd.meshIp(OK), '100.64.0.2');
  await assert.rejects(gd.meshIp(OTHER), (e) => e instanceof OperationFailedError && /not on this machine's GaiaDesk Mesh/.test(e.message));
  assert.deepEqual(await gd.disconnect(OTHER), { closed: [OTHER] });
  assert.deepEqual(await gd.disconnect(), { closed: [OK] });
  const argvs = ops().map((c) => c.argv);
  assert.deepEqual(argvs[1], ['mesh', 'ip', OK, '--json']);
  assert.deepEqual(argvs.slice(-2), [['disconnect', '--desk-id', OTHER, '--json'], ['disconnect', '--all', '--json']]);
});

test('forward: resolves when listening, close() stops it', async () => {
  const { gd } = setup();
  const f = await gd.forward(OK, [{ remotePort: 5432, localPort: 15432 }, { remotePort: 80, remoteHost: 'db.lan' }]);
  assert.deepEqual(f.listening.map((l) => [l.local_port, l.remote_host, l.remote_port]), [[15432, '127.0.0.1', 5432], [40002, 'db.lan', 80]]);
  const exit = await f.close();
  assert.ok(exit.exitCode === 0 || exit.signal === 'SIGINT');
  await assert.rejects(gd.forward(REFUSED, { remotePort: 22 }), (e) => e instanceof RefusedError && /refused the forward/.test(e.message));
});

test('agentConnect needs an agent token', async () => {
  const { gd: none } = setup();
  await assert.rejects(none.agentConnect(OK), (e) => e instanceof GaiaDeskError && /agent token is required/.test(e.message));
  const { gd, ops } = setup({ agentToken: 'gdagt_x' });
  assert.equal(await gd.agentConnect(OK), `agent session open on desk ${OK}: screenshot 1280x800`);
  assert.deepEqual(ops().at(-1)?.argv, ['agent-connect', '--desk-id', OK, '--json']);
});

test('agentConnect: a refusal is a RefusedError', async () => {
  const { gd } = setup({ agentToken: 'gdagt_x' });
  await assert.rejects(gd.agentConnect(REFUSED), (e) => e instanceof RefusedError && /screen/.test(e.message));
});

test('abort: SIGINT reaches gaiadesk-cli', async () => {
  const { gd } = setup();
  const ac = new AbortController();
  const f = await gd.forward(OK, { remotePort: 1 }, { signal: ac.signal });
  ac.abort();
  const exit = await f.done;
  assert.ok(exit.exitCode === 0 || exit.signal === 'SIGINT');
});

test('unparseable output on success is a ProtocolError', async () => {
  const { gd } = setup();
  await assert.rejects(gd.jobs(PLAIN), (e) => e instanceof ProtocolError && e.exitCode === 0);
  const done = await gd.raw(['mesh', 'ip', OK]);
  assert.deepEqual([done.code, done.stdout.trim()], [0, '100.64.0.2'], 'raw() is the escape hatch');
});

// ───────────────────────────── MCP ─────────────────────────────

test('mcp: requests carry the 2026-07-28 _meta; tools and errors', async () => {
  const { gd } = setup({ server: 'wss://example.invalid/ws' });
  const m = gd.mcp({ auditDir: '/tmp/audit' });
  try {
    const tools = await m.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['gaiadesk_exec', 'gaiadesk_screenshot']);
    const r = await m.callTool('gaiadesk_exec', { desk_id: OK, command: 'hostname' });
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent?.stdout, 'ran: hostname\n');
    assert.equal(toolText(r), 'exit 0');
    const shot = await m.callTool('gaiadesk_screenshot', { session_id: 'h' });
    assert.deepEqual(toolImage(shot), { mimeType: 'image/png', base64: 'iVBORw0K' });
    await assert.rejects(m.callTool('gaiadesk_nope'), (e) => e instanceof McpError && e.code === -32602);
    const raw = await m.request('tools/list');
    assert.deepEqual(raw.argv, ['mcp', '--server', 'wss://example.invalid/ws', '--audit-dir', '/tmp/audit']);
  } finally {
    await m.close();
  }
  await assert.rejects(m.listTools(), GaiaDeskError, 'a closed client refuses');
});
