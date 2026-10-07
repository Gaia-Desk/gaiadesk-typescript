// The pure parts of the MCP client: the protocol _meta and the tool names.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { GAIADESK_TOOLS, MCP_PROTOCOL_VERSION } from '../dist/index.js';
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

test('GAIADESK_TOOLS: the gaiadesk_* names of gaiadesk-cli mcp', () => {
  assert.equal(GAIADESK_TOOLS.length, 21);
  for (const t of GAIADESK_TOOLS) assert.match(t, /^gaiadesk_[a-z_]+$/, t);
  for (const t of ['gaiadesk_exec', 'gaiadesk_copy_files', 'gaiadesk_job_run', 'gaiadesk_forward_stop', 'gaiadesk_open_session', 'gaiadesk_screenshot', 'gaiadesk_pointer_position']) {
    assert.ok((GAIADESK_TOOLS as readonly string[]).includes(t), t);
  }
});
