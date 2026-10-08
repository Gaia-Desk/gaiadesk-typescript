// The package as an installer sees it: `@gaiadesk/sdk` resolves through
// package.json "exports" (a self-reference) to the built dist/.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import * as sdk from '@gaiadesk/sdk';

test('the public entry point exports the client, the errors and the MCP helpers', () => {
  for (const name of [
    'GaiaDesk',
    'CliStream',
    'McpClient',
    'McpError',
    'GaiaDeskError',
    'CliNotFoundError',
    'UsageError',
    'RefusedError',
    'UnreachableError',
    'ConnectionLostError',
    'OperationFailedError',
    'ProtocolError',
    'CommandError',
    'E2eError',
    'locateCli',
    'toolText',
    'toolImage',
    'errorEnvelope',
    'parseVersionInfo',
    'parseExecEvent',
  ]) {
    assert.equal(typeof (sdk as Record<string, unknown>)[name], 'function', name);
  }
  assert.equal(sdk.MCP_PROTOCOL_VERSION, '2026-07-28');
  assert.ok(sdk.GAIADESK_TOOLS.includes('gaiadesk_exec'));
  assert.ok(new sdk.RefusedError('x') instanceof sdk.GaiaDeskError);
});
