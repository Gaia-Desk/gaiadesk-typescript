// The fake `gaiadesk-cli` as a CLI too old to answer `--version --json` (see
// fake-cli.ts). A separate file so that it is a separate CLI path, as two
// installed CLIs would be.
process.env.FAKE_CLI = 'old';
await import('./fake-cli.js');
