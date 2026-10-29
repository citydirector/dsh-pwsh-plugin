# dsh-pwsh-plugin

[English](README.md) · 简体中文 · [npm](https://www.npmjs.com/package/dsh-pwsh-plugin)

为 DSH 提供常驻 PowerShell 工具 `pwsh_run`。脚本通过 stdin 传入，适合多行脚本，以及需要在多次调用之间保留变量、工作目录和模块的任务。它与内置 `pwsh` 工具并存。

需要 **DSH >=0.2.0-rc.2 <0.3.0** 和 **PowerShell 7**。Windows bundle 还会注册配套的 `custom-bash`；其 WSL 围栏说明见 [llrun](docs/llrun.md)。

## 快速开始

在 DSH「插件 → 添加插件」输入 `dsh-pwsh-plugin`，安装并启用。确认 `pwsh` 在 PATH 中，或配置 `pwshPath`。

Web profile 的命令行安装：

~~~sh
dsh plugin --profile web add dsh-pwsh-plugin
~~~

命令行操作前关闭相应实例，完成后重启。Desktop 用户优先使用插件页；管理 desktop profile 要用桌面安装自带的 CLI，并指向相同的 DSH_HOME。直接 `npm install` 不会替你启用 DSH bundle。

不要同时保留手写的 `pwsh-run` 行和 bundle 安装，否则会重复注册工具。

## 工具

| 工具 | 用途 |
| --- | --- |
| `pwsh_run` | 在常驻 PowerShell 会话中运行脚本 |
| `pwsh_run_update` | 检查 npm 新版本，或通过 DSH 安装更新 |

`pwsh_run` 参数：

| 参数 | 必填 | 说明 |
| --- | --- | --- |
| `script` | 是 | 原样传入 PowerShell 脚本，不套额外的 `pwsh -c` |
| `workdir` | 否 | 执行前切换目录，后续调用会继承 |
| `timeoutMs` | 否 | 本次调用超时，默认 120000 毫秒 |

例如向工具传入：

~~~json
{"script":"$items = Get-ChildItem\n$items | Select-Object Name","workdir":"D:/project"}
~~~

同一会话的后续调用可以继续读取 `$items`。超时、取消、空闲回收或插件更新后，内存状态会丢失。

## 配置

在 profile 的 `cordis.patch.yml` 中覆盖 `pwsh-run` 行：

~~~yaml
- set:
    - id: pwsh-run
      config:
        pwshPath: pwsh
        timeoutMs: 120000
        autoUpdate: false
~~~

| 配置 | 默认 | 说明 |
| --- | --- | --- |
| `pwshPath` | `pwsh` | PowerShell 可执行文件 |
| `timeoutMs` | `120000` | 默认调用超时 |
| `idleMs` | `1800000` | 空闲回收时间，30 分钟 |
| `maxSessions` | `4` | 最多保留的会话数 |
| `maxOutputBytes` | `8388608` | 单次输出上限，8 MB |
| `allowUnconfined` | `false` | 缺少沙箱策略服务时是否仍允许运行 |
| `updateCheck` | `true` | 检查 npm 更新 |
| `autoUpdate` | `true` | 空闲时自动安装新版 |
| `autoUpdateDelayMs` | `90000` | 首次自动更新检查延迟 |

## 更新行为

**当前版本仍保留独立更新器。** 它已使用 npm 来源，但未移除：默认启动约 90 秒后检查，之后每 12 小时检查一次，并在会话空闲时安装新版。

`pwsh_run_update` 的 `action` 可为 `check` 或 `install`。安装会交给 DSH 的插件管理器；热替换是否生效取决于宿主，按返回结果决定是否重启。更新不会主动切断正在执行的调用，但替换插件后原常驻会话会丢失。

若只想由 DSH 管理更新，在上述配置中同时设置 `autoUpdate: false` 和 `updateCheck: false`。这会停用插件自身的更新行为，注册的更新工具仍会存在。

## 使用边界与排障

- 不提供交互终端或 TTY。
- `exit N` 的退出码不可直接观测；stdout/stderr 的逐行交错顺序不会保留。
- `read-only` 下常驻 runspace 无法启动，请用内置工具。
- 缺少沙箱策略服务时默认拒绝启动；不要把 `allowUnconfined` 当作通用排障开关。
- Windows 的受限令牌可能阻止捕获子进程 stdio，遇到拒绝访问先查看工具返回的提示。
- `pwsh_run` 不需要 WSL；配套的 Windows `bash` 工具需要可用的 WSL/bash。

更多实现细节见[运行边界](docs/runtime-notes.zh-CN.md)、[llrun](docs/llrun.md) 和 [FINDINGS.md](FINDINGS.md)。

## 开发与发布

~~~sh
npm test
~~~

需要真实 DSH 运行时的测试会查找已有安装；缺少依赖时可能报告跳过，应检查输出。完整测试入口是 `npm run test:all`。

当前 [release.yml](.github/workflows/release.yml) 在版本标签推送或手动指定标签时发布 npm，使用 OIDC/provenance。仅修改 main 上的 README 不会触发发布。发布前检查 `scripts/release-check.mjs`；标签必须与 package.json 版本一致。

## 许可证

[MIT](LICENSE)
