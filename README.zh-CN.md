# dsh-pwsh-plugin

[English](README.md) · **简体中文**

给 DeepSeek Harness 的 `pwsh_run` 工具：PowerShell 脚本正文**经 stdin** 送进一个常驻 pwsh 7 进程 ——
路上不做任何转义、没有 32K 命令行上限、~400ms 冷启动只付一次，变量 / 当前目录 / 已加载模块跨调用保留。

它与内置 `pwsh` 工具**并存**，不替换。

同一仓库还带 `wsl/llrun`：一个 C 垫片，给 WSL 里的 `bash` 工具补上真正的写边界。
详见 [docs/llrun.md](docs/llrun.md)。

插件页会显示本包自己的图标、本地化标题与简介；界面语言是中文时，简介下方读的是这份
`README.zh-CN.md`，而不是英文那份。三处都声明在宿主真正去看的位置：图标走 `package.json` 的
`icon` 字段（`icon.svg`），文字走 `locale/en.json` 与 `locale/zh.json` —— 文件名不叫 `README` 的文档
只有靠 `meta.detail` 才读得到。

需要 **DSH 0.2.0-rc.2 或更新**（在 0.2.0-rc.2 与 0.2.1-rc.3 上验过）与 **PowerShell 7**。

## 为什么需要它

| 层 | 现在会发生什么 |
|---|---|
| `bash` 工具 | 命令被包成 `/bin/bash -c "<cmd>"`。外层双引号**在 PowerShell 拿到之前**就把 `$` 展掉了，heredoc 死在同一层。 |
| 内置 `pwsh` 工具 | `$` 与 here-string 原样通过，但每次都是全新进程，而且整条命令走 Windows 命令行：32,000 字符正常，32,700 就 `spawn ENAMETOOLONG`。 |
| 本工具 | 脚本正文以 base64 走 stdin，两个问题都不存在。 |

单次实测 **91,741 字符**。完整实测数据与每一处设计取舍的理由都在 [FINDINGS.md](FINDINGS.md)。

## 安装

这个包本身就是 **DSH bundle**：自带一份 `cordis.patch.yml`，会自己插入它需要的那几行。
所以装完就能用，不需要动你的 profile。

它插两行：

- `- id: pwsh-run` —— 工具本体。
- `- id: custom-bash` —— `bash` 工具的替代实现，仅 Windows 启用（`disabled: !!js process.platform !== 'win32'`）。
  它指向包内的 `dsh-pwsh-plugin/wsl/custom-bash.mjs`，所以围栏用的就是随包发布的那份 `llrun` 二进制 ——
  不用拷贝，也不用往 `/usr/local/bin` 里装东西。`remove` 会把两行和包一起拿走，profile 恢复原样。

它**不会**顺手禁用官方的 `tool-bash`：那一行本来就带 `disabled: !!js process.platform === 'win32'`，
在这里写死 `disabled: true` 会把 Linux 上的官方 bash 一起关掉。

**npm registry。** 也在 npm 上：`npm i dsh-pwsh-plugin`，或者让 DSH 装 registry 规格：

```powershell
& $dsh plugin --profile desktop add 'dsh-pwsh-plugin@<version>'
```

> 注意 pnpm 的 `minimumReleaseAge` 默认 1440 分钟：刚发布的版本当天不会自动解析到，点「更新」会装到上一个版本。这是供应链策略，不是装错。

> `npm publish` 之后的头五分钟里，tarball 地址在 CDN 边缘仍返回 **404**（`cache-control: public, max-age=300`），而版本文档和 `dist-tags.latest` 都已经是新值。在这段时间里安装会报 `ERR_PNPM_FETCH_404 … .tgz: Not Found`，看起来像权限问题，其实不是。等满五分钟即可；加 `?nocache=` 能绕过缓存，但 npm 和 pnpm 都不会去取那个地址。

**侧栏。** Plugins → Add plugin → `https://github.com/citydirector/dsh-pwsh-plugin`，然后打开开关。

**命令行。** `desktop` profile 只能由桌面端自带的 CLI 管：

```powershell
$dsh = '<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = '<DSH_HOME>'        # 桌面 App 自己用的那个数据根

# <version> 是任意已发布版本；最新的那个就是插件页会给出的那个
& $dsh plugin --profile desktop add 'dsh-pwsh-plugin@<version>'
# 或者从本地检出装
& $dsh plugin --profile desktop add 'file:<检出目录>'
```

`add` 会把 `dsh-pwsh-plugin` 追加进 profile `package.json` 的 `dsh.profile.bundles`，`remove` 取回。
想验证效果就对一个非保留 profile 跑 `--dump-config`，能看到 `# == dsh-pwsh-plugin` 段和紧跟的
`- id: pwsh-run / name: dsh-pwsh-plugin`。

选 spec 之前要知道两件事：

- **registry 规格是拷贝，`file:` 是硬链接。** `dsh-pwsh-plugin@X.Y.Z` 装的是那次发布的一份拷贝 ——
  改检出不会生效，得重新 `add`。`file:` 直接硬链接检出，改完立刻生效（`fsutil hardlink list` 能看到
  两条路径），代价是 `package.json` 里钉死了绝对路径。开发期用 `file:`，长期用 registry 规格。
  `github:citydirector/dsh-pwsh-plugin#<tag>` 仍然能装，效果与 registry 规格相同（都是拷贝），只是
  绕开了 pnpm 的供应链策略。
- **bundle 那一行带不了 `?v=N`。** 它的 `name` 必须是包名，才能从 profile 的 `node_modules` 解析，
  因此没有 URL 可变，ESM 继续用它已经缓存的那个模块。改 `node_modules` 下的文件，只有等宿主碰巧跑一次
  重组合才可能被换掉 —— 开发期不能指望这个，用下面那种手写行并把 `?v=N` 提一号，或者重启。

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

`pwsh_run` 跑脚本。版本由 DSH 自己管 —— 见[更新](#更新)。

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

## 更新

本插件**没有自己的更新器**。它就是一个普通的 registry 包，所以**版本交给 DSH 管**：「插件」页面会列出它、
标出有没有更新的版本、并按与其它插件相同的 `listVersions` / `updateBundle` 路径装上。

这条路成立的前提是 profile 里记的是裸 registry 规格（`"dsh-pwsh-plugin": "0.2.14"`）。换成别的来源就更新不了：
`github:` / `file:` / git range、不是本 profile 的第三方依赖、或者本身不声明 semver 版本，DSH 都会拒。

两件值得知道的事：

- **`minimumReleaseAge` 照样生效。** pnpm 的供应链策略默认 1440 分钟，今天发布的版本今天解析不到 ——
  点「更新」会装到上一个版本，页面上会写清实际装的是哪个。这是策略在起作用，不是出错。
- **版本号与标签必须对齐。** `package.json` 是本仓库唯一写死的版本；打了标签却没抬版本号，每一次更新装的
  都是同一份字节。`scripts/release-check.mjs` 会在 workflow 里先把这种情况拦下来。

手动更新与 DSH 做的是同一个操作：

```powershell
$env:DSH_HOME = '<DSH_HOME>'
& '<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'dsh-pwsh-plugin@<version>'
```

**更新会换掉常驻会话。** 停掉插件就要 dispose 掉它所有的常驻会话，所以升级后下一次调用是重建的 pwsh 进程：
只存在那个会话里的变量、`Set-Location`、已导入模块都会丢。不要把它当作跨升级保存状态的地方。


## `llrun` 垫片

`bash` 工具跑在 WSL 里，`/mnt/c`、`/mnt/d` 原本**任意位置都能写**：9p / drvfs 在 DSH 沙箱够不着的地方。
`wsl/llrun` 用 user namespace、landlock（ABI 7，白名单刻意不含 `/init`，于是任何 Windows 可执行文件都
起不来）与 `/var/tmp` 挂载封印把这件事变成闭环。`wsl/custom-bash.mjs` 把它接进 `bash` 工具，并按会话
权限选档。

不需要手动装：二进制随包发布，探测候选的最后一个就是它，所以一次 `plugin add` 就够。由于发布包在
Windows 上打，那份文件到手时是 `0644` —— 探测发现它属于当前用户却不可执行时，会自己补上执行位再试。

完整说明、`-r` 档语义表、54 项验收矩阵与接入方式：**[docs/llrun.md](docs/llrun.md)**。想在自己机器上
复验就 `bash wsl/acceptance.sh`（要在未被 `custom-bash` 包裹的 WSL 里跑：套第二层围栏会让四项断言
因错误的原因变红）—— 它的每个路径都从自身位置推导，并在结尾复核磁盘有没有泄漏。

## 故障处理

| 现象 | 怎么办 |
|---|---|
| `profile "desktop" is managed exclusively by the Electron application` | 用桌面安装里的 `dsh.cmd`，不要用便携版 `dsh.exe`。 |
| `Open DeepSeek Harness Desktop once to initialize its profile` | `DSH_HOME` 指错了；指到桌面 App 自己用的数据根。 |
| 启动时 `tool "pwsh_run" is already registered` | profile 的 patch 文件里手写了 `id: pwsh-run`，**而且** bundle patch 又插了一条。删掉手写那条。 |
| `refusing to start: ctx.sandboxPolicy is absent` | 组合里少了沙箱策略服务。补齐组合，或者确实要这样时设 `allowUnconfined: true`。 |
| `refusing to start: read-only mode` | 预期行为。read-only 会话里用内置 `pwsh` 工具。 |
| `could not confine the session: SetNamedSecurityInfoW failed (Win32 5)` | 工作区根目录的 DACL 没给你 `WRITE_DAC` + `WRITE_OWNER`（沙箱要在那里写 DACL 与完整性标签）。全控制权限两样都满足，`Modify` 不够。执行 `icacls "<根目录>" /grant "%USERNAME%":(OI)(CI)F`，或从用户目录下的目录起会话。 |
| 内置工具能写的地方本工具写不进 | 确认 `session` 真的传到了 `sandboxPolicy.resolve`（见「沙箱」）；漏传会把边界静默挪到 profile 目录。 |
| 输出顺序看着不对 | stdout 与 stderr 按类型合并，不按时间。自己用 `2>&1` 合。 |
| `exit N` 的退出码拿不到 | runspace 语义 —— 用 `Write-Output` 或读 `$LASTEXITCODE`。 |
| 调用结束后子进程还占着文件 | 会话持有 `Process` 对象。等 `idleMs`，或者用一次超时强制重建。 |
| `Program 'node.exe' failed to run: 拒绝访问。` | `workspace-write` 下的正常现象：受限令牌建不了匿名管道，凡是「捕获子进程 stdio」的起法都失败，`& exe` 也在其中。改用 `Start-Process -RedirectStandardOutput/-RedirectStandardError <文件>`（能拿到输出，拿不到退出码）、`[Diagnostics.Process]::Start`（`UseShellExecute=$false`、不重定向，能拿退出码但子进程继承 stdout），或一个把 stdout / stderr / `%ERRORLEVEL%` 分别写进三个文件的 `.cmd` 包装器。工具也会把这段说明附在输出末尾。 |

## 已知边界

完整清单（会话语义、已断开的子进程 std handle、UAC 差异、升级对会话的影响）见
**[docs/runtime-notes.zh-CN.md](docs/runtime-notes.zh-CN.md)**。要点：

- 不支持 `read-only`，那里用内置 `pwsh`。
- 超时会杀掉整个会话并回收其子进程树。
- `exit N` 退出码与 stdout/stderr 的逐行时序都不可观测。
- 会话是串行的，不提供 TTY。
- 升级会换掉会话，只存在于其中的东西随之丢失。

## 开发

```
plugin/
  index.mjs           工具注册、沙箱接线、超时
  session.mjs         会话对象：分帧、队列、base64、启动 argv
  session-server.ps1  PowerShell 侧：runspace、流打标、哨兵
test/
  support.mjs         定位 DSH 安装；Windows 路径转 /mnt 形式
  itest.mjs           协议与会话本体
  plugintest.mjs      插件完整路径（mock 上下文）
  e2e-real-subprocess.mjs  真 DSH subprocess 运行时
  sandboxtest.mjs     真 LocalSandboxProvider，边界 + fail-closed 用例
  bashtest.mjs        custom-bash 围栏分诊（mock runtime）
  bash-e2e.mjs        custom-bash 端到端（真 runtime + 真 llrun）
  denialtest.mjs      沙箱拒绝提示只在该触发的报错上触发
  metatest.mjs        插件页元数据：locale、icon，以及页面到底读哪份文档
wsl/
  llrun.c llrun      C 垫片与构建产物
  custom-bash.mjs    bundle 接进组合的 bash 工具替代实现（仅 Windows）
  acceptance.sh      54 项验收矩阵
docs/llrun.md        垫片的完整说明
docs/runtime-notes.zh-CN.md  完整已知边界清单，从这一页挪出去
FINDINGS.md          全部实测数据与设计理由
```

```bash
cd <检出目录>
PWSH_BIN='pwsh' node test/itest.mjs          # 17：协议与会话本体
PWSH_BIN='pwsh' node test/plugintest.mjs     # 15：插件完整路径
node test/e2e-real-subprocess.mjs            #  8：真 DSH subprocess
node test/sandboxtest.mjs                    #  7：真沙箱边界 + fail-closed
node test/bashtest.mjs                       # 25：custom-bash 围栏分诊、bash 后备、执行位自修复
node test/bash-e2e.mjs                       # 11：custom-bash 端到端
node test/denialtest.mjs                     # 11：沙箱拒绝提示（不起子进程，哪儿都能跑）
node test/metatest.mjs                       # 23：插件页元数据（不起子进程，哪儿都能跑）
```

八份脚本合计 **117 项**，都不需要 DSH 在跑 —— 只要 node 24、PowerShell 7，以及一个能借
`node_modules` 的 DSH 安装。需要 DSH 运行时的测试会自动找（`DSH_MODULES`、`DSH_MODULES_ASAR`，
或从工作目录逐级向上），找不到时打一行 `SKIP` 提示而不是失败。

### 发版

从 tag 发布由 [`.github/workflows/release.yml`](.github/workflows/release.yml) 负责：先跑
`scripts/release-check.mjs`，再用 npm 的 **trusted publishing** 执行 `npm publish --provenance` ——
runner 用自己那份短命的 GitHub 身份换一个只对「这个仓库 + 这个 workflow 文件」有效的令牌。仓库里没有
`NPM_TOKEN`，也不该加。两个连带后果值得记住：workflow 的文件名是信任契约的一部分（改名后每次发布都会
403，直到在 npm 上改设置）；provenance 在那里是强制的，所以 tarball 会带上「由哪个提交构建」的签名声明。

`package.json` 里的 version 是本仓库唯一写死的东西，DSH 拿它跟 registry 上的已发布版本比。
不升版本就发版，每次更新装的都是同一份字节：页面一直提示有新版，pnpm 一直装回旧的。
`npm version` 一次完成「改版本 + 提交 + 打 annotated tag」，所以这三者不会漂开：

```powershell
npm version patch -m 'chore(release): %s'   # 改版本、提交、打 tag
git push origin main <tag>
```

发版前跑一次 `node scripts/release-check.mjs`。工作区不干净、HEAD 上的 tag 与 `package.json` 对不上、
tag 指向的提交里版本不同、或者要重指一个已存在的 tag（那会把已发布的版本挪到新内容上），它都会拒绝。
HEAD 上还没有 tag 时，它把该打的标签名打印出来。

npm 要用 Windows 侧那份。WSL 里 `/usr/local/bin/npm` 指向 bun 的软链，`npm version` 会报
`Script not found "version"`。

## 许可

MIT —— 见 [LICENSE](LICENSE)。