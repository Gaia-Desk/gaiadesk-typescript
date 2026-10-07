// Where gaiadesk-cli is, when the caller did not say: $GAIADESK_CLI, then the
// binary of the npm package @gaiadesk/cli (an optional dependency, so
// `npm install @gaiadesk/sdk` brings a CLI with it), then PATH, then the
// install locations from GaiaDesk's public docs ("Where gaiadesk-cli is").

import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';

/** What `require('@gaiadesk/cli')` gives (CommonJS, so it loads synchronously). */
interface CliPackage {
  tryBinaryPath?: () => string | null;
}

/**
 * The gaiadesk-cli binary @gaiadesk/cli installed for this platform, or null
 * (the package is absent, older, or has no binary for this platform).
 */
export function npmCliBinary(req: (id: string) => unknown = createRequire(import.meta.url)): string | null {
  try {
    const m = req('@gaiadesk/cli') as CliPackage;
    const p = typeof m?.tryBinaryPath === 'function' ? m.tryBinaryPath() : null;
    return typeof p === 'string' && p ? p : null;
  } catch {
    return null;
  }
}

export function standardLocations(platform: string, env: Record<string, string | undefined>, home?: string): string[] {
  if (platform === 'darwin') {
    const l = ['/Applications/GaiaDesk.app/Contents/MacOS/gaiadesk-cli'];
    if (home) l.push(`${home}/Applications/GaiaDesk.app/Contents/MacOS/gaiadesk-cli`);
    l.push('/usr/local/bin/gaiadesk-cli');
    return l;
  }
  if (platform === 'win32') {
    const roots = [env.ProgramFiles, env.ProgramW6432, env['ProgramFiles(x86)']].filter((r): r is string => !!r);
    const l = [...new Set(roots)].map((r) => `${r}\\GaiaDesk\\gaiadesk-cli.exe`);
    if (env.LOCALAPPDATA) l.push(`${env.LOCALAPPDATA}\\GaiaDesk\\gaiadesk-cli.exe`, `${env.LOCALAPPDATA}\\Programs\\GaiaDesk\\gaiadesk-cli.exe`);
    if (l.length === 0) l.push('C:\\Program Files\\GaiaDesk\\gaiadesk-cli.exe');
    return l;
  }
  const l = ['/usr/bin/gaiadesk-cli', '/usr/local/bin/gaiadesk-cli'];
  if (home) l.push(`${home}/.local/bin/gaiadesk-cli`);
  return l;
}

/** PATH entries joined with the binary name(s). */
export function pathCandidates(platform: string, env: Record<string, string | undefined>): string[] {
  const raw = platform === 'win32' ? env.Path ?? env.PATH : env.PATH;
  if (!raw) return [];
  const sep = platform === 'win32' ? ';' : ':';
  const slash = platform === 'win32' ? '\\' : '/';
  const name = platform === 'win32' ? 'gaiadesk-cli.exe' : 'gaiadesk-cli';
  return raw
    .split(sep)
    .map((d) => d.trim().replace(/^"(.*)"$/, '$1'))
    .filter(Boolean)
    .map((d) => (d.endsWith(slash) ? d + name : d + slash + name));
}

/**
 * The gaiadesk-cli to run: $GAIADESK_CLI, then @gaiadesk/cli's binary, then
 * PATH, then the standard locations. Falls back to the bare name (spawn then
 * reports it missing). `npmCli` is asked only for this process's own
 * platform (the npm package holds this machine's binary).
 */
export function locateCli(
  env: Record<string, string | undefined>,
  platform: string = process.platform,
  exists: (p: string) => boolean = existsSync,
  npmCli: () => string | null = npmCliBinary,
): string {
  if (env.GAIADESK_CLI) return env.GAIADESK_CLI;
  if (platform === process.platform) {
    const fromNpm = npmCli();
    if (fromNpm) return fromNpm;
  }
  const home = platform === 'win32' ? env.USERPROFILE : env.HOME;
  for (const c of [...pathCandidates(platform, env), ...standardLocations(platform, env, home)]) {
    if (exists(c)) return c;
  }
  return platform === 'win32' ? 'gaiadesk-cli.exe' : 'gaiadesk-cli';
}
