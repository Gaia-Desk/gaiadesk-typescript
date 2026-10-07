// Run one command on a desk and handle every outcome.
//
//   export GAIADESK_TOKEN_FILE=~/.config/gaiadesk/bot.token   # a token with the `exec` scope
//   npx tsx exec-on-a-desk.ts 123456789 "df -h /"      (or compile with tsc and run with node)
import { GaiaDesk, GaiaDeskError, RefusedError, UnreachableError, UsageError } from '@gaiadesk/sdk';

const [desk, command = 'hostname'] = process.argv.slice(2);
if (!desk) {
  console.error('usage: exec-on-a-desk <desk-id> [command line]');
  process.exit(2);
}

const gd = new GaiaDesk(); // credentials from the environment (GAIADESK_TOKEN_FILE)

// Online is presence; a probe proves a command will actually get through.
const row = await gd.probe(desk);
if (row.reachable === false) {
  console.error(`desk ${desk} is not reachable: ${row.probe?.kind ?? row.last_failure?.kind ?? 'unknown'}`);
  process.exit(1);
}

try {
  const r = await gd.exec(desk, command, { shell: 'sh', timeout: 120 });
  process.stdout.write(r.stdout);
  process.stderr.write(r.stderr);
  console.error(`exit ${r.exit} via ${r.route} in ${r.duration_ms} ms (shell: ${r.shell})${r.timed_out ? ' - timed out' : ''}`);
  process.exit(r.exit);
} catch (e) {
  if (e instanceof RefusedError) console.error(`refused: ${e.message}`); // e.g. the token lacks the exec scope
  else if (e instanceof UnreachableError) console.error(`unreachable (${e.kind}): ${e.message}`);
  else if (e instanceof UsageError) console.error(`usage: ${e.message}`); // e.g. no credential set
  else throw e;
  process.exit((e as GaiaDeskError).exitCode ?? 255);
}
