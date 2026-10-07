// The pure parts of the MCP client: the protocol _meta and tool-name aliases.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { MCP_PROTOCOL_VERSION, resolveToolName, toolNameAlias } from '../dist/index.js';
import { withProtocolMeta } from '../dist/mcp.js';

test('withProtocolMeta adds the two fields; the caller wins', () => {
  assert.deepEqual(withProtocolMeta(), {
    _meta: { 'io.modelcontextprotocol/protocolVersion': MCP_PROTOCOL_VERSION, 'io.modelcontextprotocol/clientCapabilities': {} },
  });
  const p = withProtocolMeta({ name: 'x', _meta: { progressToken: 7, 'io.modelcontextprotocol/protocolVersion': 'mine' } });
  assert.equal(p.name, 'x');
  assert.deepEqual(p._meta, {
    'io.modelcontextprotocol/protocolVersion': 'mine',
    'io.modelcontextprotocol/clientCapabilities': {},
    progressToken: 7,
  });
});

test('toolNameAlias: dot <-> underscore, GaiaDesk tools only', () => {
  assert.equal(toolNameAlias('gaiadesk.exec'), 'gaiadesk_exec');
  assert.equal(toolNameAlias('gaiadesk_job_run'), 'gaiadesk.job_run');
  assert.equal(toolNameAlias('gaiadesk.copy_files'), 'gaiadesk_copy_files');
  assert.equal(toolNameAlias('other.exec'), null);
  assert.equal(toolNameAlias('gaiadesk'), null);
});

test('resolveToolName: the spelling the server advertises', () => {
  const dotted = new Set(['gaiadesk.exec', 'gaiadesk.job_run']);
  const plain = new Set(['gaiadesk_exec', 'gaiadesk_job_run']);
  assert.equal(resolveToolName('gaiadesk_exec', dotted), 'gaiadesk.exec');
  assert.equal(resolveToolName('gaiadesk.exec', dotted), 'gaiadesk.exec');
  assert.equal(resolveToolName('gaiadesk.job_run', plain), 'gaiadesk_job_run');
  assert.equal(resolveToolName('gaiadesk.nope', plain), 'gaiadesk.nope', 'unknown: sent as given');
  assert.equal(resolveToolName('gaiadesk.exec'), 'gaiadesk.exec', 'no list: sent as given');
});
