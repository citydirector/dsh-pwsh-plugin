# Persistent-session runtime notes

[Back to the README](../README.md)

Implementation details and historical measurements follow. Behavior depends on the host, permissions and PowerShell environment.

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
- **An update replaces the session, but never cuts a call short.** Replacing a plugin stops it, and stopping
  this plugin disposes its sessions, so the install that lands a new version leaves the persistent pwsh
  process gone and the next call rebuilds it: anything held only in that session (variables, `Set-Location`,
  imported modules) is lost. Measured across a v0.2.3 → v0.2.4 install: `$PID` changed from 24820 to 15632 and a
  `$global:` variable set before the install read back empty. What the updater does **not** do is interrupt
  work in flight: both the automatic loop and `pwsh_run_update action: "install"` ask the plugin whether a call
  is running, and if one is, the install is postponed (the loop retries in 3 minutes, the tool reports
  `install: postponed` and leaves the profile untouched) until the session is idle. Calls that arrive while an
  install is in progress wait for it to finish instead of starting a session that is about to be disposed.
  The version is worth more than the session state, but it is not "nothing happened" — do not hold
  unrecoverable state in it across an upgrade.
