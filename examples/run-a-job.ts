// Long work belongs in a background job: it keeps running after this script,
// the connection, or GaiaDesk itself restarts. (Do not background work inside
// exec: exec ends its whole process tree when it returns.)
//
//   export GAIADESK_TOKEN_FILE=~/.config/gaiadesk/bot.token   # scope: jobs
//   npx tsx run-a-job.ts 392586273      (or compile with tsc and run with node)
import { GaiaDesk } from '@gaiadesk/sdk';

const [desk] = process.argv.slice(2);
if (!desk) {
  console.error('usage: run-a-job <desk-id>');
  process.exit(2);
}
const gd = new GaiaDesk();
const name = `nightly-${Date.now()}`;

// An argument array (see README "Known gaps": run re-quotes a single command line).
const job = await gd.runJob(desk, name, ['sh', '-c', 'cd ~/src/app && make test'], {
  priority: 'low', // nice 10 on macOS/Linux, a lower priority class on Windows
  cpu: 50, // at most half of the whole machine
  mem: '4G', // the job and everything it starts
  keepAwake: true, // the desk does not idle-sleep while it runs
});
console.log(`started ${job.name} (pid ${job.pid}); caps enforced as:`, job.enforcement ?? []);

// Follow its output until it ends (stop following with stream.kill(); the job keeps running).
const logs = gd.followJobLogs(desk, name);
for await (const c of logs.text()) if (c.stream === 'stdout') process.stdout.write(c.text);
await logs.wait();

const final = (await gd.jobs(desk)).find((j) => j.name === name);
console.log(`${name}: ${final?.state} exit ${final?.exit_code}`);

// To stop a job early: await gd.killJob(desk, name);
