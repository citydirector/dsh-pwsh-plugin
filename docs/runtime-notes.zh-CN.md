# 常驻会话的运行边界

[返回 README](../README.zh-CN.md)

以下保留实现细节与历史测量，具体表现取决于宿主、权限和 PowerShell 环境。

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
- **升级会换掉会话。** 本插件不带自己的更新器，版本由 DSH 管理；替换插件会先把它停掉，
  而停掉本插件就会销毁它的会话 —— 所以真正装上新版的那一次，常驻 pwsh 进程已经不在了，下次调用重新拉起。
  只存在于该会话里的东西（变量、`Set-Location` 过的目录、import 进来的模块）随之丢失。实测
  v0.2.3 → v0.2.4 的一次安装：`$PID` 由 24820 变成 15632，安装前设的 `$global:` 变量读回来是空的。

  这里没有人问「现在有没有调用在跑」。更新是宿主执行的，本插件既不参与也不设闸门。版本比会话状态值钱，
  但这并不等于「什么都没发生」—— 别把不可重建的状态放在里面跨过升级。
