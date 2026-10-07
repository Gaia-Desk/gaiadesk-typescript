// The one place that reads gaiadesk-cli's error envelopes, and the mapping
// from kinds and exit codes to error classes.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { errorEnvelope, errorFromRun, lastStderrLine } from '../dist/errors.js';
import {
  ConnectionLostError,
  GaiaDeskError,
  OperationFailedError,
  RefusedError,
  UnreachableError,
  UsageError,
} from '../dist/index.js';

test('errorEnvelope: every shape the CLI prints today', () => {
  assert.deepEqual(errorEnvelope({ error: { kind: 'offline', message: 'desk is offline' } }), { kind: 'offline', message: 'desk is offline' });
  assert.deepEqual(errorEnvelope({ error: { kind: 'usage' } }), { kind: 'usage', message: '' });
  assert.deepEqual(errorEnvelope({ error: 'no job named x' }), { message: 'no job named x' });
  assert.deepEqual(errorEnvelope({ desk: '1', error: 'the desk did not answer' }), { message: 'the desk did not answer' });
  assert.deepEqual(errorEnvelope({ refused: 'file transfer is turned off for you' }), { message: 'file transfer is turned off for you' });
});

test('errorEnvelope: results are not errors', () => {
  for (const ok of [
    undefined,
    null,
    'text',
    [{ name: 'job' }],
    { exit: 0, error: null, stdout: '' }, // exec success carries "error": null
    { error: '' },
    { desk: '1', ok: true, message: 'revoked' },
    { devices: [], sources: [], notes: [] },
  ]) {
    assert.equal(errorEnvelope(ok), null, JSON.stringify(ok));
  }
});

test('errorFromRun: a kind decides the class', () => {
  const run = { code: 255, stderr: '' };
  const e = errorFromRun(run, ['exec'], { error: { kind: 'not_online', message: 'm' } });
  assert.ok(e instanceof UnreachableError);
  assert.equal(e.kind, 'not_online');
  assert.equal(e.exitCode, 255);
  assert.ok(errorFromRun(run, [], { error: { kind: 'usage', message: 'm' } }) instanceof UsageError);
  assert.ok(errorFromRun(run, [], { error: { kind: 'refused', message: 'm' } }) instanceof RefusedError);
  assert.ok(errorFromRun(run, [], { error: { kind: 'connection_lost', message: 'm' } }) instanceof ConnectionLostError);
  const other = errorFromRun(run, [], { error: { kind: 'local', message: 'm' } });
  assert.equal(other.constructor, GaiaDeskError);
  assert.equal(other.kind, 'local');
});

test('errorFromRun: otherwise the exit code decides, with the best message', () => {
  const refused = errorFromRun({ code: 254, stderr: '' }, [], { refused: 'turned off' });
  assert.ok(refused instanceof RefusedError);
  assert.equal(refused.message, 'turned off');
  const failed = errorFromRun({ code: 1, stderr: 'gaiadesk-cli: no job named x\n' }, [], undefined);
  assert.ok(failed instanceof OperationFailedError);
  assert.equal(failed.message, 'no job named x');
  const account = errorFromRun({ code: 1, stderr: '' }, [], { desk: '1', ok: false, message: 'not your desk' });
  assert.equal(account.message, 'not your desk');
  const bare = errorFromRun({ code: 255, stderr: '' }, ['x'], undefined);
  assert.equal(bare.kind, 'cli_error');
  assert.equal(bare.message, 'gaiadesk-cli exited with 255');
  assert.equal(errorFromRun({ code: null, signal: 'SIGKILL', stderr: '' }, [], undefined).message, 'gaiadesk-cli exited with SIGKILL');
});

test('lastStderrLine drops the prefix and the help hint', () => {
  assert.equal(lastStderrLine('gaiadesk-cli: desk 1 is offline\n(see `gaiadesk-cli exec --help`)\n'), 'desk 1 is offline');
  assert.equal(lastStderrLine(''), '');
});
