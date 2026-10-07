# @gaiadesk/sdk

Drive GaiaDesk desks from Node.js (18+): devices and reachability probes,
`exec` with exit codes and separate stdout/stderr, streaming output, file
copy, background jobs, stats, scoped agent tokens, port forwards, and the
screen tools through MCP. Zero runtime dependencies; ESM with type
declarations.

It runs the `gaiadesk-cli` that ships with GaiaDesk
(<https://gaiadesk.net/download>) and returns the JSON it prints.

```ts
import { GaiaDesk } from '@gaiadesk/sdk';

const gd = new GaiaDesk({ tokenFile: '/home/me/.config/gaiadesk/bot.token' });
const r = await gd.exec('392586273', 'uname -a', { shell: 'sh' });
console.log(r.exit, r.stdout);
```

Full documentation, the API table, errors and known gaps: see the
repository's top-level README.md. MIT-licensed; GaiaDesk itself is
proprietary.
