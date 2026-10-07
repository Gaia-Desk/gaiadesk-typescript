// Upload a folder, build it on the desk, download the result.
// A copy is resumable: run it again after an interruption and it continues.
//
//   export GAIADESK_TOKEN_FILE=~/.config/gaiadesk/bot.token   # scopes: cp, exec
//   node copy-a-file.mjs 392586273 ./site
import { GaiaDesk, OperationFailedError } from '@gaiadesk/sdk';

const [desk, folder = './site'] = process.argv.slice(2);
const gd = new GaiaDesk();

try {
  // A trailing / means "into that folder"; relative desk paths are under the desk user's home.
  const up = await gd.upload(folder, desk, 'builds/', { recursive: true });
  console.log(`uploaded ${up.files} files, ${up.bytes} bytes (${up.resumed_bytes} resumed) to ${up.destination}`);
} catch (e) {
  if (e instanceof OperationFailedError) {
    // Some files failed; the summary says which. Running the same copy again resumes.
    for (const f of e.json.failed) console.error(`failed: ${f.path}: ${f.message}`);
    process.exit(1);
  }
  throw e;
}

await gd.exec(desk, ['tar', '-czf', 'builds/site.tgz', '-C', 'builds', 'site'], { shell: 'none', check: true });

const down = await gd.download(desk, 'builds/site.tgz', './site.tgz');
console.log(`downloaded ${down.bytes} bytes to ${down.destination}`);
