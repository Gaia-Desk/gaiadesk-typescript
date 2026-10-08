// Administrator work (root / SYSTEM) is not available over any API: the hosted
// API and a desk's own API (local, lan) refuse it with `admin_not_via_api`,
// and the SDK reports that as the refusal it is. Administrator work runs only
// through `gaiadesk-cli exec --admin` (or MCP).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { GaiaDesk, RefusedError } from '../dist/index.js';
import { startRawServer } from './fixtures/raw-server.js';
import type { RawMode, RawServer } from './fixtures/raw-server.js';

const D = '123456789';
const MESSAGE = 'administrator work is not available over the API; run it with gaiadesk-cli exec --admin';
const REFUSED = { kind: 'refused', message: MESSAGE, reason: 'admin_not_via_api', desk: D };
/** The exec answer: 200, exit 254, refused before anything ran. */
const EXEC_REFUSED: RawMode = { status: 200, body: JSON.stringify({ desk: D, exit: 254, remote_code: null, stdout: '', stderr: '', timed_out: false, error: REFUSED }) };
/** The mint answer (and a stream refused in its first moments): 403 with the envelope. */
const FORBIDDEN: RawMode = { status: 403, body: JSON.stringify({ error: { ...REFUSED, request_id: 'req_admin' } }) };

const unix = process.platform !== 'win32';
const clients: Array<[string, boolean, (s: RawServer) => GaiaDesk]> = [
  ['api', true, (s) => new GaiaDesk({ apiKey: 'ak_t', deskToken: 'gdagt_t', baseUrl: s.url, e2e: 'off', retry: { maxRetries: 0 } })],
  ['local', unix, (s) => new GaiaDesk({ transport: 'local', socketPath: s.url, token: 'gdlocal_t', retry: { maxRetries: 0 } })],
];

const isAdminRefusal = (status: number | null) => (e: unknown) => {
  assert.ok(e instanceof RefusedError, `a RefusedError, not ${(e as Error)?.constructor?.name}`);
  assert.deepEqual([e.kind, e.reason, e.desk, e.status, e.message], ['refused', 'admin_not_via_api', D, status, MESSAGE]);
  return true;
};

for (const [name, runs, gdOf] of clients) {
  test(`${name}: admin_not_via_api is a refusal: exec (200, exit 254), execStream, and minting an admin-scoped token (403)`, { skip: !runs && 'Unix sockets' }, async () => {
    const path = (tag: string) => (name === 'local' ? join(mkdtempSync(join(tmpdir(), 'gdadm-')), `${tag}.sock`) : undefined);
    const exec = await startRawServer(EXEC_REFUSED, path('exec'));
    try {
      await assert.rejects(gdOf(exec).exec(D, 'id'), (e) => {
        isAdminRefusal(null)(e);
        assert.equal((e as RefusedError).exitCode, 254);
        return true;
      });
      assert.equal(exec.count('POST'), 1);
    } finally {
      await exec.close();
    }
    const forbidden = await startRawServer(FORBIDDEN, path('mint'));
    try {
      await assert.rejects(gdOf(forbidden).createToken({ desks: D, name: 'root-bot', scopes: ['exec', 'admin'] }), isAdminRefusal(403));
      const exit = await gdOf(forbidden).execStream(D, 'id').wait();
      assert.deepEqual([exit.exitCode, exit.error?.kind, exit.error?.reason], [254, 'refused', 'admin_not_via_api']);
      assert.equal(forbidden.count('POST'), 2);
    } finally {
      await forbidden.close();
    }
  });
}
