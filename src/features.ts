// What a gaiadesk-cli supports: `--version --json` (0.10.324+), asked once
// per CLI command vector in this process. An older CLI does not have it (it
// prints its version as text, or fails): it has no features.

import { UsageError } from './errors.js';
import type { Completed } from './proc.js';
import { parseVersionInfo } from './results.js';
import type { VersionInfo } from './types.js';

const VERSION_INFO = new Map<string, Promise<VersionInfo | null>>();

/**
 * The CLI's `--version --json`, from the cache or by `run` (which runs
 * `<cli> --version --json`). A run that could not start is not cached.
 */
export function cliVersionInfo(cli: readonly string[], run: () => Promise<Completed>): Promise<VersionInfo | null> {
  const key = JSON.stringify(cli);
  let p = VERSION_INFO.get(key);
  if (!p) {
    p = run().then((done) => (done.code === 0 ? parseVersionInfo(done.stdout) : null));
    VERSION_INFO.set(key, p);
    p.catch(() => VERSION_INFO.delete(key));
  }
  return p;
}

/** The options that need a CLI feature, by feature. */
export const NEEDS = { exec_cwd: 'exec with cwd', run_cwd: 'runJob with cwd' } as const;

/** A UsageError unless `info` lists `feature` (an option the CLI would not understand must not be dropped). */
export function requireFeature(info: VersionInfo | null, feature: keyof typeof NEEDS): void {
  if (info?.features.includes(feature)) return;
  const which = info ? `gaiadesk-cli ${info.version} does not list` : 'this gaiadesk-cli (before 0.10.324) does not have';
  throw new UsageError(
    `${NEEDS[feature]} needs gaiadesk-cli 0.10.324 or newer: ${which} the \`${feature}\` feature. Update GaiaDesk, or install @gaiadesk/sdk-native.`,
    { kind: 'usage', argv: ['--version', '--json'] },
  );
}
