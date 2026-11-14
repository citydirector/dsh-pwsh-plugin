# 删除确认与受控临时目录

`enforceFileRemoval` 默认关闭。在「pwsh 设置」中打开「删除前先确认范围」并保存后，常见的 `pwsh`、`pwsh_run`、`bash` 删除命令会在原脚本执行前被拒绝，提示 Agent 使用下面两种工具。保存开关保留现有 PowerShell 进程和变量。

## 普通文件：先计划，再确认回收

第一次调用 `file_remove`：

```json
{"action":"plan","paths":["D:/project/old-output/*.log"]}
```

工具把相对路径与最后一段通配符展开为绝对目标，完整扫描目录树。小目标完整展示；大目录返回绝对根目标、文件/目录/链接数量、字节总数、摘要哈希和预览，并提供 `planId` 与到期时间。Agent 应先核对范围与摘要，需要明细时分页读取，再单独调用：

```json
{"action":"execute","planId":"<上一步的 ID>"}
```

计划只用一次，从完整扫描结束起两分钟到期；最多 64 个根目标、32 个待确认计划。目标、目录内容、当前会话、工作目录或沙箱策略发生变化，需要重新计划。审批等待和分页不会延长有效期。根目标与祖先中的链接、未知 reparse point、挂载点、设备/特殊文件、磁盘根、用户主目录及其祖先、当前 workspace 及其祖先、`.git` 路径均拒绝。选定目录内部的普通符号链接、悬空符号链接与 Windows junction 作为叶子记录身份与链接目标，回收或清理只处理链接本体，不遍历外部目标；这允许普通 pnpm 目录树通过完整扫描。只支持最后一个路径组件的通配，不求值 PowerShell 变量或任意脚本。

## 大目录、分页与操作状态

512 只是小清单直接展示阈值，也受输出字节预算限制，不再限制扫描或清理规模。完整清单保存在插件实例内存中，分页响应受 256 KiB 预算限制：

```json
{"action":"list","planId":"<ID>","offset":0,"limit":128}
```

`limit` 为 1–256，实际页大小可能因字节预算减小。后续请求使用返回的 `nextOffset`，直到它为 `null`；不能凭预览猜测未展示部分。执行前工作进程重新扫描整树并比对摘要，不只检查根目录 mtime；变化即拒绝。

调用默认最多等待 10 秒，`waitMs: 0` 可立即取得后台操作 ID。扫描、回收与临时清理尚未完成时返回 `operationId`，使用同一工具查询或取消：

```json
{"action":"status","operationId":"<操作 ID>","waitMs":10000}
{"action":"cancel","operationId":"<操作 ID>","waitMs":10000}
```

状态为 `running`、`completed`、`failed` 或 `cancelled`；`progress` 提供阶段、累计条目/字节和已经完成的根目标。完成后 `result` 是原操作响应，规划的 `planId` 也从这里取得。状态保留五分钟，最多四个活跃操作、256 个保留状态；状态和分页仍校验会话与沙箱归属。后台每 250 毫秒复核边界，变化则中止，规划结束还会再次检查。

完整扫描有独立预算，可在 bundle 配置中调整：

| 配置 | 默认 | 上限 |
| --- | ---: | ---: |
| `fileScanMaxEntries` | 250000 个文件/目录/链接条目 | 2000000 |
| `fileScanMaxBytes` | 67108864 字节序列化清单 | 536870912 |
| `fileScanTimeoutMs` | 120000 毫秒 | 1800000 |
| `fileOperationTimeoutMs` | 300000 毫秒 | 1800000 |

清单字节预算在正在扫描和保留的计划之间共享，用于约束序列化数据量，并非整个 Node 进程的内存硬上限。工作进程逐条输出并计算摘要，不把全部明细一次塞进响应；宿主在预算内保留完整明细供分页。超预算、扫描超时、取消或协议截断时不会产生可执行计划，不能接受一个截断的目录树继续删除。文件操作预算从工作进程启动计算，和每次工具等待时间独立。

0.2.20 曾错误地比较 `ctx.get("sandbox")` 的代理对象引用：同一服务在两次调用间也会拿到不同代理，导致计划存在却报 `Plan belongs to another session, directory or sandbox boundary.`。修复后按底层服务身份比较；native 调用和两次独立 PTC 程序均已验证。真正换会话、工作目录、权限或后端时仍拒绝，不放松归属校验。

Windows 使用 `IFileOperation` 的 `FOFX_RECYCLEONDELETE`，执行前回调拒绝永久删除模式，错误停止操作；不会自动修 ACL 或改成永久删除。`/mnt/c`、`/mnt/d` 等路径在 Windows 宿主上转交真正的 Windows 回收站，不使用盘根的 `.Trash-1000`。Linux 路径使用 `gio trash`；不可回收时保留并报错，不回退到 `rm`。

Agent 确认清单与宿主审批是两件事。`workspace-write` 下回收站通常在工作区外，执行还需显式提供：

```json
{"action":"execute","planId":"<ID>","sandbox_permissions":"danger-full-access","justification":"仅将本计划中已核对的输出文件送入回收站"}
```

宿主审批服务必须返回本次允许；拒绝、取消或审批通道不可用都不会执行，也不应换一个 shell 重试。批准后再次检查会话权限边界和到期时间。`read-only` 下这两个文件工具均拒绝写操作，Windows 身份检查也无法在 ConstrainedLanguage 中启动，因此 `file_remove` 规划同样明确拒绝。

批量回收不是事务。先前成功的目标不会因为后面的文件被锁而还原；错误正文会带 `removed` 与诊断，不能把失败当作全部未执行。若进程在回收途中被取消或超时，应先重新检查现场，再为剩余目标创建新计划。

## 测试与构建：由工具登记临时目录

```json
{"action":"create"}
```

通过 `file_temp` 创建全新的随机目录，返回路径与 `tempId`；在里面放本次测试或构建产物。结束后调用：

```json
{"action":"clean","tempId":"<创建时返回的 ID>"}
```

`clean` **永久删除**这个登记目录及其内容。这是创建时就明确约定的临时清理范围，不需要另外生成删除计划；只能清理同一会话、同一权限边界创建的目录，清理前核对目录身份、所有者标记及完整树，使用相同的完整扫描预算、进度与取消机制，大于 512 条目的树也可清理。内部普通链接仅解除链接本体；根目标或祖先为链接、特殊文件或不支持的挂载仍拒绝。已有目录无法注册，目录名叫 `temp` 或 `_skadi_temp` 也不构成豁免。

每个实例最多登记 32 个临时目录。调用者负责在任务结束前调用 `clean`；插件卸载、重载、会话权限变更后不会擅自清理旧目录。登记仅在内存中，丢失登记后应按普通两阶段回收处理。开启护栏后，直接写在 shell 命令里的清理依然会被拦，应改用 `file_temp clean`；`node test/example.mjs` 等测试程序入口不因其内部清理逻辑而被阻止。

Windows 新目录创建时复制父 DACL 中现有的 capability SID 与拒绝项，补当前用户的继承授权；只作用于新对象，不修改已有目录。真实 Low 子进程已验证能写入与清理，正常用户进程也能访问。Low 标签本身不能解释一切；已有目录可能同时涉及 OWNER RIGHTS、DELETE 权限、锁或回收站策略。工具会报告错误及可读取的 DACL，不自动 `takeown`、`Set-Acl` 或放宽 Everyone。

Windows workspace 应使用默认 Windows 临时后端。WSL 原生 workspace 可指定 `backend: "wsl"`，通过现有 `custom-bash` / `llrun` 执行固定工作进程；需要 WSL 中可用的 Node 兼容运行时与 `gio`。本机已验证 Node 命令指向 Bun 时的兼容性。Linux 原生后端复用相同协议，但未在独立 Linux/macOS 宿主上验收。

## 能保证的范围

这是防止常见误操作的工具协议与入口检查，不是拦截所有文件删除的操作系统策略。它识别常见 `Remove-Item`、`rm`、`rmdir`、部分 `.Delete` / `.unlink` 等语法，不分析任意子程序、动态生成命令或全部语言语法。现有工具、编辑器与外部应用仍受它们自己的权限和审批控制。

执行前重读快照可以拒绝观察到的变化，但快照检查与实际回收之间仍存在并发窗口；不能保证对恶意并发修改的原子隔离。需要覆盖任意程序的删除行为，必须在沙箱/文件系统层收回删除权限，再由受控代理执行，超出这个开关的能力。

API 依据：[IFileOperation 标志](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperation-setoperationflags)、[PreDeleteItem 拒绝行为](https://learn.microsoft.com/en-us/windows/win32/api/shobjidl_core/nf-shobjidl_core-ifileoperationprogresssink-predeleteitem)。
