# dsh-pwsh-plugin

**English** · [简体中文](README.zh-CN.md)

[![npm](https://img.shields.io/npm/v/dsh-pwsh-plugin)](https://www.npmjs.com/package/dsh-pwsh-plugin) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE) [![DSH plugin](https://img.shields.io/badge/DSH%20plugin-%E2%89%A50.2.0--rc.2-blue)](https://github.com/topics/dsh-plugin)

A `pwsh_run` tool for DeepSeek Harness: PowerShell script text goes to a **persistent** pwsh 7 process
over stdin, so nothing is escaped on the way in, there is no 32K command-line cap, the ~400 ms cold start
is paid once, and variables / location / modules survive from one call to the next.

It sits **next to** the built-in `pwsh` tool, it does not replace it.

The same repository also carries `wsl/llrun`, a small C shim that gives the `bash` tool a real write
boundary inside WSL. See [docs/llrun.md](docs/llrun.md).

The plugin page shows this package's own icon, its localized title and summary, and — in a Chinese UI —
`README.zh-CN.md` rather than the English one. Each piece is declared where the harness looks for it:
`icon.svg` through `package.json`'s `icon` field, and the text through `locale/en.json` plus
`locale/zh.json` (only `meta.detail` can reach a document whose name is not literally `README`).

Requires **DSH 0.2.0-rc.2 or newer** (tested on 0.2.0-rc.2 and 0.2.1-rc.3) and **PowerShell 7**.

## Why you want it

| Layer | What happens today |
|---|---|
| `bash` tool | Wraps the command as `/bin/bash -c "<cmd>"`. The outer double quotes expand `$` **before** PowerShell ever sees it, and heredocs die in the same layer. |
| built-in `pwsh` tool | Passes `$` and here-strings through correctly, but each call is a brand-new process, and the whole command rides the Windows command line: 32,000 characters is fine, 32,700 gives `spawn ENAMETOOLONG`. |
| this tool | Script body travels as a base64 blob on stdin, so neither problem applies. |

Verified 91,741 characters in a single call. Full measurements and the reasoning behind every design
choice are in [FINDINGS.md](FINDINGS.md).

## Install

The package is a **DSH bundle**: it ships a `cordis.patch.yml` that inserts its own rows, so installing
it is all you do — you never edit your profile by hand.

It inserts two:

- `- id: pwsh-run` — the tool itself.
- `- id: custom-bash` — the `bash` tool replacement, Windows only (`disabled: !!js process.platform !== 'win32'`).
  It points at `dsh-pwsh-plugin/wsl/custom-bash.mjs` inside the package, so the `llrun` binary that comes with
  it is what the fence uses — nothing to copy, nothing to install into `/usr/local/bin`. `remove` takes both
  rows and the package away, leaving your profile exactly as it was.

It does **not** disable the stock `tool-bash`: that row already carries `disabled: !!js process.platform ===
'win32'`, and a hard `disabled: true` from here would switch the official bash off on Linux too.

**npm registry.** Also published to npm: `npm i dsh-pwsh-plugin`, or let DSH install the registry spec:

```powershell
& $dsh plugin --profile desktop add 'dsh-pwsh-plugin@<version>'
```

> pnpm's `minimumReleaseAge` defaults to 1440 minutes, so a version published today is not resolved
today — pressing update installs the previous release. That is the supply-chain policy, not a failure.

> For the first five minutes after `npm publish` the tarball URL still answers **404** from the CDN
edge (`cache-control: public, max-age=300`) even though the version document and `dist-tags.latest` are
already updated. Installing inside that window fails with `ERR_PNPM_FETCH_404 … .tgz: Not Found`, which
reads like a permissions problem and is not one. Wait the five minutes out; a `?nocache=` query string
bypasses the cache but neither npm nor pnpm will fetch that URL.

**Sidebar.** Plugins → Add plugin → `https://github.com/citydirector/dsh-pwsh-plugin`, then switch it on.

**CLI.** The `desktop` profile can only be managed by the desktop application's own CLI:

```powershell
$dsh = '<desktop install>\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = '<DSH_HOME>'        # the data root the desktop app itself uses

# <version> is any published version; the newest one is what the Plugins page offers
& $dsh plugin --profile desktop add 'dsh-pwsh-plugin@<version>'
# or, from a local checkout
& $dsh plugin --profile desktop add 'file:<path to checkout>'
```

`add` appends `dsh-pwsh-plugin` to `dsh.profile.bundles` in the profile's `package.json`; `remove` takes it
back out. Verify with `--dump-config` on a non-reserved profile, where the row shows up as
`# == dsh-pwsh-plugin` followed by `- id: pwsh-run / name: dsh-pwsh-plugin`.

Two things to know before you choose a spec:

- **A registry spec copies, `file:` hard-links.** `dsh-pwsh-plugin@X.Y.Z` installs one copy of that release —
  editing the checkout changes nothing until you run `add` again. A `file:` install hard-links the checkout,
  so edits are live immediately (`fsutil hardlink list` shows both paths), at the cost of pinning an absolute
  path in `package.json`. Use `file:` while developing, a registry spec for keeps.
  `github:citydirector/dsh-pwsh-plugin#<tag>` still works and installs the same copy, but it goes around
  pnpm's supply-chain policy.
- **The bundle row cannot carry `?v=N`.** Its `name` must be the package name so it resolves from the
  profile's `node_modules`, so there is no URL to change and ESM keeps serving the module it already cached.
  Changing a file under `node_modules` is only picked up if the host happens to run a recomposition later;
  that is not something to rely on while developing. Use the manual row below with a fresh `?v=N`, or restart.

**Manual install**, if you would rather not take a dependency:

```yaml
- insert:
    - id: pwsh-run
      name: '<path>/plugin/index.mjs'
      config:
        pwshPath: 'pwsh'
```

Three constraints that cost real time to find:

- **`desktop` is a reserved profile.** The portable `dsh.exe` answers
  `profile "desktop" is managed exclusively by the Electron application` and exits 1. Only the desktop
  install's `dsh.cmd` (which starts the desktop-host CLI with `manageDesktopProfile: true`) can touch it.
- **`DSH_HOME` must point at the portable data root.** The default is `~/.dsh`; point it elsewhere and you
  get `Open DeepSeek Harness Desktop once to initialize its profile` — it is looking for
  `~/.dsh/profiles/desktop/package.json`.
- **Do not double-register.** If you switch from a manual row to the bundle (or the other way round), delete
  the hand-written entry **before** installing. Both layers insert `- id: pwsh-run` and the composed tree
  will hold two of them; registration is keyed by name, and a second `pwsh_run` is a hard error at boot.
  `--dump-config` shows the duplicate plainly — that is the check to run after switching.

Keep the entire `plugin/` directory together. The entry module loads the session server and fixed file workers, including their C# recycle helper, from adjacent files.

## The tools

`pwsh_run` runs a script. Versions are managed by DSH itself — see [Updating](#updating).

| Argument | Required | Meaning |
|---|---|---|
| `script` | yes | PowerShell script text. Reaches the server **verbatim** — do not escape `$`, do not wrap it in `pwsh -c`, do not add outer quotes. |
| `mode` | no | `persistent` (default) retains state between calls. `isolated` starts a fresh process for this call and disposes it afterward, preserving existing persistent state. |
| `workdir` | no | `Set-Location` first. Persistent calls inherit this directory later; an isolated call changes only its own process. An invalid path refuses the script. |
| `timeoutMs` | no | Execution timeout, excluding queue waiting; default 120000. Integer milliseconds from 1 to 2147478647. |

Use `{"script":"Get-Process", "mode":"isolated"}` for a short stateless command. It uses the same sandbox and deletion guards, starts without the persistent process's variables or environment changes, and cannot terminate that process on timeout or cancellation. Isolated calls count toward `maxSessions`; when capacity is exhausted they refuse with a retry message rather than evicting a persistent process. Each call pays startup cost.

Output uses PowerShell formatting at width 200; objects appear as tables or lists. Use `ConvertTo-Json`
when structured fields are needed. Warning, Verbose, Information and Debug have separate labels; errors
and innermost exceptions follow ordinary output. Streams are grouped by type, so cross-stream order is
not preserved; merge them in the script with `2>&1` or `*>&1` when needed. The script stays at top level
for `using` and `param`. `#requires` is checked before the body; unsupported `-ShellId` / `-Assembly`
requirements are explicitly refused.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `pwshPath` | `pwsh` | Executable; resolved through `PATH` by default. |
| `timeoutMs` | `120000` | Default per-call timeout. |
| `idleMs` | `1800000` | Recycle an idle session (30 minutes). |
| `maxSessions` | `4` | Per-plugin process limit, isolated by DSH session ID. If all are busy, new sessions are refused with a retry message. |
| `maxOutputBytes` | `8388608` | UTF-8 payload budget per call, including record separators; errors have a separate 65536-byte budget. Framing and display labels are excluded. Truncation is reported. |
| `allowUnconfined` | `false` | `true` = start a session even when the sandbox policy service is missing. |
| `enforcePwshRun` | `false` | Refuse ordinary native `pwsh` calls before execution and direct the model to `pwsh_run`. |
| `enforceFileRemoval` | `false` | Block common direct deletion commands and require the Agent to review a `file_remove` inventory before recycling. |

`allowUnconfined` is the one deliberate escape hatch. In a normal deployment `ctx.sandboxPolicy` is always
present; when it is missing the composition is incomplete, and the plugin **refuses to start** rather than
quietly running an unconstrained session.

Hot reload (`patchReload: live`) re-runs `apply`. Tool registration and process cleanup both hang off
`ctx.effect`, so it does not trip `tool "pwsh_run" is already registered`.

### Enforce pwsh_run

This is a profile-wide plugin setting. Configure it once for all presets and sessions in that profile;
do not add it to each preset or insert a second `pwsh-run` entry when the bundle already provides one.

Open **pwsh settings** in the settings sidebar, enable **Require pwsh_run**, then select **Save**. The plugin row's configuration button opens the same form. Changes stay as a draft until saved; leaving the page discards the draft. **Restore configuration default** removes the profile override.

Saving updates the switches through DSH's settings service and preserves running PowerShell processes and session state. The page reports the value accepted by the host, protects against conflicting writes, and disables editing on read-only deployments. It follows the host's Chinese or English language setting.

For hosts without the settings UI, override the existing plugin entry in the profile's `cordis.patch.yml`:

```yaml
- id: pwsh-run
  config:
    enforcePwshRun: true
```

Ordinary native `pwsh` calls are refused before execution. The response tells the model to move
`command` into `pwsh_run`'s `script` and preserve `workdir` and `timeoutMs`.
It also points to `mode: "isolated"` for one-shot calls and the settings switch for restoring ordinary native calls.
The command is neither executed first nor replayed automatically. Both native dispatch and
PTC's `tools.pwsh(...)` pass through this check.

Three native entry points remain available: read-only sessions (unsupported by the persistent
session), jobs with `run_in_background: true`, and per-call escalation requests with a nonempty
`justification` and a requested mode strictly wider than the current one. Escalation still needs
host approval; a same-mode flag does not qualify. The guard resolves the actual session policy
on each call, so mode changes take effect on the next invocation.

Disabling the option, removing the guard through hot reload, or uninstalling restores native
`pwsh` behavior. The option defaults to off. Live configuration requires `ctx.tools.guard()`;
a host without this API is rejected explicitly so enabling the setting cannot silently go unprotected.
The guard covers the DSH `pwsh` tool entry, not PowerShell launched inside bash, Node or other scripts.

### Removal confirmation and temporary cleanup

The same **pwsh settings** page has **Review targets before deletion**, off by default. Saving it preserves running sessions. When enabled, common deletion commands in `pwsh`, `pwsh_run` and `bash` are refused before the script runs. The response directs the Agent to these tools:

- `file_remove action=plan paths=[...]` expands relative paths and final-component wildcards into a fixed inventory. The Agent reviews it, then separately calls `action=execute planId=...`. Plans are single-use, expire in two minutes, and refuse observed changes to targets, session or sandbox policy. The limits are 64 root targets, 512 tree entries and 32 pending plans.
- `file_temp action=create` makes a new registered directory inside the workspace and returns a `tempId`. `action=clean tempId=...` authorizes permanent cleanup of only that registered directory, after checking its identity, marker and tree. Existing directories cannot be registered; a name such as `temp` grants no exception. Test programs can keep their own internal cleanup.

Ordinary removal uses the real Windows Recycle Bin, including for Windows paths written as `/mnt/c/...`, or `gio trash` for native Linux paths. A failed recycle never falls back to permanent deletion. Roots, home/workspace ancestors, `.git`, links and special paths are refused. A restricted session must explicitly request wider access for the exact recycle plan; the host must approve it. Agent confirmation does not replace host approval, and read-only sessions cannot use these file tools.

New Windows scratch directories retain the parent's sandbox capability and deny entries while adding inheritable access for the current user. Low-token creation, writing and cleanup are tested. Existing broken ACLs are reported, never repaired automatically. The guard recognizes common script syntax; it does not inspect arbitrary child programs or prevent every filesystem deletion. A snapshot-to-operation concurrency window remains. See the [detailed guide in Chinese](docs/file-removal.zh-CN.md) for failure handling and backend limits.

## Sandbox

The persistent process is wrapped **once, at launch**, in the restricted argv that `ctx.sandbox.confine`
returns. The Windows ACL sandbox uses a `WRITE_RESTRICTED` token, and a token is **process-wide** — so
after that single confine, every later read and write in the session obeys the same workspace boundary as
the built-in `pwsh` tool.

Every call resolves policy against the **current real session** (`session` must reach
`sandboxPolicy.resolve`) and checks the effective policy, workspace and sandbox backend. A change
disposes the old process before any new script; read-only refuses the body. Permission or workspace
changes therefore clear persistent state too. Working-directory service errors are surfaced instead
of falling back to stale paths. Cordis tracing proxies are compared through their underlying service identity, so a fresh proxy does not invalidate state or deletion plans; an actual backend replacement still does. Persistent creation and execution share one queue per ID; only sessions with no
executing, queued or starting requests can be evicted.

A trap worth knowing: passing the ToolExecution instead (`agent` lives on `exec.agent`) means `resolve`
never sees a session and **silently falls back to the deployment default** (mode + configured
`workspaceRoot`), which put the boundary on the profile directory — the symptom was "cannot write inside
the workspace, but can write to the profile directory". The `policy-carries-session` case in
`test/sandboxtest.mjs` pins that shape down.

Measured with `workspace-write`, cwd = the plugin directory: the workspace accepts writes; the drive root,
`C:\Users\<user>\`, `C:\Windows\Temp\`, `C:\ProgramData\` and the profile directory are all
refused. The script still runs in `FullLanguage`, and `$global:` plus cwd survive across calls.
Under `danger-full-access` nothing is confined, exactly like the built-in tool.

**`read-only` does not start.** In that mode pwsh runs in ConstrainedLanguage and cannot even create a
runspace. The tool reports that clearly and points at the built-in `pwsh` tool, which works there.

## Updating

This plugin carries no updater of its own. It is an ordinary registry package, so **DSH manages its
version**: the Plugins page lists it, shows when a newer release exists, and installs it — the same
`listVersions` / `updateBundle` path used for every other plugin.

That path is available because the profile records a bare registry spec (`"dsh-pwsh-plugin": "0.2.14"`).
DSH refuses to update a bundle installed from anything else: a `github:` or `file:` source, a git range,
a package that is not a third-party dependency of this profile, or one that declares no semver version.

Two consequences worth knowing:

- **`minimumReleaseAge` still applies.** pnpm's supply-chain policy defaults to 1440 minutes, so a version
  published today is not resolved today — pressing update installs the previous release, and the page says
  which version it actually installed. This is the policy working, not a failure.
- **A version is only as good as its tag.** `package.json` is the one hard-coded version in this repository.
  Publish a tag without bumping it and every update attempt installs the same bytes; `scripts/release-check.mjs`
  fails the release workflow before that happens.

Updating by hand is the same operation DSH performs:

```powershell
$env:DSH_HOME = '<DSH_HOME>'
& '<desktop install>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'dsh-pwsh-plugin@<version>'
```

**An update replaces the persistent session.** Stopping the plugin disposes every session it owns, so after
an update the next call rebuilds the pwsh process: variables, `Set-Location` and imported modules held only
in that session are gone. Do not keep unrecoverable state in a session across an upgrade.


## The `llrun` shim

The `bash` tool runs in WSL, where `/mnt/c` and `/mnt/d` are writable **anywhere**: 9p/drvfs sits outside
the DSH sandbox. `wsl/llrun` closes that with a user namespace, landlock (ABI 7, and a whitelist that
deliberately omits `/init` so no Windows executable can be launched) and a `/var/tmp` mount seal.
`wsl/custom-bash.mjs` wires it into the `bash` tool and picks the tier from the session's permission.

It needs no manual install: the binary ships inside the package and is the last probe candidate, so a fresh
`plugin add` is enough. Since releases are packed on Windows, that copy arrives as `0644` — the probe
restores the executable bit itself before giving up, as long as the file belongs to the current user.

The same row also injects `SSH_AUTH_SOCK`. `bash -s` is non-interactive, so the `eval $(wsl2-ssh-agent)`
line at the bottom of `~/.bashrc` never runs and the variable stays empty — the fence is not the cause, a
socket named explicitly works inside it just as well. A three-line probe exports
`$HOME/.ssh/wsl2-ssh-agent.sock` when it is a real socket and nothing is set yet; `sshAgentSocket: false`
turns it off. The agent daemon itself must live **outside** the fence (it needs `/init`), typically as a
systemd user unit.

Full description, the `-r` semantics table, the 54-assertion acceptance matrix and the wiring:
**[docs/llrun.md](docs/llrun.md)**. Run `bash wsl/acceptance.sh` from a plain WSL shell (not from inside
`custom-bash`, where nesting a second fence makes four assertions fail for the wrong reason) to re-verify on
your own machine — it derives every path from its own location and re-checks the disk for leaks.

## Troubleshooting

| Symptom | Do this |
|---|---|
| `profile "desktop" is managed exclusively by the Electron application` | Use the desktop install's `dsh.cmd`, not the portable `dsh.exe`. |
| `Open DeepSeek Harness Desktop once to initialize its profile` | You are pointing `DSH_HOME` at the wrong place; set it to the data root the desktop app uses. |
| `tool "pwsh_run" is already registered` at boot | Your profile patch file has a hand-written `id: pwsh-run` **and** the bundle patch inserts one. Delete the hand-written entry. |
| `refusing to start: ctx.sandboxPolicy is absent` | The composition is missing the sandbox policy service. Fix the composition, or set `allowUnconfined: true` if you really mean it. |
| `could not confine the session: SetNamedSecurityInfoW failed (Win32 5)` | The workspace root is not fully controlled by you. The sandbox writes a DACL + an integrity label there, which needs ownership plus `WRITE_DAC` and `WRITE_OWNER`. Take ownership and grant yourself full control: `icacls "<root>" /grant "%USERNAME%":(OI)(CI)F`, or start the session from a directory under your user profile. |
| `refusing to start: read-only mode` | Expected. Use the built-in `pwsh` tool in read-only sessions. |
| Script cannot write where the built-in tool can | Check that `session` reached `sandboxPolicy.resolve` (see [Sandbox](#sandbox)); a missing session silently moves the boundary to the profile directory. |
| Output looks reordered | stdout and stderr are merged by type, not by time. Merge them yourself with `2>&1`. |
| `exit N` code is not reported | Runspace semantics — use `Write-Output` or read `$LASTEXITCODE`. |
| A child process keeps a file locked after the call | The session holds the `Process` object. Wait for `idleMs`, or force a rebuild with a timeout. |
| `Program 'node.exe' failed to run: Access is denied.` (or `拒绝访问`) | The current Windows restricted token cannot create some child pipes, so `& exe` can fail. For output and an exit code, use `[Diagnostics.Process]::Start` on `cmd.exe /c "<exe> <args> > out.txt 2> err.txt"` with `UseShellExecute=$false`; or `Start-Process -NoNewWindow -PassThru -Wait -RedirectStandardOutput/-RedirectStandardError <file>` (the exit code may be empty). Avoid a new console; directly inherited output goes to `NUL`. |

## Known limitations

The [audit and local fix record](docs/pwsh-run-audit.zh-CN.md) covers the nine issue groups.
The host TLS failure has a separate [Schannel investigation](docs/dsh-windows-schannel.zh-CN.md).

The full list — session semantics, detached child std handles, UAC differences, and what an update does to a
session — lives in **[docs/runtime-notes.md](docs/runtime-notes.md)**. The short version:

- `read-only` mode is unsupported; use the built-in `pwsh` there.
- A timeout kills the whole session and reaps its child process tree.
- `exit N` codes and stdout/stderr interleaving are not observable.
- A session is serial, and there is no TTY.
- An update replaces the session; anything held only in it is lost.

## Development

```
plugin/
  index.mjs           tool registration, sandbox wiring, timeouts
  config.mjs          native schema; routing and removal switches are volatile
  native-pwsh-guard.mjs  optional native pwsh invocation guard
  deletion-guard.mjs  common deletion syntax guard
  file-tools.mjs      fixed removal plans, approvals and registered scratch directories
  file-worker.ps1 file-worker.cjs file-recycle.cs  sandboxed filesystem workers
  session.mjs         the session object: framing, queue, base64 encode, boot argv
  session-server.ps1  the PowerShell side: runspace, stream tagging, sentinels
client/index.js      localized settings page using DSH native controls
test/
  settingstest.mjs    persistence, conflicts, live switches and process preservation
  filetoolstest.mjs   real Windows recycling, Low scratch directories and refusal paths
  filetools-wsl.mjs   real WSL scratch cleanup, trash and backend boundaries
  support.mjs         locates a DSH install; converts Windows paths to /mnt form
  routingtest.mjs     native/PTC routing, exceptions, unload and reload
  protocoltest.mjs    frame limits, UTF-8 budgets, startup cleanup
  lifecycletest.mjs   policy changes, session pool, cancellation
  itest.mjs           protocol and session core
  plugintest.mjs      the whole plugin path against a mock context
  e2e-real-subprocess.mjs  real DSH subprocess runtime
  sandboxtest.mjs     real LocalSandboxProvider, boundary + fail-closed cases
  bashtest.mjs        custom-bash fence triage (mock runtime)
  bash-e2e.mjs        custom-bash end to end (real runtime + real llrun)
  denialtest.mjs      the sandbox-denial hint fires on the right messages only
  metatest.mjs        the plugin-page metadata: locale, icon, and which document the page selects
wsl/
  llrun.c llrun      the C shim and its build
  custom-bash.mjs    the bash tool replacement the bundle wires in (Windows only)
  acceptance.sh      the 54-assertion matrix
docs/llrun.md        the shim in full
docs/runtime-notes.md  the full list of known limits, kept out of this page
FINDINGS.md          every measurement and the reasoning behind the design
```

```bash
cd <checkout>
pnpm install --ignore-scripts --config.auto-install-peers=false
node test/settingstest.mjs                  # 24: native settings, live switches and preserved state
node test/filetoolstest.mjs                  # 42: Windows recycling, Low directories, approval and cancellation
node test/filetools-wsl.mjs                  #  7: WSL scratch cleanup, trash and backend boundaries
node test/routingtest.mjs                   # 31: native/PTC routing, exceptions, disable and unload
node test/protocoltest.mjs                  #  6: frame limits, UTF-8 budgets, startup cleanup
node test/lifecycletest.mjs                 # 21: policy, pool, concurrency, cancellation, unload
PWSH_BIN='pwsh' node test/itest.mjs          # 30: protocol and session core
PWSH_BIN='pwsh' node test/plugintest.mjs     # 15: full plugin path
node test/e2e-real-subprocess.mjs            # 12: real DSH subprocess
node test/sandboxtest.mjs                    # 15: real sandbox, downgrade, root switch, first concurrency
node test/bashtest.mjs                       # 31: custom-bash fence triage, bash fallback, exec-bit repair
node test/bash-e2e.mjs                       # 11: custom-bash end to end
node test/denialtest.mjs                     # 11: sandbox-denial hint (no spawn, runs anywhere)
node test/metatest.mjs                       # 23: plugin-page metadata (no spawn, runs anywhere)
```

Fourteen scripts, **279 assertions**, none of which needs DSH to be running — just node 24, PowerShell 7 and a
DSH install to borrow `node_modules` from. Tests that need a DSH runtime locate one automatically
(`DSH_MODULES`, `DSH_MODULES_ASAR`, or by walking up from the working directory) and print a `SKIP` hint
when none is found. The settings integration test exits unsuccessfully if its host modules are unavailable;
a release validation must complete every suite without skips.

### Releasing

Publishing from a tag is `[.github/workflows/release.yml](.github/workflows/release.yml)`: it runs
`scripts/release-check.mjs`, then `npm publish --provenance` under npm's **trusted publishing**, which trades
the runner's short-lived GitHub identity for a token scoped to this repository and this workflow file. No
`NPM_TOKEN` secret exists, and none should be added. Two consequences worth knowing: the workflow file name is
part of the trust contract (rename it and every publish fails with 403 until the npm setting is updated), and
provenance is mandatory there, so the tarball carries a signed statement of which commit built it.

The version in `package.json` is the one thing in this repository that is hard-coded, and it is what DSH
compares against the published version. Publish a tag without bumping it and every update attempt installs
the same bytes: the page keeps offering the "new" version, pnpm keeps landing the old one. `npm version`
writes the version, commits, and tags in one step, which is why the three cannot drift apart:

```powershell
npm version patch -m 'chore(release): %s'   # bump, commit, annotated tag
git push origin main <tag>
```

Run `node scripts/release-check.mjs` before publishing. It fails when the working tree is dirty, when HEAD
carries a tag that disagrees with `package.json`, when the tagged commit declares a different version, and
when you are about to re-point a tag that already exists (that would move an already-published version onto
new content). With no tag on HEAD it prints the exact name to create.

Use the Windows-side npm. In WSL, `/usr/local/bin/npm` resolves to a bun symlink and `npm version` fails
with `Script not found "version"`.

## Related projects

More DeepSeek Harness (DSH) projects from [@citydirector](https://github.com/citydirector):

| Project | Kind | What it does |
|---|---|---|
| [DSH-build](https://github.com/citydirector/DSH-build) | Build | Portable and desktop Windows builds of DSH, patched, smoke-tested and released daily |
| [dsh-remote-access-proxy](https://github.com/citydirector/dsh-remote-access-proxy) | Plugin | Use the DSH Web GUI from your phone, tablet, or another computer |
| [deepinfra-fusion-proxy](https://github.com/citydirector/deepinfra-fusion-proxy) | Plugin | DeepInfra Standard / Flex switching with automatic fallback, per session |
| [dsh-loop-rescue](https://github.com/citydirector/dsh-loop-rescue) | Plugin | Cut model repetition loops mid-stream, prune them from the log, and resume |
| [ui-locate-mcp](https://github.com/citydirector/ui-locate-mcp) | MCP plugin | Pixel-exact coordinates for on-screen text and icons, for desktop automation |
| [dsh-session-manager](https://github.com/citydirector/dsh-session-manager) | Offline tool | Upgrade, archive, trash, loop cleanup and repair for DSH sessions |

## License

[MIT](LICENSE)
