# dsh-pwsh-plugin

English · [简体中文](README.zh-CN.md) · [npm](https://www.npmjs.com/package/dsh-pwsh-plugin)

Add `pwsh_run`, a persistent PowerShell tool, to DSH. Scripts travel over stdin, making it useful for multiline scripts and tasks that retain variables, location and imported modules between calls. It runs alongside the built-in `pwsh` tool.

Requires **DSH >=0.2.0-rc.2 <0.3.0** and **PowerShell 7**. On Windows, the bundle also registers `custom-bash`; see [llrun](docs/llrun.md) for its WSL write fence.

## Quick start

Enter `dsh-pwsh-plugin` in **Plugins → Add plugin**, then enable it. Ensure `pwsh` is on PATH or set `pwshPath`.

For a Web profile:

~~~sh
dsh plugin --profile web add dsh-pwsh-plugin
~~~

Stop the corresponding instance before CLI changes and restart afterwards. Prefer the Plugins page on Desktop; its desktop profile requires that installation's CLI and the same DSH_HOME. A plain `npm install` does not activate the DSH bundle.

Remove any manually inserted `pwsh-run` row before switching to the bundle, avoiding duplicate tool registration.

## Tools

| Tool | Purpose |
| --- | --- |
| `pwsh_run` | Run a script in a persistent PowerShell session |
| `pwsh_run_update` | Check npm or ask DSH to install an update |

Arguments to `pwsh_run`:

| Argument | Required | Meaning |
| --- | --- | --- |
| `script` | Yes | Literal PowerShell script; no extra `pwsh -c` wrapper |
| `workdir` | No | Change directory before execution; subsequent calls inherit it |
| `timeoutMs` | No | Per-call timeout, default 120000 milliseconds |

Example tool arguments:

~~~json
{"script":"$items = Get-ChildItem\n$items | Select-Object Name","workdir":"D:/project"}
~~~

Later calls in the same session can read `$items`. Timeouts, cancellation, idle recycling and plugin updates discard in-memory state.

## Configuration

Override row `pwsh-run` in the profile's `cordis.patch.yml`:

~~~yaml
- set:
    - id: pwsh-run
      config:
        pwshPath: pwsh
        timeoutMs: 120000
        autoUpdate: false
~~~

| Setting | Default | Meaning |
| --- | --- | --- |
| `pwshPath` | `pwsh` | PowerShell executable |
| `timeoutMs` | `120000` | Default call timeout |
| `idleMs` | `1800000` | Recycle after 30 minutes idle |
| `maxSessions` | `4` | Maximum retained sessions |
| `maxOutputBytes` | `8388608` | Output cap per call, 8 MB |
| `allowUnconfined` | `false` | Allow execution without the sandbox policy service |
| `updateCheck` | `true` | Check npm for updates |
| `autoUpdate` | `true` | Install new releases while idle |
| `autoUpdateDelayMs` | `90000` | Initial automatic-check delay |

## Update behavior

**The current version still contains its own updater.** Its source is npm, but it has not been removed: by default it checks after about 90 seconds, then every 12 hours, and installs while idle.

`pwsh_run_update` accepts `action: check` or `action: install`. Installation goes through DSH's plugin manager. Follow the returned restart requirement; hot replacement depends on the host. Updates wait for active calls to finish, but replacing the plugin discards existing persistent sessions.

To leave updating to DSH, set both `autoUpdate: false` and `updateCheck: false`. The update tool remains registered, but the plugin's update behavior is disabled.

## Limitations and troubleshooting

- No interactive terminal or TTY.
- `exit N` exit codes are not directly observable, and stdout/stderr interleaving is not preserved.
- Persistent runspaces cannot start under `read-only`; use the built-in tool there.
- A missing sandbox policy service prevents startup by default. Treat `allowUnconfined` as an explicit policy choice.
- Restricted Windows tokens can block child processes whose stdio is captured. Read the diagnostic hint in the tool result first.
- `pwsh_run` does not need WSL; the bundled Windows `bash` tool needs working WSL/bash.

See [runtime notes](docs/runtime-notes.md), [llrun](docs/llrun.md) and [FINDINGS.md](FINDINGS.md) for implementation detail.

## Development and publishing

~~~sh
npm test
~~~

Tests needing a real DSH runtime search for an existing installation and may skip when dependencies are absent; inspect their output. `npm run test:all` runs the broader suite.

The current [release.yml](.github/workflows/release.yml) publishes npm on version-tag pushes or manual dispatch with a tag, using OIDC/provenance. A README edit on main alone does not publish. Check `scripts/release-check.mjs` before releasing; the tag must match package.json.

## License

[MIT](LICENSE)
