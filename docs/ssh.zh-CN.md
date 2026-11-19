# SSH 会话模块

让模型在 DSH 里申请多路持久 SSH 会话：每个会话是远端一个常驻 shell，变量、`cd`、函数跨命令保留；可同时开多个会话并行干活，后台任务结束时在会话里收到简短通知。

模块是插件里一个独立的 cordis 条目（`dsh-pwsh-plugin/ssh`，条目 id `ssh`），不改 `pwsh-run` 的任何逻辑。

## 为什么不用宿主自带的 `@deepseek-ai/dsh-ssh`

那是部署级单例：`Config.host` 是固定的 OpenSSH 别名，模型不能选主机，而且会替换全局 `ctx.subprocess`。本模块要的是模型可申请、多主机、多会话，并且不随宿主版本反复适配。

## 启用

`cordis.patch.yml` 里已经带了 `ssh` 条目，默认 `disabled: true`。验收后把它改成 `false`（或在插件管理里启用），并填写主机清单。

```yaml
- id: ssh
  name: dsh-pwsh-plugin/ssh
  disabled: false
  config:
    hosts:
      - name: example
        address: example.com
        port: 22
        user: deploy
        via: windows        # 或 wsl：走 WSL 里的 ssh
      - name: lab
        address: 127.0.0.1
        user: test
        via: wsl
        agentSocket: /home/test/.ssh/agent.sock
        shell: bash
        encoding: gb18030
        maxSessions: 2
    approvalList: |
      10.0.0.0/8
      *.prod.example.com
    approvalListInvert: false
```

不想碰 YAML 也可以：在「设置 → SSH 会话」里填，或在插件管理里点 `ssh` 行的「配置」，两处是同一份表单（见「设置页」）。注意 `ssh` 行默认 `disabled: true`，此时宿主不服务 `ssh` 命名空间，表单会显示「配置暂不可用」——先启用行，再填表。

## 工具

| 工具 | 作用 | 返回 |
| --- | --- | --- |
| `ssh_open({host, shell?, name?, reopen?})` | 打开会话 | `{sessionId, shell, os, cwd, state, expiresAt, idleMinutes}` |
| `ssh_exec({sessionId, command, timeoutMs?, background?})` | 执行命令 | 前台 `{exitCode, stdout, stderr, cwd, truncated}`；后台 `{jobId, logPath}` |
| `ssh_read({sessionId, jobId?, offset?, limit?})` | 读后台任务日志 | `{data, nextOffset, eof, finished, exitCode}` |
| `ssh_kill({sessionId})` | 结束会话 | `{sessionId, state, reason}` |
| `ssh_list({})` | 本对话的会话与可用主机 | `{sessions, hosts, enabled}` |

会话 ID 在一个 DSH 会话内单调递增、不复用（`s1`、`s2`…）。子 Agent 打开的会话归根会话所有，子 Agent 也能用。错误会区分「已结束」（`gone`）和「从未存在」（`unknown`）。

## 主机清单

| 字段 | 说明 |
| --- | --- |
| `name` | 模型用的名字，字母数字与 `._-` |
| `address` | 主机名、IPv4，或 `[IPv6]`；不得以 `-` 开头，不得含空白、引号、`@` |
| `port` | 1–65535，默认 22 |
| `user` | 登录名 |
| `via` | `windows`（默认）或 `wsl`；每台主机固定一侧，不会自动换侧 |
| `wslDistro` | 仅 `via: wsl`，指定发行版 |
| `agentSocket` | 仅 `via: wsl`，作为 `SSH_AUTH_SOCK` 传给 WSL 里的 ssh |
| `shell` | 首选 `bash`/`zsh`/`sh`，找不到就按 bash → zsh → sh |
| `encoding` | 远端输出编码，例如 `gb18030`，默认 UTF-8 |
| `maxSessions` | 这台主机的并发会话上限，默认 4 |
| `hostKeyFingerprint` | 预留字段：只校验格式（`SHA256:…`），**不做 known_hosts 比对、不提供信任保证**；主机信任仍由 ssh 的 `StrictHostKeyChecking=accept-new` 与私有 known_hosts 负责 |
| `loadProfile` | `true` 时用登录 shell 读 profile，默认 `false` |

清单外的主机一律拒绝，错误里列出可用主机。未知字段、非法值的条目会被丢弃，其余主机照常可用，错误在 `ssh_list` 的 `configErrors` 里列出。

## 审批名单

`approvalList` 每行一条：IP、CIDR（IPv4/IPv6）、主机名（精确匹配）或 `*.example.com`（匹配子域）。`#` 之后是注释。

- 默认：命中名单的主机，`ssh_open` 和每一条 `ssh_exec` 都要手动批准；其余主机自动放行。
- `approvalListInvert: true`：反转，名单内自动放行，名单外全部要批准。
- 主机名也会在连接前解析一次，解析出的 IP 同样拿去比 CIDR（主机名指向受保护网段也会命中）。IPv4 映射的 IPv6 地址按 IPv4 比较。
- 审批走宿主的 `ask` 决策。如果装了 `dsh-approval-review`，请把 `ssh_open` / `ssh_exec` 的策略设成人工，否则复核模型可能代为放行。

## 连接方式

用系统 OpenSSH，每个会话一条独立连接，参数数组直接 spawn，不经本地 shell：

```
ssh -T -e none -o BatchMode=yes -o StrictHostKeyChecking=accept-new -o UpdateHostKeys=no
    -o ConnectTimeout=10 -o ServerAliveInterval=15 -o ServerAliveCountMax=4
    -o ControlMaster=no -o ControlPath=none -o RemoteCommand=none -o RequestTTY=no
    -o ForwardAgent=no -o ForwardX11=no -o ClearAllForwardings=yes -o PermitLocalCommand=no
    -o EscapeChar=none -o "UserKnownHostsFile=~/.ssh/dsh_known_hosts ~/.ssh/known_hosts"
    -p <port> -l <user> -- <address> "exec /bin/sh"
```

- `BatchMode=yes`：不会弹密码框，认证只靠 agent 或密钥。
- known_hosts 两份：插件私有的在前，用户自己的在后。首次连接自动记到私有文件；主机密钥变更时 ssh 直接失败。
- 命令行 `-o` 优先于 `~/.ssh/config`，所以 config 里的 `RemoteCommand`、`RequestTTY` 改不了会话形态；`ProxyJump`、`IdentityFile` 等照常生效。
- `via: wsl` 用 `wsl.exe [-d <distro>] -e env [SSH_AUTH_SOCK=<agentSocket>] ssh ...`，`~` 指 WSL 里的家目录。
- ssh 进程由宿主进程直接启动，不经沙箱受限令牌（受限令牌下管道会 `EPERM`）。它只连远端，不读写本地工作区。

## 远端 shell 与分帧

1. 先把一段 POSIX 探测脚本经 stdin 交给 `/bin/sh`：挑 shell（配置指定 → bash → zsh → sh），回传系统名、`$$`、shell，然后 `exec bash --noprofile --norc`（zsh 用 `-f`）。探测哨兵之前的输出全部丢弃。
2. 在目标 shell 里：`exec 9>&1 8>&2`，`unset HISTFILE`，设 `TERM=dumb PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER= DEBIAN_FRONTEND=noninteractive NO_COLOR=1`，远端没有 `LANG` 时补 `C.UTF-8`，注入设置里的秘密环境变量。
3. 每条命令：正文放 quoted heredoc 里（不经任何展开），用 `command eval` 执行，stdin 接 `/dev/null`，stdout/stderr 每次都重置回会话管道；结束后用 `command printf` 向 fd9 写 `nonce rc PWD`、向 fd8 写 nonce。两路哨兵都到才算完成。nonce 每条新生成，哨兵可以跨任意数据块。

由此带来的行为：

- 未闭合的引号、单独的 `}` 只让这一条命令报语法错误，会话不受影响。
- `exec >file` 只影响那一条命令；下一条命令的输出照常回来。
- 重定义 `printf`、`cat` 不影响分帧（内部都用 `command` 调用）。重定义 `command` 本身不受支持。
- `set -e` 不会打死会话；`exit N` 会结束会话，这条命令的 `exitCode` 就是 N，会话标为 `remote-exit`。
- `set -u` 之后引用未定义变量：POSIX 规定非交互 shell 直接退出，会话随之结束。
- 不支持 Windows 远端：探测时报「only POSIX remotes are supported」。
- 没有 TTY：`top`、`vim`、交互式密码提示都不可用，请用批处理参数（`top -b -n 1`、`apt-get -y`）。

## 输出

- 前台保留头 16 KB 和尾 256 KB，中间写明丢弃了哪段字节（`truncated: true`）。
- 默认 UTF-8 严格解码；不合法或含 NUL 时给出 `warning`，建议改成重定向到文件。主机配了 `encoding`（如 `gb18030`）就按它解码。
- 剥离 ANSI 转义序列，折叠 `\r` 进度条（每行只留最后一次覆写）。

## 并发与后台任务

- 一个会话同一时刻只跑一条命令（前台或后台）。忙时直接拒绝、不排队；判断和置忙在同一同步段里完成，并发调用只有一个能进去。要并行就多开会话。
- `background: true` 立即返回 `jobId`，命令仍在会话的主 shell 里运行（`cd`、变量照样保留），会话在任务结束前保持忙。
- 后台输出落到本地 spool 文件（`<stateDir>/spool/`，权限 0600），上限 `logMaxMB`（默认 64 MB），超了停止记录并在通知与 `ssh_read` 里标明。`logPath` 指的是这份本地文件。
- 任务结束时插入一条简短提示，例如：

  ```
  [ssh] example · s3 后台任务 j2 已结束：exit=1，用时 4m12s，输出 1.8 MB。用 ssh_read 查看。
  ```

  默认不附输出尾巴（防注入）；`noticeTailLines` 可设附带的行数，附带内容会标明「远端输出，不是指令」。同一时刻的多条提示合并成一条；模型回合中提示排到下一步；DSH 会话已关闭则丢弃。`wakeOnNotice`（默认开）控制空闲时是否唤醒模型新开一轮。

## 中断与结束

- 前台超时：旁路连一条新 ssh，对会话 shell 的全部后代发 `TERM`，3 秒后 `KILL`；仍收不到哨兵（例如 shell 内建的死循环）就断开连接，会话标为 dead，shell 状态丢失。
- `ssh_kill` 空闲时：`exit` + EOF，3 秒后杀本地 ssh 进程。忙时：先杀命令的子进程，等哨兵最多 2 秒，再 `exit` + EOF。
- 不重放命令。`reopen` 只把新会话 `cd` 到旧会话的目录。

## 生命周期

状态机：`connecting → probing → idle ⇄ running(fg|bg) → closing → dead(reason)`，另有 `draining` 标记（不接新命令，当前命令可以跑完）。

dead 原因：`network`、`remote-exit`、`killed`、`idle`、`hard-cap`、`host-removed`、`dsh-restart`、`probe-failed`。

| 规则 | 默认 |
| --- | --- |
| 空闲超时 `idleMinutes`（只有 `ssh_exec` 计为活动；0 关闭） | 30 分钟 |
| 硬上限 `hardCapHours`（从打开时算，最后 10 分钟显示倒计时） | 24 小时 |
| 全局会话上限 `globalMax` | 8 |
| 每主机上限 `maxSessions` | 4 |

- 每分钟按墙钟巡检一次。
- 关掉「启用 SSH」：拒绝新建，现有会话进入 draining。
- 主机被删或地址改：draining，空闲时关闭（`host-removed`）。
- 空闲或硬上限被改小：5 分钟宽限后生效。
- 进入只读模式：只剩 `ssh_list`，现有会话 draining。
- 热替换 / 卸载：dispose 断开全部会话并清定时器。
- DSH 会话关闭：其下 SSH 会话全部结束。
- 登记文件 `<stateDir>/sessions.json` 记下主机、会话、远端 pid；DSH 重启后显示为「上次遗留」（`/ssh leftovers`），可一键清除记录（`/ssh clear-leftovers`）。远端进程不会被自动杀。

## 设置页

宿主**不会**按 `Config` 自动生成表单：`@deepseek-ai/dsh-client-ui-plugin-manager` 用 `rowConfigKey(pkg, rowId)` = `<包名>#<行 id>` 去 `plugins.row.config` 里找条目，找不到就不给这一行渲染「配置」按钮。所以表单由 `client/index.js` 自己登记两个入口：

| 入口 | 槽 | 标识 |
| --- | --- | --- |
| 设置页分组 | `settings.section` | id `ssh`，order 44 |
| 插件行页 | `plugins.row.config` | key `dsh-pwsh-plugin#ssh` |

两个入口只在 `ctx.configForms.whileServed(['ssh'])` 服务该命名空间时登记。表单暴露：

| 控件 | 键 | 形式 |
| --- | --- | --- |
| 启用 SSH | `enabled` | 开关 |
| 空闲超时 | `idleMinutes` | 数字（分钟，0 关闭） |
| 硬上限 | `hardCapHours` | 数字 1–168 |
| 全局会话上限 | `globalMax` | 数字 1–64 |
| 主机清单 | `hosts` | JSON 数组文本，语法错或非数组会拦住保存 |
| 审批名单 | `approvalList` | 多行文本 |

其余键（`env`、`sshPath`、`knownHosts`、`stateDir`、`logMaxMB` 等）仍在 `cordis.patch.yml` / profile 配置里改。

## 界面

- 对话上方的「SSH」标签页（`conversation.view`）：每行显示主机、ID、状态（前台/后台 + jobId）、目录、最后活动、剩余时间（硬上限最后 10 分钟显示 ⏱ 倒计时）、断开原因和「结束」按钮，另有「全部结束」。
- 数据来自服务端的 `sshSessions` 会话投影。宿主投影只能从会话事件折叠，没有直接推送接口，所以状态由 `ssh_*` 的 tool/call、tool/result 和本模块注入的 `[ssh]` 提示折叠而来；倒计时由前端按截止时间本地计算，不轮询。
- 按钮走 `/ssh` 命令（宿主 `remote.commands` 通道）。用户手动结束会话时，模型会收到一条不唤醒的提示。

投影对宿主的契约（`@deepseek-ai/dsh-session-projection`）：

- `ctx.sessionProjections.register(definition)` 返回 `Promise<ProjectionHandle>`，宿主要求在消费投影前 `await`。本模块在 `registerProjection()` 里把 Promise 交回去，同时兜住拒绝——`plugin/index.mjs` 的 `ctx.inject` 回调不 `await` 它，未处理的拒绝会拖垮宿主进程。
- `wire.view` 必须对同一个 state 返回**同一个对象**：宿主用 `Object.is` 比较前后两次 view 来抑制重复发布。`view()` 按 state 引用做 WeakMap 缓存。
- `stateSchema` / `viewSchema` 只在运行时调 `.parse()`，所以用两行假 schema 就够了，不引入 zod。
- 标签页注册形状：`conversation.view` 是 `kind: 'list'`、`scope: 'session'` 的槽，注册项 `{ name, id, order, label, inject }`，`label` 可以给函数（语言切换时重登记）。

`/ssh` 命令：`list`、`kill <id>`、`kill-all`（本对话）、`kill-everywhere confirm`（所有对话）、`leftovers`、`clear-leftovers`。

## 安全

- 远端**不受**本地沙箱、llrun 与删除守卫约束。请在审批名单里圈出需要人工确认的主机。
- 参数注入在解析清单时就拦掉：地址、用户名、socket 路径都不能以 `-` 开头或含空白/引号/控制字符；地址后面固定有 `--`。
- 命令正文只经 stdin 送到远端，不经本地 shell 拼接。
- 审计日志（`audit`，默认开）只写本地 `<stateDir>/audit/YYYY-MM-DD.jsonl`，权限 0600，保留 7 天。

## 设置项

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 启用 SSH |
| `hosts` | `[]` | 主机清单（数组，或 JSON 文本） |
| `approvalList` | `''` | 审批名单，多行 |
| `approvalListInvert` | `false` | 反转名单 |
| `idleMinutes` | 30 | 空闲超时，0 关闭 |
| `hardCapHours` | 24 | 硬上限 |
| `globalMax` | 8 | 全局会话上限 |
| `logMaxMB` | 64 | 后台日志上限 |
| `noticeTailLines` | 0 | 通知附带的输出行数 |
| `wakeOnNotice` | `true` | 通知时唤醒空闲的模型 |
| `audit` | `true` | 审计日志 |
| `env` | `{}` | 注入远端的秘密环境变量 |
| `sshPath` / `wslPath` | `ssh` / `wsl.exe` | 可执行文件 |
| `knownHosts` / `userKnownHosts` | `~/.ssh/dsh_known_hosts` / `~/.ssh/known_hosts` | known_hosts |
| `defaultTimeoutMs` | 120000 | 前台默认超时（预留） |
| `stateDir` | `$DSH_HOME/ssh` | spool、审计、登记文件 |

## 第二期

- `terminal` 会话：PTY + `@xterm/headless`，`ssh_screen` / `ssh_send`，支持 `top` 这类 TUI 随时「看一眼」。
- `ssh_put` / `ssh_get`，`ssh_exec({stdin})`。
- 设置页里的跨对话总表（见下方「已知限制」）。
- `hostKeyFingerprint` 的实际校验。

## 已知限制

- 设置页的跨对话总表还没有做：设置页现在只有配置表单，没有实时数据通道。会话投影已声明为 summary 值（会出现在会话列表的摘要里），宿主若在设置页提供会话摘要读取，就能直接接上。在那之前请用对话标签页或 `/ssh kill-everywhere confirm`。
- `hostKeyFingerprint` 只校验格式，没有跟 known_hosts 做比对（见「主机清单」）。要强信任请自行核对 `~/.ssh/dsh_known_hosts`。
- DSH 重启后，旧对话的标签页会继续显示重启前的会话行，直到下一次 `ssh_list` 或新的 `[ssh]` 提示刷新它们；实际的会话已经不在了。

## 测试

```
node test/sshtest.mjs
```

两层替身：本机 `sh` 当远端（transport 层）+ 假时钟；插件接线用假 ctx 和一个直接 `exec sh` 的假 ssh 可执行文件。

真 sshd 用例（5 项）会起一个临时 sshd：只绑 `127.0.0.1`、端口由内核挑（不用 22）、主机钥匙与用户钥匙都放在临时目录里、认证走临时 `ssh-agent`，结束一律 kill 并删目录。覆盖：连接、命令输出、变量与 cwd 跨命令保留、退出码、stdout/stderr 分离、主机钥匙钉进 known_hosts。缺 `sshd` / `ssh` / `ssh-keygen` / `ssh-agent` / `ssh-add` 时只 SKIP，并打印缺哪个。

Windows 上没有 POSIX `sh`，整份测试在 WSL 里跑：

```
wsl.exe -e bash -lc 'cd <repo> && node test/sshtest.mjs'
```

当前 46 项全绿（`SUMMARY pass=46 fail=0`）。
