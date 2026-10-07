// The argument vectors, checked against `gaiadesk-cli <cmd> --help`.
// Tests import the built package (../dist), so they test what is published.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as A from '../dist/args.js';
import { UsageError } from '../dist/index.js';
import type { Shell } from '../dist/index.js';
import { locateCli, npmCliBinary, standardLocations } from '../dist/locate.js';

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

test('env: --env KEY=VALUE per variable (exec, run); names checked, values never in errors', () => {
  assert.deepEqual(A.execArgs('1', 'make', { env: { CI: '1', MSG: 'a b=c' }, shell: 'bash' }, true), [
    'exec', '--desk-id', '1', '--quiet', '--json', '--no-stdin', '--shell', 'bash', '--env', 'CI', '--env', 'MSG', '--', 'make',
  ], "names only: the values travel in gaiadesk-cli's environment");
  assert.deepEqual(A.cliEnv({ CI: '1', MSG: 'a\nb' }), { CI: '1', MSG: 'a\nb' });
  assert.equal(A.cliEnv(undefined), undefined);
  assert.deepEqual(A.execArgs('1', 'x', { env: {} }, true), A.execArgs('1', 'x', {}, true));
  for (const bad of [{ '': 'x' }, { 'A=B': 'x' }, { 'A B': 'x' }, { A: 1 as unknown as string }, { A: 'sec\0ret' }] as Record<string, string>[]) {
    assert.throws(() => A.execArgs('1', 'x', { env: bad }, true), (e) => e instanceof UsageError && !/sec/.test(e.message));
  }
  assert.ok(A.execArgs('1', 'x', { shell: 'zsh' }, true).includes('zsh'));
});

test('env: names gaiadesk-cli itself reads stay --env KEY=VALUE, out of its environment', () => {
  const env = { GAIADESK_TOKEN: 't', gaiadesk_x: 'y', PATH: '/opt/bin', HOME: '/h', LC_ALL: 'C', Path: 'p', CI: '1' };
  assert.deepEqual(A.envFlags(env, 'darwin'), [
    '--env', 'GAIADESK_TOKEN=t', '--env', 'gaiadesk_x=y', '--env', 'PATH=/opt/bin', '--env', 'HOME=/h', '--env', 'LC_ALL=C', '--env', 'Path', '--env', 'CI',
  ]);
  assert.deepEqual(A.cliEnv(env, 'darwin'), { Path: 'p', CI: '1' });
  assert.deepEqual(A.cliEnv(env, 'win32'), { CI: '1' }, 'case-insensitive on Windows');
  assert.ok(A.envFlags({ systemroot: 'x' }, 'win32').includes('systemroot=x'));
  assert.equal(A.cliEnv({ SystemRoot: 'x', ComSpec: 'y', TMPDIR: 'z', TEMP: 'a', TMP: 'b', USERPROFILE: 'c', LANG: 'd' }, 'linux'), undefined);
});

test('run --shell / --env; wait; whoami', () => {
  assert.deepEqual(A.runArgs('1', 'b', 'make', { shell: 'pwsh', env: { CONFIG: 'Release' } }), [
    'run', '--detach', '--name', 'b', '--desk-id', '1', '--shell', 'pwsh', '--env', 'CONFIG', '--json', '--', 'make',
  ]);
  for (const bad of ['none', 'default', 'fish']) assert.throws(() => A.runArgs('1', 'b', 'make', { shell: bad as 'sh' }), UsageError);
  assert.deepEqual(A.waitArgs('1', 'build', {}), ['wait', 'build', '--desk-id', '1', '--json']);
  assert.deepEqual(A.waitArgs('1', 'build', { timeout: '10m' }), ['wait', 'build', '--desk-id', '1', '--timeout', '10m', '--json']);
  assert.deepEqual(A.waitArgs('1', 'build', { timeout: 1.5 }).slice(4, 6), ['--timeout', '2']);
  assert.throws(() => A.waitArgs('1', '-x', {}), UsageError);
  assert.throws(() => A.waitArgs('1', 'b', { timeout: -1 }), UsageError);
  assert.deepEqual(A.whoamiArgs(), ['whoami', '--json']);
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
  assert.deepEqual(A.logsArgs('1', 'build', { tail: 100, follow: true }), ['logs', 'build', '--desk-id', '1', '--follow', '--json', '--tail', '100']);
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
  assert.deepEqual(A.disconnectArgs(), ['disconnect', '--all', '--json']);
  assert.deepEqual(A.disconnectArgs('1'), ['disconnect', '--desk-id', '1', '--json']);
  assert.deepEqual(A.agentConnectArgs('1', 'wss://x/ws'), ['agent-connect', '--desk-id', '1', '--server', 'wss://x/ws', '--json']);
});

test('locating gaiadesk-cli: $GAIADESK_CLI, @gaiadesk/cli, PATH, then the install locations', () => {
  const none = () => null;
  assert.equal(locateCli({ GAIADESK_CLI: '/x/cli' }, 'linux', () => false, () => '/npm/cli'), '/x/cli');
  assert.equal(locateCli({ PATH: '/a:/b' }, 'linux', (p) => p === '/b/gaiadesk-cli', none), '/b/gaiadesk-cli');
  assert.equal(locateCli({ PATH: '/a' }, 'darwin', (p) => p.startsWith('/Applications/'), none), '/Applications/GaiaDesk.app/Contents/MacOS/gaiadesk-cli');
  assert.equal(locateCli({ ProgramFiles: 'C:\\Program Files' }, 'win32', (p) => p.includes('Program Files'), none), 'C:\\Program Files\\GaiaDesk\\gaiadesk-cli.exe');
  assert.equal(locateCli({}, 'linux', () => false, none), 'gaiadesk-cli');
  // The npm package's binary comes before PATH, on this machine's own platform only.
  assert.equal(locateCli({ PATH: '/b' }, process.platform, () => true, () => '/npm/gaiadesk-cli'), '/npm/gaiadesk-cli');
  const other = process.platform === 'linux' ? 'darwin' : 'linux';
  assert.equal(locateCli({ PATH: '/b' }, other, (p) => p === '/b/gaiadesk-cli', () => '/npm/gaiadesk-cli'), '/b/gaiadesk-cli');
  // npmCliBinary: the package's tryBinaryPath, and null for anything wrong.
  assert.equal(npmCliBinary(() => ({ tryBinaryPath: () => '/n/bin/gaiadesk-cli' })), '/n/bin/gaiadesk-cli');
  assert.equal(npmCliBinary(() => ({ tryBinaryPath: () => null })), null);
  assert.equal(npmCliBinary(() => ({})), null, 'a package without the function');
  assert.equal(npmCliBinary(() => { throw new Error('Cannot find module'); }), null, 'not installed');
  assert.deepEqual(standardLocations('linux', {}, '/home/me'), ['/usr/bin/gaiadesk-cli', '/usr/local/bin/gaiadesk-cli', '/home/me/.local/bin/gaiadesk-cli']);
});
