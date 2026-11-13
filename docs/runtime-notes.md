# Persistent-session runtime notes

[Back to the README](../README.md)

Implementation details and historical measurements follow. Behavior depends on the host, permissions and PowerShell environment.

## Known limits

- **`read-only` mode is unsupported**; use the built-in `pwsh` tool there.
- **Refuses to start when the sandbox policy service is absent**, unless `allowUnconfined: true`.
- **A timeout in persistent mode kills that session** (and reaps its child process tree). State is lost; the next persistent call rebuilds automatically. `mode: "isolated"` instead starts and disposes a separate process per call; its timeout or cancellation preserves the persistent process and state. It uses the same sandbox and guards, counts toward the process limit, and refuses a full pool instead of evicting a persistent process.
- **`exit N` exit codes are not observable** (runspace semantics).
- **stdout / stderr interleaving is not preserved** — streams are collected separately and grouped by type.
- **Direct Console output is discarded.** `Console.Out` and `Console.Error` use null writers rather than
  retained memory streams. On Windows, inheritable `NUL` handles replace stdin/stdout/stderr so a child
  cannot read requests or inject protocol lines. PowerShell-captured native output, `Write-Error` and
  `throw` still return; launches that directly inherit the detached handles lose their output.
  Handle-detachment failure refuses startup. `NUL` can change native-launch denial wording, not permissions.
- **Persistent calls are serial**: creation and execution share one queue per DSH ID. The execution timeout
  excludes queue waiting. Cancelling a queued request affects only itself; active cancellation kills its process.
- **Reuse rechecks boundaries**: changes to effective policy, workspace or sandbox backend rebuild the
  process. A missing session ID is rejected instead of sharing a default process. Cordis creates new tracing proxies per lookup; comparisons unwrap only the service identity while service operations still use the tracing proxy.
- **Pool pressure and idle expiry never evict busy sessions.** A full busy pool refuses new sessions
  with a retry message. Idle age starts after the last call completes.
- **UTF-8 payload budgets are enforced on both sides.** Ordinary streams share `maxOutputBytes`; errors
  retain a separate 64KiB budget, including record separators. Consumed records and undisplayed progress
  records are drained immediately. Frames are size-limited; display prefixes are outside the payload budget.
- **Top-level syntax is retained.** Workdir uses a separate API call and objects use
  `Out-String -Stream -Width 200`. `#requires` checks version, PSEdition, modules and administrator identity
  before the body; `-ShellId` / `-Assembly` are explicitly refused. Administrator group membership alone
  does not prove the process is unconfined.
- **Startup failure cleans up and returns the stderr tail.** Handshake warnings appear once on the first
  user call. The gzip bootstrap must remain within the encoded Windows command-line budget or startup is refused.
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
- **An update replaces the session.** This plugin carries no updater of its own; DSH manages its
  version, and replacing a plugin stops it. Stopping this plugin disposes its sessions, so the install that
  lands a new version leaves the persistent pwsh process gone and the next call rebuilds it: anything held
  only in that session (variables, `Set-Location`, imported modules) is lost. Measured across a
  v0.2.3 → v0.2.4 install: `$PID` changed from 24820 to 15632 and a `$global:` variable set before the
  install read back empty.

  Nothing asks whether a call is in flight. The host performs the update; this plugin does not get a say and
  does not gate it. The version is worth more than the session state, but it is not "nothing happened" — do
  not hold unrecoverable state in a session across an upgrade.

## Diagnosing system queries

Neither the routing guard nor the deletion guard disables `Get-Process`, `Get-NetTCPConnection` or `Get-CimInstance`. Success still depends on the host token, the system provider and access to the target resource. Empty output does not establish a sandbox denial.

Use `-ErrorAction Stop` during diagnosis and retain the exception type, `FullyQualifiedErrorId` and original message. `-ErrorAction SilentlyContinue` hides non-terminating errors, and `try/catch` does not catch every non-terminating error by itself. Distinguish an empty result, a missing resource and an access denial. `Get-NetTCPConnection` reporting `No matching MSFT_NetTCPConnection objects found by CIM query` means that invocation found no matching object; it does not by itself establish a permission denial or an invalid `-State Listen` value. Compare the exact query and timing, then check the target port in unfiltered results.

In one historical trace, a native `pwsh` script successfully listed processes before `Get-CimInstance Win32_Process` returned an access denial. A different script printed its own “Get-NetTCPConnection unavailable” message for an empty port query; that was not a tool rejection. All three queries succeeded in the current restricted workspace session. The exact permission conditions behind the historical CIM denial remain unresolved, so this does not guarantee CIM access on every host.