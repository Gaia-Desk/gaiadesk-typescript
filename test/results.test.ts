// Reading results: lists, exec errors, the version object and --json-stream events.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { execError, listOf, neverRan, normalizeExecResult, parseVersionInfo, textOf } from '../dist/results.js';
import { exitFromEvent, parseExecEvent } from '../dist/exec-stream.js';
import { ProtocolError } from '../dist/index.js';
import type { CliError, ExecEvent, Schema, VersionInfo } from '../dist/index.js';

test('the generated schema types are exported (Schema namespace and the SDK names)', () => {
  const kinds: Schema.ErrorKind[] = ['usage', 'refused', 'unreachable', 'connection_lost', 'failed', 'protocol'];
  const e: CliError = { kind: kinds[2], message: 'm', reason: 'offline', desk: '123456789' };
  const env: Schema.ErrorEnvelope = { error: e };
  const v = { name: 'gaiadesk-cli', version: '0.10.324', features: ['exec_cwd'], mcp_protocol_versions: [] } as unknown as VersionInfo;
  assert.equal(env.error.kind, 'unreachable');
  assert.equal(v.features[0], 'exec_cwd');
});

test('listOf: the list inside the object', () => {
  assert.deepEqual(listOf({ jobs: [{ name: 'a' }] }, 'jobs'), [{ name: 'a' }]);
  assert.throws(() => listOf([{ name: 'a' }], 'jobs'), ProtocolError, 'a bare array is not a result');
  assert.deepEqual(listOf({ tokens: [] }, 'tokens'), []);
  assert.deepEqual(listOf({ events: [{ action: 'exec' }] }, 'events'), [{ action: 'exec' }]);
  assert.throws(() => listOf({ jobs: 'x' }, 'jobs', ['ps']), (e) => e instanceof ProtocolError && e.argv[0] === 'ps');
  assert.throws(() => listOf({ tokens: [] }, 'jobs'), ProtocolError);
});

test('textOf: the field of an object', () => {
  assert.equal(textOf('out', 'output'), '');
  assert.equal(textOf({ job: {}, output: 'out' }, 'output'), 'out');
  assert.equal(textOf({ desk_id: '123456789', mesh_ip: '100.64.0.2' }, 'mesh_ip'), '100.64.0.2');
  assert.equal(textOf(null, 'output'), '');
});

test('execError: null, or {kind, message, reason?, desk?}', () => {
  assert.equal(execError(null), null);
  assert.equal(execError(undefined), null);
  assert.deepEqual(execError({ kind: 'refused', message: 'no scope', desk: '123456789' }), { kind: 'refused', message: 'no scope', desk: '123456789' });
  assert.deepEqual(execError({ kind: 'unreachable', message: 'm', reason: 'offline' }), { kind: 'unreachable', message: 'm', reason: 'offline' });
});

test('normalizeExecResult and neverRan', () => {
  const ran = normalizeExecResult({ exit: 3, remote_code: 3, error: null, timed_out: false, desk: '123456789' });
  assert.equal(neverRan(ran), false);
  const timedOut = normalizeExecResult({ exit: 124, remote_code: null, timed_out: true, error: { kind: 'failed', message: 'stopped' } });
  assert.equal(neverRan(timedOut), false, 'a timeout is a result');
  const notRun = normalizeExecResult({ exit: 255, remote_code: null, timed_out: false, error: { kind: 'unreachable', message: 'm', reason: 'offline' } });
  assert.equal(neverRan(notRun), true);
  const refused = normalizeExecResult({ exit: 254, remote_code: null, timed_out: false, error: { kind: 'refused', message: 'no scope' } });
  assert.equal(neverRan(refused), true);
  const notFound = normalizeExecResult({ exit: 127, remote_code: 127, timed_out: false, error: { kind: 'failed', message: 'command not found' } });
  assert.equal(neverRan(notFound), false, 'it ran: the code is its own');
});

test('parseVersionInfo: the version object, else null', () => {
  const v = parseVersionInfo('{"name":"gaiadesk-cli","version":"0.10.324","features":["exec_cwd"],"mcp_protocol_versions":["2026-07-28"]}\n');
  assert.deepEqual(v, { name: 'gaiadesk-cli', version: '0.10.324', features: ['exec_cwd'], mcp_protocol_versions: ['2026-07-28'] });
  for (const old of ['gaiadesk-cli 0.10.300\n', '', '{"error":{"kind":"usage","message":"unknown flag"}}', '[]']) assert.equal(parseVersionInfo(old), null, old);
});

test('parseExecEvent and exitFromEvent', () => {
  assert.deepEqual(parseExecEvent('{"event":"stdout","data":"x"}'), { event: 'stdout', data: 'x' });
  assert.equal(parseExecEvent('not json'), null);
  assert.equal(parseExecEvent('{"data":"x"}'), null);
  const proc = { exitCode: 3, signal: null, stderrTail: 'cli line' };
  const exit = parseExecEvent('{"event":"exit","exit":3,"remote_code":3,"duration_ms":5,"desk":"123456789","route":"LAN","mode":"pipes","shell":null,"timed_out":false,"error":null,"notes":[]}') as ExecEvent;
  const e = exitFromEvent(proc, exit);
  assert.equal(e.exitCode, 3);
  assert.equal(e.stderrTail, 'cli line');
  assert.equal(e.result?.desk, '123456789');
  assert.equal((e.result as unknown as Record<string, unknown>).event, undefined, 'the result is the ExecExit, without `event`');
  const err = exitFromEvent({ exitCode: 255, signal: null, stderrTail: 'x' }, { event: 'error', exit: 255, error: { kind: 'unreachable', message: 'offline', reason: 'offline' } });
  assert.deepEqual(err, { exitCode: 255, signal: null, stderrTail: 'offline', error: { kind: 'unreachable', message: 'offline', reason: 'offline' } });
  assert.equal(exitFromEvent({ exitCode: null, signal: 'SIGKILL', stderrTail: '' }, { event: 'error', exit: 255, error: { kind: 'failed', message: 'm' } }).exitCode, 255);
  assert.deepEqual(exitFromEvent(proc, null), proc);
});
