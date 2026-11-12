# pwsh_run 审计：权限、多会话和命令兼容性

审计日期：2026-11-11（America/Los_Angeles）。审计对象：0.2.17，提交 `2ea7783103328cbdf568aeae596aa9d299f661fc`。

结论：普通串行调用的主要功能正常，但目前不能宣称权限切换安全、多会话互不影响。复用了旧权限的进程、淘汰忙会话、首次并发创建和队列超时是优先处理项。本轮只审计，未修改运行实现、安装件、全局配置或发布版本。

> A1–A9 以下记录的是上述提交的审计基线。当前工作区的修复与复验见文末「本地修复验收」。

## 方法与验证范围

- Windows 11、PowerShell 7.6.8、Node.js 24.22.1。直接加载仓库模块，通过隔离的工具注册上下文调用真实 apply/execute；协议边界另用模拟子进程做确定性验证。
- 权限边界使用真实 DSH LocalSandboxProvider。测试目录 A/B 都位于本仓库临时区；“越界”指离开子进程获准的 A，仍未离开本仓库。
- 运行当前相关回归：itest 17、plugintest 15、e2e-real-subprocess 8、sandboxtest 7、denialtest 11、metatest 23，共 **81 条断言通过**。这不代表下列新增场景已被原测试覆盖。
- 为避免既有测试往仓库外落探针，回归在临时副本运行，导入仍指向未修改的生产模块。e2e 副本的 Start-Process 补了 -NoNewWindow，避免已知的控制台初始化弹窗。未修改原测试。
- 当前受限令牌无法支持 Node 内部的部分子进程管道；真实沙箱与进程测试使用经审批的正常令牌启动，再由 DSH confine 构造被测受限进程。这不是在受限调用失败后绕过生产边界。
- 未在 Linux/macOS 的 PowerShell、不同 PowerShell 7 小版本、UAC 标准用户、全部第三方原生命令上重做环境矩阵。没有证据支持“各种环境全部正常”。

## A1：复用会话不重新核对权限与工作区（高，优先修）

位置：[会话缓存命中](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L182)、[只在创建时解析 policy](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L204)。

会话缓存键只有 session ID。命中活进程就直接返回；本次 policy、workspaceRoot 以及策略服务是否仍存在均未重新验证。Windows ACL 令牌确实能约束进程，但它约束的是创建时的边界。

真实沙箱结果：

| 同一个 ID 的操作 | 结果 |
|---|---|
| workspace-write，根 A，在 A 写 | WROTE |
| 同上，在 B 写 | DENIED，磁盘上没有该文件 |
| 将 policy 切为 read-only，在 A 写新文件 | **WROTE，文件存在**；未再次解析 policy |
| 使用新 ID 启动 read-only | 正确拒绝启动，提示改用原生 pwsh |
| 将旧 ID 的工作区根改为 B，再在 A 写 | **WROTE** |
| 同上，在 B 写 | **DENIED** |

模拟上下文还复现了 danger-full-access → read-only 后仍执行脚本。以上是工具复用逻辑的缺陷；没有宣称它绕过了 DSH 所有外层授权机制。

建议：每次 acquire 先解析当前有效 policy，以 mode、规范化 workspaceRoot、执行后端与其它影响边界的配置核对进程身份。边界变化时不能复用旧进程；新策略只读或不可解析时应先拒绝本次执行。同步保护正在创建和正在执行的旧实例，不能仅换 Map 的键。

## A2：容量淘汰和空闲回收会杀正在执行的会话（高）

位置：[容量淘汰](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L235)、[空闲回收](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L256)、[lastUsed 更新](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session.mjs#L175)。

两条回收路径都未检查执行或排队状态。lastUsed 记录开始使用的时间，不代表真正闲置的起点。

真实 PowerShell 复现：

- 使用生产默认 maxSessions=4，预热 A/B/C/D；让 A 执行任务，再访问 B/C/D，最后创建 E。**E 淘汰了仍在执行的 A**，A 返回 no response，未完成原任务。
- maxSessions=1 时同样复现 A 被 B 杀掉。
- 将 idleMs 缩短为 150ms，正在运行 600ms 的任务被“空闲”回收。默认 30 分钟时相同代码会影响持续超过阈值且没有后续访问的调用；这个默认时长场景没有实际等待 30 分钟。

建议：维护 active/queued/pending-start 计数，只回收真正空闲的实例，完成调用后再开始计算闲置时间。池满且全部忙时应等待容量或清楚拒绝新请求，不能腾位置就杀旧任务。

## A3：首次并发会创建两个进程，状态分叉（高）

位置：[读取 Map 后先 await 目录](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L182)、[之后才写 Promise 占位](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L199)。

注释声称 Promise 占位避免重复创建，但占位前已有 await。首次不带 workdir 的两个并发请求都可能看到缓存为空。

真实沙箱复现：同一新 ID 的两个 Promise.all 请求分别返回 PID 28584 和 13440，spawn 数为 2。两个请求写入不同的全局变量值；下一次调用只看到最终保留的那个进程的值。

因此问题是状态分叉，不是协议输出混到一起。被覆盖的进程还可能失去池的追踪；本轮探针显式回收了自己创建的所有句柄。

建议：在第一个 await 前原子登记“正在创建”的槽位，让所有并发调用等待同一个 Promise。失败和淘汰时须核对槽位代次，旧实例的回调不得删掉新实例。

## A4：排队请求的超时会杀前面的任务，预取消请求仍执行（高）

位置：[在 session.run 排队前创建外层定时器](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L296)、[串行队列](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session.mjs#L163)、[中止后整会话淘汰](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L321)。

真实复现：

1. 同一 ID 先运行 Start-Sleep 7 秒，timeoutMs=9000；这条任务本应正常完成。
2. 50ms 后排入另一条 timeoutMs=100 的短任务。
3. 短任务尚未执行，外层 100+5000ms 的预算先到，便销毁整个会话。
4. 两个请求都返回 no response。长任务约 14012ms 才返回，正常结束输出丢失；短任务文案还将 100ms 四舍五入为“within 0s”。

另用真实 PowerShell 和已 aborted 的 AbortController 调用，仍得到 RAN-DESPITE-CANCEL。监听器只接收未来的 abort，没有先处理既有中止状态。

建议：分开排队等待和脚本运行的预算；排队取消只移除那一个请求，不终止当前任务。开始 acquire、入队和实际发送前都检查 signal.aborted。实际正在执行的调用需要取消时，再按已声明语义销毁其会话。

## A5：dispose 不结算在途 Promise（中，与 A2/A4 叠加）

位置：[dispose](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session.mjs#L146)、[#fail 的 dead 短路](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session.mjs#L135)。

dispose 先设置 dead=true，没有 reject pending。后续 handle.done 再调用 #fail 时直接返回。模拟协议中等待的 run 在 dispose 后仍 pending；真实调用往往要等外层超时后才结束，而不能及时收到准确的“会话被回收”原因。

建议：显式拒绝所有在途请求并清空状态，再终止/等待进程；自然死亡和主动销毁共用幂等的结算路径。

## A6：常见 PowerShell 对象输出和顶层语法不完全兼容（中）

位置：[用脚本块包装正文并逐对象强转字符串](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session-server.ps1#L127)。

| 真实命令 | 返回 |
|---|---|
| [pscustomobject]@{Name='audit';Value=42} | @{Name=audit; Value=42} |
| Get-Process -Id $PID | System.Diagnostics.Process (pwsh)，缺少通常表格里的 Id/CPU 等字段 |
| 显式 Select-Object 后 ConvertTo-Json -Compress | 字段完整 |
| using namespace System.Text 后使用 StringBuilder | A 'using' statement must appear before any other statements in a script. |

脚本经过字符串传输没有转义损坏，但“原样送达”不等于在普通脚本顶层执行的语义相同。Write-Host、Information、Debug 均可见，但被并为普通输出；Warning/Verbose/Error 保留各自类别。

建议：定义对象输出契约，显式按 PowerShell 格式化系统输出或选定结构化表示，不能用逐对象 [string] 替代默认显示；另处理 using/param/#requires 等顶层结构。这里只实测了 using namespace，没有把其它顶层结构都判成已复现缺陷。

## A7：输出上限不是实际字节上限，也不能限制服务端内存（中）

位置：[客户端计数与截断](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session.mjs#L111)、[隐藏 Console 内存流](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session-server.ps1#L49)、[输出集合累计](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session-server.ps1#L175)、[按索引读取但不移除](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session-server.ps1#L194)。

- 计数使用 text.length，即 UTF-16 代码单元。模拟协议设置 maxOutputBytes=4，中文中文实际 UTF-8 为 12 字节，仍完整交付且 truncated=false。
- 所有流共用同一个预算；注释“每个流各自计”与代码不符。达到上限后后续 Error/Exception/Fatal 也会被丢弃，虽仍保留状态哨兵，但错误原因可能不见。
- 客户端截断不等于服务端停止累积。PSDataCollection 本次调用内仍保存已发出的编码结果。
- [Console]::Write('X' * 4000000) 的文本被吞进 SafeOut 的 MemoryStream，并未按调用清空。一次真实测量中，强制 GC 后的托管内存从 14895168 增至 19368784 字节；源码同时确认了无清理路径。这里不把内存差值全部精确归因给单一对象。
- 继承 stdout/stderr 的原生子进程写入 drain 文件，源码仅在下一次调用开始时截零；单次调用期间没有文件大小预算。这一点是静态发现，没有用填盘实验验证。

建议：按 Buffer.byteLength(text, 'utf8') 统计并约束协议帧大小；给错误保留独立预算；服务端消费后移除集合内容；吞掉的 Console 输出用空输出流或受限环形缓存；明确 drain 的资源上限。

## A8：启动失败诊断和加固警告会丢失（中）

位置：[启动握手](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session.mjs#L194)、[首次警告发送](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/session-server.ps1#L167)。

- 模拟首次握手返回 TAKEOVER-FAILED 警告，startSession 将其丢弃，用户第一次调用的 warn 数组为空。服务端把“第一次调用”当成用户调用，实际上先被内部版本探针消费。
- 握手中的 run 抛错会跳过后面的 dispose 和 stderrTail 拼接分支。模拟退出 code=127，terminate 调用数为 0；对已退出进程无需再杀，但其它握手失败类型仍缺统一清理。
- 真实基线曾因测试 TEMP 放在沙箱 workspace 内而被 runner 拒绝。runner 的明确原因是 Windows ACL temp root must be outside the workspace，而工具只报告 session died code=127。将测试 TEMP 移到获准的同级目录后，原七条沙箱回归全过。这是测试设置错误，未计为插件沙箱创建失败；丢诊断则确实来自插件。
- 20 秒握手 race 的定时器未 clear，也未 unref；成功启动后仍留到到期。这是源码确认的资源问题。

建议：try/catch/finally 统一握手失败清理、补 stderr 尾巴、撤销定时器；将启动警告存为会话属性并在第一条用户调用显示；句柄隔离未成立时，应明确决定是否拒绝继续使用。

## A9：超时参数没有合法范围上限（低）

位置：[只做正数和取整](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L277)、[加 5000ms 后交给 AbortSignal.timeout](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L296)。

模拟工具传入 timeoutMs=4294967295 后，抛出：

> The value of "delay" is out of range. It must be >= 0 && <= 4294967295. Received 4_294_972_295

参数 schema 允许 number，没有 maximum。小于 1 的正小数还会被截为 0。这些错误发生在会话可能已经启动之后。

建议：在 acquire 前验证为受支持范围内的正整数；为 RESPONSE_GRACE_MS 留足上界，返回明确参数错误。

## 另一个需要约定的接口边界

[缺少 session ID 时使用 default](https://github.com/citydirector/dsh-pwsh-plugin/blob/2ea7783103328cbdf568aeae596aa9d299f661fc/plugin/index.mjs#L171)：所有没有身份的调用会共用进程。真实 DSH 正常请求带 session ID，本轮没有发现真实会话 ID 冲突；这不是“正常两个会话会串变量”的证据。若支持其它调用方，应明确拒绝无 ID，或给调用方分配不会相撞的身份。

## 已确认正常和既定限制

正常项：不同真实 ID 的变量、环境变量分别保持 A/B；热会话的串行输出不混线；字面 here-string、中文 UTF-8 原生 stdout/stderr 与 stdin、非零 LASTEXITCODE、异常后恢复、普通超时及重建正常。ThreadJob 的简单 Wait/Receive 流程返回 THREAD-OK。

既定限制：[运行边界说明](runtime-notes.zh-CN.md)。Read-Host 的实测结果为不支持交互的明确错误；exit 7 结束本次 runspace 调用，但不提供该 exit 数字；Console.WriteLine 被吞；受限令牌下部分原生程序的管道创建被拒；升级/卸载插件会销毁常驻会话。它们应清楚告知调用方，不能全部当成新发现的 bug。

本轮没有更改凭据、登录状态、PATH、WSL 服务、系统注册表或用户目录。也没有测试破坏性命令或执行填盘、失控输出实验。

## 推荐修复顺序及验收条件

1. 先修 A1/A3：权限身份和创建槽位。验收同 ID 切只读/切根时绝不继续使用旧边界；首次并发只 spawn 一次。
2. 再修 A2/A4/A5：忙会话保护、排队取消与超时、销毁结算。验收第五个会话不能杀前四个中的忙任务；排队短任务超时不能影响当前任务；dispose 后请求立即结束。
3. 再修 A7/A8：资源上限与启动诊断。验收中文字节预算、错误保留、Console 无持续积存、握手失败可诊断且无遗漏清理。
4. 最后处理 A6/A9 与文档契约：常见对象字段、顶层 using、参数边界。补测各受支持 OS/PowerShell 版本和 UAC 标准用户。

本报告是修复输入；现有 81 条回归全部通过，不消除上述可复现缺陷。临时探针完成后回收，生产源码保持本次审计的原状。

## 独立的宿主网络问题

Schannel / curl / Invoke-WebRequest 的对照矩阵、令牌变量隔离、来源提交和新版核对，已移至 [DSH Windows 沙箱与 Schannel 兼容性记录](dsh-windows-schannel.zh-CN.md)。这是宿主后端问题，不计入本插件 A1–A9 修复。

## 本地修复验收（2026-11-12）

以下结果记录修复发版前的本地验收；安装件需更新到包含这些修复的版本后才会使用新实现。原始审计结果保留为历史基线。

| 组 | 已实现行为 | 验证 |
|---|---|---|
| A1 | 每次解析当前策略、工作区和沙箱后端，变化就销毁旧进程；只读拒绝正文；无 ID、工作目录服务错误、无效 confine 结果均拒绝 | 真实沙箱同 ID 降权、A→B 切根；模拟后端变化和错误分支 |
| A2 | 容量与 idle 只回收没有执行、排队或启动请求的实例；满池全忙明确拒绝；结束后计算闲置 | 默认四个实例同时忙，第五个不能淘汰它们；缩短 idle 不打断长调用 |
| A3 | 第一次 await 前登记 ID 槽位，创建与执行共用队列 | 真实沙箱首次并发返回同一 PID，状态累计到 2 |
| A4 | 从实际发送起计超时；预取消不执行；队列取消只影响自身；执行中取消才销毁 | 5150ms 的队列等待不触发旧的 100+5000ms 误杀；三种取消分支 |
| A5 | 销毁先结算 pending，再幂等终止；卸载也中止仍在握手的启动 | dispose 立即拒绝在途调用；卸载握手进程被终止且未执行正文 |
| A6 | 正文保持顶层，workdir 单独设置；对象标准格式化；信息、调试分流；显式核验 requires | 真 PowerShell 的 using、param、对象表格、Get-Process、模块及版本要求 |
| A7 | 两侧 UTF-8 预算、错误独立 64KiB、帧限长；消费后清集合；Console 与继承输出接空设备 | 中文截断保留错误、空记录限额、帧拆分重组；连续大段 Console 写入后保留内存增量约 28KB |
| A8 | 启动统一清理和计时器撤销，保留 stderr 尾部与首次警告；隔离失败拒绝运行 | 模拟握手失败、超时、警告一次性显示；真实隔离与原生 UTF-8 输出 |
| A9 | acquire 前校验整数毫秒 1–2147478647；压缩启动源码并检查命令行预算 | 非法/越界超时在 spawn 前拒绝；gzip 启动与超限检测 |

完整回归：protocoltest 6、lifecycletest 16、itest 30、plugintest 15、e2e-real-subprocess 8、sandboxtest 12、bashtest 31、bash-e2e 11、denialtest 11、metatest 23，合计 **163 项**。回归失败会返回非零退出码。

平台复验仍限 Windows 11 / PowerShell 7.6.8 / Node 24.22.1 与本机 DSH LocalSandboxProvider。Linux/macOS、其它 PowerShell 小版本、UAC 标准用户尚未重测。`#requires -RunAsAdministrator` 不能用“这是受限令牌”作为必然拒绝的测试前提：受限令牌仍可能保留管理员组身份，因此沙箱负向用例采用确定不满足的版本 999.0。

宿主 Schannel 故障不由这些修复解决，仍见独立记录。
