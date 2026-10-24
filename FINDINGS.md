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

`wsl/custom-bash.mjs` 是 profile 里 `presets/shared/custom-bash.mjs` 的源码副本。
两个改动：**命令改走 stdin**、**按 sandbox mode 分诊挂 llrun**。

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
| **从不自己装** | 页面把钉了 tag 的 spec 交给 DSH 的 `plugin_manager` | 输出末尾挂一行，让模型去调 `plugin_manager` |

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

2. **`plugin_manager` 工具**：`@deepseek-ai/dsh-plugin-manager` 的 `./tools` 入口，
   但 `dsh-base/cordis.patch.yml:15-17` 里 `tool-plugin-manager` 是 `disabled: true`，
   **本机 profile 没有覆盖它 —— 所以这个工具在当前会话里不存在**（`Object.keys(tools).filter(/plugin/i)` 为空）。
   要用得先在 profile patch 里把它打开，并且它自己会走 `approveEscalation({requestedMode:'danger-full-access', …})`，
   等于每次装插件都要过一次 `danger-full-access` 审批。

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

`test/updatetest.mjs`（51 项）不联外网：发布源用 `mkdtempSync` 建的真 git 仓库 +
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

