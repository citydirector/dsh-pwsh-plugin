# dsh-pwsh-plugin

[English](README.md) · **简体中文**

[![npm](https://img.shields.io/npm/v/dsh-pwsh-plugin)](https://www.npmjs.com/package/dsh-pwsh-plugin) [![License: MIT](https://img.shields.io/badge/license-MIT-green)](LICENSE)

为 DeepSeek Harness 提供 PowerShell 会话、可选的工具护栏和文件删除确认。

## 功能

- **常驻 PowerShell 7**：脚本经 stdin 原样送达，不经过中间 shell，不受 Windows 命令行长度限制。变量、环境修改、模块和工作目录跨调用保留。
- **独立执行模式**：短命令可使用全新进程，超时或取消只影响自己，保留已有常驻状态。
- **沙箱接入**：不同 DSH 会话各自隔离，执行前检查权限、工作区及沙箱后端变化。
- **即时设置**：当前 profile 统一管理 PowerShell 路由与删除确认，支持中英文界面。保存开关保留正在运行的会话。
- **先审阅再回收**：删除前生成固定计划。大目录支持摘要、完整明细分页、进度和取消；登记临时目录支持限定范围的清理。
- **WSL Bash 围栏**：Windows 上随包接入的 Bash 工具使用 `llrun` 执行会话写入边界，二进制随包提供。

## 安装

需要 **PowerShell 7**，以及支持设置服务和工具守卫的兼容 **DSH 0.2.x**。Windows 的 Bash 功能还需要 WSL。

在 DSH 的**插件 → 添加插件**中输入 `dsh-pwsh-plugin` 并启用。工具和设置页由 bundle 自动接入。

桌面版 CLI 安装：

```powershell
$dsh = '<桌面版安装目录>\resources\runtime\cli\bin\dsh.cmd'
$env:DSH_HOME = '<DSH 数据目录>'
& $dsh plugin --profile desktop add 'dsh-pwsh-plugin'
```

指定版本使用 `dsh-pwsh-plugin@<version>`。保留的 `desktop` profile 必须使用桌面版自己的 CLI。由旧手写配置迁移时，先移除原来的 `pwsh-run` 条目，避免重复注册。

## 运行 PowerShell

调用 `pwsh_run`，直接传脚本正文；不要包 `pwsh -c`，也不要添加 shell 转义。

```json
{"script":"$buildName = 'demo'; Write-Output $buildName"}
```

短命令可独立运行：

```json
{"script":"Get-Process | Select-Object -First 5","mode":"isolated"}
```

| 参数 | 默认值 | 说明 |
| --- | --- | --- |
| `script` | 必填 | PowerShell 脚本正文。 |
| `mode` | `persistent` | 常驻并保留状态；`isolated` 每次新建独立进程，结束后销毁。 |
| `workdir` | 当前目录 | 执行前切换目录，路径无效则拒绝脚本；常驻模式会保留该目录。 |
| `timeoutMs` | `120000` | 执行超时，单位毫秒，不含排队等待。 |

同一常驻会话串行执行，不同 DSH 会话互相独立。独立调用占用同一个进程池，每次有启动开销；容量不足时提示重试，不挤掉常驻会话。

输出使用 PowerShell 表格和列表格式。需要结构化字段时使用 `ConvertTo-Json`；需要合并输出流时使用 `2>&1` 或 `*>&1`。

## 设置

打开设置侧栏的 **pwsh 设置**，或插件行的配置按钮。两个开关默认均**关闭**，统一作用于当前 profile 的所有预设和会话，点击**保存**后生效。

| 设置 | 配置键 | 行为 |
| --- | --- | --- |
| 强制使用 pwsh_run | `enforcePwshRun` | 拒绝普通原生 `pwsh` 调用，引导模型改用 `pwsh_run`。只读会话、明确后台任务和有效的更高权限请求仍可使用原生工具；提权仍需宿主审批。 |
| 删除前先确认范围 | `enforceFileRemoval` | 拦截 `pwsh`、`pwsh_run` 和 `bash` 中常见的直接删除命令，引导模型先审阅删除计划。 |

护栏检查工具入口与常见脚本语法，无法分析所有子程序或覆盖任意文件删除。

## 文件回收与临时目录

通过 `file_remove` 生成固定清单：

```json
{"action":"plan","paths":["D:/project/node_modules"]}
```

核对返回的目标后，另行确认回收：

```json
{"action":"execute","planId":"<计划 ID>"}
```

小清单展示全部条目；大目录返回绝对根目标、数量、总字节数、摘要和预览。完整明细通过分页读取：

```json
{"action":"list","planId":"<计划 ID>","offset":0,"limit":128}
```

按返回的 `nextOffset` 继续，直到它为 `null`。**512 仅是小清单展示阈值。** 默认可扫描 25 万个文件、目录及链接条目；超过扫描预算时，不会生成可执行计划。

长操作返回 `operationId`，使用同一工具的 `action: "status"` 查询，或 `action: "cancel"` 请求取消；`waitMs` 范围为 0–10000。完成后的 `result` 包含原操作响应。

- 计划仅用一次，完整扫描结束后两分钟到期。执行前重新扫描整树，检测到目标或会话边界变化就拒绝。
- Windows 路径进入真正的 Windows 回收站，Linux 原生路径使用 `gio trash`。回收失败不会转为永久删除；受限会话可能需要为该计划显式申请宿主批准的提权。
- 内部符号链接和 Windows junction 只处理链接本体，不遍历目标。根目标及祖先中的链接、挂载点、保护根和 `.git` 路径均拒绝。
- 取消不会撤销已经完成的回收。重试前先核对返回结果与剩余目标。

测试或构建产物可通过 `file_temp` 的 `action: "create"` 创建新目录，取得 `tempId`；结束后用 `action: "clean"` **永久清理该登记目录及其内容**。已有目录不能注册。大目录预算、进度、取消和链接检查同样适用。

审批示例、完整限制与失败处理见[删除工具指南](docs/file-removal.zh-CN.md)。

## 配置

进程参数与扫描预算在现有的 `pwsh-run` bundle 条目中配置；两个即时护栏开关见[设置](#设置)。

| 配置键 | 默认值 | 说明 |
| --- | --- | --- |
| `pwshPath` | `pwsh` | PowerShell 7 可执行文件，默认通过 `PATH` 解析。 |
| `timeoutMs` | `120000` | 脚本默认超时，单位毫秒。 |
| `idleMs` | `1800000` | 空闲会话保留时间，单位毫秒。 |
| `maxSessions` | `4` | 进程上限，包含独立调用；不会淘汰忙碌会话。 |
| `maxOutputBytes` | `8388608` | 单次 UTF-8 输出预算，错误另留 65536 字节；截断会明确提示。 |
| `allowUnconfined` | `false` | 沙箱策略服务缺席时，仍允许启动。 |
| `fileScanMaxEntries` | `250000` | 完整目录树条目预算，上限 2000000。 |
| `fileScanMaxBytes` | `67108864` | 正在扫描和保留的计划共享的序列化清单预算，上限 536870912 字节。 |
| `fileScanTimeoutMs` | `120000` | 扫描超时，上限 1800000 毫秒。 |
| `fileOperationTimeoutMs` | `300000` | 文件操作超时，上限 1800000 毫秒，与工具等待时间独立。 |

清单预算约束序列化数据量，并非整个进程的内存硬上限。沙箱策略缺席时默认拒绝启动，只有显式开启 `allowUnconfined` 才放行。

## 沙箱与限制

- `workspace-write` 使用 DSH 沙箱，`danger-full-access` 遵循宿主的完全权限语义。`read-only` 下 `pwsh_run` 与文件工具拒绝执行，应使用原生 `pwsh` 查询。
- 常驻调用超时会终止该进程及子进程树，并清空会话状态；独立调用超时只影响独立进程。权限、工作区或后端变化也会重建常驻状态。
- 不提供 TTY。`exit N` 的数字退出码不可获取；原生命令可检查 `$LASTEXITCODE`。输出流按类型分组，除非在脚本中自行合并。
- Windows 沙箱可能影响子进程管道、CIM 查询或 Schannel HTTPS，具体取决于宿主环境；见[运行限制](docs/runtime-notes.zh-CN.md)与[Schannel 调查](docs/dsh-windows-schannel.zh-CN.md)。
- Windows 上受限的 WSL Bash 会阻止调用 Windows exe 和访问 Docker socket。SSH agent 注入复用已有 socket，桥接进程须预先在围栏外启动；见[WSL 配置与限制](docs/llrun.md)。

## 更新

版本检查与安装由 DSH **插件页**统一管理。使用 npm registry 安装可接入这条更新路径，本插件不自带独立更新器。

本地 pnpm 的 `minimumReleaseAge` 策略可能推迟新版本安装；npm 元数据和下载节点也可能先后可用。刚发布的包下载返回 404 时，稍后重试，并核对实际安装版本。

更新前先结束正在执行的任务：插件替换会清空常驻状态。按宿主提示重载或重启；通过外部 CLI 安装后，重启 DSH 加载新代码。

## 开发与文档

```sh
pnpm install --ignore-scripts --config.auto-install-peers=false
pnpm test
pnpm run test:all
```

完整回归目前为 **15 组、303 项断言**，需要 Windows、Node.js 24、PowerShell 7、WSL 和可加载的 DSH 运行时。自动发现运行时失败时可设置 `DSH_MODULES` 或 `DSH_MODULES_ASAR`；发布验收不接受跳过。在未套用插件围栏的普通 WSL shell 中运行 `bash wsl/acceptance.sh`。

发版前先提交改动，再执行：

```sh
npm version patch -m 'chore(release): %s'
node scripts/release-check.mjs
git push --atomic origin main <tag>
```

[发布工作流](.github/workflows/release.yml)使用 npm trusted publishing 发布，并附带来源证明。

- [运行限制](docs/runtime-notes.zh-CN.md)
- [删除工具指南](docs/file-removal.zh-CN.md)
- [WSL 围栏](docs/llrun.md)
- [审计与修复记录](docs/pwsh-run-audit.zh-CN.md)
- [历史实测记录](FINDINGS.md)

## 相关项目

[DSH-build](https://github.com/citydirector/DSH-build) · [远程访问](https://github.com/citydirector/dsh-remote-access-proxy) · [DeepInfra 代理](https://github.com/citydirector/deepinfra-fusion-proxy) · [循环救援](https://github.com/citydirector/dsh-loop-rescue) · [UI Locate](https://github.com/citydirector/ui-locate-mcp) · [会话管理](https://github.com/citydirector/dsh-session-manager)

## 许可证

[MIT](LICENSE)
