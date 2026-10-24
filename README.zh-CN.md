# dsh-pwsh-plugin

[English](README.md) · **简体中文**

给 DeepSeek Harness 的 `pwsh_run` 工具：PowerShell 脚本正文**经 stdin** 送进一个常驻 pwsh 7 进程 ——
路上不做任何转义、没有 32K 命令行上限、~400ms 冷启动只付一次，变量 / 当前目录 / 已加载模块跨调用保留。

它与内置 `pwsh` 工具**并存**，不替换。

同一仓库还带 `wsl/llrun`：一个 C 垫片，给 WSL 里的 `bash` 工具补上真正的写边界。
详见 [docs/llrun.md](docs/llrun.md)。

需要 **DSH 0.2.0-rc.2 或更新**（在 0.2.0-rc.2 与 0.2.1-rc.2 上验过）与 **PowerShell 7**。

## 为什么需要它

| 层 | 现在会发生什么 |
|---|---|
| `bash` 工具 | 命令被包成 `/bin/bash -c "<cmd>"`。外层双引号**在 PowerShell 拿到之前**就把 `$` 展掉了，heredoc 死在同一层。 |
| 内置 `pwsh` 工具 | `$` 与 here-string 原样通过，但每次都是全新进程，而且整条命令走 Windows 命令行：32,000 字符正常，32,700 就 `spawn ENAMETOOLONG`。 |
| 本工具 | 脚本正文以 base64 走 stdin，两个问题都不存在。 |

单次实测 **91,741 字符**。完整实测数据与每一处设计取舍的理由都在 [FINDINGS.md](FINDINGS.md)。

## 安装

这个包本身就是 **DSH bundle**：自带一份 `cordis.patch.yml`，会自己插入 `- id: pwsh-run` 那一行。
所以装完就能用，不需要动你的 profile。

**侧栏。** Plugins → Add plugin → `https://github.com/citydirector/dsh-pwsh-plugin`，然后打开开关。

**命令行。** `desktop` profile 只能由桌面端自带的 CLI 管：

```powershell
$dsh = '<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = '<DSH_HOME>'        # 桌面 App 自己用的那个数据根

& $dsh plugin --profile desktop add 'github:citydirector/dsh-pwsh-plugin#v0.1.0'
# 或者从本地检出装
& $dsh plugin --profile desktop add 'file:<检出目录>'
```

`add` 会把 `dsh-pwsh-plugin` 追加进 profile `package.json` 的 `dsh.profile.bundles`，`remove` 取回。
想验证效果就对一个非保留 profile 跑 `--dump-config`，能看到 `# == dsh-pwsh-plugin` 段和紧跟的
`- id: pwsh-run / name: dsh-pwsh-plugin`。

选 spec 之前要知道两件事：

- **`github:` 是拷贝，`file:` 是硬链接。** `github:` 装的是那个 tag 的快照 —— 改检出不会生效，得重新 `add`。
  `file:` 直接硬链接检出，改完立刻生效（`fsutil hardlink list` 能看到两条路径），代价是 `package.json`
  里钉死了绝对路径。开发期用 `file:`，长期用 `github:`。
- **bundle 那一行带不了 `?v=N`。** 它的 `name` 必须是包名，才能从 profile 的 `node_modules` 解析。
  手写 `file:` 行那套「提版本号绕 ESM URL 缓存」的手法在这里不存在 —— 改完插件代码要重启 DSH。

**手写一行** —— 不想装成依赖时（开发期常用）：

```yaml
- insert:
    - id: pwsh-run
      name: '<路径>/plugin/index.mjs'
      config:
        pwshPath: 'pwsh'
```

三条花了不少时间才确认的约束：

- **`desktop` 是保留 profile。** 便携版 `dsh.exe` 会答 `profile "desktop" is managed exclusively by the Electron application` 并退出 1；只有桌面安装里的 `dsh.cmd`（它以 `manageDesktopProfile: true` 起 desktop-host 的 CLI）能碰它。
- **`DSH_HOME` 必须指到便携版的数据根。** 默认是 `~/.dsh`，指错就报 `Open DeepSeek Harness Desktop once to initialize its profile` —— 它在找 `~/.dsh/profiles/desktop/package.json`。
- **别重复注册。** 从手写行换成 bundle（或反过来）时，**先删手写那条再装**。两层都会插入 `- id: pwsh-run`，
  合成后的配置树里就有两条；注册按名字查重，第二个 `pwsh_run` 在启动时是硬错误。`--dump-config` 一眼就能看出重复 ——
  切换后跑这一条。

`plugin/` 下三个文件（`index.mjs`、`session.mjs`、`session-server.ps1`）必须放在一起：
`index.mjs` 在加载时读那个 `.ps1`，再以 `-EncodedCommand` 送给子进程。

## 工具接口

| 参数 | 必填 | 说明 |
|---|---|---|
| `script` | 是 | PowerShell 脚本正文。**原样**送达 —— 不要转义 `$`，不要包 `pwsh -c`，不要加外层引号。 |
| `workdir` | 否 | 先 `Set-Location` 过去。会话有状态，后续调用会继承。路径无效则本次脚本不执行。 |
| `timeoutMs` | 否 | 单次超时，默认 120000。 |

输出：stdout 原样，warning 前缀 `WARNING: `，verbose 前缀 `VERBOSE: `，抛出的异常带 `[script threw]`
与最内层消息。错误（`Write-Error`、子进程的 stderr）排在 stdout **之后** —— 服务端用 `*>&1` 合并全部
流并按类型打标，所以 **stdout 与 stderr 的逐行时序不保留**（内置工具是分开两栏的）。需要顺序时自己
合并：`2>&1` 或 `*>&1`。

## 配置

| 键 | 默认 | 说明 |
|---|---|---|
| `pwshPath` | `pwsh` | 可执行文件；默认经 `PATH` 解析。 |
| `timeoutMs` | `120000` | 单次调用默认超时。 |
| `idleMs` | `1800000` | 空闲会话回收（30 分钟）。 |
| `maxSessions` | `4` | 同时存活的会话上限（每个 agent 工作区一个）。 |
| `maxOutputBytes` | `8388608` | 单次调用的输出收集上限（8MB）。截断会明确报出来，不静默。 |
| `allowUnconfined` | `false` | `true` = 沙箱策略服务缺席时也起会话。 |
| `updateCheck` | `true` | 定期查发布标签（只查，从不自己安装）。 |

`allowUnconfined` 是唯一一条「明知故犯」的开关。正常部署下 `ctx.sandboxPolicy` 一定在；缺席说明组合
不完整，这时插件**拒绝启动**，而不是悄悄跑一个不受约束的会话。

热重载（`patchReload: live`）会重新 `apply`。工具注册与进程清理都挂在 `ctx.effect` 上，不会触发
`tool "pwsh_run" is already registered`。

## 沙箱

常驻进程在**启动时**整体包进 `ctx.sandbox.confine` 返回的受限 argv。Windows ACL 沙箱用的是
`WRITE_RESTRICTED` 受限令牌，而令牌是**进程级**的 —— 所以 confine 一次之后，该会话的每一次读 / 写都
受同一个 workspace 边界约束，与内置 `pwsh` 工具等价。

策略按**启动会话时的真实 session** 解析（`session` 必须传进 `sandboxPolicy.resolve`）：会话的
`sandbox/mode` 优先，边界根取会话的 `header.cwd`。

一个值得记住的坑：早先传的是 ToolExecution（`agent` 挂在 `exec.agent` 上），`resolve` 拿不到
session，**静默退回部署默认值**（mode + 配置里的 `workspaceRoot`），边界于是跑到 profile 目录去了 ——
症状是「工作区内写不进去、profile 目录反而能写」。`test/sandboxtest.mjs` 的 `policy-carries-session`
用例专门钉住这个形状。

实测（`workspace-write`，cwd = 插件目录）：工作区内写入成功；盘符根、`C:\Users\<user>\`、
`C:\Windows\Temp\`、`C:\ProgramData\`、profile 目录全部被拒。脚本仍是 `FullLanguage`，
`$global:` 与 cwd 照常跨调用保留。`danger-full-access` 下不 confine，与内置工具一样无边界。

**`read-only` 模式不启动。** 该模式下 pwsh 是 ConstrainedLanguage，连 runspace 都建不起来。工具会
明确报错并提示改用内置 `pwsh` 工具（它在 read-only 下可用）。

## 自动更新检查

启动 5 秒后查一次发布标签，之后每 12 小时一次。**只查、只提示、从不自己安装** —— 查到新版本时在下次
`pwsh_run` 输出末尾挂一行（每个进程生命周期只挂一次）。让插件自己动手等于在自己的尸体上开刀：热
替换会 dispose 旧实例，`dispose` 一跑后半段代码就不再执行。

升级从外面发起，两条路任选：

```powershell
$env:DSH_HOME = '<DSH_HOME>'
& '<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'github:citydirector/dsh-pwsh-plugin#v0.2.0'
```

或者让模型调 `plugin_manager` 工具，`target` 传提示行里给的那个 spec。

默认发布源是 `github:citydirector/dsh-pwsh-plugin`，读 `GET /repos/<repo>/tags`。标签必须匹配
`^v\d+\.\d+\.\d+$`（预发布永不推送），取版本号最大的那个。

| 环境变量 | 作用 |
|---|---|
| `DSH_PWSH_UPDATE_SOURCE` | `owner/repo` → GitHub；`git+<url>` → 直接 `git ls-remote --tags`（`git+file:///path` 可在本地预演） |
| `DSH_PWSH_UPDATE_API` | GitHub API 基址，默认 `https://api.github.com` |
| `DSH_PWSH_UPDATE_DELAY_MS` | 首次检查延迟，默认 5000 |

本地预演：先建一个带 tag 的仓库，再把源指过去 ——

```powershell
$root = Join-Path $env:TEMP ('pwsh-rel-' + [guid]::NewGuid().ToString('N').Substring(0, 8))
git init -q -b main $root
git -C $root -c user.email=t@l -c user.name=t commit -q --allow-empty -m release
git -C $root tag v0.2.0
$env:DSH_PWSH_UPDATE_SOURCE = 'git+file:///' + ($root -replace '\\','/')
node -e "import('./plugin/update-check.mjs').then(async (m) => console.log(JSON.stringify(await new m.UpdateChecker({ version: '0.1.0' }).check())))"
# → {"state":"available","latest":"v0.2.0","checkedAt":"..."}
Remove-Item -Recurse -Force $root
```

预演请走 **Windows 侧**（`pwsh_run` 或内置 `pwsh` 工具）。在 WSL 的 `bash` 调用里
`export DSH_PWSH_UPDATE_SOURCE=...` 传不进 Windows 进程 —— WSL 只透传 `WSLENV` 里点名过的变量，其余
`DSH_*` 到子进程就消失，表现是「明明设了源，却去查默认的 GitHub 仓库」。真要跨过去得写
`WSLENV=DSH_PWSH_UPDATE_SOURCE`；**别加 `/p`**，那会把 `/tmp/...` 转成 `\\wsl.localhost\...` 路径，源就废了。

查询失败不会抛进工具调用：记 `state: 'failed'`，经 `ctx.logger` 留一行，先前查到过的 `latest` 保留成
`stale: 'available'` —— 一次网络抖动不该让已知的新版本消失。

## `llrun` 垫片

`bash` 工具跑在 WSL 里，`/mnt/c`、`/mnt/d` 原本**任意位置都能写**：9p / drvfs 在 DSH 沙箱够不着的地方。
`wsl/llrun` 用 user namespace、landlock（ABI 7，白名单刻意不含 `/init`，于是任何 Windows 可执行文件都
起不来）与 `/var/tmp` 挂载封印把这件事变成闭环。`wsl/custom-bash.mjs` 把它接进 `bash` 工具，并按会话
权限选档。

完整说明、`-r` 档语义表、54 项验收矩阵与接入方式：**[docs/llrun.md](docs/llrun.md)**。想在自己机器上
复验就 `bash wsl/acceptance.sh` —— 它的每个路径都从自身位置推导，并在结尾复核磁盘有没有泄漏。

## 故障处理

| 现象 | 怎么办 |
|---|---|
| `profile "desktop" is managed exclusively by the Electron application` | 用桌面安装里的 `dsh.cmd`，不要用便携版 `dsh.exe`。 |
| `Open DeepSeek Harness Desktop once to initialize its profile` | `DSH_HOME` 指错了；指到桌面 App 自己用的数据根。 |
| 启动时 `tool "pwsh_run" is already registered` | profile 的 patch 文件里手写了 `id: pwsh-run`，**而且** bundle patch 又插了一条。删掉手写那条。 |
| `refusing to start: ctx.sandboxPolicy is absent` | 组合里少了沙箱策略服务。补齐组合，或者确实要这样时设 `allowUnconfined: true`。 |
| `refusing to start: read-only mode` | 预期行为。read-only 会话里用内置 `pwsh` 工具。 |
| 内置工具能写的地方本工具写不进 | 确认 `session` 真的传到了 `sandboxPolicy.resolve`（见「沙箱」）；漏传会把边界静默挪到 profile 目录。 |
| 永远看不到更新提示 | 源环境变量必须在 **Windows** 侧设；WSL 不透传 `DSH_*`。 |
| 输出顺序看着不对 | stdout 与 stderr 按类型合并，不按时间。自己用 `2>&1` 合。 |
| `exit N` 的退出码拿不到 | runspace 语义 —— 用 `Write-Output` 或读 `$LASTEXITCODE`。 |
| 调用结束后子进程还占着文件 | 会话持有 `Process` 对象。等 `idleMs`，或者用一次超时强制重建。 |

## 已知边界

- **不支持 `read-only` 模式**（见上），用内置 `pwsh`。
- **沙箱策略服务缺席时拒绝启动**，除非 `allowUnconfined: true`。
- **超时会杀掉整个会话**（连带回收子进程树）。状态丢失，下次调用自动重建。
- **`exit N` 的退出码不可观测**（runspace 语义）。
- **stdout / stderr 的逐行时序不保留** —— 全部流经 `*>&1` 合并后按类型打标。
- **`[Console]::Error.WriteLine` 会被吞掉**（服务端为防协议污染把 `Console.Error` 指向内存流）。
  子进程的 stderr、`Write-Error`、`throw` 都正常回来。
- **会话是串行的**：并发调用排成队列逐个执行（不会串输出，但也没有并行加速）。
- 不支持交互式程序与 TTY。

## 开发

```
plugin/
  index.mjs           工具注册、沙箱接线、超时
  session.mjs         会话对象：分帧、队列、base64、启动 argv
  session-server.ps1  PowerShell 侧：runspace、流打标、哨兵
  update-check.mjs    发布标签查询与比较
test/
  support.mjs         定位 DSH 安装；Windows 路径转 /mnt 形式
  itest.mjs           协议与会话本体
  plugintest.mjs      插件完整路径（mock 上下文）
  e2e-real-subprocess.mjs  真 DSH subprocess 运行时
  sandboxtest.mjs     真 LocalSandboxProvider，边界 + fail-closed 用例
  bashtest.mjs        custom-bash 围栏分诊（mock runtime）
  bash-e2e.mjs        custom-bash 端到端（真 runtime + 真 llrun）
  updatetest.mjs      更新检查（本地 git 仓库）
  wiringtest.mjs      更新提示真的接到工具输出末尾
wsl/
  llrun.c llrun      C 垫片与构建产物
  custom-bash.mjs    presets/shared/custom-bash.mjs 的替代实现
  acceptance.sh      54 项验收矩阵
docs/llrun.md        垫片的完整说明
FINDINGS.md          全部实测数据与设计理由
```

```bash
cd <检出目录>
PWSH_BIN='pwsh' node test/itest.mjs          # 14：协议与会话本体
PWSH_BIN='pwsh' node test/plugintest.mjs     # 15：插件完整路径
node test/e2e-real-subprocess.mjs            #  8：真 DSH subprocess
node test/sandboxtest.mjs                    #  7：真沙箱边界 + fail-closed
node test/bashtest.mjs                       # 17：custom-bash 围栏分诊
node test/bash-e2e.mjs                       # 11：custom-bash 端到端
node test/updatetest.mjs                     # 51：更新检查（只碰本地 git）
node test/wiringtest.mjs                     #  9：更新提示接线
```

八份脚本合计 **132 项**，都不需要 DSH 在跑 —— 只要 node 24、PowerShell 7，以及一个能借
`node_modules` 的 DSH 安装。需要 DSH 运行时的测试会自动找（`DSH_MODULES`、`DSH_MODULES_ASAR`，
或从工作目录逐级向上），找不到时打一行 `SKIP` 提示而不是失败。

## 许可

MIT —— 见 [LICENSE](LICENSE)。
