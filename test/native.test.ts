// The native backend (@gaiadesk/sdk-native) through a mock module
// (fixtures/mock-native.ts), and the two backends side by side: the same
// calls must give the same results, error classes and kinds.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CliNotFoundError,
  CommandError,
  ConnectionLostError,
  GaiaDesk,
  GaiaDeskError,
  OperationFailedError,
  RefusedError,
  UnreachableError,
  UsageError,
} from '../dist/index.js';
import type { GaiaDeskOptions } from '../dist/index.js';
import { loadNative } from '../dist/native.js';
import { LOST, OFFLINE, OK, REFUSED, USAGE, makeMock } from './fixtures/mock-native.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.js', import.meta.url));
const BASE_ENV = { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot };

function nativeGd(opts: GaiaDeskOptions = {}) {
  const m = makeMock();
  const gd = new GaiaDesk({ native: m.module, env: { ...BASE_ENV }, ...opts });
  return { gd, ...m };
}

function cliGd(opts: GaiaDeskOptions = {}) {
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-'));
  return new GaiaDesk({ cli: [process.execPath, FAKE], env: { ...BASE_ENV, FAKE_LOG: join(dir, 'calls.jsonl') }, ...opts });
}

// ───────────────────────────── choosing the backend ─────────────────────────────

test('backend: native when the module is there, cli when asked or when a cli is given', () => {
  assert.equal(nativeGd().gd.backend, 'native');
  assert.equal(nativeGd({ backend: 'cli' }).gd.backend, 'cli');
  assert.equal(nativeGd({ cli: '/x/gaiadesk-cli' }).gd.backend, 'cli');
  assert.equal(nativeGd({ cli: '/x/gaiadesk-cli', backend: 'native' }).gd.backend, 'native');
  assert.equal(nativeGd({ env: { ...BASE_ENV, GAIADESK_SDK_BACKEND: 'cli' } }).gd.backend, 'cli');
  assert.throws(() => nativeGd({ backend: 'bogus' as 'cli' }).gd.backend, UsageError);
});

test('without @gaiadesk/sdk-native: auto falls back to the CLI, native is an error', () => {
  const gd = new GaiaDesk({ native: null, env: { ...BASE_ENV } });
  assert.equal(gd.backend, 'cli');
  assert.throws(() => new GaiaDesk({ backend: 'native', native: null, env: { ...BASE_ENV } }).backend, CliNotFoundError);
});

test('loadNative: a module whose binary does not load counts as absent', () => {
  const broken = () => ({ Client: class {}, buildInfo: () => { throw new Error('no binary for this platform'); } });
  assert.equal(loadNative(broken).module, null);
  assert.match(loadNative(broken).why ?? '', /no binary/);
  assert.notEqual(loadNative(() => ({ Client: class {} })).module, null);
});

test('credentials: the same ones the CLI would read, from options or the environment', async () => {
  const { gd, clients } = nativeGd({ tokenFile: '/t/bot.token', accountToken: 'acct', agentToken: 'gdagt_x', server: 'wss://example.invalid/ws', persist: 30, cwd: '/w' });
  await gd.stats(OK);
  assert.deepEqual(clients[0], { tokenFile: '/t/bot.token', accountToken: 'acct', agentToken: 'gdagt_x', server: 'wss://example.invalid/ws', persist: '30', cwd: '/w' });
  const e = nativeGd({ env: { ...BASE_ENV, GAIADESK_TOKEN_FILE: '/inherited' }, code: 'pw' });
  await e.gd.stats(OK);
  assert.deepEqual(e.clients[0], { code: 'pw' });
  assert.throws(() => nativeGd({ persist: 'forever' as unknown as number }).gd.backend, UsageError);
});

// ───────────────────────────── operations ─────────────────────────────

test('exec: the ops and arguments the native library gets', async () => {
  const { gd, calls } = nativeGd();
  const r = await gd.exec(OK, ['ls', '-l'], { shell: 'sh', timeout: 90, connectTimeout: '30s', stdin: 'hi' });
  assert.equal(r.stdout, 'ran: ls -l\nstdin: hi\n');
  assert.deepEqual(calls[0], { op: 'exec', args: { desk_id: OK, command: ['ls', '-l'], shell: 'sh', timeout: '90', connect_timeout: '30s' }, input: 'hi', signal: false });
  await assert.rejects(gd.exec(OK, 'exit 3', { check: true }), (e: unknown) => e instanceof CommandError && (e.result as { exit: number }).exit === 3);
  assert.equal((await gd.shell(OK, 'echo hi\n')).stdout, 'ran: script:echo hi\n');
  assert.equal((await gd.shell(OK, 'echo hi\n', { cwd: '/srv/app' })).stdout, 'ran: script:echo hi\nin: /srv/app\n');
  assert.equal(calls.at(-1)?.args.cwd, '/srv/app', 'shell cwd reaches the native library');
});

test('every other operation maps to its op', async () => {
  const { gd, calls } = nativeGd();
  await gd.devices({ probe: true });
  assert.equal((await gd.probe(OK)).reachable, true);
  await gd.upload('./a', OK, 'b/', { recursive: true });
  await gd.download(OK, 'b', './a');
  await gd.runJob(OK, 'build', 'make', { priority: 'low', cpu: 50, mem: '4G', keepAwake: true });
  assert.deepEqual((await gd.jobs(OK)).map((j) => j.name), ['build']);
  assert.equal(await gd.jobLogs(OK, 'build', { tail: 100 }), 'line 1\nline 2\n');
  await gd.killJob(OK, 'build');
  await gd.stats(OK);
  await gd.measure(OK, { count: 3 });
  await gd.createToken({ desks: [OK], name: 'bot', scopes: ['exec'], lowPriv: true });
  assert.equal((await gd.listTokens(OK))[0].label, 'bot');
  await gd.revokeToken(OK, { all: true });
  assert.deepEqual(await gd.revokeToken(OK, 'bot', { account: true }), { desk: OK, ok: true, message: 'revoked' });
  assert.equal((await gd.audit(OK, { limit: 5 }))[0].action, 'exec.end');
  await gd.meshStatus();
  assert.equal(await gd.meshIp(OK), '100.64.0.1');
  assert.deepEqual(await gd.disconnect(OK), { closed: [OK] });
  assert.deepEqual(await gd.disconnect(), { closed: [] });
  assert.equal(await gd.version(), 'gaiadesk-native 0.10.323');
  const byOp = Object.fromEntries(calls.map((c) => [c.op, c.args]));
  assert.deepEqual(byOp.job_run, { desk_id: OK, name: 'build', command: 'make', limits: { priority: 'low', cpu_percent: 50, mem_mb: 4096, keep_awake: true } });
  assert.deepEqual(byOp.token_mint, { desks: [OK], name: 'bot', scopes: ['exec'], low_priv: true });
  assert.deepEqual(byOp.upload, { desk_id: OK, local: './a', remote: 'b/', recursive: true });
  assert.deepEqual(byOp.job_logs, { desk_id: OK, name: 'build', tail: 100 });
  assert.equal(calls.filter((c) => c.op === 'disconnect').length, 2);
});

test('cwd: exec, streams and jobs pass it to the native library', async () => {
  const { gd, calls } = nativeGd();
  const r = await gd.exec(OK, 'make', { cwd: '/srv/app' });
  assert.equal(r.stdout, 'ran: make\nin: /srv/app\n');
  assert.equal(calls[0].args.cwd, '/srv/app');
  await gd.runJob(OK, 'build', 'make', { cwd: 'src' });
  assert.deepEqual(calls[1].args, { desk_id: OK, name: 'build', command: 'make', limits: {}, cwd: 'src' });
  const s = gd.execStream(OK, 'make', { cwd: '/srv' });
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'part1 part2 make\nin: /srv\n');
  assert.equal(calls[2].args.cwd, '/srv');
  await assert.rejects(gd.exec(OK, 'x', { cwd: '' }), UsageError);
});

test('waitJob, whoami, env and a job shell reach the native library', async () => {
  const { gd, calls } = nativeGd();
  const r = await gd.waitJob(OK, 'build');
  assert.deepEqual([r.timed_out, r.job.exit_code], [false, 0]);
  assert.equal((await gd.waitJob(OK, 'slow', { timeout: 30 })).timed_out, true);
  await assert.rejects(gd.waitJob(OK, 'nope'), OperationFailedError);
  assert.deepEqual(await gd.whoami(), { source: 'app', account: 'you@example.com' });
  await gd.exec(OK, 'make', { env: { CI: '1' } });
  await gd.runJob(OK, 'build', 'make', { shell: 'bash', env: { JOBS: '8' } });
  const s = gd.execStream(OK, 'make', { env: { CI: '1' } });
  assert.equal((await s.wait()).exitCode, 0);
  assert.deepEqual(calls.filter((c) => c.op === 'job_wait').map((c) => c.args).slice(0, 2), [{ desk_id: OK, name: 'build' }, { desk_id: OK, name: 'slow', timeout: '30' }]);
  const by = (op: string) => calls.filter((c) => c.op === op).pop()!.args;
  assert.deepEqual(by('whoami'), {});
  assert.deepEqual(by('exec').env, { CI: '1' });
  assert.deepEqual(by('job_run'), { desk_id: OK, name: 'build', command: 'make', limits: {}, shell: 'bash', env: { JOBS: '8' } });
  assert.deepEqual(by('stream:exec').env, { CI: '1' });
  await assert.rejects(gd.exec(OK, 'x', { env: { 'A B': 'x' } }), UsageError);
});

test('errors carry the envelope: kind, reason and desk', async () => {
  const { gd } = nativeGd();
  await assert.rejects(gd.exec(OFFLINE, 'x'), (e: unknown) => {
    assert.ok(e instanceof UnreachableError);
    assert.equal(e.kind, 'offline');
    assert.equal(e.reason, 'offline');
    assert.equal(e.desk, OFFLINE);
    assert.deepEqual(e.json, { error: { kind: 'unreachable', message: `desk ${OFFLINE} is offline (last seen 4 min ago)`, reason: 'offline', desk: OFFLINE } });
    return true;
  });
  await assert.rejects(gd.killJob(OK, 'nope'), (e: unknown) => e instanceof OperationFailedError && e.desk === OK);
});

test('streams: the exit carries the run result and error', async () => {
  const { gd } = nativeGd();
  const exit = await gd.execStream(OK, 'exit 4').wait();
  assert.equal(exit.exitCode, 4);
  assert.equal(exit.result?.remote_code, 4);
  assert.equal(exit.result?.error, null);
  const t = await gd.execStream(OK, 'sleep').wait();
  assert.equal(t.result?.timed_out, true);
  assert.deepEqual(t.error, { kind: 'failed', message: 'the command ran past --timeout and was stopped' });
  assert.equal(t.stderrTail, 'the command ran past --timeout and was stopped');
  const refused = await gd.execStream(REFUSED, 'x').wait();
  assert.equal(refused.error?.kind, 'refused');
});

test('streams: chunks, then the exit; stdin kept open; kill stops the remote side', async () => {
  const { gd } = nativeGd();
  const s = gd.execStream(OK, 'make');
  let out = '';
  let err = '';
  for await (const c of s.text()) c.stream === 'stdout' ? (out += c.text) : (err += c.text);
  assert.equal(out, 'part1 part2 make\n');
  assert.equal(err, 'warn\n');
  const exit = await s.wait();
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.stderrTail, 'warn');

  const sh = gd.shellStream(OK);
  sh.write('ls\n'); // before the native stream is up: queued
  sh.end();
  let t = '';
  for await (const c of sh.text()) t += c.text;
  assert.equal(t, 'stdin: ls\n');

  const f = gd.followJobLogs(OK, 'forever');
  for await (const c of f) {
    assert.equal(Buffer.from(c.data).toString(), 'line 1\n');
    f.kill();
  }
  assert.equal((await f.wait()).exitCode, 130);
});

test('a stream that fails to start ends like the CLI would: its exit code and reason', async () => {
  const { gd } = nativeGd();
  const s = gd.execStream(REFUSED, 'x');
  const chunks = [];
  for await (const c of s) chunks.push(c);
  assert.equal(chunks.length, 0);
  const e = await s.wait();
  assert.equal(e.exitCode, 254);
  assert.match(e.stderrTail, /exec. scope/);
});

test('forward and agentConnect', async () => {
  const { gd } = nativeGd();
  const f = await gd.forward(OK, [{ remotePort: 5432 }, { remotePort: 80, remoteHost: 'printer', localPort: 8080 }]);
  assert.deepEqual(f.listening.map((l) => l.local_port), [54321, 8080]);
  assert.equal((await f.close()).exitCode, 0);
  await assert.rejects(gd.forward(REFUSED, { remotePort: 1 }), RefusedError);
  assert.equal(await gd.agentConnect(OK), `agent session open on desk ${OK}: screenshot 1280x800`);
});

test('an AbortSignal reaches the native call', async () => {
  const { gd, calls } = nativeGd();
  await assert.rejects(gd.stats(OK, { signal: AbortSignal.abort() }), (e: unknown) => e instanceof GaiaDeskError && e.kind === 'interrupted' && e.exitCode === 130);
  assert.equal(calls[0].signal, true);
});

// ───────────────────────────── both backends, same answers ─────────────────────────────

type Scenario = [name: string, run: (gd: GaiaDesk) => Promise<unknown>, cls: Function, kind: string];

const SCENARIOS: Scenario[] = [
  ['exec on an offline desk', (gd) => gd.exec(OFFLINE, 'x'), UnreachableError, 'offline'],
  ['exec refused', (gd) => gd.exec(REFUSED, 'x'), RefusedError, 'refused'],
  ['exec with no credential', (gd) => gd.exec(USAGE, 'x'), UsageError, 'usage'],
  ['a bad desk id, before anything runs', (gd) => gd.exec('1 2', 'x'), UsageError, 'usage'],
  ['an empty command', (gd) => gd.exec(OK, ''), UsageError, 'usage'],
  ['check: true on a non-zero exit', (gd) => gd.exec(OK, 'exit 2', { check: true }), CommandError, 'cli_error'],
  ['a copy with a failed file', (gd) => gd.upload('./fail.txt', OK, 'x/'), OperationFailedError, 'failed'],
  ['a bad job name', async (gd) => gd.killJob(OK, '-x'), UsageError, 'usage'],
];

for (const [name, run, cls, kind] of SCENARIOS) {
  test(`same error on both backends: ${name}`, async () => {
    for (const [backend, gd] of [['cli', cliGd()], ['native', nativeGd().gd]] as const) {
      await assert.rejects(run(gd), (e: unknown) => {
        assert.ok(e instanceof cls, `${backend}: ${(e as Error)?.constructor?.name} is not ${cls.name}`);
        if (cls !== CommandError) assert.equal((e as GaiaDeskError).kind, kind, `${backend}: kind`);
        return true;
      });
    }
  });
}

test('same error on both backends: a copy with a failed file carries the summary', async () => {
  for (const gd of [cliGd(), nativeGd().gd]) {
    await assert.rejects(gd.upload('./fail.txt', OK, 'x/'), (e: unknown) => {
      assert.ok(e instanceof OperationFailedError);
      assert.equal((e.json as { failed: unknown[] }).failed.length, 1);
      return true;
    });
  }
});

test('the native backend reports a lost connection as ConnectionLostError', async () => {
  await assert.rejects(nativeGd().gd.stats(LOST), (e: unknown) => e instanceof ConnectionLostError && e.kind === 'connection_lost' && e.exitCode === 253);
});

test('same results on both backends', async () => {
  for (const gd of [cliGd({ code: 'pw' }), nativeGd({ code: 'pw' }).gd]) {
    const r = await gd.exec(OK, 'exit 3');
    assert.equal(r.exit, 3);
    assert.equal(r.desk, OK);
    const j = await gd.runJob(OK, 'build', 'make');
    assert.equal(j.state, 'running');
    const k = await gd.revokeToken(OK, 'bot', { account: true });
    assert.equal((k as { ok: boolean }).ok, true);
  }
});
