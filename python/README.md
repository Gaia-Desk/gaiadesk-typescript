# gaiadesk

Drive GaiaDesk desks from Python (3.9+, sync and asyncio): devices and
reachability probes, `exec` with exit codes and separate stdout/stderr,
streaming output, file copy, background jobs, stats, scoped agent tokens,
port forwards, and the screen tools through MCP. No dependencies.

It runs the `gaiadesk-cli` that ships with GaiaDesk
(<https://gaiadesk.net/download>) and returns the JSON it prints.

```python
from gaiadesk import GaiaDesk

gd = GaiaDesk(token_file="/home/me/.config/gaiadesk/bot.token")
r = gd.exec("392586273", "uname -a", shell="sh")
print(r["exit"], r["stdout"])
```

`AsyncGaiaDesk` has the same methods as coroutines.

Full documentation, the API table, errors and known gaps: see the
repository's top-level README.md. MIT-licensed; GaiaDesk itself is
proprietary.
