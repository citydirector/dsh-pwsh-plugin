# dsh-pwsh-plugin

[English](README.md) · [简体中文](README.zh-CN.md)

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

# <version> is any published version; the newest one is what the plugin itself would install
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

The three files in `plugin/` (`index.mjs`, `session.mjs`, `session-server.ps1`) must stay together —
`index.mjs` reads the `.ps1` at load time and ships it to the child as `-EncodedCommand`.

## The tools

`pwsh_run` runs a script. Versions are managed by DSH itself — see [Updates](#updates).

| Argument | Required | Meaning |
|---|---|---|
| `script` | yes | PowerShell script text. Reaches the server **verbatim** — do not escape `$`, do not wrap it in `pwsh -c`, do not add outer quotes. |
| `workdir` | no | `Set-Location` first. The session is stateful, so later calls inherit it. An invalid path fails this call without running the script. |
| `timeoutMs` | no | Per-call timeout, default 120000. |

Output: stdout as-is, warnings prefixed `WARNING: `, verbose prefixed `VERBOSE: `, a thrown exception
carries `[script threw]` plus the innermost message. Errors (`Write-Error`, a child process's stderr)
come **after** stdout — the server merges every stream through `*>&1` and tags lines by type, so
**line-by-line interleaving of stdout and stderr is not preserved** (the built-in tool keeps two columns).
When order matters, merge them yourself: `2>&1` or `*>&1`.

## Configuration

| Key | Default | Meaning |
|---|---|---|
| `pwshPath` | `pwsh` | Executable; resolved through `PATH` by default. |
| `timeoutMs` | `120000` | Default per-call timeout. |
| `idleMs` | `1800000` | Recycle an idle session (30 minutes). |
| `maxSessions` | `4` | How many sessions may live at once (one per agent workspace). |
| `maxOutputBytes` | `8388608` | Output collection cap per call (8 MB). Truncation is reported honestly, never silently. |
| `allowUnconfined` | `false` | `true` = start a session even when the sandbox policy service is missing. |

`allowUnconfined` is the one deliberate escape hatch. In a normal deployment `ctx.sandboxPolicy` is always
present; when it is missing the composition is incomplete, and the plugin **refuses to start** rather than
quietly running an unconstrained session.

Hot reload (`patchReload: live`) re-runs `apply`. Tool registration and process cleanup both hang off
`ctx.effect`, so it does not trip `tool "pwsh_run" is already registered`.

## Sandbox

The persistent process is wrapped **once, at launch**, in the restricted argv that `ctx.sandbox.confine`
returns. The Windows ACL sandbox uses a `WRITE_RESTRICTED` token, and a token is **process-wide** — so
after that single confine, every later read and write in the session obeys the same workspace boundary as
the built-in `pwsh` tool.

Policy is resolved against the **real session at launch time** (`session` must be passed into
`sandboxPolicy.resolve`): the session's `sandbox/mode` wins, and the boundary root comes from the
session's `header.cwd`.

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

## Updates

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
| `Program 'node.exe' failed to run: Access is denied.` (or `拒绝访问`) | Expected under `workspace-write`: the restricted token cannot create anonymous pipes, so **any** launch that captures a child's stdio fails — `& exe` included. Use `Start-Process -RedirectStandardOutput/-RedirectStandardError <file>` (captures output, no exit code), `[Diagnostics.Process]::Start` with `UseShellExecute=$false` and no redirection (exit code, child inherits stdout), or a `.cmd` wrapper that writes stdout, stderr and `%ERRORLEVEL%` to three files. The tool appends this same advice to the output. |

## Known limits

- **`read-only` mode is unsupported** (see above); use the built-in `pwsh` tool there.
- **Refuses to start when the sandbox policy service is absent**, unless `allowUnconfined: true`.
- **A timeout kills the whole session** (and reaps its child process tree). State is lost; the next call
  rebuilds automatically.
- **`exit N` exit codes are not observable** (runspace semantics).
- **stdout / stderr interleaving is not preserved** — everything goes through `*>&1` and is tagged by type.
- **`[Console]::Error.WriteLine` is swallowed** (the server points `Console.Error` at an in-memory stream so
  the protocol cannot be polluted). A child process's stderr, `Write-Error` and `throw` all come back fine.
- **Child std handles are detached from the protocol.** `Console::SetIn/SetOut` only changes the .NET layer, so
  the server also rewrites the three Win32 slots: stdin goes to `NUL`, stdout and stderr go to a
  `FILE_FLAG_DELETE_ON_CLOSE` temp file truncated before every call. A grandchild that writes to inherited
  stdout can no longer inject a fake protocol line (measured: one `Write-Output '<<<BYE>>>'` from a child used
  to kill the session), and one that reads inherited stdin gets EOF instead of the caller's request.
  The replacement handles are created **inheritable** (`SECURITY_ATTRIBUTES.bInheritHandle`): a handle made with
  a `NULL` security descriptor only exists in this process, so a child that trusts `STARTUPINFO.hStdInput`
  receives a bare handle *number* that means nothing over there — `GetFileType` reports `UNKNOWN`, and once in
  a few dozen launches that number is recycled by an unrelated object and the read returns its bytes.
  stdout deliberately does **not** go to `NUL`: that is a character device, PowerShell then believes its output
  is not redirected and the sandbox denial changes into a useless `StandardOutputEncoding` message.
  If the temp directory is unwritable it falls back to `NUL` and says so once, in a warning on the first call.
- **A session is serial**: concurrent calls queue up and run one at a time (no interleaved output, but no
  parallel speedup either).
- **No WSL is required.** `pwsh_run` never touches WSL; only `wsl/custom-bash.mjs` does. Without a usable
  `bashPath`, applying that preset still succeeds (the executable is resolved lazily) and the `bash` tool
  fails per call with `command "<path>" is not an executable file` — a clear failure, not a silent
  downgrade. The default is the bare name `bash`; when PATH cannot resolve it, the Windows build retries
  `C:\Windows\System32\bash.exe` (the same WSL shim) before giving up. That fallback exists because a
  process can inherit an environment block that predates a PATH edit and then lacks `System32`, which
  otherwise costs you the whole tool. An explicit absolute `bashPath` is honoured alone — a typo there
  should fail loudly rather than be silently redirected.
- **UAC behaves differently from this machine.** These measurements come from a box with UAC off, where the
  process runs elevated. With UAC on, sessions run as a standard user, and the ACL sandbox needs the
  workspace root's DACL to give you **`WRITE_DAC` and `WRITE_OWNER`** — full control satisfies both, because
  the integrity label it writes lives in the SACL. A directory under your user profile inherits exactly
  that; a directory created at a drive root only inherits `Modify`, and `Modify` alone fails with
  `SetNamedSecurityInfoW failed (Win32 5)`. Ownership is not the deciding factor: `icacls <root> /grant
  "%USERNAME%":(OI)(CI)F` fixes a root you do not own. Confinement fails closed with that message instead of
  running unconfined.
- No interactive programs and no TTY.
- **An update replaces the session.** Replacing a plugin stops it, and stopping this plugin disposes its
  sessions, so the install that lands a new version leaves the persistent pwsh process gone and the next call
  rebuilds it: anything held only in that session is lost. Measured across a v0.2.3 → v0.2.4 install: `$PID`
  changed from 24820 to 15632 and a `$global:` variable set before the install read back empty.

## Development

```
plugin/
  index.mjs           tool registration, sandbox wiring, timeouts
  session.mjs         the session object: framing, queue, base64 encode, boot argv
  session-server.ps1  the PowerShell side: runspace, stream tagging, sentinels
test/
  support.mjs         locates a DSH install; converts Windows paths to /mnt form
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
FINDINGS.md          every measurement and the reasoning behind the design
```

```bash
cd <checkout>
PWSH_BIN='pwsh' node test/itest.mjs          # 17: protocol and session core
PWSH_BIN='pwsh' node test/plugintest.mjs     # 15: full plugin path
node test/e2e-real-subprocess.mjs            #  8: real DSH subprocess
node test/sandboxtest.mjs                    #  7: real sandbox boundary + fail-closed
node test/bashtest.mjs                       # 25: custom-bash fence triage, bash fallback, exec-bit repair
node test/bash-e2e.mjs                       # 11: custom-bash end to end
node test/denialtest.mjs                     # 11: sandbox-denial hint (no spawn, runs anywhere)
node test/metatest.mjs                       # 23: plugin-page metadata (no spawn, runs anywhere)
```

Eight scripts, **117 assertions**, none of which needs DSH to be running — just node 24, PowerShell 7 and a
DSH install to borrow `node_modules` from. Tests that need a DSH runtime locate one automatically
(`DSH_MODULES`, `DSH_MODULES_ASAR`, or by walking up from the working directory) and print a `SKIP` hint
instead of failing when none is found.

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

## License

MIT — see [LICENSE](LICENSE).