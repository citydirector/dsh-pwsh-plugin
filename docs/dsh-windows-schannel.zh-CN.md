# DSH Windows 沙箱与 Schannel 兼容性记录

记录日期：2026-11-12。来源为本机隔离实验及上游代码追溯；与本插件九组修复分开维护。

## 补充核实：curl 联网与 Windows PATH（2026-11-11）

本段核实 DSH 沙箱里的 curl 联网与 Windows PATH 是否符合既定语义。本段所有网络请求均为公开站点的只读请求，未修改网络、凭据、PATH 或沙箱配置。

### 结论

1. **不是全面断网。** 当前 workspace-write 的 Windows 沙箱可以建立 TCP，也能使用 HTTP；HTTPS 故障发生在系统 curl / Invoke-WebRequest 使用的 Windows Schannel 凭据获取阶段。
2. **这是当前沙箱令牌与 Schannel 的兼容性问题，不是设计上禁止联网。** 已安装的 `@deepseek-ai/dsh-sandbox-windows-acl` 0.2.2-rc.1 的中文边界说明（第 127 行）明确写“写入与删除受限；读取、网络与进程可见性不受限”。
3. **当前 Windows PATH 正常。** 旧的 Machine PATH 整段丢失没有复现。
4. **WSL 围栏禁止执行 Windows exe 是预期限制。** 借 cmd.exe / pwsh.exe 从 WSL 查询 Windows 环境会被拦，与 Windows 侧读取 PATH 的问题不同。

### 本轮对照矩阵

| 环境 / 工具 | 请求 | 结果 |
|---|---|---|
| workspace-write，pwsh_run，系统 curl 8.22.0 / Schannel | http://example.com/ | HTTP 200，exit 0 |
| 同上 | https://example.com/ | TCP 约 0.048s 建立；TLS 未建立，HTTP 000，exit 35 |
| 同上 | https://registry.npmjs.org/ | TCP 约 0.053s 建立；TLS 未建立，HTTP 000，exit 35 |
| workspace-write，原生 pwsh，系统 curl | https://example.com/ | 同样 exit 35，排除本插件独有故障 |
| workspace-write，pwsh_run，Invoke-WebRequest | https://example.com/ | 最内层 Win32Exception：安全包中没有可用的凭证 |
| 正常令牌，原生 pwsh，**同一系统 curl** | https://example.com/ | HTTP 200，exit 0 |
| 正常令牌，Invoke-WebRequest | https://example.com/ | HTTP 200 |
| workspace-write，Windows Node.js 的 https 模块 | https://example.com/ | HTTP 200，exit 0，未关闭证书校验 |
| 当前 WSL 围栏内，Linux curl 8.14.1 / OpenSSL 3.5.6 | https://example.com/ | HTTP 200，exit 0 |

Windows curl 的原始错误：

> curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)

受限进程的完整性 SID 为 S-1-16-4096（Low），正常对照为 S-1-16-12288（High）。这个对照确认问题随当前 Windows 沙箱令牌出现；本轮没有进一步分离 Low 完整性和 WRITE_RESTRICTED 各自的贡献，也没有证明所有 Windows 主机必然如此。此前记忆中有类似结论，本段以本轮本机实测为依据。

### PATH 核对

- 当前 PowerShell 7.6.8。Process PATH 长 1087，Machine PATH 长 471，User PATH 长 588；三者可读取。
- 逐项展开 Machine PATH 中的变量，再与进程 PATH 忽略大小写和尾斜杠比对：**缺失项 0**，没有未展开的变量引用。
- System32 存在；Get-Command 能解析 curl.exe、cmd.exe、wsl.exe、git.exe。curl 落在 Windows System32，后端是 Schannel。
- WSL 自己的 PATH 也含 System32，但执行 Windows cmd.exe 返回 126 / Permission denied。这是 llrun 阻止 Windows interop 的既定行为，不能据此判定 PATH 缺失。

### 目前可用的路径与范围

Windows 沙箱内需要 HTTPS 时，Windows Node.js 的 https 已验证可用；纯 Linux 网络操作可使用 WSL curl；读取网页也可以用宿主提供的抓取工具。Windows 路径与文件操作仍走 Windows 工具。

如果程序必须依赖 Schannel，应作为 Windows 沙箱后端的兼容性问题单独处理，不能通过修改 PATH 解决，也不应默认放开全部文件权限来掩盖。只读模式的独立进程、本机其它 curl 构建、UAC 标准用户和其它主机未在本段补测；不把这张矩阵扩大成所有环境的保证。

## 归因追溯：Schannel 故障由谁引入（2026-11-12）

本段追溯预期外 HTTPS 故障的引入层与来源提交。本段只做归因、记录与一次性对照，不修改生产沙箱或插件实现。

### 归属结论

**故障触发点在 DSH 上游 Windows ACL 后端的受限令牌构造。** 当前系统 curl 使用 Schannel，在带 restricting SIDs 的 WRITE_RESTRICTED 令牌下无法取得出站 TLS 凭据。这是该安全机制在本机暴露的兼容性缺陷；不能解释成产品有意禁止联网。

- pwsh_run 只是委托宿主：plugin/index.mjs:204 解析策略，:226 调用 sandbox.confine(plain, policy, signal)，:230 使用返回的 confined.argv 启动。它没有实现 CreateRestrictedToken。
- 原生 pwsh 在同一策略下同样失败，排除插件独有的会话协议或编码处理。
- 当前桌面归档的 dsh/node_modules/@deepseek-ai/dsh-sandbox-windows-acl/lib/types-Cl07j3lG.js 中，createRestrictedToken 函数与本轮测试使用的便携包逐字相同；两者包版本均为 0.2.2-rc.1，桌面 VERSION 为 fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159。
- 本地 DSH-build 的 portable/patch-windows-acl-runner-console.mjs 只调整 ffi.ts / runner.ts 的控制台处理，没有改 token.ts。本轮直接调用 AclSandbox 的进程启动接口也能复现，未经过本插件的 PowerShell 服务端。

### 隔离变量，而非只比较高低完整性

同一台 Windows、同一个 System32 curl.exe、同一个 https://example.com/，均为公开页面只读请求。探针父进程经审批使用正常令牌；仅在该一次性进程中调整 Win32 API 的实参，测试后恢复。所有 AclSandbox 实例均设 manageDacls:false，未改变磁盘 ACL、注册表或生产配置。

| 对照令牌 | 完整性 | CreateRestrictedToken flags / SID 数 | curl 结果 |
|---|---|---|---|
| 正常父进程 | High | 不创建受限令牌 | HTTP 200 / exit 0 |
| 仅降完整性，不加 restricting SID | Low | 0 / 0 | HTTP 200 / exit 0 |
| 仅裁剪特权，不加 restricting SID | High | DISABLE_MAX_PRIVILEGE = 1 / 0 | HTTP 200 / exit 0 |
| 写限制与 restricting SID，不裁剪特权 | High | WRITE_RESTRICTED = 8 / 2 | HTTP 000 / exit 35 |
| 当前正式构造，仅保留 High | High | 9 / 2 | HTTP 000 / exit 35 |
| 当前正式构造 | Low | 9 / 2 | HTTP 000 / exit 35 |
| 恢复 Authenticated Users | High | 9 / 3 | HTTP 000 / exit 35 |
| 重建初版广 SID 列表和 flags | High | 13 / 6 | HTTP 000 / exit 35 |

flags 9 = DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED；flags 13 另含历史 LUA_TOKEN。当前 read-only 的两个 SID 是 logon SID、Everyone；初版广列表另含 Authenticated Users、INTERACTIVE、LOCAL 与一个写能力 SID。

所有 exit 35 的有效对照均返回：

> curl: (35) schannel: AcquireCredentialsHandle failed: SEC_E_NO_CREDENTIALS (0x8009030e)

由此排除“只要 Low 就不能用 Schannel”和“仅因裁剪特权而失败”；恢复 Authenticated Users 也不能修复。这里定位到的是**写限制令牌与 restricting SID 的组合**，没有声称限制 SID 中某一个成员是单独根因，也没有定位 Windows 内部哪个访问检查返回拒绝。

额外尝试进一步拆开该组合时，WRITE_RESTRICTED / 零限制 SID 的进程退出 3221225794（0xC0000142），flags 0 / 两个限制 SID 的进程退出 3221225781（0xC0000135）。这两组连 whoami / curl 都未正常启动，**属于无效 TLS 对照，不计为网络失败证据**；本轮不继续扩大这些变体。随后查询 System / Application Popup，最近 12 分钟没有新事件。

### 来源提交链

以下日期均为 UTC；作者为 Git 提交记录中的 author，不把提交元数据解释成人为故障责任。

| 上游提交 | 日期 | 内容及本轮判断 |
|---|---|---|
| [f64ba40](https://github.com/deepseek-ai/deepseek-harness/commit/f64ba40f43961fc65b7e1724132708a0b6d163cf) | 2026-08-07 17:24:33 | Huanqi Cao，feat(sandbox): Windows ACL write-restriction sandbox (restricted-token runner)。首次加入该后端及受限令牌构造；本机重建初版参数也复现同一 TLS 错误，是可追溯的机制来源。 |
| [441927c](https://github.com/deepseek-ai/deepseek-harness/commit/441927c5268e1abd2be024d3b5bb69e3869b6f06) | 2026-08-08 | 为封堵 C 盘根的越界写入而移除 Authenticated Users；本轮恢复该 SID 仍失败，不能把本次故障归给这一处收紧。 |
| [d5ad3ba](https://github.com/deepseek-ai/deepseek-harness/commit/d5ad3baeb5d531e31da5e586c3ec3ebedd825169) | 2026-09-18 | 增加 Low 完整性及目录标签，堵 FILE_DELETE_CHILD 删除旁路；仅 Low 的 TLS 对照成功，不能把它当作本次故障引入点。 |
| [bdd75ca](https://github.com/deepseek-ai/deepseek-harness/commit/bdd75ca1a0ce122a4801fa0e24d26f19159c071b) | 2026-10-26 | Huo Yaoyuan，去掉 LUA_TOKEN 以支持内置 Administrator / WDAGUtilityAccount；带/不带 LUA 的已测组合均失败，不是该修补造成。 |

首次提交的父提交为 4c2d20dbf7709ce88da5f01b163c8daaa1f087aa。初版 token.ts 的关键调用是 DISABLE_MAX_PRIVILEGE | LUA_TOKEN | WRITE_RESTRICTED，列表为 world / logonSid / authUser / interactive / local / writeSid。当前桌面编译件的调用为 flags 9，read-only 列表为 logonSid / world，workspace-write 另加写能力 SID。

这是一条**代码来源 + 本机参数复现**的归因链；未安装并运行全部历史 DSH 版本，不能宣称已证明每个旧版本在当时 Windows 系统上的表现。当前版本上游 runner.spec.ts 中未检出 curl / Schannel / HTTPS / Invoke-WebRequest 用例；这只能说明该测试文件未覆盖，不能扩大成全仓所有测试都没有。

### 记录更正与后续方向

此前记忆 dsh-sandbox-lowil-schannel-no-credentials 将完整沙箱与 High 的差异直接归因于 Low，证据不成立。本轮仅 Low 成功、High + 写限制失败，已据此更正；前段“未分离变量”的观察保留为历史记录，以本段为进一步结论。

后续应在 DSH Windows ACL 后端增加 Schannel / curl / Invoke-WebRequest 回归，并研究保留文件写入与删除边界的兼容方案。不能直接撤 Low（会回开删除旁路，且本轮 High + 写限制仍然失败），也不能恢复宽 SID 列表（本轮无效，历史上还会回开越界写入）。Node.js HTTPS / WSL OpenSSL 的可用性已在前段实测，可作为沙箱内现有的网络路径。

本轮没有修改上游、应用归档、生产权限或系统网络配置，没有创建公开 issue / PR；归因实验只覆盖本机 Windows 构建，其他系统及 UAC 标准用户仍需独立验证。

## 新版上游复核（2026-11-12）

联网核对时，最新标签为 [dsh-v0.2.2-rc.2](https://github.com/deepseek-ai/deepseek-harness/tree/dsh-v0.2.2-rc.2)，commit ddac96760b6edf8fa0fe17cbdcf0b512f4c12b2c；master 为 e8f7b93a344964de3dca1ace9e72b6e4d6de87cb，提交时间2026-11-11T02:49:46Z。发布标签与master的Windows ACL后端src树相同。

与本机fcc0ad462172522aaf5c93a7b2e01f6b9f0b0159相比，token.ts、runner.ts、spawn.ts、ffi.ts、acl.ts、grant.ts均为相同Git blob；tests树也完全相同。src仅index.ts新增导出isTempRootInsideWorkspace，path-boundary.ts把既有临时目录包含关系判断抽成该函数；没有改变Schannel、令牌、进程启动或凭据处理。token.ts仍为DISABLE_MAX_PRIVILEGE | WRITE_RESTRICTED加logon SID / Everyone / 写能力SID。

结论：截至该次核对，最新发布与master中没有针对此故障的修复，不能指望升级到rc.2恢复系统curl/IWR。此为源码与历史差异核对，没有安装新版运行；仍不泛化所有Windows主机。API查询dev分支失败，未对不存在或不可取的dev分支作结论。

上游已有相同现象报告：[讨论3207](https://github.com/deepseek-ai/deepseek-harness/discussions/3207)（2026-08-18）及[讨论4163](https://github.com/deepseek-ai/deepseek-harness/discussions/4163)（2026-08-23；2026-10-02回复建议OpenSSL）。帖子是旁证，结论以实际源码差异为主；不沿用帖子里未经隔离的特权归因或把pip/git一概判定为Schannel客户端。
