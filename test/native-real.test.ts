// The native backend against a REAL @gaiadesk/sdk-native build: its test
// backend (fake desks with the same ids as fake-cli.ts) behind the real
// binary. Skipped unless GAIADESK_SDK_NATIVE_MODULE names the package
// directory (with its gaiadesk.<platform>.node beside package.json), e.g.
//   GAIADESK_SDK_NATIVE_MODULE=/path/to/sdk-native npm test
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GaiaDesk, OperationFailedError, RefusedError, UnreachableError, UsageError } from '../dist/index.js';
import type { NativeModule } from '../dist/index.js';

const where = process.env.GAIADESK_SDK_NATIVE_MODULE;
const skip = where ? false : 'GAIADESK_SDK_NATIVE_MODULE is not set';
const OK = '100000001';

function gd(extra: Record<string, unknown> = {}): GaiaDesk {
  const mod = createRequire(import.meta.url)(where as string) as NativeModule;
  return new GaiaDesk({ native: mod, backend: 'native', env: { PATH: process.env.PATH }, code: 'pw', agentToken: 'gdagt_x', ...extra });
}

test('real binary: exec, shell and results', { skip }, async () => {
  const g = gd();
  assert.equal(g.backend, 'native');
  assert.match(await g.version(), /^gaiadesk-native \d+\.\d+\.\d+$/);
  const r = await g.exec(OK, 'make; exit 3', { stdin: 'hi', timeout: '10m' });
  assert.equal(r.exit, 3);
  assert.equal(r.stdout, 'ran: make; exit 3\nstdin: hi\n');
  assert.equal((await g.shell(OK, 'echo hi')).stdout, 'script: echo hi\n');
  assert.equal((await g.stats(OK)).hostname, 'build-box');
  assert.equal((await g.devices({ probe: true })).devices.length, 2);
});

test('real binary: errors map to the SDK classes and kinds', { skip }, async () => {
  const g = gd();
  await assert.rejects(g.exec('100000002', 'x'), (e: unknown) => e instanceof UnreachableError && e.kind === 'offline');
  await assert.rejects(g.exec('100000003', 'x'), (e: unknown) => e instanceof RefusedError && e.kind === 'refused' && e.exitCode === 254);
  await assert.rejects(g.exec('100000004', 'x'), (e: unknown) => e instanceof UsageError);
  const dir = mkdtempSync(join(tmpdir(), 'gd-sdk-real-'));
  writeFileSync(join(dir, 'a.txt'), 'hello');
  const c = gd({ cwd: dir });
  assert.equal((await c.upload('a.txt', OK, '/tmp/a')).bytes, 5);
  await assert.rejects(c.upload('a.txt', OK, '/readonly/a'), (e: unknown) => e instanceof OperationFailedError && (e.json as { failed: unknown[] }).failed.length === 1);
});

test('real binary: streams, jobs, forward, agent session', { skip }, async () => {
  const g = gd();
  const s = g.execStream(OK, 'hostname');
  let out = '';
  for await (const c of s.text()) if (c.stream === 'stdout') out += c.text;
  assert.equal(out, 'ran: hostname\n');
  assert.equal((await s.wait()).exitCode, 0);

  await g.runJob(OK, 'forever', 'yes');
  const f = g.followJobLogs(OK, 'forever');
  for await (const _ of f) {
    f.kill();
    break;
  }
  assert.equal(typeof (await f.wait()).exitCode, 'number');

  const fw = await g.forward(OK, { remotePort: 5432 });
  assert.ok(Number(fw.listening[0].local_port) > 0);
  assert.equal((await fw.close()).exitCode, 0);
  assert.equal(await g.agentConnect(OK), `agent session open on desk ${OK}: screenshot 1x1`);
});
