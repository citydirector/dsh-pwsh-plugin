# dsh-pwsh-plugin

**English** · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/dsh-pwsh-plugin)](https://www.npmjs.com/package/dsh-pwsh-plugin) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

PowerShell sessions, optional tool guards and planned file removal for DeepSeek Harness.

## Features

- **Persistent PowerShell 7:** scripts travel over stdin without an intermediate shell or the Windows command-line length limit. Variables, environment changes, modules and working directory survive between calls.
- **Isolated calls:** use a fresh process for a one-off command. Its timeout or cancellation leaves the persistent session intact.
- **Sandbox integration:** each DSH session has its own state. Permission, workspace and sandbox-backend changes are checked before execution.
- **Live settings:** profile-wide switches for PowerShell routing and deletion confirmation, with Chinese and English UI. Saving either switch preserves running sessions.
- **Planned removal:** review targets before recycling. Large directories support summaries, complete inventory pages, progress and cancellation; registered temporary directories support scoped cleanup.
- **WSL Bash fence:** on Windows, the bundled Bash tool uses `llrun` to enforce the session's write boundary. The binary ships with the package.

## Install

Requires **PowerShell 7** and a compatible **DSH 0.2.x** host with settings and tool-guard support. The Windows Bash feature also needs WSL.

In DSH, open **Plugins → Add plugin**, enter `dsh-pwsh-plugin`, and enable it. The bundle registers its tools and settings page automatically.

For the desktop CLI:

```powershell
$dsh = '<desktop install>\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = '<DSH data directory>'
& $dsh plugin --profile desktop add 'dsh-pwsh-plugin'
```

Use `dsh-pwsh-plugin@<version>` to select a release. The reserved `desktop` profile requires the desktop application's CLI. Remove an old manual `pwsh-run` entry before switching to the bundle to avoid duplicate registration.

## Run PowerShell

Call `pwsh_run` with the script body as-is; do not wrap it in `pwsh -c` or add shell escaping.

```json
{"script":"$buildName = 'demo'; Write-Output $buildName"}
```

For a one-off command:

```json
{"script":"Get-Process | Select-Object -First 5","mode":"isolated"}
```

| Parameter | Default | Description |
| --- | --- | --- |
| `script` | Required | PowerShell script text. |
| `mode` | `persistent` | Retain state, or use `isolated` for a fresh process disposed after the call. |
| `workdir` | Current directory | Set the directory before execution; an invalid path refuses the script. Persistent calls retain it. |
| `timeoutMs` | `120000` | Execution timeout in milliseconds, excluding queue waiting. |

Calls to one persistent session run serially; different DSH sessions are independent. Isolated calls share the process limit, pay startup cost and refuse when capacity is full rather than evicting a persistent session.

Output uses PowerShell tables and lists. Use `ConvertTo-Json` for structured data; use `2>&1` or `*>&1` when stream ordering matters.

## Settings

Open **pwsh settings** in the settings sidebar, or the plugin row's configuration button. Both switches default to **off**, apply to every preset and session in the current profile, and take effect after **Save**.

| Setting | Configuration key | Behavior |
| --- | --- | --- |
| Require pwsh_run | `enforcePwshRun` | Refuse ordinary built-in `pwsh` calls and direct the model to `pwsh_run`. Read-only sessions, explicit background jobs and valid requests for a higher permission mode remain available; elevation still needs host approval. |
| Review targets before deletion | `enforceFileRemoval` | Block common direct deletion commands in `pwsh`, `pwsh_run` and `bash`, and direct the model to review a removal plan. |

The guards check tool entries and common script syntax; they do not inspect every child program or prevent every filesystem deletion.

## Recycle files and clean temporary directories

Use `file_remove` to prepare a fixed inventory:

```json
{"action":"plan","paths":["D:/project/node_modules"]}
```

Review the returned targets, then confirm in a separate call:

```json
{"action":"execute","planId":"<plan ID>"}
```

Small inventories list every entry. Large ones return exact roots, counts, byte totals, a digest and a preview. Read the complete inventory with:

```json
{"action":"list","planId":"<plan ID>","offset":0,"limit":128}
```

Follow `nextOffset` until it is `null`. **512 is only the small-inventory display threshold.** Scans default to 250000 file, directory and link entries; hitting a scan budget produces no executable plan.

Long operations return an `operationId`. Use `action: "status"` or `action: "cancel"` with that ID on the same tool; `waitMs` accepts 0–10000. A completed status contains the original response in `result`.

- Plans are single-use and expire two minutes after scanning completes. Execution rescans the full tree and refuses observed changes to targets or session boundaries.
- Windows paths use the real Windows Recycle Bin; native Linux paths use `gio trash`. Recycling never falls back to permanent deletion. Restricted sessions may need explicit, host-approved escalation for the exact plan.
- Internal symlinks and Windows junctions are handled as links, without traversing their destinations. Target/ancestor links, mounted filesystems, protected roots and `.git` paths are refused.
- Cancellation does not undo completed removals. Check the reported results and remaining targets before retrying.

For test or build output, `file_temp` with `action: "create"` returns a new directory and `tempId`. Later, `action: "clean"` with that ID **permanently deletes only that registered directory**. Existing directories cannot be registered. Large-tree budgets, progress, cancellation and link checks apply here too.

See the [file-removal guide](docs/file-removal.zh-CN.md) for approval examples, limits and failure handling.

## Configuration

Set process parameters and scan budgets on the existing `pwsh-run` bundle entry. The two live guard switches are described under [Settings](#settings).

| Key | Default | Description |
| --- | --- | --- |
| `pwshPath` | `pwsh` | PowerShell 7 executable, resolved through `PATH`. |
| `timeoutMs` | `120000` | Default script timeout, in milliseconds. |
| `idleMs` | `1800000` | Idle-session lifetime, in milliseconds. |
| `maxSessions` | `4` | Process limit, including isolated calls. Busy sessions are not evicted. |
| `maxOutputBytes` | `8388608` | Per-call UTF-8 output budget; errors have a separate 65536-byte budget. Truncation is reported. |
| `allowUnconfined` | `false` | Allow startup when the sandbox policy service is absent. |
| `fileScanMaxEntries` | `250000` | Complete-tree entry budget; maximum 2000000. |
| `fileScanMaxBytes` | `67108864` | Serialized inventory budget shared by scanning and retained plans; maximum 536870912 bytes. |
| `fileScanTimeoutMs` | `120000` | Scan timeout; maximum 1800000 ms. |
| `fileOperationTimeoutMs` | `300000` | File-operation timeout; maximum 1800000 ms, independent of tool waiting. |

The inventory budget limits serialized data, not total process memory. Missing sandbox policy is refused unless `allowUnconfined` is explicitly enabled.

## Sandbox and limits

- `workspace-write` uses DSH's sandbox. `danger-full-access` follows the host's unrestricted mode. `read-only` refuses `pwsh_run` and file-tool operations; use built-in `pwsh` for read-only commands.
- A persistent-call timeout terminates that process and its child tree, clearing session state. Isolated-call timeouts affect only the isolated process. Permission, workspace or backend changes also rebuild persistent state.
- There is no TTY. `exit N` does not expose its numeric code; inspect `$LASTEXITCODE` for native commands. Output streams are grouped by type unless merged in the script.
- Windows sandbox restrictions can affect child-process pipes, CIM queries or Schannel HTTPS. These are host-dependent; see [runtime notes](docs/runtime-notes.md) and the [Schannel investigation](docs/dsh-windows-schannel.zh-CN.md).
- On Windows, restricted WSL Bash blocks Windows executables and Docker socket access. SSH-agent injection uses an existing socket; the bridge must already run outside the fence. See [WSL setup and limits](docs/llrun.md).

## Update

DSH's **Plugins** page manages version checks and installation. Use an npm registry installation for this update path; the plugin has no separate updater.

The local pnpm `minimumReleaseAge` policy can defer a new release. Registry metadata and download nodes can also become available at different times; retry later if a newly published tarball returns 404, and check the version actually installed.

Finish active tasks before updating: plugin replacement clears persistent state. Follow the host's reload or restart prompt; after installing through an external CLI, restart DSH to load the new code.

## Development and documentation

```sh
pnpm install --ignore-scripts --config.auto-install-peers=false
pnpm test
pnpm run test:all
```

The full regression suite currently has **15 scripts / 303 assertions**. It needs Windows, Node.js 24, PowerShell 7, WSL and a loadable DSH runtime. Use `DSH_MODULES` or `DSH_MODULES_ASAR` when automatic runtime discovery is unavailable; release validation must finish without skips. Run `bash wsl/acceptance.sh` from a plain WSL shell, outside the plugin's fence.

For a release, commit changes, then run:

```sh
npm version patch -m 'chore(release): %s'
node scripts/release-check.mjs
git push --atomic origin main <tag>
```

The [release workflow](.github/workflows/release.yml) publishes through npm trusted publishing with provenance.

- [Runtime notes](docs/runtime-notes.md)
- [File-removal guide](docs/file-removal.zh-CN.md)
- [WSL fence](docs/llrun.md)
- [Audit and fixes](docs/pwsh-run-audit.zh-CN.md)
- [Historical measurements](FINDINGS.md)

## Related projects

[DSH-build](https://github.com/citydirector/DSH-build) · [Remote access](https://github.com/citydirector/dsh-remote-access-proxy) · [DeepInfra proxy](https://github.com/citydirector/deepinfra-fusion-proxy) · [Loop rescue](https://github.com/citydirector/dsh-loop-rescue) · [UI Locate](https://github.com/citydirector/ui-locate-mcp) · [Session manager](https://github.com/citydirector/dsh-session-manager)

## License

[MIT](LICENSE)
