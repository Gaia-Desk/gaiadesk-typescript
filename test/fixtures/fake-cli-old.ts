// The fake `gaiadesk-cli` as a CLI from before 0.10.324 (see fake-cli.ts).
// A separate file so that it is a separate CLI path, as two installed CLIs
// would be.
process.env.FAKE_CLI = 'old';
await import('./fake-cli.js');
