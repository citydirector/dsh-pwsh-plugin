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

**侧栏。** Plugins → Add plugin → `https://github.com/citydirector/dsh-pwsh-plugin`，然后打开开关。

**命令行。** `desktop` profile 只能由桌面端自带的 CLI 管：

```powershell
$dsh = '<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = '<DSH_HOME>'        # 桌面 App 自己用的那个数据根

# <tag> 是任意已发布的标签；最新的那个就是插件自己会装的那个
& $dsh plugin --profile desktop add 'github:citydirector/dsh-pwsh-plugin#<tag>'
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

`pwsh_run` 跑脚本；`pwsh_run_update` 查更新、必要时安装本插件的新版本 —— 见[自动更新检查](#自动更新检查)。

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
| `updateCheck` | `true` | 定期查发布标签。查与装分开：这里只查，装由 `pwsh_run_update` 与自动更新做。 |
| `autoUpdate` | `true` | 自己装上更新，宿主有 HMR 时**不需要重启**即生效。 |
| `autoUpdateDelayMs` | `90000` | 自动检查前的等待，避免与启动流程抢 pnpm。 |

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

默认情况下插件自己升级：启动 90 秒后查一次发布标签，之后每 12 小时一次；查到更高的 `vX.Y.Z` 就直接
装上。宿主跑着 DSH 的 HMR 服务时，**装上的那一刻新代码就已经在跑** —— 不用重启，不用弹窗，用户什么
都不用做。

| 方式 | 行为 |
|---|---|
| 自动（`autoUpdate: true`，默认） | 查 → 装 → 就地生效。装失败按指数退避重试（5 分钟起、翻倍、封顶 2 小时）；装成功过的版本不再重试。**有调用在跑时绝不装** —— 3 分钟后再看。宿主**没有** HMR 时它什么都不装，见下。 |
| `pwsh_run_update` 的 `action: "check"` | 只读一次标签，报出 `state` / `running` / `newest release` / `install spec`。不装任何东西。 |
| `pwsh_run_update` 的 `action: "install"` | 同一条安装路径，只是由人按下去而不是由时钟按下去。有调用在跑时报 `install: postponed`；预检判定「装了也没用」时报 `install: restart-required` / `install: broken-release`（见下）。 |

安装走 `ctx.get('pluginManager')` —— 也就是「插件」页面背后那个服务 —— 由它跑 pnpm，失败时回滚
`package.json`。本插件**从不自己改自己的文件**：它是 profile 的 bundle 依赖，版本钉在
`package.json` 与 `pnpm-lock.yaml` 里，绕开包管理器写文件会立刻让 lockfile 与磁盘对不上。

**为什么能不重启就生效。** 插件的 `apply` 以及它起的定时器，都跑在 HMR 服务的事务上下文里
（`AsyncLocalStorage`）。在那里直接调 `installBundle`，pnpm 会跑完、磁盘会换成新版，紧接着的重组合
却被拒掉（`HMR transactions cannot be nested`），于是停在最难看清的状态：磁盘是新的、进程里是旧的。
先把上下文清空（`hmr.executing.run(undefined, …)`）再调，重组合才会真的发生；而磁盘上新装的文件与已
加载的模块已经对不上，HMR 于是驱逐旧模块、import 新模块。实测：从触发到新代码应答 137 ms。

**为什么先看一眼再装。** DSH 的插件管理器在跑 pnpm **之前**就会拒掉一类安装：要装的规格与 profile
里为该包记下的规格完全一致 —— 也就是 `already-installed`。有两种情形会走到这一步，而这两种本来就不该
发起安装：

- 这个版本已经装好了（终端里的 `dsh plugin add`、或者「插件」页面），只是进程还没重启。文件是新的，
  缺的只是一次重启。
- 发版时忘了把 `package.json` 里的 `version` 抬上去。标签变了、声明的版本没变，于是每一次尝试装的都是
  同一份字节、被同一句话拒掉 —— 一个永不结束、也从不吭声的循环。

所以安装之前，更新器先比对手上已有的三个事实：profile 记下的规格、已装包自己声明的版本、运行中的进程
报出的版本。磁盘上已经是新版的报 `install: restart-required`；标签存在但包内版本没抬的报
`install: broken-release` 并直说原因。`scripts/release-check.mjs` 在推标签**之前**拦第二种，运行时这道
预检则在**之后**、在每一台试图升级的机器上再拦一次。

**为什么非要等安静。** 安装会替换插件，而停掉本插件就要 dispose 掉它所有的常驻会话。若此刻有脚本正在
跑，那与直接断电无异：输出写了一半、调用结束时拿不到状态、会话状态全失。所以更新器先问插件「现在有没有
调用在跑」（与工具本身用同一套同步的检查加置位，中途塞不进新调用），有就整轮推迟。安装进行中到达的调用
则等它装完，而不是跟它抢。

宿主**没有** HMR 时，自动路径什么都不做。那种环境装下去只会「磁盘是新版、进程是旧版」—— 需要重启的
自动更新不算更新，只是一个会说谎的版本号。（`pwsh_run_update` 的 `install` 在这种情况下照样装，因为
是人按的、人能决定什么时候重启；结果里会诚实地写 `restart-required`。）
把自动路径关掉（`autoUpdate: false`）则在任何宿主上都回到旧行为：只查不装，在下次 `pwsh_run` 输出末尾
挂一行，让人来定。

若 profile 关掉了 `plugin-manager` 服务，`install` 会报 `no-manager`，改用终端升级：

```powershell
$env:DSH_HOME = '<DSH_HOME>'
& '<桌面端安装目录>\resources\runtime\cli\bin\dsh.cmd' plugin --profile desktop add 'github:citydirector/dsh-pwsh-plugin#<tag>'
```

注意 DSH 的默认组合关掉的是**工具** `plugin_manager`，而桌面 profile 上的**服务** `plugin-manager`
是活的 —— 两者不是一回事，这里只用服务。



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
git -C $root tag v0.2.1
$env:DSH_PWSH_UPDATE_SOURCE = 'git+file:///' + ($root -replace '\\','/')
node -e "import('./plugin/update-check.mjs').then(async (m) => console.log(JSON.stringify(await new m.UpdateChecker({ version: '0.1.0' }).check())))"
# → {"state":"available","latest":"v0.2.1","checkedAt":"..."}
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
| 永远看不到更新提示 | 源环境变量必须在 **Windows** 侧设；WSL 不透传 `DSH_*`。 |
| 输出顺序看着不对 | stdout 与 stderr 按类型合并，不按时间。自己用 `2>&1` 合。 |
| `exit N` 的退出码拿不到 | runspace 语义 —— 用 `Write-Output` 或读 `$LASTEXITCODE`。 |
| 调用结束后子进程还占着文件 | 会话持有 `Process` 对象。等 `idleMs`，或者用一次超时强制重建。 |
| `Program 'node.exe' failed to run: 拒绝访问。` | `workspace-write` 下的正常现象：受限令牌建不了匿名管道，凡是「捕获子进程 stdio」的起法都失败，`& exe` 也在其中。改用 `Start-Process -RedirectStandardOutput/-RedirectStandardError <文件>`（能拿到输出，拿不到退出码）、`[Diagnostics.Process]::Start`（`UseShellExecute=$false`、不重定向，能拿退出码但子进程继承 stdout），或一个把 stdout / stderr / `%ERRORLEVEL%` 分别写进三个文件的 `.cmd` 包装器。工具也会把这段说明附在输出末尾。 |

## 已知边界

- **不支持 `read-only` 模式**（见上），用内置 `pwsh`。
- **沙箱策略服务缺席时拒绝启动**，除非 `allowUnconfined: true`。
- **超时会杀掉整个会话**（连带回收子进程树）。状态丢失，下次调用自动重建。
- **`exit N` 的退出码不可观测**（runspace 语义）。
- **stdout / stderr 的逐行时序不保留** —— 全部流经 `*>&1` 合并后按类型打标。
- **`[Console]::Error.WriteLine` 会被吞掉**（服务端为防协议污染把 `Console.Error` 指向内存流）。
  子进程的 stderr、`Write-Error`、`throw` 都正常回来。
- **子进程的 std handle 已与协议流断开。** `Console::SetIn/SetOut` 只改 .NET 层，服务端还改写了三个 Win32 槽位：
  stdin 接 `NUL`，stdout / stderr 接一个带 `FILE_FLAG_DELETE_ON_CLOSE` 的临时文件、每次调用前截回零。
  于是子进程往继承来的 stdout 写东西不会再伪造出协议行（实测：子进程一句 `Write-Output '<<<BYE>>>'`
  曾让会话当场死亡），读继承来的 stdin 也只会读到 EOF，而不是调用方的请求。
  替上去的句柄必须是**可继承**的（`SECURITY_ATTRIBUTES.bInheritHandle`）：用 `NULL` 安全描述符建的句柄
  只存在于本进程，子进程按 `STARTUPINFO.hStdInput` 拿到的只是一个在那边没有意义的句柄**编号** ——
  `GetFileType` 报 `UNKNOWN`，几十次里还有一次那个编号被别的对象复用，读出来是别人的字节。
  stdout **故意不接 `NUL`**：那是字符设备，PowerShell 会认为输出没被重定向，沙箱拒绝的报错会变成一句
  没用的 `StandardOutputEncoding` 提示。临时目录不可写时退回 `NUL`，并在第一次调用的警告里说明一次。
- **会话是串行的**：并发调用排成队列逐个执行（不会串输出，但也没有并行加速）。
- **不依赖 WSL。** `pwsh_run` 全程不碰 WSL，只有 `wsl/custom-bash.mjs` 才碰。没有可用的 `bashPath` 时，
  该预设照样加载成功（可执行文件是惰性解析的），`bash` 工具每次调用报
  `command "<路径>" is not an executable file` —— 清晰失败，不会静默降级。默认值是裸名 `bash`；
  PATH 解不出来时，Windows 上会再试 `C:\Windows\System32\bash.exe`（同一个 WSL 垫片）才放弃。
  设这道后备是因为进程可能继承到一份早于 PATH 修改的环境块，里面没有 `System32` ——
  没有它就等于整个工具作废。显式写出的绝对 `bashPath` 只认那一个：写错了就该响亮地失败，
  不该被悄悄换成另一份。
- **UAC 开启时的行为与本机不同。** 本机实测环境是 UAC 关闭、进程提权。UAC 开着时会话是标准用户，
  此时 ACL 沙箱要求工作区根目录的 DACL 给你 **`WRITE_DAC` 与 `WRITE_OWNER`** —— 全控制两者都满足
  （它写的完整性标签在 SACL 里）。用户目录下的目录天然继承这两样；在盘符根新建的目录只继承
  `Modify`，单靠 `Modify` 会以 `SetNamedSecurityInfoW failed (Win32 5)` 失败。属主不是决定因素：
  `icacls <根目录> /grant "%USERNAME%":(OI)(CI)F` 能救。届时是 fail-closed 报错，不会退化成无边界。
- 不支持交互式程序与 TTY。
- **升级会换掉会话，但绝不打断正在跑的调用。** 替换插件会先把它停掉，而停掉本插件就会销毁它的会话 ——
  所以真正装上新版的那一次，常驻 pwsh 进程已经不在了，下次调用重新拉起。只存在于该会话里的东西（变量、
  `Set-Location` 过的目录、import 进来的模块）随之丢失。实测 v0.2.3 → v0.2.4 的一次安装：`$PID` 由
  24820 变成 15632，安装前设的 `$global:` 变量读回来是空的。更新器**不会**做的事是打断在跑的活：
  自动循环与 `pwsh_run_update` 的 `install` 都会先问插件「现在有没有调用在跑」，有就整轮推迟
  （循环 3 分钟后再看，工具报 `install: postponed` 且不动 profile），直到会话安静下来。安装进行中到达的
  调用会先等它装完，而不是建一个马上要被销毁的会话。版本比会话状态值钱，但这并不等于「什么都没发生」
  —— 别把不可重建的状态放在里面跨过升级。

## 开发

```
plugin/
  index.mjs           工具注册、沙箱接线、超时
  session.mjs         会话对象：分帧、队列、base64、启动 argv
  session-server.ps1  PowerShell 侧：runspace、流打标、哨兵
  update-check.mjs    发布标签查询与比较
  update-apply.mjs    把钉住的规格交给 pluginManager，不自己下载
  auto-update.mjs     自动路径：在 HMR 事务之外安装，失败退避
test/
  support.mjs         定位 DSH 安装；Windows 路径转 /mnt 形式
  itest.mjs           协议与会话本体
  plugintest.mjs      插件完整路径（mock 上下文）
  e2e-real-subprocess.mjs  真 DSH subprocess 运行时
  sandboxtest.mjs     真 LocalSandboxProvider，边界 + fail-closed 用例
  bashtest.mjs        custom-bash 围栏分诊（mock runtime）
  bash-e2e.mjs        custom-bash 端到端（真 runtime + 真 llrun）
  updatetest.mjs      更新检查与安装结果（本地 git 仓库）
  autoupdatetest.mjs  自动更新循环、退避、空闲闸门，以及它依赖的 HMR 上下文逃逸
  wiringtest.mjs      更新提示真的接到工具输出末尾、安装要等会话空闲
  denialtest.mjs      沙箱拒绝提示只在该触发的报错上触发
  metatest.mjs        插件页元数据：locale、icon，以及页面到底读哪份文档
wsl/
  llrun.c llrun      C 垫片与构建产物
  custom-bash.mjs    bundle 接进组合的 bash 工具替代实现（仅 Windows）
  acceptance.sh      54 项验收矩阵
docs/llrun.md        垫片的完整说明
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
node test/updatetest.mjs                     # 96：更新检查、安装结果、安装前预检（只碰本地 git）
node test/autoupdatetest.mjs                 # 38：自动安装、退避、空闲闸门、安装前预检、HMR 上下文逃逸
node test/wiringtest.mjs                     # 21：更新提示接线、空闲闸门、安装前预检的接线
node test/denialtest.mjs                     # 11：沙箱拒绝提示（不起子进程，哪儿都能跑）
node test/metatest.mjs                       # 23：插件页元数据（不起子进程，哪儿都能跑）
```

十一份脚本合计 **272 项**，都不需要 DSH 在跑 —— 只要 node 24、PowerShell 7，以及一个能借
`node_modules` 的 DSH 安装。需要 DSH 运行时的测试会自动找（`DSH_MODULES`、`DSH_MODULES_ASAR`，
或从工作目录逐级向上），找不到时打一行 `SKIP` 提示而不是失败。

### 发版

`package.json` 里的 version 是本仓库唯一写死的东西，而更新检查拿它跟已发布的标签比。只打 tag 不升版本，
检查会永远报有新版：装上去的文件读到的还是旧数字，于是每轮都重装同一个 tag，退避一路爬到上限。
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
