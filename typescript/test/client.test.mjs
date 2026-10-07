// The client against a fake gaiadesk-cli (test-fixtures/fake-cli.mjs).
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

const FAKE = fileURLToPath(new URL('../test-fixtures/fake-cli.mjs', import.meta.url));
const OK = '100000001';
const OFFLINE = '100000002';
const REFUSED = '100000003';
const USAGE = '100000004';
const PLAIN = '100000005';

function setup(opts = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-'));
  const log = join(dir, 'calls.jsonl');
  const env = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_LOG: log };
  const gd = new GaiaDesk({ cli: [process.execPath, FAKE], env, ...opts });
  const calls = () => (existsSync(log) ? readFileSync(log, 'utf8').trim().split('\n').map((l) => JSON.parse(l)) : []);
  return { gd, calls };
}

test('version', async () => {
  const { gd } = setup();
  assert.equal(await gd.version(), 'gaiadesk-cli 0.1.0');
});

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
  const gd = new GaiaDesk({ cli: [process.execPath, FAKE], env: { PATH: process.env.PATH, FAKE_LOG: log, GAIADESK_TOKEN_FILE: '/inherited' }, code: 'pw' });
  await gd.exec(OK, 'x');
  const c = JSON.parse(readFileSync(log, 'utf8').trim());
  assert.deepEqual(c.env, { GAIADESK_CODE: 'pw' });
});

test('exec: the CLI JSON, verbatim', async () => {
  const { gd, calls } = setup();
  const r = await gd.exec(OK, 'hostname', { shell: 'sh', timeout: 10 });
  assert.equal(r.exit, 0);
  assert.equal(r.remote_code, 0);
  assert.equal(r.stdout, 'ran: hostname\n');
  assert.equal(r.stderr, 'warn\n');
  assert.equal(r.route, 'LAN');
  assert.equal(r.shell, '/bin/zsh -l -c');
  assert.deepEqual(calls()[0].argv, ['exec', '--desk-id', OK, '--quiet', '--json', '--no-stdin', '--shell', 'sh', '--timeout', '10', '--', 'hostname']);
});

test('exec: stdin is sent, then closed', async () => {
  const { gd, calls } = setup();
  const r = await gd.exec(OK, ['wc', '-l'], { stdin: 'a\nb\n' });
  assert.match(r.stdout, /stdin: a\nb\n/);
  assert.ok(calls()[0].argv.includes('--stdin'));
});

test('exec: a non-zero exit is a result; check:true makes it an error', async () => {
  const { gd } = setup();
  const r = await gd.exec(OK, 'exit 3');
  assert.equal(r.exit, 3);
  await assert.rejects(gd.exec(OK, 'exit 3', { check: true }), (e) => e instanceof CommandError && e.result.exit === 3);
  const t = await gd.exec(OK, 'sleep');
  assert.equal(t.timed_out, true);
  assert.equal(t.exit, 124);
});

test('exec: failures before the command ran are typed by their kind', async () => {
  const { gd } = setup();
  await assert.rejects(gd.exec(OFFLINE, 'x'), (e) => e instanceof UnreachableError && e.kind === 'offline' && /offline/.test(e.message) && e.exitCode === 255);
  await assert.rejects(gd.exec(USAGE, 'x'), (e) => e instanceof UsageError && /no credential/.test(e.message));
  await assert.rejects(gd.exec(REFUSED, 'x'), (e) => e instanceof RefusedError && /`exec` scope/.test(e.message) && e.exitCode === 254);
  await assert.rejects(gd.exec(PLAIN, 'x'), (e) => e instanceof GaiaDeskError && e.message === 'something odd');
});

test('a missing gaiadesk-cli is CliNotFoundError with the download link', async () => {
  const gd = new GaiaDesk({ cli: '/nonexistent/gaiadesk-cli', env: {} });
  await assert.rejects(gd.version(), (e) => e instanceof CliNotFoundError && e.message.includes('https://gaiadesk.net/download'));
});

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
  s.write('hello');
  s.end();
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.match(out, /stdin: hello/);
  assert.equal((await s.wait()).exitCode, 0);
});

test('shell: the script goes on stdin, the result is exec-shaped', async () => {
  const { gd, calls } = setup();
  const r = await gd.shell(OK, 'cd /tmp\nls\n', { shell: 'sh' });
  assert.equal(r.stdout, 'ran: script:cd /tmp\nls\n');
  assert.deepEqual(calls()[0].argv, ['shell', '--desk-id', OK, '--quiet', '--json', '--shell', 'sh']);
  assert.equal(calls()[0].stdin, 'cd /tmp\nls\n');
});

test('devices and probe (exit 1 for an unreachable desk is still a result)', async () => {
  const { gd } = setup();
  const all = await gd.devices();
  assert.equal(all.devices.length, 2);
  assert.equal(all.devices[0].reachable, null);
  const probed = await gd.devices({ probe: true });
  assert.deepEqual(probed.devices.map((d) => d.reachable), [true, false]);
  const one = await gd.probe(OK);
  assert.equal(one.probe.route, 'LAN');
});

test('cp: upload / download summaries; failures and refusals are typed', async () => {
  const { gd, calls } = setup();
  const up = await gd.upload('dist', OK, 'deploy/', { recursive: true });
  assert.equal(up.direction, 'upload');
  assert.equal(up.dirs, 1);
  assert.deepEqual(calls()[0].argv, ['cp', '--recursive', '--json', 'dist', `${OK}:deploy/`]);
  const down = await gd.download(OK, 'logs/app.log', './app.log');
  assert.equal(down.direction, 'download');
  await assert.rejects(gd.upload('fail.txt', OK, 'x/'), (e) => e instanceof OperationFailedError && e.json.failed.length === 1);
  await assert.rejects(gd.upload('a', REFUSED, 'x/'), (e) => e instanceof RefusedError && /turned off/.test(e.message));
  await assert.rejects(gd.upload('a', PLAIN, 'x/'), (e) => e instanceof GaiaDeskError && /offline/.test(e.message) && e.exitCode === 255);
});

test('jobs: run, ps, logs, kill', async () => {
  const { gd } = setup();
  const j = await gd.runJob(OK, 'build', ['make', '-j8'], { priority: 'low', cpu: 50 });
  assert.equal(j.name, 'build');
  assert.equal(j.state, 'running');
  await assert.rejects(gd.runJob(REFUSED, 'build', 'make'), RefusedError);
  const list = await gd.jobs(OK);
  assert.deepEqual(list.map((x) => x.state), ['running', 'exited']);
  assert.equal(await gd.jobLogs(OK, 'build'), 'line1\nline2\n');
  assert.equal(await gd.jobLogs(OK, 'build', { tail: 10 }), 'tail\n');
  await assert.rejects(gd.jobLogs(OK, 'nope'), (e) => e instanceof OperationFailedError && e.message === 'no job named nope');
  assert.equal((await gd.killJob(OK, 'build')).state, 'killed');
  await assert.rejects(gd.killJob(OK, 'nope'), (e) => e instanceof OperationFailedError && e.message === 'no job named nope');
});

test('followJobLogs streams', async () => {
  const { gd } = setup();
  const s = gd.followJobLogs(OK, 'build');
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'one\ntwo\nthree\n');
  assert.equal((await s.wait()).stderrTail, 'job build exited (exit 0)');
});

test('stats and measure', async () => {
  const { gd } = setup();
  const s = await gd.stats(OK);
  assert.equal(s.cpus, 8);
  assert.equal(s.desk, OK);
  await assert.rejects(gd.stats(PLAIN), (e) => e instanceof GaiaDeskError && e.message === 'the desk did not answer');
  assert.equal((await gd.measure(OK, { count: 5 })).sent, 5);
  assert.equal((await gd.measure(REFUSED)).rtt_ms, null, 'no ping back: exit 1, still a result');
});

test('tokens: owner password via code; create, list, revoke, audit', async () => {
  const { gd: anon } = setup();
  await assert.rejects(anon.listTokens(OK), (e) => e instanceof RefusedError && /unattended password/.test(e.message));
  const { gd, calls } = setup({ code: 'owner-pw' });
  const made = await gd.createToken({ desks: [OK, '100000009'], name: 'bot', scopes: ['exec', 'cp'] });
  assert.equal(made.tokens.length, 2);
  assert.match(made.tokens[0].secret, /^gdagt_/);
  const toFile = await gd.createToken({ desks: OK, out: '/tmp/bot.token' });
  assert.equal(toFile.file, '/tmp/bot.token');
  assert.equal(toFile.tokens[0].secret, undefined);
  assert.equal(calls()[0].env.GAIADESK_CODE, 'owner-pw');
  assert.equal((await gd.listTokens(OK))[0].id, '9f3a1c2b7d004e11');
  assert.deepEqual(await gd.revokeToken(OK, 'bot'), { revoked: 'bot', stopped_sessions: 1 });
  assert.deepEqual(await gd.revokeToken(OK, { all: true }), { revoked: 'bot', stopped_sessions: 1 });
  assert.equal((await gd.revokeToken(OK, 'bot', { account: true })).ok, true);
  await assert.rejects(gd.revokeToken(OK, 'ghost'), (e) => e instanceof OperationFailedError && /no live token/.test(e.message));
  assert.equal((await gd.audit(OK, { token: 'bot' }))[0].action, 'exec.end');
});

test('mesh and disconnect', async () => {
  const { gd, calls } = setup();
  assert.equal((await gd.meshStatus()).peers[0].mesh_ip, '100.64.0.2');
  assert.equal(await gd.meshIp(OK), '100.64.0.2');
  await assert.rejects(gd.meshIp('100000009'), OperationFailedError);
  await gd.disconnect(OK);
  await gd.disconnect();
  const argvs = calls().map((c) => c.argv);
  assert.deepEqual(argvs.slice(-2), [['disconnect', '--desk-id', OK], ['disconnect', '--all']]);
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
  const { gd } = setup({ agentToken: 'gdagt_x' });
  assert.match(await gd.agentConnect(OK), /screenshot 1280x800/);
});

test('mcp: requests carry the 2026-07-28 _meta; tools and errors', async () => {
  const { gd } = setup({ server: 'wss://example.invalid/ws' });
  const m = gd.mcp({ auditDir: '/tmp/audit' });
  try {
    const tools = await m.listTools();
    assert.deepEqual(tools.map((t) => t.name), ['gaiadesk.exec', 'gaiadesk.screenshot']);
    const r = await m.callTool('gaiadesk.exec', { desk_id: OK, command: 'hostname' });
    assert.equal(r.isError, false);
    assert.equal(r.structuredContent.stdout, 'ran: hostname\n');
    assert.equal(toolText(r), 'exit 0');
    const shot = await m.callTool('gaiadesk.screenshot', { session_id: 'h' });
    assert.deepEqual(toolImage(shot), { mimeType: 'image/png', base64: 'iVBORw0K' });
    await assert.rejects(m.callTool('gaiadesk.nope'), (e) => e instanceof McpError && e.code === -32602);
    const raw = await m.request('tools/list');
    assert.deepEqual(raw.argv, ['mcp', '--server', 'wss://example.invalid/ws', '--audit-dir', '/tmp/audit']);
  } finally {
    await m.close();
  }
  await assert.rejects(m.listTools(), GaiaDeskError, 'a closed client refuses');
});

test('abort: SIGINT reaches gaiadesk-cli', async () => {
  const { gd } = setup();
  const ac = new AbortController();
  const p = gd.forward(OK, { remotePort: 1 }, { signal: ac.signal });
  const f = await p;
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
