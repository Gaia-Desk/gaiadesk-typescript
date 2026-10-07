// The few Node.js APIs this package uses, declared here so the only dev
// dependency is TypeScript (no @types/node). Compile-time only: this file is
// not emitted, and no public type of the SDK refers to anything in it.

declare module 'node:child_process' {
  interface Readable {
    on(event: 'data', cb: (chunk: Uint8Array) => void): this;
    on(event: 'end' | 'close', cb: () => void): this;
    on(event: 'error', cb: (e: Error) => void): this;
  }
  interface Writable {
    write(data: string | Uint8Array, cb?: (e?: Error | null) => void): boolean;
    end(data?: string | Uint8Array): void;
    on(event: 'error', cb: (e: Error) => void): this;
  }
  interface ChildProcess {
    readonly stdout: Readable | null;
    readonly stderr: Readable | null;
    readonly stdin: Writable | null;
    readonly pid?: number;
    readonly exitCode: number | null;
    kill(signal?: string): boolean;
    on(event: 'close', cb: (code: number | null, signal: string | null) => void): this;
    on(event: 'error', cb: (e: Error & { code?: string }) => void): this;
  }
  interface SpawnOptions {
    cwd?: string;
    env?: Record<string, string | undefined>;
    stdio?: Array<'pipe' | 'ignore' | 'inherit'>;
    windowsHide?: boolean;
  }
  function spawn(command: string, args: readonly string[], options?: SpawnOptions): ChildProcess;
}

declare module 'node:fs' {
  function existsSync(path: string): boolean;
}

declare const process: {
  env: Record<string, string | undefined>;
  platform: string;
};

declare class TextDecoder {
  constructor(label?: string);
  decode(input?: Uint8Array, options?: { stream?: boolean }): string;
}
declare class TextEncoder {
  encode(input: string): Uint8Array;
}
declare function setTimeout(cb: () => void, ms: number): unknown;
declare function clearTimeout(handle: unknown): void;
