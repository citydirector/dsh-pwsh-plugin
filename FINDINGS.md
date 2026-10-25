# pwsh_run 可行性报告（实测结论）

> 结论先行：**方案可行，已做成可装载的插件**。三处必须偏离原方案；沙箱不降级（可做实）；
> read-only 模式是唯一真边界；另外发现写边界漏洞其实在 bash 工具，不在 pwsh。

探针环境：Windows 11 + WSL2 Debian，pwsh 7.6.8（`<scoop>\apps\pwsh\current\pwsh.exe`），
node 24.22.1，全部数字均为实测，不是估算。

---

## 一、问题诊断：到底哪一层吃掉了 `$` 和 heredoc

最初的方向是「命令先过 bash/cmd 再到 pwsh，中间被解析掉」——方向对，但**责任层要改**：

| 层 | 实测结果 |
|---|---|
| 原生 `pwsh` 工具 | **不吃 `$`、不吃 heredoc**。`Write-Output "hello $name"`、`@'...'@` 都完整正确 |
| `bash` 工具 | **就是这里**。DSH 把命令包成 `/bin/bash -c "<cmd>"`，外层双引号先展开 `$`；`<<'EOF'` 也在这一层失效 |
| 长度 | 原生 `pwsh` 的真实上限是 **Windows 命令行 32K**：32000 字符 OK，32700 报 `spawn ENAMETOOLONG` |
| 状态 | 原生 `pwsh` 每次全新进程，`$global:` 与 `Set-Location` 都不跨调用 |

证据：`pwsh -Command "Write-Output \"var=$abc\""` 经 bash 后输出 `var=`；同一段 heredoc 写进 `.sh` 文件再执行则完全正常 → 问题只在「DSH 传给 bash 的那一层」，不在 heredoc 语义本身。
另用 base64 隔离实验确认 bash 工具收命令**字节无损**（98 字节 payload 解码后 === 原文），所以不是截断。

**所以 `pwsh_run` 的真实价值是：绕开 bash 那一层、突破 32K、省掉每次 300–500ms 冷启动、保留状态**——
而「原生 pwsh 会吃 `$`」这个前提本身不成立。

---

## 二、原方案里必须改的三处

### 1. `-Command -` 不能当常驻进程的入口
`pwsh -Command -` 是「读到 stdin EOF 就退出」的一次性模式。要常驻必须自己 `while (ReadLine)` 循环，
但循环脚本本身就得以某种方式送进去。改用 **`-EncodedCommand`**（服务端脚本随插件分发，不落地临时文件）。

顺带把 `-EncodedCommand` 的上限测准了（原先估计的 32K 是**命令行**长度，不是脚本长度）：

| 脚本长度 | base64 长度 | 结果 |
|---|---|---|
| 12000 字符 | 32128 | OK |
| 12500 字符 | 33464 | `pwsh.exe: Invalid argument` |

→ UTF-16LE + base64 膨胀 2.67×，**脚本上限约 12K 字符**。它只适合当「常驻进程起不来」时的兜底，
不能当主路径。

### 2. 「用 GUID 结束标记切分」→ 改成三段标记
单靠一个结束标记无法区分「跑完了」/「抛异常了」/「被中断了」/「脚本根本没解析」。实测协议最终是：

```
客户端 → 服务端（每行一条）：
  <id> <timeoutSeconds> <base64(utf8 脚本)>

服务端 → 客户端：
  <<<B:id>>>          本次输出开始
  O:/E:/W:/V:/X:/F: + base64   输出流 / 错误 / 警告 / 详细 / 异常 / 致命
  S:<base64>          哨兵：ok=跑完 / threw=抛异常 / ran=被 exit 或超时打断
  <<<T:id:0|1>>>      结束标记，1 = 超时被打断
  <<<E:id>>>          整条响应结束
  <<<BYE>>>           进程正常退出
```

### 3. stdout/stderr 分开 → 顺序也要保真
`2>&1` 只合并 error 流，**warning / verbose 会丢**；改 `*>&1` 再按记录类型打标。
实测 `Write-Output 'L1'; Write-Error 'ERR'; Write-Output 'L2'; Write-Warning 'WARN'; Write-Output 'L3'`
→ O,E,O,W,O 顺序严格保真且流分离。

---

## 三、六个坑（全部实测踩过，实现里都写了注释）

1. **单例 PowerShell 实例在 `throw` 之后会让下一次调用静默返回空输出**。
   改为「每次调用新建 PowerShell 实例、共享同一 Runspace」（`$PS=[PowerShell]::Create(); $PS.Runspace=$RS`）。
2. **用户脚本一句 `[Console]::In.ReadLine()` 就能吃掉协议数据、让整个会话永久失联**。
   必须把 `Console.In/Out/Error` 换成内存流，原始 stdin/stdout 只留给协议。
3. **PowerShell 变量名不区分大小写**：`$W` 与 `$w` 是同一个变量，曾把 StreamWriter 覆盖成 string，
   报 `[System.String] does not contain a method named 'WriteLine'`。
4. **主 shell 定义的 function 在 runspace 里不可见**，base64 表达式必须内联。
5. **脚本内 `$ErrorActionPreference='Stop'` 会跨调用污染**，每次调用前强制重置为 `Continue`。
6. **`exit N` 的退出码拿不到**：runspace 内 exit 只结束当次实例，`EndInvoke` 不抛、
   `$LASTEXITCODE` 为空、`catch [ExitException]` 与 `trap` 都捕获不到；finally 会执行。
   → 只能从哨兵知道「被 exit」，数字拿不到。**已如实写进工具描述**，让模型改用 `Write-Output`。

---

## 四、卖点实测量化

| 卖点 | 实测 |
|---|---|
| 零转义 | `$n='Skadi'; "hi $n"` → `hi Skadi`；`@' lit $n '@` 原样 |
| 无长度限制 | 81,798 字符脚本 61ms 跑完；挂载后再测 91,741 字符照常（原生 32,700 就挂） |
| 省启动 | 首调用约 370ms（含服务端 boot），此后往返 **1.3ms/次**（50 次共 64ms）；原生每次 300–500ms |
| 状态保留 | `$plain` / `$global:` / `Set-Location` / `$env:` / `Import-Module` 全保留 |
| 超时中断 | `Start-Sleep 60` 用 3s 打断（3021ms）；`while($true){}` 用 2s 打断（2015ms）；**中断前的部分输出能交付** |
| 大输出 | 2MB 输出 8ms |

---

## 五、沙箱：不降级（原判断已推翻）

### 0. 落地时踩的坑：策略「看起来有」，其实是部署默认值

挂载后第一轮实测就撞上怪异现象：`pwsh_run` 连**工作区内**都写不进去，
而 `<profile dir>\`（profile 目录）**反而能写**。边界整个错位了。

根因在插件解析策略的形状：

```js
// 错误版：把 ToolExecution 当成了 Agent
const resolvePolicy = (exec) => {
  const agent = exec?.agent
  return sandboxPolicy.resolve(agent === undefined ? {} : { session: agent.session })
}
```

`acquire()` 收到的入参已经是 `exec.agent`（Agent 本身），于是 `exec.agent` 恒为 `undefined`
→ `resolve({})`。而 `SandboxPolicyService.resolve` 在没有 `session` 时**不报错，静默退回部署默认值**：

```js
const { session } = request
mode: request.mode ?? (session === void 0 ? void 0 : this.overrideOf(session)) ?? this.defaultMode,
workspaceRoot: resolveWorkspaceRoot(session?.header.cwd ?? this.workspaceRoot)
```

即 mode=`workspace-write` + workspaceRoot=配置里的 `<profile dir>`。
边界没消失，只是跑到别的目录去了 —— 这比「没有沙箱」更难发现。

原生工具的写法（`dsh-tools/lib/index.js:2788-2792`）是：
`resolveSandboxPolicy: (exec) => policy.resolve(exec.agent === void 0 ? {} : { session: exec.agent.session })`
—— 传的是 **ToolExecution**；插件内部已经拆过一层，所以直接传 `{ session }` 才对：

```js
const resolvePolicy = (agent) => {
  const sandboxPolicy = ctx.get('sandboxPolicy')
  if (sandboxPolicy === undefined) return null
  const session = agent?.session
  return sandboxPolicy.resolve(session === undefined ? {} : { session })
}
```

**教训**：`resolve` 的静默降级是这类 bug 的温床。`test/sandboxtest.mjs` 的
`policy-carries-session` 用例专门钉住形状 —— 它让 `resolve` 在没有 session 时返回一个假的
fallback root，只要传错就必然断言失败。

另外一条：`patchReload: live` 重载**不会**重新求值同 URL 的 ESM 模块。
改 `plugin/index.mjs` 内容后必须给 patch 里的 `name` 加版本串（`...index.mjs?v=4`）
或改 entry `id`，否则看到的是改之前的旧行为 —— 会白排查很久。

### 1. 早先的结论是错的，原因找到了
最初以为「`ctx.sandbox.confine` 逐次包装 argv，所以常驻进程拿不到边界」。
实测推翻：Windows ACL 沙箱用 **`WRITE_RESTRICTED` 受限令牌**，令牌是**进程级**的。
常驻进程只要在**启动时**被 confine 一次，之后每一次读/写都受同一个 workspace 边界约束，
与原生工具等价。

做法：`sandbox.confine([pwsh, ...bootArgv], policy)` 返回的整条 `argv`
（`node.exe runner.js --workspace <ws> --temp <t> --mode <m> -- pwsh ...`）直接作为会话进程的 argv。

实测（受限常驻会话，mode=workspace-write，workspace=`<workspace>`）：

| 目标 | 结果 |
|---|---|
| `D:\_cf1.txt` | DENIED |
| `C:\Users\<user>\_cf1.txt` | DENIED |
| `C:\Windows\Temp\_cf1.txt` | DENIED |
| `C:\ProgramData\_cf1.txt` | DENIED |
| `<profile dir>\_cf1.txt` | DENIED |
| 工作区内 `_cf_ws.txt` | WROTE |

同时 `$ExecutionContext.SessionState.LanguageMode` = `FullLanguage`，`$global:` 与 cwd 仍跨调用保留。

### 2. read-only 模式启动不了（这条是真边界）
read-only 下 pwsh 以 **ConstrainedLanguage** 运行：
`[Text.UTF8Encoding]::new()`、`[PowerShell]::Create()`、`[RunspaceFactory]::CreateRunspace()`、
`[IO.StreamReader]::new()` 全部报 "Cannot create type / Method invocation is supported only on core types"。
常驻会话靠 runspace，所以起不来。

→ 实现里 read-only 直接拒绝启动并提示改用原生 pwsh 工具（原生工具在 read-only 下仍可用，跑 CL）。

### 3. 真正的写边界漏洞不在 pwsh，在 bash
`bash` 工具（WSL2 Debian，9p 挂载）**完全没有写边界**。实测以下全部 WROTE：
`/mnt/d/_probe.txt`、`/mnt/c/Users/<user>/`、`<DSH_HOME>/profiles/desktop/`、
`/mnt/c/Windows/Temp/`、`/mnt/d/Documents/`、`/mnt/c/ProgramData/`、`/tmp/`。

→ 之前遇到的「D 盘根目录、C 盘用户目录、profile 目录莫名出现文件」，最可能的来源是 bash 工具，
不是 pwsh。这一点与 pwsh_run 无关，但值得单独处置。

### 4. 子进程回收要靠杀整个会话
脚本内 `Start-Process cmd` 起的子进程，在 `$PS.Stop()` 之后仍然存活（实测 CHILD-ALIVE）。
只有 terminate 整个会话、靠 `ctx.subprocess` 的 Windows Job Object 才能连带清干净。

→ 实现里因此采用：**超时即 evict 整个会话**（状态丢失，诚实告知），而不是只 Stop 当前脚本。
端到端实测：`Start-Process cmd` 超时后子进程 pid 已消失。

### 5. `exit N` 退出码不可观测（见上）

---

## 六、与原生工具的关系：软路由，不做硬拦

- **并存，不替换。** 两者沙箱边界等价；原生 `pwsh` 保住审批、超时后转后台 job、read-only 可用；
  `pwsh_run` 管转义敏感、超长、需保留状态的活。
- **硬拦的两条路都查清了，都不作基石**：
  - `tools/pre-execute` 钩子：`PreToolDecision` 只有 `allow` / `deny` / `cancel` / `ask`，
    **没有 replace 语义**；改 `exec.arguments` 是踩未文档化的洞（官方注释：call identity immutable）。
  - per-agent / preset realm 注册同名 `pwsh`：类型上可行（`ScopedLayers.merge` 注释：Scoped tools shadow globals），
    `custom-bash.mjs` 就是同款手法；但本机 presets 里 `agent.ctx.tools.register` **零先例**，风险高一档，
    而且真要保留审批/截断就得自己重做一遍执行器。
- **不存在「拿到原实现再包装」的公开 API**（`get(name)` 拿得到 definition，但同名注册必须先自己占位）。

→ 结论：**先靠软路由**（工具描述 + AGENTS.md 一条规则）。若实际使用中模型仍频繁绕道 bash，
再考虑硬拦，且优先选 per-agent 同名注册这条已验证的路。

---

## 七、bash 写边界的硬拦：`llrun`（已做成、已验收、已接入）

第五节第 3 条指出 bash 工具完全没有写边界。三条路线的实测结论：Windows ACL 包 WSL bash 起不来
（`Bash/E_ACCESS_DENIED`）、`unshare -rm` 只读 bind 被 `cmd.exe` 与 `remount,rw` 双向逃逸、
软限制挡不住有意绕路。四条路里只有 **landlock** 是真边界。

### 1. 为什么 landlock 能成

landlock 是**进程级、不可回退、不需要 root** 的文件系统访问控制（syscall 444/445/446），
本机内核 `6.18.33.2-microsoft-standard-WSL2` 的 **ABI = 7**。

关键洞察是 **`/init` 不进白名单**：WSL 的所有 Windows interop 都要经 `/init` 中转，
它一被 landlock 挡住，`cmd.exe` / `pwsh.exe` / 任意绝对路径 PE **全部无法执行**。
反向验证过：白名单里加上 `/init` 后 `cmd.exe` 立刻 RAN，并且能写 `D:\` 与 profile 目录
—— interop 一开，所有写限制形同虚设。所以「不含 `/init`」不是可选项，是这个方案的定义。

### 2. 交付物

- 源码 `wsl/llrun.c`（约 260 行，中文注释），`gcc -O2 -Wall -Wextra` 零警告
- 二进制 `wsl/llrun`（17,168 字节），部署两份：`<DSH_HOME>\bin\llrun`（跟便携版走）
  与 `~/.local/bin/llrun`（WSL 原生 fs），`chmod 755`

```
llrun [--no-isolate] [-r] [-C <dir>] <workspace|-> <prog> [args...]
  --no-isolate  不做 socket 掩蔽（docker 口子保持连通，等于放弃这道防线）
  -r            工作区只读（对应 DSH read-only 模式）
  -C <dir>      landlock 生效后 chdir（不污染脚本的 $0 与行号）
  workspace     可写目录（WSL 路径）；'-' = getcwd()
  prog          目标程序，其后 argv 原样传递（不经过任何 shell）
```
退出码：exec 成功则完整透传目标进程；126 = 护栏初始化失败；127 = exec 失败。
`workspace` 为 `/` 直接拒绝。

### 3. 三道边界与顺序

1. **user + mount namespace 掩 socket**（必须先做，landlock 不可回退）
   `unshare(CLONE_NEWUSER)` → `setgroups=deny` → 写 uid/gid map → `unshare(CLONE_NEWNS)`
   → `mount(MS_REC|MS_PRIVATE)` → 把 `/run/docker.sock`、`/run/docker.pid`、
   `/var/run/docker.sock`、`/run/containerd/containerd.sock`、`/run/podman/podman.sock`
   逐个 bind 成 `/dev/null`；再用 `mkdtemp` 造的空目录盖掉 `/etc/ssh/ssh_config.d`。
2. **landlock 白名单**
   - 全权限：`/usr /bin /sbin /lib /lib64 /lib32 /etc /var /srv /media /root /tmp /dev
     /proc /sys /run /opt /home /usr/local /snap /boot`
   - 只读（EXECUTE|READ_FILE|READ_DIR）：`/mnt/c /mnt/d /mnt/e /mnt/wsl /mnt/wslg /mnt`
   - 工作区：`-r` 时只读，否则全权限
   - `/init` 永不入列表
   - `prctl(PR_SET_NO_NEW_PRIVS)` → `syscall(446)` → 可选 `chdir` → `execv`
3. **`/var/tmp` 挂载封印**（v8 起，`--no-seal` 可关）
   userns 内 `mount(d,d,MS_BIND|MS_REC)` + `mount(NULL,d,MS_REMOUNT|MS_BIND|MS_RDONLY|MS_NOSUID|MS_NODEV)`。
   为什么必须用 mount 而不是 landlock：**landlock 父子规则取并集**（见第 13 小节实测）。
   `/dev` 必须留全权（`/dev/null` 是字符设备，landlock 无法单独授权），
   所以 `-r` 档额外用 mount 封印 `/dev/shm`。封印失败只告警降级，不阻断执行。
4. **顺序硬约束**：`unshare(mount)` → 封印 → landlock 规则集 → `PR_SET_NO_NEW_PRIVS`
   → `syscall(446)` → 可选 `chdir` → `execv`。
   landlock restrict 之后白名单外路径连 `stat` 都可能失败，封印必须排在它前面。

### 4. 三处踩坑（都是实测撞出来的）

- **`uid_map` 必须写同 uid 映射**（`1000 1000 1`），不能写 `0 1000 1`。
  后者把调用者变成 ns 内 root，`$HOME` 下所有文件显示成 `65534`，
  `ssh` 读 `~/.ssh` 直接 `Permission denied`。改成同 uid 后身份保持不变，
  代价只是丢掉 root 映射 —— 而 root 本来就因 `NO_NEW_PRIVS` 不可用。
- **`getuid()/getgid()` 必须在 `unshare` 之前取**：进 userns 后返回 65534，拿它写 map 会 `Operation not permitted`。
- **`setgroups(0,NULL)` 走不通**（缺 `CAP_SETGID`，报 `Operation not permitted`），
  所以「丢掉 docker 组」这条路死，必须改成掩 socket。

### 5. 验收矩阵（56 项全绿，连续三次一致）

`bash wsl/acceptance.sh` → `TOTAL pass=56 fail=0`。

| 项 | 结果 |
|---|---|
| 写盘符根 / 用户目录 / data 根 / profile | 全 **DENIED**（磁盘复核 absent） |
| 写工作区 / `/tmp` / `/home`（本用户） | **WROTE** |
| 写 `/var/tmp` | **DENIED**（Read-only file system）；读正常 |
| 写 `/dev/shm`（默认档） | **WROTE**（POSIX 共享内存挂载点，必须保留） |
| 读 `/mnt/c`、`/mnt/d` | OK |
| `cmd.exe` / `pwsh.exe` / `notepad.exe` / 直接 `/init` | 全 **BLOCKED** |
| `docker ps` / 直连 `/var/run/docker.sock` | 默认档 **BLOCKED**；`--no-isolate` 档 CONNECTED |
| `git` / `node`(bun) / `python3` / `gcc` / `dpkg -l` / `apt list` / `curl https` | 全部 OK |
| `ssh -G` | 掩掉 `ssh_config.d` 后不再报 `Bad owner or permissions` |
| **`-r` 档写入**：工作区 / `/tmp` / `/home` / `/dev/shm` / `/var/tmp` / `/etc` / `/var/log` / `mktemp` | 8 项全 **DENIED** |
| **`-r` 档读取**：工作区 / `/tmp` / `/home` / `/etc` / `/mnt/d` / `/dev/null` 写 | 6 项全 **OK** |
| **`-r` 档工具链**：`python3` / `git` / `curl` / `dpkg` / `ssh` | 全 OK；**`gcc` 如预期失败**（`/tmp` 只读 → `Cannot create temporary file` → `Aborted`） |
| **`-r` 档删文件 / 建目录** | 全 DENIED，事后磁盘复核文件仍在 |
| `--no-seal` / `--no-isolate` | 均按预期放开 `/var/tmp` |
| `-C /tmp` | `pwd` = `/tmp`，且工作区仍可写 |
| 退出码 `exit 42` | 42 透传 |
| stdin heredoc 字面量、中文、单双引号 | 全部原样 |
| `workspace=/` | 126 拒绝 |
| **开销** | 裸 bash 2-3ms/次，llrun 8-9ms/次 → **约 +6ms/次** |

> 更正：早期版本（无 userns、无 ssh 掩蔽）测出 +0.5ms；加上 socket 掩蔽与 `mkdtemp+bind` 之后
> 才是 +6ms。这个数字以当前二进制为准。

### 6. 已知代价（使用前必须知道）

- **sudo 不可用**：`NO_NEW_PRIVS` 下 setuid 提权被内核拒绝
  （`sudo: /usr/bin/sudo must be owned by uid 0 and have the setuid bit set`）。
  同理 `apt-get install` 装不了包，`apt list` / `dpkg -l` 等只读查询照常。
- **dbus / systemd --user 正常**：同 uid 映射之前 `dbus-send --session` 会报
  `Did not receive a reply`（`/run/user/1000/bus` 的属主视图不匹配），改成 `1000 1000 1`
  之后恢复正常，`dbus-send --session --print-reply` 拿得到 `method return`，
  `systemctl --user is-system-running` 返回 `degraded`（与裸 bash 一致）。
- **WSL 里再也不能调任何 Windows exe**（scoop / pwsh / node.exe 全 BLOCKED）。
  这与 AGENTS.md 现有路由方向一致（那里已写明禁止在 bash/ops_bash 里调 powershell.exe）。
- `--no-isolate` 档不掩 socket，docker 能连 —— 但那时 docker 就是写 D 盘的逃逸口。
  实测两档 7 项对照，**唯一差别就是 docker**（写边界、Windows exe、`/var/tmp`、工作区全部一致）：

  | 项目 | 默认档 | `--no-isolate` |
  |---|---|---|
  | 写 D 盘根 | DENIED | DENIED |
  | 调 `cmd.exe` | BLOCKED | BLOCKED |
  | `docker ps` | **BLOCKED** | **CONNECTED** |
  | 写 `/var/tmp` | WROTE（v9 后默认档已封印成 DENIED） | WROTE |
  | 写工作区 | WROTE | WROTE |
  | `mount --bind` | MNT-DENIED | MNT-DENIED |
  | `unshare -rm` | NS-DENIED | NS-DENIED |

  结论：**`--no-isolate` 只开 docker 一个口子，其余边界都在，但 docker 本身足以绕出写 D 盘**；
  同时它没有 CAP_SYS_ADMIN，所以既封不了子目录，也做不了 `/var/tmp` 封印。
- **`-r` 档的 `/tmp` 只读是硬代价**：`gcc` 编译失败（`Cannot create temporary file in /tmp/`），
  任何依赖临时文件的工具都会挂。这是 read-only 语义的直接后果，不是缺陷 —— 需要编译就别用只读档。
- **`-r` 档封 `/dev/shm` 后 python 多进程崩**：`Semaphore` / `SharedMemory` → `OSError: [Errno 30]`，
  `Manager` → `EOFError`。只读场景本就不该起多进程，默认档不受影响。

### 7. 接入方式（当时的接入草案，现已实现为 `wsl/custom-bash.mjs`）

`presets/shared/custom-bash.mjs` 的 `execute`（第 97-149 行）有两处要改：

**a. 命令必须走 stdin，不能走 `-c` 参数。**
现有 `argv: [shell, '-c', command]` 即使加引号包裹，反引号与复杂引号仍会在 Windows `bash.exe`
那一层被处理掉（实测 `unexpected EOF while looking for matching \`\``）。正确形态：

```js
const handle = ctx.subprocess.spawn({
  argv: [shell, '-c', `exec ${shq(llrunPath)} ${shq(workspace)} /bin/bash -s`],
  ...cwd !== undefined ? { cwd } : {},
  stdio: { stdin: { data: args.command }, stdout: { maxBytes: maxOutputBytes }, stderr: { maxBytes: maxOutputBytes } },
  signal, graceMs: 3000,
})
```

**b. `workspace` 取会话工作区的 WSL 路径**：`resolveCwd` 返回的是 Windows 路径
（如 `D:\<workspace>`），要转成 `/mnt/d/<workspace>` 再传给 llrun。
`workdir` 的 POSIX 分支改用 `llrun -C <dir>`，Windows 分支继续用 spawn cwd。

**c. 读-only 模式传 `-r`。** 这样 bash 工具的三种沙箱模式才算真正对齐。

### 8. 残留风险

`--no-isolate` 档是给「明确要用 docker」的场景留的，接入时应做成配置项默认关闭，
不暴露给模型。否则模型一句 `llrun --no-isolate ... /bin/bash` 就能绕过全部边界。

### 9. 更正记录（v5）

早期版本（uid 映射写 `0 <uid> 1`）测出「dbus 连不上、sudo 报属主错误」，
改成同 uid 映射 `1000 1000 1` 后这两条**只剩 sudo**：

| 项 | `0 1000 1`（旧） | `1000 1000 1`（现） |
|---|---|---|
| `id` | `uid=0(root)` | `uid=1000(<user>)` |
| `~/.ssh` 可读 | 否（Permission denied） | **是** |
| `ssh_config.d` 属主检查 | 失败 | 靠空目录 bind 通过 |
| `dbus-send --session` | Did not receive a reply | **正常** |
| `systemctl --user` | 失败 | **正常（degraded）** |
| `sudo` | 属主 + setresuid 双重失败 | 仍失败（`NO_NEW_PRIVS` 拦 setuid） |
| `/etc/passwd` 属主 | 65534 | 仍 65534（未映射的 root） |

结论：**sudo / apt-get install 是 landlock 的固有代价**（`PR_SET_NO_NEW_PRIVS` 禁止 setuid 提权），
`/etc/passwd` 等 root 文件在 ns 内显示 65534 也是固有现象（只影响 `-ln` 的输出观感，读取不受影响）。

### 10. 快速切换与并发（实测）

mode 之间反复切换**不会出问题**——每次调用都是独立进程，`unshare`/`landlock` 都是进程级的，
没有任何跨调用的状态残留：

| 检查项 | 结果 |
|---|---|
| 10 轮 read↔write 交替 | 每轮 `read=DENIED write=WROTE`，无一漂移 |
| 8 条并发（4 read + 4 write） | write 全 WROTE；read 全 DENIED |
| 60 次切换后残留进程 | `llrun` 0 个、`bash` 僵尸 0 个 |

> read 档的 `touch 已存在文件` 会成功——这是 landlock 的语义（改 mtime 不需要 `MAKE_*`），不是竞态。

### 11. 两个已修的缺陷（v6）

**a. `mkdtemp` 目录泄漏**：v5 用 `mkdtemp("/tmp/.llrun-empty-XXXXXX")` 造 ssh 掩蔽源，
每次调用留一个空目录，实测累积 **421 个** `.llrun-empty-*` 垃圾。
改成固定路径 `/tmp/.llrun-empty`（`mkdir` + `EEXIST` 容忍）后，连续 20 次调用只留 **1 个**，不再增长。
ssh 不受影响（`ssh -G` 输出行数 92，与裸 bash 一致）。二进制 md5 `52e4af16993e5c39d0dc78b220367a50`。

**b. `-r` 档不够严（v9 已修）**：v8 及以前 `-r` 只把**工作区**降只读，
`/tmp` `/home` `/var/tmp` `/dev/shm` 全部照常可写，与 DSH read-only 的
「permits only required sinks such as `/dev/null`」不等价。

v9 改为严格只读（见第 14 小节）：`FULL_ACCESS` 表整体降 `readExecute`，`/dev` 例外保留全权，
工作区同样降只读。**读权限全部保留** —— 没有它连 `ls`/`cat` 都起不来。

两个实现要点：`/dev/null` 是字符设备，`LANDLOCK_ADD_RULE` 返回 `EINVAL`，**整个 `/dev` 必须留全权**；
sink 权限位必须给到 **bit14 `TRUNCATE`**，否则 `>` 覆盖已存在文件会失败。
（v9 走的是全降只读 + `/dev` 例外 + mount 封 `/dev/shm`，不再需要 sink 组。）

### 12. landlock 的固有盲区：mtime 与 chmod

read-only 档下**改已存在文件的 mtime 与权限位仍然成功**，这与 9p 无关，ext4 上同样如此：

| 操作 | read-only 档 | 说明 |
|---|---|---|
| 写内容 | **DENIED** | `WRITE_FILE` 被拦 |
| 新建 / 删除 / 重命名 | **DENIED** | `MAKE_*` / `REMOVE_*` / `REFER` 被拦 |
| 改 mtime | **CHANGED** | landlock 无「改时间戳」这个权限位 |
| chmod | **CHANGED** | 同上，属主改自己文件的 mode 不受 landlock 约束 |

这是内核 ABI 7 的权限词汇表里就没有的概念，任何 landlock 方案都躲不掉。
影响有限（改不了内容、删不掉、移不走），但必须说清：**read-only 不是绝对只读**。

### 13. landlock 的父子规则是**并集**，不是交集（关键陷阱）

用独立 C 探针验证（`allow()` 父目录全权 + 子目录只读）：

```
allow(rs, "/var", all);   allow(rs, "/var/tmp", ro);  → /var/tmp/_llt  WROTE   ← 父规则胜出
allow(rs, "/dev", all);   allow(rs, "/dev/shm", ro);  → /dev/shm/_llt  WROTE
```

→ **父目录全权时，子目录更严格的规则被吞掉。** 这直接决定了三件事：

1. 为什么 `/dev/shm` 不是「选择保留」而是**必然可写**：`/dev/null` 是字符设备必须让整个 `/dev` 全权，
   子规则 `/dev/shm` 只读被父规则吞掉。要真封只能靠 mount —— 这就是 v8 加 `/var/tmp` 封印的动机。
2. 为什么 `/var/tmp` 看似「顺带可写」：`/var` 因 dpkg 数据库必须全权，`/var/tmp` 被并集带过去。
   （`/var/lib` 显示 DENIED 只是普通文件权限 755 root:root 造成的，不是 landlock。）
3. 封子目录**唯一可行路径 = `mount -o remount,ro`**，而它要 CAP_SYS_ADMIN → 只能在 userns 内做 →
   **`--no-isolate` 档封不住任何子目录**，这是它不该暴露给模型的又一条理由。

### 14. `-r` 严格只读档（v9）与它的硬代价

实现：`FULL_ACCESS` 表整体降 `readExecute`（EXECUTE|READ_FILE|READ_DIR），
`/dev` 例外保留全权，工作区降只读，`/dev/shm` 与 `/var/tmp` 用 mount 封印。
`--no-seal` 可单独关掉封印（socket 掩蔽照旧）。

实测（`-r` 档）：

| 操作 | 结果 |
|---|---|
| 写工作区 / `/tmp` / `/home` / `/etc` / `/var/log` | **DENIED**（Permission denied） |
| 写 `/dev/shm` / `/var/tmp` | **DENIED**（Read-only file system） |
| `mktemp -d` | **DENIED** |
| 删文件 / 重命名 / mkdir / truncate | **DENIED** |
| 读工作区 / `/tmp` / `/home` / `/etc` / `/mnt/d` / 写 `/dev/null` | **全部 OK** |
| `python3` / `git --version` / `curl` / `dpkg -l` / `ssh -G` / `bun` / `node` | **全部 OK** |
| `gcc` 编译 | **失败**：`Cannot create temporary file in /tmp/: Permission denied` → `Aborted` |
| python `multiprocessing.Semaphore` / `SharedMemory` | `OSError: [Errno 30] Read-only file system` |
| python `multiprocessing.Manager` | `EOFError` |
| python `threading` | `THR-OK` |
| 改 mtime / chmod | **仍 CHANGED**（第 12 小节的内核盲区） |

**结论：`-r` 是「读、查、下载、跑已有脚本」档，不是「编译、构建」档。**
`/tmp` 只读是 DSH read-only 语义的直接后果 —— 想要真只读就必须接受临时文件不可写。

### 15. `/var/tmp` 与 `/dev/shm` 的定性（这两个什么时候用到）

性质：`/var/tmp` = **ext4 磁盘**（重启保留）；`/tmp` 与 `/dev/shm` = **tmpfs 内存**。
本机 `/var/tmp` 只有 2 个 `systemd-private-*`（polkit / systemd-logind），`TMPDIR` 未设置，
`tempfile.gettempdir()` = `/tmp`，git 无 `core.tempdir` → **封它零代价**（已封）。

`/dev/shm` 是 POSIX `shm_open` / 信号量的挂载点，**是硬需求**：
封掉后 `multiprocessing.Semaphore`（`_multiprocessing.SemLock`）与 `SharedMemory`（`/psm_*`）直接崩；
`Manager` 走 `/tmp` socket，但在 `/tmp` 也只读的 `-r` 档里同样崩（`EOFError`）。
默认档（`/tmp` 可写）不受影响，所以 `/dev/shm` 只在 `-r` 档被封印。

### 16. `llrun` 挡不住「把工作区删空」（必须诚实说明）

用与事故同构的目录复刻那条 `rm -rf` 命令（工作区内）：

```
命令: rm -rf <victim>/_tmpncd <victim>; echo rc=$?
输出: rm: cannot remove '<victim>': Permission denied
      rc=1
事后: 目录还在 yes / 剩余文件 0
```

→ **工作区在默认档本就可写，`rm -rf` 对其中文件有完整权限，内容照样被清空。**
只有目录本身因 cwd 占着才保住。围栏只防「往外写」，不防「把里面删空」。
对照项：围栏内 `touch /mnt/d/_ll_outside` → `Permission denied`（对外确实封住了）。
→ 防误删只能靠纪律：bash 工具里不拿 `\n` 分隔多行命令；`rm -rf` 不一次带多个路径；
删除一律走回收站（见第 17 小节）。

### 17. 接入 `custom-bash.mjs`（v10，已实施）

`wsl/custom-bash.mjs` 是 `bash` 工具的替代实现（v13 起由 bundle 自己的 patch 接进组合，
见第二十三节）。两个改动：**命令改走 stdin**、**按 sandbox mode 分诊挂 llrun**。

**为什么必须改 stdin**：原来 `argv = [bash, '-c', command]`。Windows 的 `bash.exe`（WSL 垫片）
会把 `-c` 后面的字符串再过一层自己的解析，反引号、`\n` 里的反斜杠、复杂引号都会被吃掉。
改成 `argv = [bash, '-s']` + `stdio.stdin = { data: command }` 之后脚本正文零解析。
这正是那次工作区被误删的直接根因：`rm -rf X/_tmp\ncd X && ...` 里的 `\n` 被内层 bash
消掉 `\` 后粘成 `_tmpncd`，紧跟的路径成了 `rm` 的第二个参数。

**mode 分诊**（`sandboxPolicy.resolve` 必须带 `session`，否则静默退回部署默认值）：

| 会话权限 | 起的进程 | 实测 |
|---|---|---|
| `danger-full-access` | 裸 `bash -s` | 写 `/mnt/d/_probe_full.txt` → WROTE |
| `workspace-write` | `llrun <workspace> /bin/bash -s` | 工作区 WROTE；`/mnt/d/_probe_out.txt` → `Permission denied` |
| `read-only` | `llrun -r <workspace> /bin/bash -s` | 工作区与 `/tmp` 写入均 `Permission denied`；`ls` 正常 |
| `sandboxPolicy` 缺席 | **抛错拒绝**（`fence: false` 才放行） | `bash fence requested but ctx.sandboxPolicy is absent` |
| llrun 不可执行 | **抛错拒绝**，不静默降级 | `llrun is not executable at ...` |

`workspace` 取策略里的 `workspaceRoot`，Windows 路径转 `/mnt/<盘符>/...`；
`workdir` 传 POSIX 路径时交给 `-C`（landlock 之后 chdir），Windows 路径仍作进程 cwd。

端到端实测（真 `LocalSubprocessRuntime` + 真 llrun，`test/bash-e2e.mjs` 11 项）：
`stdin` 模式、多行脚本、中文、工作区可写、区外被拒、`-C` chdir、`-r` 拒写、
full-access 不挂围栏、流分离 + `exit code: 7`、2000 行大输出 —— 全绿。

### 18. 删除纪律：回收站（Windows 与 WSL 是两套体系）

| 目标 | 做法 | 实测 |
|---|---|---|
| Windows 路径 | `[Microsoft.VisualBasic.FileIO.FileSystem]::DeleteFile($p,'OnlyErrorDialogs','SendToRecycleBin')` | 文件消失，`Shell.Application.Namespace(10)` 里查得到，`GetDetailsOf($i,1)` 返回 `OriginalLocation` 正确 |
| Windows 目录 | `DeleteDirectory($p,'OnlyErrorDialogs','SendToRecycleBin')` | 目录与子文件一并进回收站 |
| WSL 自己的路径 `/home/...` | `gio trash <path>` | `~/.local/share/Trash/{files,info}`，该文件系统正确的回收站，`gio trash --list` 可列 |
| **`/mnt/c`、`/mnt/d` 上的 Windows 文件** | **不能**用 `gio trash`，改走 FileSystem API | `gio trash` 只建 `<盘>:\.Trash-1000`，**不是 Windows 回收站**（见下）|
| `/tmp`、`/dev/shm` | —— | `gio: Trashing on system internal mounts is not supported`（系统内部挂载不支持回收站）|

**`.Trash-1000` 不是回收站**（被指出后实测，原判断已推翻）：

| 检查项 | 实测结果 |
|---|---|
| `gio trash /mnt/d/x` 之后文件在哪 | `D:\.Trash-1000\files\x` + `info\x.trashinfo` |
| Windows 回收站里看得到吗 | **看不到** —— `Shell.Application.Namespace(10)` 的 37 条里查无 `_cleanup.sh` 等 |
| Explorer 里能还原吗 | **不能** —— 不在回收站命名空间 |
| 在 `D:\` 根可见吗 | **可见** —— `attrs=Directory`（不是系统隐藏），Shell 能列出，只是 `Shell.Application.Namespace('D:\\.Trash-1000')` 打不开 |
| 还原手段 | 只有命令行 `gio trash --restore 'trash:///%5Cmnt%5Cd%5C.Trash-1000%5Cfiles%5Cx'`；传普通路径报 `Location given doesn't start with trash:///` |
| 元数据 | `info/<name>.trashinfo` 里 `[Trash Info]` + `Path=`（相对挂载点）+ `DeletionDate=` |

**处置**：已把 `D:\.Trash-1000` 里 13 项、`C:\.Trash-1000` 里 1 项全部转进 Windows 真回收站（逐个 `SendToRecycleBin`），
清掉孤儿的 `.trashinfo`，再 `rmdir` 两个目录 —— 现在 `C:\.Trash-1000` 与 `D:\.Trash-1000` **都不存在**。
`C:\.Trash-1000` 是测试时用 `gio trash` 删 C 盘文件产生的，`C:` 与 `D:` 行为一致。

`DeleteFile` / `DeleteDirectory` 对不存在路径抛 `MethodInvocationException`，用前先 `Test-Path`。

实测坑：
- 查回收站不能用 `Where-Object` 过滤：`$rb.Items() | Where-Object { $rb.GetDetailsOf($_,1) -eq $p }` 报 `[System.__ComObject] does not contain a method named 'GetDetailsOf'`；`$_` 的 PSObject 包装让 COM 绑定失败。改为 `$items = @($rb.Items())` + `foreach ($i in $items) { $rb.GetDetailsOf($i,1) }` 即正常（实测 `COUNT=12`，`orig`/`del` 两列都能读）。

---

## 十九、自动更新：只查、只提示、从不自己装

参考同作者的 `dsh-remote-access-proxy`（v1.4 起有更新检查，1454 行里第 102-107 / 225-233 / 244 / 982 / 1010 行是全部相关代码）。
本插件照搬了它的**判决逻辑与失败语义**，改掉了两处形态。

### 照搬的部分

| 设计 | 参考实现 | 本插件 |
|---|---|---|
| 标签契约 | `/^v(0\|\d*)\.(0\|\d*)\.(0\|\d*)$/`，预发布永不推送 | 同（`parseReleaseTag`）|
| 安装规格 | `${source.spec}#${tag}` —— 一个 tag 一个规格，装新版就是盖掉旧的 | 同（`releaseSpec`）|
| 源可覆盖 | `DSH_RAP_UPDATE_SOURCE`：`owner/repo` → GitHub；`git+<url>` → `git ls-remote` | `DSH_PWSH_UPDATE_SOURCE`，同名规则 |
| 首次延迟 / 周期 | 5s 之后每 12h，timer 都 `.unref?.()` | 同 |
| 失败不抛 | `state:'failed'` + 保留先前 `latest` + `stale:'available'` | 同，注释原话「一次网络抖动不该让已知的新版本消失」 |
| **查与装分开** | 页面把钉了 tag 的 spec 交给 DSH 的 `plugin_manager` | 输出末尾挂一行提示；装由 `pwsh_run_update` 显式触发，同样交给 `pluginManager` |

### 改掉的两处

1. **没有 UI 形态**。参考实现有 client 入口，用 `ctx.connection.fetch.register` 开了个 `/api/.../update-check` 路由给配置页面读。
   本插件没有 client 入口，也不需要界面 —— 提示直接挂在 `pwsh_run` 的返回文本末尾（每次进程生命周期只挂一次，靠 `this.announced` 去重，否则每次调用都刷一句会很吵）。
2. **`announce` 是一次性的**（`get announce()`），不是持续可读的状态。原因同上：这是给模型看的一句注记，不是给界面轮询的字段。

### 为什么不自己装

热替换会 dispose 旧实例 —— 而「安装新版本」这件事正是要由**外部**发起：
插件在自己的 effect 里调安装 API 等于在自己的尸体上开刀，`dispose` 一旦跑起来，
后半段代码再也不会执行，日志也留不下。所以提示行只写「有新版本 + 装了它的 spec」，装由外部做。

外部有两条路：

1. **`dsh plugin` CLI**（本机可用的那条）：

   ```powershell
   $env:DSH_HOME = '<DSH_HOME>'
   & '<desktop cli>\dsh.cmd' plugin --profile desktop add 'github:<owner>/dsh-pwsh-plugin#v0.2.0'
   ```

2. **`pwsh_run_update` 工具**（0.2.2 起）：把钉住 tag 的 spec 交给 `ctx.get('pluginManager')`。

   这里要区分**工具**与**服务**，早前我把两者混为一谈：
   - 工具 `plugin_manager`：`dsh-base/cordis.patch.yml:15-17` 里 `tool-plugin-manager` 是 `disabled: true`，
     profile 没覆盖 → 会话里确实没有这个工具（`Object.keys(tools).filter(/plugin/i)` 为空）。
     它打开后自己会走 `approveEscalation({requestedMode:'danger-full-access', …})`。
   - 服务 `plugin-manager`：同文件 `disabled: !!js "!ctx.get('profileContext')"` —— **桌面 profile 有
     `profileContext`，服务是活的**，`installBundle` 可用。`dsh-host-plugin-inventory/lib/index.js:137`
     就是 `ctx.get("pluginManager")` 这么取的。

   所以「装」这一步可以走服务，不必打开那个需要 `danger-full-access` 审批的工具。

### 为什么不照抄 our-free-model 的自带下载器

`<profile>/node_modules/dsh-our-free-model/src/updater.js`（1056 行）做了整套：Ed25519 签名清单
（`PINNED_MANIFEST_PUBLIC_KEY`，SPKI base64）、逐文件 sha256、`backupPackage` / `installStaged` /
`verifyInstalled` / `restoreBackup`、`.ofm-new` 同目录改名、`renameWithRetry` 处理 Windows EPERM。

它能这么干是因为**它是独立包，安装目录里就是自己那几十个文件**。本插件是 profile 的 bundle 依赖：
文件在 `node_modules/dsh-pwsh-plugin`，版本钉在 profile 的 `package.json` 与 `pnpm-lock.yaml` 里。
绕开包管理器改文件，下一轮 `dsh plugin add/remove` 就会踩到 lockfile 与磁盘不一致的脏状态。

`installBundle` 的返回里 `application` 是 `'applied' | 'restart-required' | 'failed' | 'cancelled'`；
`change()` 失败**不抛**，折进 `result.application='failed'` + `result.error=managementError(error)`
（`{ code:'operation-error', diagnostic }`），只有拿不到 profile 锁或服务销毁时才 reject。

### `applied` 也要说重启

bundle 行的 `name` 就是包名，装新版前后 `resolve` 出**同一个 module URL**，而 ESM 按 URL 缓存。
实测：同进程内改文件后同 URL 再 import，拿到的是同一个模块对象（`same === true`）；加 `?v=bust`
才拿到新代码。所以 `application` 的两种取值对「是否已经生效」没有区别 —— 都得重启。

### 陷阱：WSL 的 `bash` 工具里 `export DSH_PWSH_UPDATE_SOURCE=...` 是无效的

本地预演时踩到（`_skadi_temp` 里的探针已清）：

```bash
export DSH_PWSH_UPDATE_SOURCE='git+file:///tmp/release'
node -e "console.log(process.env.DSH_PWSH_UPDATE_SOURCE)"   # → undefined
```

根因是 WSL 的互操作规则：**只向 Windows 侧透传 `WSLENV` 里点名过的变量**，其余一律丢。
表现极具误导性 —— `updateSource()` 收到空串就静静退回默认 GitHub 仓库，
于是明明设了本地源，却看到 `GitHub answered HTTP 404`（仓库还没建，当然 404）。

三条实测：

| 写法 | node 里读到的 |
|---|---|
| `export DSH_PWSH_UPDATE_SOURCE=...` | `undefined` |
| `WSLENV=DSH_PWSH_UPDATE_SOURCE` + export | `"git+file:///tmp/release"` ✅ |
| `WSLENV='DSH_PWSH_UPDATE_SOURCE/p'` + export | `"git+file;\\wsl.localhost\Debian\tmp\release"` ❌ `/p` 会把路径翻译成 UNC，本地 git 源就废了 |

**结论：预演一律在 Windows 侧做**（`pwsh_run` 或原生 `pwsh`），不要试图从 WSL 跨过去。
README 里的预演脚本已改成 PowerShell 写法，并且照抄跑通过一次（`available / v0.2.0`）。

### 测试

`test/updatetest.mjs`（52 项）不联外网：发布源用 `mkdtempSync` 建的真 git 仓库 +
`git+file://` 规格，走完「读标签 → 比版本 → 下判决 → 出 spec → 去重 announce」全链路，
`finally` 里 `rmSync` 自清。失败路径（源不存在、自身版本读不出）各有钉住用例。


---

## 二十、安装路径：`desktop` profile 只能由桌面端 CLI 管

要把插件装成 bundle（而不是手写 patch 行），必须走对入口。这块踩了三个坑，都实测过。

### 1. 便携版的 `dsh.exe` 管不了 `desktop`

```powershell
PS> & '<portable>\dsh.exe' plugin --profile desktop list
error: profile "desktop" is managed exclusively by the Electron application
dsh 已退出，退出码 1
```

源码在 `@deepseek-ai/dsh/lib/bin.js`（asar 内 `11772` 字节那版）：

```js
function rejectElectronProfile(program, profile) {
  if (profile.toLowerCase() === "desktop") program.error("error: profile \"desktop\" is managed exclusively by the Electron application");
}
// …
if (!manageDesktopProfile) rejectElectronProfile(plugin, options.profile);
```

`manageDesktopProfile` 默认为 `false`，只有桌面安装里的 CLI 会传 `true`：
`<asar>\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js` 的 `runDesktopCli` →
`runCli({ manageDesktopProfile: true, packageManager: { command: process.execPath, args: ['--expose-internals', …/pnpm/bin/pnpm.mjs], env: { ELECTRON_RUN_AS_NODE: '1' } } })`。
启动器 `<desktop cli>\dsh.cmd` 干的就是这件事：

```bat
@echo off
setlocal DisableDelayedExpansion
set "ELECTRON_RUN_AS_NODE=1"
"%~dp0..\..\..\..\DeepSeek Harness.exe" --expose-internals "%~dp0..\..\..\app.asar\dsh\node_modules\@deepseek-ai\dsh-desktop-host\lib\cli.js" %*
exit /b %errorlevel%
```

### 2. 必须把 `DSH_HOME` 指到便携版的数据根

`resolveDshHome()` 的优先级是「显式配置 > `$DSH_HOME` > `~/.dsh`」。不设的话去找 `C:\Users\<user>\.dsh\profiles\desktop\package.json`，
而便携版的数据根是 `<DSH_HOME>`，于是报：

```
dsh: Error: Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.
```

源码 `@deepseek-ai/dsh/lib/plugin-BiveYA7h.js`：

```js
function requireDesktopProfile(dir) {
  if (!existsSync(join(dir, "package.json"))) throw new Error("Open DeepSeek Harness Desktop once to initialize its profile, then fully quit it before running dsh plugin --profile desktop.");
}
```

设上就通了：

```powershell
$env:DSH_HOME = '<DSH_HOME>'
& '<desktop cli>\dsh.cmd' plugin --profile desktop list
```

```
Legend: production dependency, optional only, dev only

dsh-profile-desktop@0.1.0 <DSH_HOME>\profiles\desktop (PRIVATE)
│
│   dependencies:
├── <plugin-a>
├── <plugin-b>
├── …
└── <plugin-f>

6 packages
```

### 3. bundle patch 与手写 insert 会各插一份，不做去重

`applyEntryPatches()`（`@deepseek-ai/dsh-app-boot/lib/index.js:56-96`）对 `insert` 的处理就是 `data.push(...insert)`，
**按 id 去重只发生在 `buildMap()` 建索引时（后写覆盖索引），不发生在插入时**。
所以仓库里的 `cordis.patch.yml` 插一条、profile 的 `cordis.patch.yml` 手写一条，dump 出来就是两条同 id 的 `pwsh-run`：

```
pwsh-run 行数=2
  |- id: pwsh-run
  |  name: dsh-pwsh-plugin
  |    timeoutMs: 120000
  |- id: pwsh-run
  |  name: file:///D:/<workspace>/plugin/index.mjs?v=99
  |    timeoutMs: 999
```

两条都会被 mount（`applyEntryPatches` 只管插入，不去重），于是同一个插件实例化两次。
`@deepseek-ai/dsh-tools/lib/index.js:2634` 的同名注册是硬错误：

```js
this.tools = new NamedEntries((name) => new Error(scope === void 0
  ? `tool "${name}" is already registered (for a per-agent variant, register through that agent's agent.ctx instead)`
  : `tool "${name}" is already registered in this scope`));
```

> 这一条**是从源码推的，没有把重复 id 的 profile 真正 boot 起来验**（`_skt3` 启动后 20 秒无输出、按超时杀掉，
> `--dump-config` / `--dump-config-schema` 都 rc=0 —— 说明组合层不查重，冲突要等 mount 才爆）。

→ **装成 bundle 之后，把 profile 里手写的那条 `- id: pwsh-run` 删掉。**

### 实测过的安装命令

用临时 profile `_sktest` 演练了一遍（演练完 `SendToRecycleBin` 清掉）：

```powershell
$env:DSH_HOME = '<DSH_HOME>'
& '<portable>\dsh.exe' plugin --profile _sktest add 'file:D:/<workspace>'
```

```
dsh: initialized profile _sktest at <DSH_HOME>\profiles\_sktest
dependencies:
+ dsh-pwsh-plugin file:../../../../<workspace>
Done in 88ms using pnpm v12.15.0
```

生成的 `profile/package.json` 里 `dsh.profile.bundles` 自动多了 `dsh-pwsh-plugin`，
`--dump-config` 里也能看到 bundle patch 插进来的那一行：

```
# == dsh-pwsh-plugin
- id: pwsh-run
  name: dsh-pwsh-plugin
  config:
    pwshPath: pwsh
    timeoutMs: 120000
    idleMs: 1800000
    maxSessions: 4
```

注意 `file:` 后面的路径要写正斜杠（`file:D:/…`）——README 与本文都用这个形态，且实测可用。


---

## 二十一、bundle 切换与更新检查的闭环实测

第十九节讲了更新检查怎么设计，第二十节讲了安装入口怎么选。这一节是两者接上之后的真机结果 ——
从「手写 patch 行」换成「bundle 依赖」，以及用**装进 profile 的那份模块**（不是工作区副本）验证更新判决。

### 1. 切换前必须先删手写段

`applyEntryPatches()` 的 `insert` 分支只是 `data.push(...insert)`，不去重（第二十节第 3 小节）。
所以顺序是「先删手写 → 再装 bundle」，反了就会在合成树里留下两条 `- id: pwsh-run`。

删掉之后 profile 的 `cordis.patch.yml` 从 1779 行降到 **1753** 行，`grep pwsh-run` 只剩 skadi-route
`residentTools` 里那个工具名（第 823 / 825 行）—— 那是在说「晋升后别过滤掉它」，与注册无关。

### 2. `--dump-config` 对 `desktop` 也拒绝

第二十节记的是 `plugin list` 拒绝，实测 `--dump-config` 一样拒绝：

```
PS> & '<desktop cli>\dsh.cmd' --profile desktop --dump-config
error: profile "desktop" is managed exclusively by the Electron application
rc=1
```

`rejectElectronProfile` 挂在 profile 解析入口上，不是挂在 `plugin add` 上。
想验 patch 合法性就借一个临时 profile：装同一个 bundle、把 desktop 的 `cordis.patch.yml` 拷进去，
`--dump-config` 应给出 `rc=0` 与 `- id: pwsh-run` 计数 **1**。验完把临时 profile 送回收站。

### 3. 装进去的东西与工作区逐字节一致

`github:` 是拷贝（第二十节），所以值得核对一次 —— 五个承重文件 md5 全同：

| 文件 | md5 前 8 位 |
|---|---|
| `plugin/index.mjs` | `E5B3E41A` |
| `plugin/session.mjs` | `A2ACF1A7` |
| `plugin/session-server.ps1` | `46ED2221` |
| `cordis.patch.yml` | `30666D67` |
| `package.json` | `71426A25` |

装完本会话就能用（工具面 390 个，`pwsh_run` 是可调函数），`$global:` 变量跨调用保留。

### 4. 更新检查：用装进 profile 的那份跑

工作区副本测过不等于线上那份对。直接 import
`file:///<DSH_HOME>/profiles/desktop/node_modules/dsh-pwsh-plugin/plugin/update-check.mjs`：

```
new UpdateChecker()                      → 从包自己的 package.json 读到 0.1.1
check()                                  → 217–330 ms → {"state":"current","latest":"v0.1.1"}
```

再把候选标签喂给纯函数，验判决边界：

| 输入标签 | 判决 |
|---|---|
| `v0.1.0 v0.1.1 v0.2.0 v0.2.0-rc.1 nonsense` | `{"state":"available","latest":"v0.2.0"}`，spec = `github:citydirector/dsh-pwsh-plugin#v0.2.0` |
| 只有 `v0.1.0`（当前 0.1.1） | `{"state":"current","latest":"v0.1.0"}`，不误报 |

预发布 `v0.2.0-rc.1` 与非 `vX.Y.Z` 的标签都被跳过 —— 这是标签契约在起作用，不是巧合。

### 5. 真闭环：装旧版，让它自己查到新版

上面的判决是喂标签进去验的。真正想确认的是「**线上真有一个更新的版本时，装着的旧版会怎么说**」。
做法不是模拟，而是真装旧版：

```powershell
& $dsh plugin --profile desktop add 'github:citydirector/dsh-pwsh-plugin#v0.1.0'   # 2.1s → 0.1.0
```

然后 import 装进 profile 的那份 `update-check.mjs`（此时它是 v0.1.0 的代码）：

```
installed version : 0.1.0
check             : {"state":"available","latest":"v0.1.1", …}  317 ms
document          : {…, "running":"0.1.0", "spec":"github:citydirector/dsh-pwsh-plugin#v0.1.1"}
announce          : {"latest":"v0.1.1","spec":"github:citydirector/dsh-pwsh-plugin#v0.1.1"}
announce again    : undefined
```

三件事一次确认：查询命中真远端、给出的 spec 正好是能直接装的那条、`announce` 只吐一次（不会每次调用都刷）。
验完升回 `v0.1.1`，`package.json` 里的依赖行也随之回到 `#v0.1.1`。

> 这一步也顺带暴露了一个测试问题：`updatetest` 原本写死断言 `packageVersion() === '0.1.0'`，
> 版本一升就红。已改成「等于 `package.json` 声明的版本」+「三段版本号」两条（51 → 52 项）。

### 6. 版本推进

文档与示例 tag 必须一起动，否则照抄 README 装到旧版：`0.1.0` → `0.1.1`（`package.json` + 中英 README 的
安装示例 `#v0.1.1`），提交 `2c7543a`，annotated tag `v0.1.1` → `8a50a40`，main 与 tag 都已推送；
desktop profile 的依赖行同步为 `#v0.1.1`，重装后 `node_modules` 里的 `package.json` 读回 0.1.1。

### 7. bundle 模式改代码必须重启（已由缓存实验钉死）

第二十节说 bundle 行的 `name` 必须是包名、带不了 `?v=N`。这条**代价**原来是推断，现在实测过了。

做法：取 `require.resolve('dsh-pwsh-plugin')` 得到的真实 URL（`file:///<DSH_HOME>/profiles/desktop/node_modules/dsh-pwsh-plugin/plugin/index.mjs`），
同一进程里按顺序 import 三次，中间把文件里的 `export const name` 改掉：

| 步骤 | 结果 |
|---|---|
| 1. 普通 import | `pwsh-run` |
| 2. 改文件后用**同一个 URL** 再 import | `pwsh-run`，且返回的是**同一个模块对象**（`same === true`）|
| 3. 改文件后用 `<url>?v=bust` import | `PATCHED` —— 新 URL 才绕过缓存 |

结论：ESM 按 URL 缓存，磁盘上文件换了、URL 没换，进程里还是旧模块。
bundle 模式给不出新 URL，所以 `dsh plugin add …#vX.Y.Z` 装新版本之后（或本地 `file:` 硬链接改了之后），
**必须重启 DSH** 才会加载新代码 —— 这一点与手写 `file:` 行 + `?v=N` 的老手法正相反。

同一实验也顺手确认了恢复路径：把文件写回原内容后，五个承重文件（`plugin/index.mjs`、`session.mjs`、
`session-server.ps1`、`package.json`、`cordis.patch.yml`）与工作区 md5 全同。

## 二十二、llrun 候选探测与两种「非本机」环境（2026-10-24）

### 1. 默认路径改候选探测，且探测脚本必须走 stdin

原来 `wsl/custom-bash.mjs` 把 `DEFAULT_LLRUN_PATH` 写死成一个路径，且 docs 教人装到另外两个位置，
新用户第一条 `bash` 调用就会 fail-closed。现在按 `$LLRUN` / `$DSH_LLRUN` → `<DSH_HOME>/bin/llrun` →
`/usr/local/bin/llrun` → `~/.local/bin/llrun` 探测第一个可执行的，结果跨调用缓存（失败不缓存，装好即生效）。

落地时撞上一个**真坑**：探测脚本最初走 `bash -c <script>`，一直算出错误的候选序号。隔离实验：

| 写在 `bash -c` 正文里 | 期望 | WSL 垫片 `bash.exe` 实得 |
|---|---|---|
| `x=abc; echo "x=$x"` | `x=abc` | **`x=`**（赋值整个被吃掉）|
| `i=0; i=$((i+1)); echo "i=$i"` | `i=1` | **`i=`** |
| `echo "sub=$(echo hi)"` | `sub=hi` | `sub=hi`（命令替换正常）|
| `if [ -x "<path>" ]; then exit 1; fi; exit 0` | 1 | 1（控制流正常）|

`C:\Windows\System32\bash.exe`（WSL 垫片）会改写 `-c` 的正文，原生 Linux `/bin/bash` 不会。
同一层还有另一个症状：`bash -c 'echo "$@"' name a b` 在垫片下 `$@` 为空。

**结论：不要用 `bash -c` 给 WSL 传脚本，一律 `bash -s` + stdin。** 这正是主执行路径早就采用的手法
（头注释里记着「避开 bash.exe 的 argv 引号怪癖」），探测脚本只是漏用了。改成 stdin 后立刻正常。

探测结果只走退出码（0 = 全无，N = 第 N 个候选可执行），不读 stdout —— 收集缓冲区只在 stdio 声明为
collect 时才存在，不该把可用性押在它上面。

### 2. 「没有 WSL」：清晰失败，不是静默降级

`bashPath: 'C:/nonexistent/bash.exe'` 时 `apply()` 不抛错（可执行文件是惰性解析的），`bash` 工具照常注册；
真调一次才报 `subprocess-local: command "C:/nonexistent/bash.exe" is not an executable file`，
三种权限档一致。`pwsh_run` 本体全程不碰 WSL。

### 3.「UAC 正常」：决定因素是 DACL 的两条权限位，不是属主

本机 UAC 关闭（`EnableLUA = 0`），进程带完整令牌。用 `runas /trustlevel:0x20000` 造受限令牌
（只剩 `SeChangeNotifyPrivilege`，等价于 UAC 开着的标准用户）做对照，三组目录各测一次 `confine`：

| 目录 | 属主 | DACL（当前用户） | 受限令牌下 confine |
|---|---|---|---|
| `<drive>:\_uac_case_fresh`（新建成）| 当前用户 | 继承 `Modify` | **THREW** `SetNamedSecurityInfoW failed (Win32 5): grantWrite(...)` |
| 同上 + `icacls /grant <user>:(OI)(CI)F` | 当前用户 | 全控制 | **OK**（`enforcement=partial`）|
| `C:\Users\<user>\<dir>`（用户目录下）| 当前用户 | 继承 `FullControl` | **OK** |

对照全令牌（本机现状）：三组都 OK，包括盘符根下只有 `Modify` 的目录 —— 完整令牌能自己改写 DACL，
受限令牌不能。这就是「本机能跑不代表开了 UAC 也能跑」的全部原因。

源码依据（`dsh-sandbox-windows-acl`）：`grantWrite` 用 `SetNamedSecurityInfoW(path, 1, 20, …)` 同时写
DACL 与 SACL（低完整性标签），注释原文：`The directory must be owned by the caller AND grant
WRITE_OWNER (the label lives in the SACL; owner-implicit rights cover only READ_CONTROL and WRITE_DAC)`。
实测细化一句：**属主不是硬条件**（`icacls` 授权后属主仍是当前用户、但已能通过），真正卡住的是
`WRITE_DAC` + `WRITE_OWNER` 两条 —— 全控制两样都有，`Modify` 两样都没有。

受限令牌下的端到端复验（真 `LocalSubprocessRuntime` + 真 `LocalSandboxProvider` + 真插件 `apply`，
workspace 取用户目录下的一个临时目录）：

| 断言 | 结果 |
|---|---|
| 工作区内 `Set-Content` 后读回 | `"IN"`，磁盘 `inside=true` |
| 盘符根下的 `<drive>:\_uac_out.txt` | `DENIED: UnauthorizedAccessException`，磁盘 `outside=false` |
| `$global:uacz` 跨调用 | `7` |
| `LanguageMode` | `FullLanguage` |

### 4. confine 失败给可操作的错误

原始错误只有一句 `SetNamedSecurityInfoW failed (Win32 5): grantWrite(<path>)`，看不出该改哪个目录、
该给什么权限。`plugin/index.mjs` 现在把它翻成一段话：指出 workspace 根、说明需要 `WRITE_DAC` +
`WRITE_OWNER`（全控制满足）、给出 `icacls "<root>" /grant "%USERNAME%":(OI)(CI)F` 或换到用户目录下的目录。
`execute` 侧也不再套第二层 `pwsh_run could not start a session:` 前缀。
## 二十三、方案 D：bundle 自己接线，装完即用、卸载即还原（2026-10-25）

### 1. 为什么不是「改一份 shim 转发」（方案 C 被证伪）

方案 C 的设想是让 profile 里那份 `presets/shared/custom-bash.mjs` 改成一行 `export * from`，指向包内实现。
在全新 profile `_skc1` 里实测（`dsh plugin --profile _skc1 add 'github:citydirector/dsh-pwsh-plugin#v0.1.3'`）：

| 检查项 | 结果 |
|---|---|
| profile 目录内容 | `.plugin-manager` `node_modules` `cordis.patch.yml` `package.json` `pnpm-lock.yaml` `pnpm-workspace.yaml` |
| `presets/` 是否存在 | **False** |
| 该 profile patch 里 `custom-bash` 计数 | **0** |

→ `presets/shared/custom-bash.mjs` 只是本机预设（skadi / skadi-route / skadi-ptc）的私有物，不是 DSH 的通用组件。
方案 C 只对本机有效，换个用户就无从下手，达不到「别人不用麻烦」。

### 2. 方案 D：让 bundle 的 patch 自己插这一行

关键机制在 `dsh-app-boot/lib/index.js:3537`：

```js
function anchorInsertedPluginNames(patches, file) {
  const base = dirname(resolve(file));
  const visit = (entry) => {
    if (typeof entry.name === 'string' && (isAbsolute(entry.name) || entry.name.startsWith('./') || entry.name.startsWith('../')))
      entry.name = pathToFileURL(resolve(base, entry.name)).href;
    if (entry.group && Array.isArray(entry.config)) entry.config.forEach(visit);
  };
  for (const patch of patches) patch.insert?.forEach(visit);
  return patches;
}
```

`parsePatchList` 末尾 `return anchorInsertedPluginNames(parsed, file)`（index.js:3569），bundle 与用户 patch 走同一条路。
**`./` 相对名按 patch 文件所在目录改写**，所以写在包根 patch 里的 `./wsl/custom-bash.mjs` 会落进
`<profile>/node_modules/dsh-pwsh-plugin/wsl/`。

但这里有一个反直觉的取舍：**不要用 `./`**。它会被改写成绝对 `file://` URL 并抄进合成后的配置树，
等于把安装路径钉死 —— 便携版挪一次目录、或换一台机器，那行就废。改用**裸子路径**：

```yaml
- id: custom-bash
  name: dsh-pwsh-plugin/wsl/custom-bash.mjs
  disabled: !!js process.platform !== 'win32'
```

裸子路径不进改写分支，每次 boot 都从 profile 的 `node_modules` 重新解析。代价是
`package.json` 的 `exports` 必须加上 `"./wsl/custom-bash.mjs": "./wsl/custom-bash.mjs"`，否则
`ERR_PACKAGE_PATH_NOT_EXPORTED`。`wsl/llrun` 本身不需要导出 —— 插件靠 `import.meta.url` 找它。

### 3. 三个必须踩对的细节

**不要在 patch 里顺手禁用 `tool-bash`。** `dsh-base/cordis.patch.yml:269` 的 `tool-bash` 本来就带
`disabled: !!js process.platform === 'win32'`，我们这行只在 win32 启用，两边已经互斥。
再写一条 `- id: tool-bash / disabled: true` 会把 Linux 上的官方 bash 一起关掉。

**llrun 必须跟着包走。** 原来的候选全在系统目录（`$LLRUN` / `<DSH_HOME>/bin/llrun` /
`/usr/local/bin/llrun` / `~/.local/bin/llrun`），新用户一个都没有，装上就是 fail-closed。
现在末尾追加包内那份（`import.meta.url` → `toWslPath` → `<pkg>/wsl/llrun`），顺序是
「用户装的在前，包内只保证开箱可用」：

```js
function packagedLlrunPath() {
  try {
    // 目录 URL 带尾分隔符，去掉再转，免得拼出双斜杠。
    return toWslPath(fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, ''))
  } catch {
    return undefined
  }
}
```

**llrun 在 git 里丢了可执行位。** `git ls-files -s wsl/llrun` 原本是 `100644`。本机侥幸能跑纯属 9p 挂载的
功劳（`/proc/mounts`: `9p rw,noatime,aname=drvfs;path=D:\;uid=1000;...`，Windows 侧一律给 `rwxrwxrwx`）；
在 ext4 上模拟 clone（`chmod 644`）→ 探测 `test -x` 失败 → fail-closed。用
`git update-index --chmod=+x wsl/llrun` 改成 `100755`（`core.filemode false` 时只改索引）。

### 4. 反证实验：负向用例为什么一开始没抓到

把 `wsl/llrun` 临时改名后跑负向探针，结果是 `UNEXPECTED: ran` —— 因为本机
`/home/<user>/.local/bin/llrun` 真实存在，探测命中了它。捕获探测脚本的 stdin 才看清候选顺序。
把 `HOME` 指到空目录后才真正走到包内那份（`RESULT: "PACKAGED-ONLY-HOME"`）。
`test/bashtest.mjs` 的 `llrun-packaged-candidate` 因此必须同时挪开 `HOME`。

### 5. 装卸演练（临时 profile `_skx` / `_sky`，均已进回收站）

`_skx`（干净 profile，`add 'file:<检出>'`）：

| 检查项 | 结果 |
|---|---|
| `--dump-config` | rc=0，`- id: pwsh-run` **1 条**、`- id: custom-bash` **1 条** |
| `custom-bash` 的 name 渲染 | `dsh-pwsh-plugin/wsl/custom-bash.mjs`（裸子路径不被改写，符合预期） |
| 解析与实际加载 | `resolve` → 包内真实路径；`import` → `name=custom-bash inject=["subprocess","tools"]` |
| 卸载后 `--dump-config` | `pwsh-run` 与 `custom-bash` **各 0 条** |
| 卸载后 `node_modules/dsh-pwsh-plugin` | 不存在 |
| 卸载后 `pnpm-lock.yaml` 命中 | **0** |
| 卸载后 profile `cordis.patch.yml` | 仍是初始的 `[]`（从未被写过） |

**卸载完美还原成立。**

`_sky`（克隆 desktop 的 patch + `presets/` 后再装 bundle）：`id: custom-bash` 共 **4 条**（1 条 bundle + 3 条手写）。
patch 层不去重（`applyEntryPatches` 的 insert 分支就是 `data.push(...insert)`），boot 时同名注册是硬错误
→ **本机 desktop 直接装会撞双行陷阱，必须先删那三处手写行。**

那三处已在 2026-10-25 删掉（`profiles/desktop/cordis.patch.yml` 1769 → 1736 行），删后
`grep 'id: custom-bash'` 在该文件里为 **0**，`pwsh-run` 也只剩 bundle 那一条。
另一件事：三处手写在三个不同预设的 realm 里，删之前真 boot 20 秒 stderr 里 `already registered`
命中 **0** —— `dsh-tools/lib/index.js:2874` 的注释说明硬错误只发生在同一层，跨 realm 同名注册是允许的。
所以「双行陷阱」精确地说只发生在**同 scope 的 bundle 行与手写行**之间。

### 6. 参数顺序坑（再记一次）

`dsh plugin --profile X --dump-config` → `[ERROR] Unknown option: 'dump-config'`，rc=1。
必须写成 `dsh.cmd --profile X --dump-config`，`--dump-config` 在 `plugin` 之外。




## 二十四、子进程与协议流：两个真实事故（2026-10-25）

### 1. 事故一：一句 `<<<BYE>>>` 就能杀掉会话

服务端原本只用 `Console::SetIn/SetOut/SetError` 把 .NET 层的三个流换掉。**Win32 的 std handle 槽位没有动**，
新起的子进程从槽位继承的仍是那条协议管道。

实测（脚本里放一句 `Start-Process pwsh.exe -Command 'Write-Output (<<<BYE>>> 的字符拼接)'`）：
`pwsh_run` 当场返回 `[Error: session said BYE; a new session starts on the next call]`，连续三次全中。
反向也成立：子进程 `[Console]::In.ReadLine()` 能读走客户端发来的协议行，读到的是**真实请求**。

有意思的是普通 `cmd /c echo` 与 node 的 `console.log` 反而不漏 —— 它们写的是继承来的 stdout 句柄本身；
而 PowerShell 的调用运算符与 `Start-Process` 在不重定向时会先建管道，管道两端都还挂在协议流上。

**修法**：拿到协议流后改写三个槽位 —— stdin 接 `NUL`；stdout / stderr 接一个
`FILE_FLAG_DELETE_ON_CLOSE` 的临时文件，每次调用前 `SetFilePointer(0)` + `SetEndOfFile` 截回零。

**为什么 stdout 不能接 `NUL`**（这一步踩过）：`NUL` 是字符设备（`GetFileType` = 2），PowerShell 据此判定
「输出没有被重定向」，于是 `& exe` 的报错从

    Program 'node.exe' failed to run: 拒绝访问。

变成

    Program 'node.exe' failed to run: StandardOutputEncoding is only supported when standard output is redirected.

沙箱边界最有用的那条诊断信息就没了。磁盘句柄（`GetFileType` = 1）三种场景下文案都不变，实测
P0/P1/P2 三档（未接管 / 只换 stdout / 再换 stdin）完全一致。

**验证**（文件式 stdin/stdout 驱动改造后的服务端）：协议流只剩 `O:UFJF` / `O:UE9TVA==` / `S:b2s=` 三行，
伪造行消失；偷 stdin 的孙子进程拿到 `CHILD-SAW-EOF`。

**降级**：临时目录不可写时退回 `NUL`（协议流仍然干净，只是报错文案变成重定向那一句）；
接管失败时把原因写进 `$TakeoverNote`，随**第一次调用**以 `W:` 行交付一次，然后清空 —— 挂在每次调用上只是噪音。

### 2. 事故二：`& exe` 被拒时的报错看不出是沙箱

workspace-write 会话里 `& node --version` 报 `Program 'node.exe' failed to run: 拒绝访问。`。
根因（P/Invoke 实测）是受限令牌 = Low 完整性 + `WRITE_RESTRICTED`，**建不了匿名管道**：
`CreatePipe`（带不带 `SECURITY_ATTRIBUTES` 都一样）→ `ok=False err=5`，
`[IO.Pipes.AnonymousPipeServerStream]::new` → access denied。命名管道反而能建，但 node 的 `stdio:'pipe'`
走的是匿名管道，一样 `EPERM`。

所以凡是「捕获子进程 stdio」的起法全失，`& exe` 也在其中（调用运算符内部要建管道）。
三条实测可用的绕法：`Start-Process -RedirectStandardOutput/-RedirectStandardError <文件>`（拿得到输出、
拿不到退出码）、`[Diagnostics.Process]::Start`（`UseShellExecute=$false`、不重定向，拿得到退出码但子进程
继承 stdout）、`.cmd` 包装器（stdout / stderr / `%ERRORLEVEL%` 各写一个文件，两样都拿得到）。

原始报错只说明「起不来」，看不出这是沙箱边界。现在 `describeExecDenial()` 识别
`failed to run` + `拒绝访问|Access is denied|StandardOutputEncoding is only supported`，在输出末尾附上说明，
并点明「不要在不重定向的情况下让子进程继承 stdout」。

误报同样要防：`Cannot find path`、只有前半句的 `failed to run: 找不到文件。`、空串都不触发。
`test/denialtest.mjs` 用 11 项钉住识别与不识别两侧 —— 它**不起任何子进程**，所以在连 spawn 都 EPERM 的
会话里照样能跑。

**这一节后来被推翻了两处**（详见第二十五节）：三条绕法里只有 `.cmd` 那条与
`[Diagnostics.Process]::Start` 在 `pwsh_run` 会话里真的可用；而且第一道门 `/failed to run/` 在真实路径上
从不命中 —— 服务端把异常剥到最内层才交付。

### 3. 两个环境的报错文案不同，原因在 `Console.OutputEncoding`

同一条 `& '...\git.exe' --version`，在原生 `pwsh` 工具里报「拒绝访问」，在 `pwsh_run` 会话里报
「StandardOutputEncoding is only supported when standard output is redirected」。差异不在沙箱，而在编码：

| 环境 | `[Console]::OutputEncoding` | 报错文案 |
|---|---|---|
| 原生 `pwsh` 工具 | `utf-8` | `failed to run: 拒绝访问。` |
| `pwsh_run` 会话 | `gb2312`（取系统 ANSI 代码页）| `failed to run: StandardOutputEncoding is only supported when standard output is redirected.` |

PowerShell 在重定向场景下要把子进程输出按 `Console.OutputEncoding` 解码，非 UTF-8 时先撞上自己的编码检查，
于是沙箱那句「拒绝访问」还没轮到就抛了。手动 `[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)`
后文案**变回**「拒绝访问」，但子进程照样起不来 —— 两种文案都指向同一个边界。
所以 `describeExecDenial` 两条都要认。

四档对照实验（`probe-mode.ps1`，M0 基线 / M1 仅 `Console::SetOut` / M2 再加磁盘槽位 / M3 换成 `NUL` 槽位）
在**管道式**与**文件式** stdout 下各跑一遍，结论一致：`& exe` 的成败**只取决于令牌能不能建匿名管道**，
与 .NET 层的 `SetOut`、与 Win32 槽位的句柄类型（`GetFileType` 3=管道 / 1=磁盘 / 2=字符设备）都无关。
唯一的区别是「把输出接进管道」这一种写法（`& exe ... | ForEach-Object`）文案会变成「拒绝访问」——
因为这条路径先走管道、再撞令牌。

## 二十五、可执行子进程被拒：从「提示」到「能装的包」（2026-10-25）

### 第一节那版提示在真实路径上从不触发

`describeExecDenial` 的第一道门原来是 `/failed to run/`。但服务端交付的根本不是这句：
`plugin/session-server.ps1:112-114 / 150-152 / 170-172` 三处都有

```powershell
while ($null -ne $__e.InnerException) { $__e = $__e.InnerException }
```

—— 异常被剥到**最内层**才交出去，于是 `& node --version` 交上来的是
`StandardOutputEncoding is only supported when standard output is redirected.`，
正则永远不命中。denialtest 的 9 个用例全用外层文案造样本，测试与实现一起错了。

改法（一处）：第一道门变成 `/failed to run|StandardOutputEncoding is only supported/`，
第二道门（`拒绝访问|Access is denied|StandardOutputEncoding…`）不动。denialtest 补 2 项
「内层编码文案命中」与「只有拒绝访问、没有编码线索时不触发（太泛）」，9 → 11 项。

### 提示里的走法必须真的在本机跑得通

19 组探针（`$env:TEMP\pr*_<guid>`，跑完即删）的结论：

| 走法 | 结果 |
|---|---|
| `Start-Process … -NoNewWindow -PassThru -Wait -RedirectStandardOutput o -RedirectStandardError e` | 输出拿到了（`out=v24.22.1`），`.ExitCode` 恒为空，`Refresh()` 也救不回来 |
| 同上**不加** `-NoNewWindow` | `$p` 是 `$null` → `You cannot call a method on a null-valued expression.` |
| `[Diagnostics.Process]::Start` 带 `CreateNoWindow=$true` | rc=`-1073741502` = `0xC0000142` `STATUS_DLL_INIT_FAILED`，**弹模态错误框** |
| `[Diagnostics.Process]::Start` 不设 `CreateNoWindow`、`UseShellExecute=$false` | rc 正确（`cmd /c exit 9` → 9） |
| 同上但 `RedirectStandardOutput=$true` | `拒绝访问。`（受限令牌建不了匿名管道） |
| **`cmd.exe /c "<exe> <args> > out 2> err"`** | **rc 与输出全对**：`node --version` → rc=0 / `v24.22.1`；`node --nonsense` → rc=9 / `node: bad option: --nonsense` |

所以提示改成两条可用走法 + 两条禁止。禁止那条尤其重要：`CreateNoWindow=$true` 会弹
`0xC0000142` 模态框，用户在别的窗口干活时会被打断。

### `pwsh_run_update`

`action` 只有 `check` 与 `install`。`install` 走 `pluginManager.installBundle(spec, { requestId })`；
返回 `failed` / `cancelled` 时把 `error.code` 与 `error.diagnostic` 原样带出，并附一行手装命令；
`threw` 只覆盖「拿不到 profile 锁 / 服务销毁」两种。

一个容易写错的分支：`state === 'failed'`（源不可达）不能落进「已是最新」那一句。
实测把源指到不存在的路径，旧写法输出的是
`state: failed` + `No newer release.` —— 自相矛盾。改后输出
`Could not reach the release source, so whether a newer version exists is unknown.`
并且这条分支上 `doc.spec` 是 `undefined`，只能给模板而不是插值。



## 二十六、接管句柄必须是可继承的（2026-10-25）

第二十四节那版接管（`CreateFileW` 传 `IntPtr.Zero` 作安全属性）只解决了一半问题：
协议流干净了，但交接给子进程的句柄**在子进程里根本不存在**。

### 现象

`test/itest.mjs` 的 `child-stdio-detached` 用例十二连跑会红一次：

    FAIL child-stdio-detached :: sentinel=ok out=["POST"] stole=CHILD-STOLE:MZ?  ?@  € ????L?This program cannot be run in DOS mode.

`stole` 里是一个**PE 可执行头**。子进程读继承来的 stdin，读到的不是 EOF，而是别的对象的字节。

### 探针结论（真实会话内，`Start-Process` 起子 pwsh 各 20–40 次）

| 项目 | 旧写法（`NULL` 安全属性） | 新写法（`bInheritHandle = true`） |
|---|---|---|
| 父进程 `GetStdHandle(-10)` | `1448`，`GetFileType` = 2（字符设备）| 同左 |
| 子进程 `GetStdHandle(-10)` | `1448`（**同一个编号**），`GetFileType` = **0（UNKNOWN）** | 同一个合法句柄，`GetFileType` = 2 |
| 子进程 `GetHandleInformation` | `ok=True`，`flags=0`（inherit 位没置）| `ok=True`，`flags=1` |
| 子进程读 stdin | 20 次里 **19 次 0 字节、1 次 1 字节** | 30 次、40 次全 0 |

`GetFileType` 返回 `UNKNOWN` 是关键证据：句柄号在子进程里指向不到对象。Windows 只在
`bInheritHandle` 为真时才把句柄复制进子进程的句柄表；用 `NULL` 安全属性建的句柄不可继承，
于是子进程按 `STARTUPINFO.hStdInput` 拿到的是一个**悬空编号**，偶尔这个编号被别的对象（这里是某个
已映射的可执行映像）复用，读出来就是别人的字节。

### 两个 PowerShell 侧的坑（都让第一版改法直接报错）

1. **`Marshal.SizeOf([type]'X+Y')` 会绑到 `SizeOf(object)` 重载**：
   `Type 'System.RuntimeType' cannot be marshaled as an unmanaged structure; no meaningful size or offset can be computed.`
   改法是把尺寸算在 C# 里：`public static int SecurityAttributesSize { get { return Marshal.SizeOf(typeof(SecurityAttributes)); } }`。
2. **`Add-Type -PassThru` 返回的是类型数组**，`$K = Add-Type … -PassThru` 之后 `$K::CreateFileW` 报
   `[System.Object[]] does not contain a method named 'CreateFileW'`。改成 `$null = Add-Type …` 再按名字取 `[PwshRunStdio]`。
   这两处失败都不会让会话起不来 —— 接管段整体在 `try/catch` 里，只会在第一次调用时发一条 `W:` 警告。

### 钉住

`test/itest.mjs` 新增第 2 项 `std-handles-takeover`：起会话后第一次调用必须 `sentinel=ok` 且 **`warn` 为空**。
它比 `child-stdio-detached` 更直接 —— 接管本身失败时立刻红，而不是等到那个万分之一的句柄复用。
itest 15 → **16 项**，九份脚本合计 **162 项**。
