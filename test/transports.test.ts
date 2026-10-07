// The same behaviour on both transports: every case below runs once against
// the CLI transport (the fake gaiadesk-cli) and once against the API
// transport (the mock hosted API, which answers from the same fake CLI).
// Results, error classes, kinds, reasons, desks and exit codes must match.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  CommandError,
  GaiaDesk,
  GaiaDeskError,
  OperationFailedError,
  ProtocolError,
  RefusedError,
  UnreachableError,
  UsageError,
} from '../dist/index.js';
import type { CpSummary, MintResult } from '../dist/index.js';
import { startMockApi } from './fixtures/mock-api.js';

const FAKE = fileURLToPath(new URL('./fixtures/fake-cli.js', import.meta.url));
const OK = '123456789';
const OTHER = '234567890';
const OFFLINE = 'offline-desk';
const REFUSED = 'refused-desk';
const USAGE = 'usage-desk';
const PLAIN = 'plain-desk';

const api = await startMockApi();
after(() => api.close());

interface Transport {
  name: 'cli' | 'api';
  /** A client for desk operations. */
  desk(): GaiaDesk;
  /** A client allowed to administer tokens (the CLI: the desk's password; the API: a person's session). */
  owner(): GaiaDesk;
  /** A client that may not administer tokens. */
  anon(): GaiaDesk;
}

function cliClient(extra: { code?: string } = {}): GaiaDesk {
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-'));
  return new GaiaDesk({ cli: [process.execPath, FAKE], env: { PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, FAKE_LOG: join(dir, 'calls.jsonl') }, ...extra });
}

const TRANSPORTS: Transport[] = [
  { name: 'cli', desk: () => cliClient(), owner: () => cliClient({ code: 'owner-pw' }), anon: () => cliClient() },
  {
    name: 'api',
    desk: () => new GaiaDesk({ apiKey: 'ak_test', deskToken: 'gdagt_test', baseUrl: api.url }),
    owner: () => new GaiaDesk({ apiKey: 'session-person', baseUrl: api.url }),
    anon: () => new GaiaDesk({ apiKey: 'ak_test', deskToken: 'gdagt_test', baseUrl: api.url }),
  },
];

/** `test` once per transport, named `<transport>: <name>`. */
function both(name: string, fn: (t: Transport) => Promise<void>): void {
  for (const t of TRANSPORTS) test(`${t.name}: ${name}`, () => fn(t));
}

function files() {
  const dir = mkdtempSync(join(tmpdir(), 'gaiadesk-sdk-files-'));
  writeFileSync(join(dir, 'app.txt'), 'hello desk\n');
  writeFileSync(join(dir, 'fail.txt'), 'nope\n');
  return dir;
}

// ───────────────────────────── exec ─────────────────────────────

both('backend', async (t) => {
  assert.equal(t.desk().backend, t.name);
});

both('exec: the result, verbatim', async (t) => {
  const r = await t.desk().exec(OK, 'hostname', { shell: 'sh', timeout: 10 });
  assert.deepEqual(
    [r.exit, r.remote_code, r.stdout, r.stderr, r.route, r.shell, r.error, r.desk],
    [0, 0, 'ran: hostname\n', 'warn\n', 'LAN', '/bin/zsh -l -c', null, OK],
  );
});

both('exec: stdin, argv and cwd', async (t) => {
  const gd = t.desk();
  assert.match((await gd.exec(OK, ['wc', '-l'], { stdin: 'a\nb\n' })).stdout, /^ran: wc -l\nstdin: a\nb\n/);
  assert.equal((await gd.exec(OK, 'make', { cwd: '/srv/app' })).stdout, 'ran: make\nin: /srv/app\n');
});

both('exec: a non-zero exit or a timeout is a result; check:true makes it an error', async (t) => {
  const gd = t.desk();
  assert.equal((await gd.exec(OK, 'exit 3')).exit, 3);
  await assert.rejects(gd.exec(OK, 'exit 3', { check: true }), (e) => e instanceof CommandError && (e.result as { exit: number }).exit === 3 && e.desk === OK);
  const s = await gd.exec(OK, 'sleep');
  assert.deepEqual([s.timed_out, s.exit, s.error], [true, 124, { kind: 'failed', message: 'the command ran past --timeout and was stopped' }]);
});

both('exec: failures before the command ran are typed by their kind', async (t) => {
  const gd = t.desk();
  await assert.rejects(gd.exec(OFFLINE, 'x'), (e) => e instanceof UnreachableError && e.kind === 'offline' && e.reason === 'offline' && /offline/.test(e.message) && e.exitCode === 255 && e.desk === OFFLINE);
  await assert.rejects(gd.exec(USAGE, 'x'), (e) => e instanceof UsageError && e.kind === 'usage' && /no credential/.test(e.message));
  await assert.rejects(gd.exec(REFUSED, 'x'), (e) => e instanceof RefusedError && e.kind === 'refused' && /`exec` scope/.test(e.message) && e.exitCode === 254);
  await assert.rejects(gd.exec(PLAIN, 'x'), (e) => e instanceof GaiaDeskError && e.message === 'something odd');
  await assert.rejects(gd.exec(OK, 'make', { cwd: '/missing' }), (e) => e instanceof OperationFailedError && e.kind === 'failed' && e.exitCode === 1 && /no such directory/.test(e.message));
});

both('exec: bad arguments are the same UsageError, before anything runs', async (t) => {
  const gd = t.desk();
  await assert.rejects(gd.exec(OK, ''), UsageError);
  await assert.rejects(gd.exec(OK, 'x', { cwd: '' }), UsageError);
  await assert.rejects(gd.exec('-x', 'x'), UsageError);
  assert.throws(() => gd.execStream(OK, 'x', { cwd: '' }), UsageError);
});

// ───────────────────────────── streams ─────────────────────────────

both('execStream: chunks as they come, then the exit with its result', async (t) => {
  const s = t.desk().execStream(OK, 'exit 2', { cwd: '/srv' });
  let out = '';
  let err = '';
  for await (const c of s.text()) c.stream === 'stdout' ? (out += c.text) : (err += c.text);
  assert.equal(out, 'part1 part2 exit 2\nin: /srv\n');
  assert.equal(err, 'warn\n');
  const exit = await s.wait();
  assert.equal(exit.exitCode, 2);
  assert.equal(exit.result?.remote_code, 2);
  assert.equal(exit.result?.route, 'LAN');
  assert.equal(exit.error, undefined);
});

both('execStream: stdin given up front', async (t) => {
  const s = t.desk().execStream(OK, 'cat', { stdin: 'hello' });
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.match(out, /stdin: hello/);
  assert.equal((await s.wait()).exitCode, 0);
});

both('execStream: a command that never ran ends with its error', async (t) => {
  const s = t.desk().execStream(OFFLINE, 'x');
  const chunks = [];
  for await (const c of s) chunks.push(c);
  assert.equal(chunks.length, 0);
  const exit = await s.wait();
  assert.equal(exit.exitCode, 255);
  assert.deepEqual(exit.error, { kind: 'unreachable', reason: 'offline', message: `desk ${OFFLINE} is offline (last seen 4 min ago)`, desk: OFFLINE });
  assert.match(exit.stderrTail, /is offline/);
  const timed = await t.desk().execStream(OK, 'sleep').wait();
  assert.equal(timed.result?.timed_out, true);
  assert.equal(timed.error?.kind, 'failed');
});

both('followJobLogs: the output, then the end', async (t) => {
  const s = t.desk().followJobLogs(OK, 'build');
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'one\ntwo\nthree\n');
  const exit = await s.wait();
  assert.equal(exit.exitCode, 0);
  assert.equal(exit.stderrTail, 'job build exited (exit 0)');
  assert.equal(exit.error, undefined);
});

both('followJobLogs: a failure is typed on wait()', async (t) => {
  const s = t.desk().followJobLogs(OK, 'lost');
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'one\ntwo\nthree\n');
  const exit = await s.wait();
  assert.equal(exit.exitCode, 255);
  assert.equal(exit.error?.kind, 'connection_lost');
  assert.equal(exit.stderrTail, 'the connection to the desk was lost');
});

// ───────────────────────────── jobs / stats / devices ─────────────────────────────

both('jobs: run, ps, logs, kill', async (t) => {
  const gd = t.desk();
  const j = await gd.runJob(OK, 'build', ['make', '-j8'], { priority: 'low', cpu: 50 });
  assert.deepEqual([j.name, j.state, j.command], ['build', 'running', 'make -j8']);
  await assert.rejects(gd.runJob(REFUSED, 'build', 'make'), (e) => e instanceof RefusedError && /`jobs` scope/.test(e.message) && e.desk === REFUSED && e.exitCode === 254);
  assert.deepEqual((await gd.jobs(OK)).map((x) => x.state), ['running', 'exited']);
  assert.equal(await gd.jobLogs(OK, 'build'), 'line1\nline2\n');
  assert.equal(await gd.jobLogs(OK, 'build', { tail: 10 }), 'tail\n');
  await assert.rejects(gd.jobLogs(OK, 'nope'), (e) => e instanceof OperationFailedError && e.message === 'no job named nope' && e.exitCode === 1);
  assert.equal((await gd.killJob(OK, 'build')).state, 'killed');
  await assert.rejects(gd.killJob(OK, 'nope'), (e) => e instanceof OperationFailedError && e.kind === 'failed');
  await assert.rejects(gd.jobs(PLAIN), ProtocolError);
});

both('stats', async (t) => {
  const gd = t.desk();
  const s = await gd.stats(OK);
  assert.deepEqual([s.cpus, s.desk, s.hostname], [8, OK, 'office-pc']);
  await assert.rejects(gd.stats(PLAIN), (e) => e instanceof UnreachableError && e.kind === 'timeout' && e.reason === 'timeout' && e.desk === PLAIN && e.message === 'the desk did not answer');
});

both('devices: the {devices, sources, notes} list; one desk by id', async (t) => {
  const gd = t.desk();
  const all = await gd.devices();
  assert.deepEqual(all.devices.map((d) => [d.desk_id, d.online, d.reachable]), [[OK, true, null], [OTHER, false, null]]);
  assert.deepEqual(all.sources, ['account', 'mesh']);
  assert.deepEqual(all.notes, []);
  assert.deepEqual((await gd.devices({ deskId: OK })).devices.map((d) => d.name), ['office-pc']);
});

// ───────────────────────────── cp ─────────────────────────────

both('cp: upload and download one file; failures and refusals are typed', async (t) => {
  const gd = t.desk();
  const dir = files();
  const up = await gd.upload(join(dir, 'app.txt'), OK, 'deploy/');
  assert.deepEqual([up.direction, up.desk, up.dirs], ['upload', OK, 0]);
  if (t.name === 'api') assert.equal(up.destination, 'deploy/app.txt', 'a remote folder keeps the file name');
  const local = join(dir, 'got.log');
  const down = await gd.download(OK, 'logs/app.log', local);
  assert.deepEqual([down.direction, down.desk], ['download', OK]);
  if (t.name === 'api') assert.equal(readFileSync(local, 'utf8'), 'contents of logs/app.log\n');
  await assert.rejects(gd.upload(join(dir, 'fail.txt'), OK, 'x/'), (e) => e instanceof OperationFailedError && (e.json as CpSummary).failed.length === 1 && e.exitCode === 1);
  await assert.rejects(gd.upload(join(dir, 'app.txt'), REFUSED, 'x/'), (e) => e instanceof RefusedError && /turned off/.test(e.message) && e.desk === REFUSED);
  await assert.rejects(gd.upload(join(dir, 'app.txt'), PLAIN, 'x/'), (e) => e instanceof GaiaDeskError && /offline/.test(e.message) && e.exitCode === 255);
  await assert.rejects(gd.download(REFUSED, 'a.txt', local), (e) => e instanceof RefusedError && e.desk === REFUSED);
});

// ───────────────────────────── tokens ─────────────────────────────

both('tokens: only the owner administers them; create, list, revoke', async (t) => {
  await assert.rejects(t.anon().listTokens(OK), RefusedError);
  const gd = t.owner();
  const made = (await gd.createToken({ desks: [OK, OTHER], name: 'bot', scopes: ['exec', 'cp'] })) as MintResult;
  assert.deepEqual(made.tokens.map((x) => x.desk), [OK, OTHER]);
  assert.match(made.tokens[0].secret ?? '', /^gdagt_/);
  assert.equal(made.tokens[0].token.label, 'bot');
  assert.equal((await gd.listTokens(OK))[0].id, '9f3a1c2b7d004e11');
  assert.deepEqual(await gd.revokeToken(OK, 'bot'), { revoked: 'bot', stopped_sessions: 1 });
  await assert.rejects(gd.revokeToken(OK, 'ghost'), (e) => e instanceof OperationFailedError && /no live token/.test(e.message));
});
