// The argument vectors, checked against `gaiadesk-cli <cmd> --help`.
// Tests import the built package (../dist), so they test what is published.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../dist/args.js';
import { UsageError } from '../dist/index.js';
import type { Shell } from '../dist/index.js';
import { locateCli, standardLocations } from '../dist/locate.js';

test('exec: one command line vs an argument vector, stdin closed by default', () => {
  assert.deepEqual(A.execArgs('123456789', 'ls | wc -l', {}, true), ['exec', '--desk-id', '123456789', '--quiet', '--json', '--no-stdin', '--', 'ls | wc -l']);
  assert.deepEqual(A.execArgs('1', ['printf', '%s', 'a b'], { shell: 'none', stdin: true }, false), [
    'exec', '--desk-id', '1', '--quiet', '--stdin', '--shell', 'none', '--', 'printf', '%s', 'a b',
  ]);
});

test('exec: durations are whole seconds (rounded up) or strings as written', () => {
  const a = A.execArgs('1', 'x', { timeout: 1.2, connectTimeout: '90s', persist: 0, verbose: true }, true);
  assert.deepEqual(a.slice(6, -2), ['--timeout', '2', '--connect-timeout', '90s', '--persist', '0', '--verbose']);
  assert.ok(A.execArgs('1', 'x', { timeout: 0 }, true).includes('0'), 'timeout 0 = no limit');
  assert.throws(() => A.execArgs('1', 'x', { connectTimeout: 0 }, true), UsageError);
  assert.throws(() => A.execArgs('1', 'x', { timeout: -1 }, true), UsageError);
  assert.throws(() => A.execArgs('1', 'x', { timeout: '1 day; rm' }, true), UsageError);
});

test('exec: bad input is refused before anything runs', () => {
  for (const bad of [() => A.execArgs('', 'x', {}, true), () => A.execArgs('39 2586273', 'x', {}, true), () => A.execArgs('--code', 'x', {}, true),
    () => A.execArgs('1', '', {}, true), () => A.execArgs('1', [], {}, true), () => A.execArgs('1', 'x', { shell: 'fish' as Shell }, true)]) {
    assert.throws(bad, UsageError);
  }
});

test('credentials are never in argv', () => {
  const all = [
    A.execArgs('1', 'x', {}, true), A.shellArgs('1', {}, true), A.cpArgs('upload', '1', 'a', 'b', false),
    A.tokenCreateArgs({ desks: '1' }), A.devicesArgs({ probe: true, deskId: '1' }),
  ].flat();
  for (const f of ['--code', '--allow-code-in-argv', '--token-file', '--token']) assert.ok(!all.includes(f), f);
});

test('cp: direction decides the order; local paths that look like <desk>:<path> or a flag get ./', () => {
  assert.deepEqual(A.cpArgs('upload', '123456789', 'report.pdf', 'Documents/', false), ['cp', '--json', 'report.pdf', '123456789:Documents/']);
  assert.deepEqual(A.cpArgs('download', '123456789', './app.log', 'logs/app.log', true), ['cp', '--recursive', '--json', '123456789:logs/app.log', './app.log']);
  assert.equal(A.localPath('build:out/x'), './build:out/x');
  assert.equal(A.localPath('-weird'), './-weird');
  assert.equal(A.localPath('C:\\Users\\me\\a.txt'), 'C:\\Users\\me\\a.txt', 'a Windows drive letter is one character');
  assert.equal(A.localPath('/tmp/a:b'), '/tmp/a:b');
});

test('run --detach: caps and the command after --', () => {
  assert.deepEqual(A.runArgs('234567890', 'build', 'msbuild app.sln /m', { priority: 'low', cpu: 50, mem: '4G', keepAwake: true }), [
    'run', '--detach', '--name', 'build', '--desk-id', '234567890', '--priority', 'low', '--cpu', '50', '--mem', '4G', '--keep-awake', '--json', '--', 'msbuild app.sln /m',
  ]);
  assert.ok(A.runArgs('1', 'b', ['./build.sh', '--release'], { keepAwake: false }).includes('--no-keep-awake'));
  assert.throws(() => A.runArgs('1', '-x', 'make', {}), UsageError, 'a job name never looks like a flag');
  assert.throws(() => A.runArgs('1', 'b', 'make', { cpu: 0 }), UsageError);
  assert.throws(() => A.runArgs('1', 'b', 'make', { priority: 'urgent' as 'low' }), UsageError);
});

test('exec --json-stream and --cwd (gaiadesk-cli 0.10.324+)', () => {
  assert.deepEqual(A.execArgs('123456789', 'make', { cwd: '/srv/app' }, 'stream'), [
    'exec', '--desk-id', '123456789', '--quiet', '--json-stream', '--no-stdin', '--cwd', '/srv/app', '--', 'make',
  ]);
  assert.deepEqual(A.execArgs('123456789', 'make', { cwd: 'src', shell: 'sh' }, true).slice(4), ['--json', '--no-stdin', '--shell', 'sh', '--cwd', 'src', '--', 'make']);
  assert.ok(!A.execArgs('1', 'x', {}, 'stream').includes('--json'), '--json and --json-stream are never combined');
  assert.ok(!A.execArgs('1', 'x', {}, false).includes('--cwd'), 'no --cwd unless asked');
  for (const bad of ['', '  ', 'a\0b']) assert.throws(() => A.execArgs('1', 'x', { cwd: bad }, true), UsageError, JSON.stringify(bad));
  assert.deepEqual(A.runArgs('123456789', 'build', 'make', { cwd: '/srv/app' }), ['run', '--detach', '--name', 'build', '--desk-id', '123456789', '--cwd', '/srv/app', '--json', '--', 'make']);
  assert.throws(() => A.runArgs('1', 'b', 'make', { cwd: '' }), UsageError);
});

test('jobs, stats, measure', () => {
  assert.deepEqual(A.psArgs('1'), ['ps', '--desk-id', '1', '--json']);
  assert.deepEqual(A.killArgs('1', 'build'), ['kill', 'build', '--desk-id', '1', '--json']);
  assert.deepEqual(A.logsArgs('1', 'build', { tail: 100, follow: true }), ['logs', 'build', '--desk-id', '1', '--follow', '--tail', '100']);
  assert.deepEqual(A.statsArgs('1'), ['stats', '--desk-id', '1', '--json']);
  assert.deepEqual(A.measureArgs('1', 5), ['measure', '--desk-id', '1', '--count', '5', '--json']);
  assert.throws(() => A.measureArgs('1', 0), UsageError);
});

test('tokens and audit', () => {
  assert.deepEqual(A.tokenCreateArgs({ desks: ['1', '2'], name: 'bot', expires: '3d', scopes: ['exec', 'cp'], cwd: '/srv', lowPriv: true, out: '/tmp/t' }), [
    'token', 'create', '--desk', '1,2', '--name', 'bot', '--expires', '3d', '--scope', 'exec,cp', '--cwd', '/srv', '--low-priv', '--out', '/tmp/t', '--json',
  ]);
  assert.deepEqual(A.tokenListArgs('1'), ['token', 'list', '--desk', '1', '--json']);
  assert.deepEqual(A.tokenRevokeArgs('1', 'bot', false), ['token', 'revoke', '--desk', '1', 'bot', '--json']);
  assert.deepEqual(A.tokenRevokeArgs('1', { all: true }, true), ['token', 'revoke', '--desk', '1', '--all-for-desk', '--account', '--json']);
  assert.throws(() => A.tokenRevokeArgs('1', '', false), UsageError);
  assert.deepEqual(A.auditArgs('1', { token: 'bot', limit: 200, account: true }), ['audit', '--desk', '1', '--token', 'bot', '--limit', '200', '--account', '--json']);
});

test('forward pairs, mcp, disconnect, agent-connect', () => {
  assert.deepEqual(A.forwardArgs('1', [{ remotePort: 5432, localPort: 15432 }, { remotePort: 80, remoteHost: 'db.lan' }]), [
    'forward', '--json', '1:5432', 'localhost:15432', '1:db.lan:80', 'localhost:0',
  ]);
  assert.throws(() => A.forwardArgs('1', [{ remotePort: 0 }]), UsageError);
  assert.throws(() => A.forwardArgs('1', []), UsageError);
  assert.deepEqual(A.mcpArgs({ auditDir: '/a', allowDomains: ['example.com'] }, 'wss://x/ws'), ['mcp', '--server', 'wss://x/ws', '--allow-domain', 'example.com', '--audit-dir', '/a']);
  assert.deepEqual(A.disconnectArgs(), ['disconnect', '--all']);
  assert.deepEqual(A.disconnectArgs('1'), ['disconnect', '--desk-id', '1']);
  assert.deepEqual(A.agentConnectArgs('1', 'wss://x/ws'), ['agent-connect', '--desk-id', '1', '--server', 'wss://x/ws']);
});

test('locating gaiadesk-cli: $GAIADESK_CLI, PATH, then the install locations', () => {
  assert.equal(locateCli({ GAIADESK_CLI: '/x/cli' }, 'linux', () => false), '/x/cli');
  assert.equal(locateCli({ PATH: '/a:/b' }, 'linux', (p) => p === '/b/gaiadesk-cli'), '/b/gaiadesk-cli');
  assert.equal(locateCli({ PATH: '/a' }, 'darwin', (p) => p.startsWith('/Applications/')), '/Applications/GaiaDesk.app/Contents/MacOS/gaiadesk-cli');
  assert.equal(locateCli({ ProgramFiles: 'C:\\Program Files' }, 'win32', (p) => p.includes('Program Files')), 'C:\\Program Files\\GaiaDesk\\gaiadesk-cli.exe');
  assert.equal(locateCli({}, 'linux', () => false), 'gaiadesk-cli');
  assert.deepEqual(standardLocations('linux', {}, '/home/me'), ['/usr/bin/gaiadesk-cli', '/usr/local/bin/gaiadesk-cli', '/home/me/.local/bin/gaiadesk-cli']);
});
