# wsl/llrun — the `bash` tool's write boundary

DSH's `bash` tool runs in WSL. On `/mnt/c` and `/mnt/d` (9p / drvfs) it can write **anywhere** — the DSH
sandbox does not reach across that mount. `wsl/llrun` is a small C shim that inserts three boundaries in
front of the shell, turning that hole into a closed loop. `wsl/custom-bash.mjs` wires it into the
`bash` tool (see [Wiring](#wiring-custom-bashmjs)).

```
llrun [--no-isolate] [--no-seal] [-r] [-C <dir>] <workspace|-> <prog> [args...]
```

| Argument | Meaning |
|---|---|
| `workspace` | Writable directory (WSL path). `-` = current directory. `/` is refused outright. |
| `-r` | **Strict read-only** (maps to DSH's `read-only` mode). Every directory except `/dev` drops to read-only; see the table below. |
| `-C <dir>` | `chdir` after landlock is applied, so the script's `$0` and line numbers stay clean. |
| `--no-isolate` | Skip socket masking (docker becomes reachable — this drops a whole layer); also loses the `/var/tmp` seal. |
| `--no-seal` | Disable only the `/var/tmp` seal; socket masking stays. |

## The three boundaries

1. **User + mount namespace.** Binds `/run/docker.sock`, `/var/run/docker.sock`,
   `/run/containerd/containerd.sock` and `/run/podman/podman.sock` onto `/dev/null`, then covers
   `/etc/ssh/ssh_config.d` with an empty directory (a userns makes the ownership check there fail).
2. **landlock (ABI 7).** System directories keep full access; `/mnt/c` `/mnt/d` `/mnt/e` become read-only;
   the workspace stays writable. **The whitelist does not contain `/init`** — WSL's interop relay cannot
   execute, so `cmd.exe`, `pwsh.exe` and any absolute-path PE are blocked along with it. This is the
   linchpin of the whole scheme; adding `/init` back means having no boundary at all.
3. **`/var/tmp` mount seal.** Inside the userns, `bind` the directory onto itself and `remount,ro`.
   It has to be a mount: **landlock unions parent and child rules**, so a full-access `/var` swallows the
   stricter read-only rule for `/var/tmp` (`/dev` + `/dev/shm` behave the same way — both stay writable).
   Only a mount-level ro can seal a subdirectory, and `remount` needs `CAP_SYS_ADMIN`, which is only
   available inside the userns — which is why `--no-isolate` cannot seal it.
   `-r` additionally seals `/dev/shm` (plain mode leaves it alone, see below).

## read-only (`-r`) semantics

| Operation | Default | `-r` strict |
|---|---|---|
| Read / list / execute | allowed | **allowed** (without read access, not even `ls` or `cat` starts) |
| Write / create / delete / rename / truncate | workspace and non-Windows mounts allowed | **all denied** |
| Write `/dev/null` | allowed | **allowed** (character device, must keep full access) |
| Write `/tmp` `/home` `/etc` `/var/log` | allowed | **denied** |
| Write `/dev/shm` `/var/tmp` | allowed | **denied** (mount seal) |
| Touch mtime / `chmod` | allowed | **still allowed** (inherent landlock blind spot — the kernel has no such permission concept) |

**What `-r` really costs.** `/tmp` is read-only, so **any tool that needs temporary files breaks**:
`gcc` gives `Cannot create temporary file in /tmp/: Permission denied` (`Aborted`). `python3`, `git`,
`curl`, `dpkg`, `ssh` and `bun` all work. With `/dev/shm` sealed, Python's
`multiprocessing.Semaphore` / `SharedMemory` raise `OSError: [Errno 30]` and `Manager` raises
`EOFError` — an inherent cost of the read-only tier, not a defect.

## Build and install

```bash
cd wsl && gcc -O2 -Wall -Wextra -o llrun llrun.c
mkdir -p <DSH_HOME>/bin && cp llrun <DSH_HOME>/bin/llrun && chmod 755 <DSH_HOME>/bin/llrun
```

`custom-bash.mjs` does not hard-code one path. It probes, in this order, and takes the first executable:

| # | Candidate | Note |
|---|---|---|
| 1 | `$LLRUN` or `$DSH_LLRUN` | explicit override; also useful for a per-session binary |
| 2 | `<DSH_HOME>/bin/llrun` | **recommended** — inside your own data root, survives upgrades with it |
| 3 | `/usr/local/bin/llrun` | only if you can write there (`sudo`) |
| 4 | `~/.local/bin/llrun` | no `sudo`, but must be a path the shell user can execute |
| 5 | the copy next to `custom-bash.mjs` | ships with the package — the only candidate a fresh install has |

**The packaged copy arrives without an executable bit.** `npm pack` runs on Windows when the release is
cut, and Windows has no such concept: every entry lands as `0644`. So the probe does not stop at `-x`. If a
candidate exists, belongs to the shell user (`-O`) and is not executable yet, it runs `chmod +x` on it and
retries — the file is ours, inside the user's own `node_modules`, so this costs nothing and needs no
install script (pnpm does not run those by default anyway). Ownership is the gate: a `llrun` owned by
someone else is left untouched, and reported as 「exists but is not executable」 rather than as missing.

The result is cached across calls, so installing the binary later takes effect on the next call — no DSH
restart. The probe runs once over `bash -s` and returns a single exit code, so a missing candidate costs a
few milliseconds and never changes the tool's behaviour. Setting `llrunPath` in the config skips the probe
and accepts exactly that one path.

## Acceptance matrix (54 assertions, all green, repeated runs)

`bash wsl/acceptance.sh` → `TOTAL pass=54 fail=0 skip=0`, `leaks=0`.

The script is machine-independent: it derives the workspace from its own location, discovers the Windows
user directory under `/mnt/*/Users/*/`, and only asserts against directories that actually exist. It also
re-checks the disk at the end (`leaks=N`) so a silently-succeeding write cannot pass unnoticed.

Run it from a WSL shell that is **not** itself inside the fence. Under `custom-bash` the shell is already
wrapped in `llrun`, and nesting a second user namespace turns four assertions red and leaves a `/dev/shm`
probe behind — a false failure, not a regression. `wsl.exe -e bash` from a plain Windows prompt is enough.

- **Write boundary**: outside targets (drive root, `Documents`, the portable data root, the profile dir,
  `C:\Users\<user>`) all DENIED with disk re-check absent; workspace, `/tmp` and `/home` writable;
  `/var/tmp` sealed but readable.
- **Windows executables**: `cmd.exe`, `powershell.exe`, `notepad.exe` and a direct `/init` call all BLOCKED.
- **Docker escape**: `docker ps` BLOCKED, raw socket connect BLOCKED; `--no-isolate` reverses it (CONNECTED).
- **Toolchain**: `git`, `node`, `python3`, `gcc`, `dpkg -l`, `curl https`, `ssh` all normal.
- **`-r` tier**: 8 write assertions DENIED (workspace, `/tmp`, `/home`, `/dev/shm`, `/var/tmp`, `/etc`,
  `/var/log`, `mktemp`); 6 read assertions OK; delete and `mkdir` DENIED; `python3` / `git` / `curl` /
  `dpkg` / `ssh` stay alive, `gcc` unusable as expected.
- **Switches**: `--no-seal` and `--no-isolate` both open `/var/tmp` as designed.
- **Verbatim pass-through**: exit codes, heredoc literals, Chinese text and quoting all survive unchanged.

**Overhead**: bare bash 2-3 ms per call → llrun 8-9 ms per call, about **+6 ms**.

## Known costs

- **`sudo` is unusable** (`PR_SET_NO_NEW_PRIVS` refuses setuid elevation), so `apt-get install` is out;
  read-only queries like `dpkg -l` and `apt list` still work.
- `dbus-send --session` / `systemctl --user` work (restored by the same-uid mapping; the early 0→1000
  mapping broke them).
- **mtime and `chmod` are not restricted**: landlock's permission vocabulary has no concept for them, so
  even the read-only tier can retimestamp or re-permission an existing file (content, creation, deletion
  and rename are all blocked). A kernel-level blind spot, not an implementation gap.
- **`-r` does not stop damage inside the workspace** — it guards against writing *outward*, not against
  emptying the workspace. The workspace is writable by design in the default tier, and `rm -rf` has full
  authority there. Only discipline prevents that.
- **`/dev/shm` must stay writable in the default tier**: it is the POSIX shared-memory mount, and sealing
  it crashes Python `multiprocessing` `Semaphore` / `SharedMemory`. Only `-r` seals it (a read-only run
  should not spawn multi-process work anyway).
- **The ssh mask uses a fixed path, `/tmp/.llrun-empty`** (since v6). An earlier `mkdtemp` version leaked
  one directory per call — 421 of them had accumulated in testing.
- **No Windows executable can be called from inside WSL any more** (scoop, pwsh, node.exe all BLOCKED).

## Wiring (`custom-bash.mjs`)

`wsl/custom-bash.mjs` is what the bundle wires in. The package's own `cordis.patch.yml` carries:

```yaml
- id: custom-bash
  name: dsh-pwsh-plugin/wsl/custom-bash.mjs
  disabled: !!js process.platform !== 'win32'
```

A **bare subpath**, resolved from the profile's `node_modules`. That matters: the loader rewrites a `./` or
absolute `name` inside an inserted entry into an absolute `file://` URL and copies it into the composed
tree (`anchorInsertedPluginNames` in `dsh-app-boot`), which pins the install path — move the data directory
and the row breaks. A bare subpath resolves fresh on every boot instead. It needs
`"./wsl/custom-bash.mjs"` in the package `exports`; the `llrun` binary itself is not exported and does not
need to be, because the plugin finds it through `import.meta.url`.

So: install the bundle, and the `bash` tool is fenced. Uninstall it, and the `custom-bash` row goes with it —
there is no separate copy to keep in sync and nothing to delete by hand.

If you wire it by hand instead, the row is:

```yaml
- id: custom-bash
  name: '<path>/wsl/custom-bash.mjs'
  disabled: !!js process.platform !== 'win32'
```

Do not also disable `tool-bash` from a patch. That row already carries
`disabled: !!js process.platform === 'win32'`; a hard `disabled: true` would turn the stock bash off on
Linux as well.

**Commands go in over stdin**: `argv = [bash, '-s']` plus `stdio.stdin = { data: command }`. It used to be
`[bash, '-c', command]`, where backticks, `$` and complex quoting were all eaten by the Windows
`bash.exe` layer first — the root cause of a workspace-deletion incident (a `\n` lost its backslash in the
inner bash, gluing two commands together).

**Mode triage** (`sandboxPolicy.resolve` must be given `session`, otherwise it silently falls back to the
deployment default):

| Session permission | Process started |
|---|---|
| `danger-full-access` | bare `bash -s`, no fence (DSH's established semantics) |
| `workspace-write` | `llrun <workspace> /bin/bash -s` |
| `read-only` | `llrun -r <workspace> /bin/bash -s` |
| `sandboxPolicy` absent | **throws, refuses to run**, unless `fence: false` is configured |
| no candidate executable | **throws, refuses to run** — never silently degrades to unfenced; the message lists every probed path |
| a candidate exists but cannot be executed | **throws**, naming that exact path — not reported as 「not found」 |

`workspace` comes from the policy's `workspaceRoot` (falling back to the session cwd), with Windows paths
translated to `/mnt/<drive>/...`. A POSIX `workdir` goes to llrun's `-C` (chdir after landlock); a Windows
one still becomes the process cwd.

Configuration:

```yaml
- id: custom-bash
  config:
    llrunPath: '/mnt/c/Users/<you>/.local/bin/llrun'   # omit to probe the candidates
    fence: true                                        # false = no fence (not recommended)
    sshAgentSocket: '$HOME/.ssh/wsl2-ssh-agent.sock'   # false = do not inject
```

`llrunPath` is only for overriding. Left out, the plugin probes `$LLRUN` / `$DSH_LLRUN`,
`<DSH_HOME>/bin/llrun`, `/usr/local/bin/llrun`, `~/.local/bin/llrun`, and finally the copy that sits next
to `custom-bash.mjs` inside the package — first executable wins, and the result is cached, so a fresh
install works without a restart. Yours come first: a system-level `llrun` may be newer, the packaged one only
guarantees that the fence is there at all.

Tests: `node test/bashtest.mjs` (31, mock runtime) + `node test/bash-e2e.mjs` (11, real runtime + real llrun).
Three of the 25 pin the executable-bit repair: a `0644` copy is made executable and the call succeeds, an
unusable copy is named in the error, and an unusable candidate earlier in the list does not shadow a usable
one later. They only assert the mode on POSIX hosts — NTFS reports every file as `0666`, so there the
assertion is that the call still works.

### The SSH agent socket

`bash -s` is a **non-interactive** shell: it never reads `~/.bashrc`, so the usual
`eval $(wsl2-ssh-agent)` line at the bottom of that file never runs and `SSH_AUTH_SOCK` stays empty. The
fence is not the cause — a socket given explicitly works inside it just as well as outside.

`custom-bash` therefore prepends a three-line probe to every command:

```sh
if [ -z "$SSH_AUTH_SOCK" ] && [ -S "$HOME/.ssh/wsl2-ssh-agent.sock" ]; then
  export SSH_AUTH_SOCK="$HOME/.ssh/wsl2-ssh-agent.sock"
fi
```

It tests `-S` (a real socket, not merely an existing path) and never overwrites a value you set yourself —
so a script that exports its own socket still wins. `sshAgentSocket: false` turns the injection off; any
other string replaces the path. The agent itself is still yours to keep running: the fence blocks
`/init`, so `wsl2-ssh-agent` cannot start **inside** it and must be a user service outside.
