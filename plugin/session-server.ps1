# pwsh_run 常驻会话服务端 —— 已实测验证的参考实现
#
# 启动：pwsh -NoProfile -NonInteractive -EncodedCommand <base64(utf16le, 本文件)>
#   - -EncodedCommand 而非 -File，是为了不落地临时脚本文件；
#     启动字符串是 base64(UTF-16LE, 本文件)；命令行上限 32K，本文件换算后约 16.6K，安全在内。
#   - 不要用 -Command -：那是"读到 EOF 就退出"的一次性模式，无法常驻。
#
# 协议（客户端 → 服务端，每行一条）：
#   <id> <timeoutSeconds> <base64(utf8 脚本文本)>
#   保留控制行：QUIT
#
# 响应（服务端 → 客户端，每行一条）：
#   <<<B:id>>>           本次调用的输出开始
#   O:<base64>           输出流对象
#   E:<base64>           ErrorRecord（Write-Error / 非终止错误）
#   W:<base64>           WarningRecord
#   X:<base64>           异常消息（throw 或包装层自身异常）
#   S:<base64>           哨兵：ok=正常跑完 / threw=抛异常 / ran=被 exit 或超时打断
#   F:<base64>           BeginInvoke 本身失败
#   <<<T:id:0|1>>>       结束标记，1 表示超时被打断
#   <<<E:id>>>           整条响应结束
#   <<<BYE>>>            进程正常退出
#
# 关键设计决定（每条都有实测依据，见 ../../FINDINGS.md）：
#   1. 每次调用新建 PowerShell 实例、共享同一 Runspace。
#      单例实例在 throw 之后会让下一次调用静默返回空输出。
#   2. 原始 stdin/stdout 被协议独占，Console.In/Out/Error 换成安全流。
#      否则用户脚本一句 [Console]::In.ReadLine() 就会吃掉协议数据、整个会话失联。
#   3. *>&1 而非 2>&1：只合并 error 会漏掉 warning / verbose。
#   4. 边跑边吐（$out 增量读取）：超时被打断前的部分输出也能交付。
#   5. 每次调用前重置 $ErrorActionPreference：脚本内设成 'Stop' 会跨调用污染。

$ErrorActionPreference = 'Continue'
$Utf8 = [Text.UTF8Encoding]::new($false)
# 原始 stdin 交给协议读取器独占；再把 Console.In 换成安全空流
# 否则用户脚本一句 [Console]::In.ReadLine() 就会吃掉协议数据，整个会话失联（已实测）
$ProtoIn = [IO.StreamReader]::new([Console]::OpenStandardInput(), $Utf8)
$SafeIn = [IO.StreamReader]::new([IO.MemoryStream]::new([byte[]]@()), $Utf8)
[Console]::SetIn($SafeIn)
$ProtoOut = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), $Utf8)
$ProtoOut.AutoFlush = $true
# 原始 stdout 同样收回，避免用户脚本 [Console]::Out 直写污染协议行
$SafeOut = [IO.StreamWriter]::new([IO.MemoryStream]::new(), $Utf8)
[Console]::SetOut($SafeOut)
[Console]::SetError($SafeOut)

$RS = [RunspaceFactory]::CreateRunspace()
$RS.Open()
$Fmt = @'
$ErrorActionPreference = 'Continue'
$__pwshn = 'ran'
try {
  # *>&1 把全部流按发生顺序汇入管道（只写 2>&1 会漏 warning / verbose），
  # 再按对象类型逐条打标：顺序保真，同时保留 stdout / error / warning 的分流。
  . { __PWSHRUN_BODY__
  } *>&1 | ForEach-Object {
    if ($_ -is [System.Management.Automation.ErrorRecord]) { 'E:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) }
    elseif ($_ -is [System.Management.Automation.WarningRecord]) { 'W:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) }
    elseif ($_ -is [System.Management.Automation.VerboseRecord]) { 'V:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) }
    else { 'O:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$_)) }
  }
  $__pwshn = 'ok'
} catch {
  $__pwshn = 'threw'
  # PowerShell 会把真实异常包进一层 RuntimeException，EndInvoke 还会再包一层；
  # 逐层剥到最内层，模型看到的才是原始错误文本。
  $__e = $_.Exception
  while ($null -ne $__e.InnerException) { $__e = $__e.InnerException }
  'X:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$__e.Message))
} finally {
  'S:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__pwshn))
}
'@

while ($true) {
    $line = $ProtoIn.ReadLine()
    if ($null -eq $line -or $line -eq 'QUIT') { break }
    if ($line.Length -eq 0) { continue }
    $sp1 = $line.IndexOf(' '); $sp2 = $line.IndexOf(' ', $sp1+1)
    $cid = $line.Substring(0, $sp1)
    $to = [double]$line.Substring($sp1+1, $sp2-$sp1-1)
    $src = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($line.Substring($sp2+1)))
    $ProtoOut.WriteLine('<<<B:' + $cid + '>>>')
    $PS = [PowerShell]::Create()
    $PS.Runspace = $RS
    $out = [System.Management.Automation.PSDataCollection[psobject]]::new()
    $a = $null
    try {
      [void]$PS.AddScript($Fmt.Replace('__PWSHRUN_BODY__', $src))
      $a = $PS.BeginInvoke[psobject, psobject]($null, $out)
    } catch {
      # 语法错误在 AddScript 阶段就抛 ParseException，不会走到 $Fmt 的 finally，
      # 所以这里必须自己补哨兵，否则客户端分不清「语法错」和「协议崩」。
      $__e = $_.Exception
      while ($null -ne $__e.InnerException) { $__e = $__e.InnerException }
      $ProtoOut.WriteLine('X:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$__e.Message)))
      $ProtoOut.WriteLine('S:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes('threw')))
    }
    # 管道内每条输出已经是 "标记:base64" 的合法协议行（见 $Fmt），
    # 这里必须原样写出；再包一层 base64 会变成 "O:<b64(O:xxx)>"，客户端解不出来。
    $emitted = 0; $timedOut = $false; $sawSentinel = $false
    if ($null -ne $a) {
      $deadline = [DateTime]::UtcNow.AddSeconds($to)
      while (-not $a.IsCompleted) {
        while ($out.Count -gt $emitted) { $item = $out[$emitted]; $emitted++; if ($null -ne $item) { if ([string]$item -like 'S:*') { $sawSentinel = $true }; $ProtoOut.WriteLine([string]$item) } }
        if ([DateTime]::UtcNow -gt $deadline) { $timedOut = $true; break }
        [void]$a.AsyncWaitHandle.WaitOne(30)
      }
      if ($timedOut) { try { $PS.Stop() } catch {}; [void]$a.AsyncWaitHandle.WaitOne(1500) }
      else {
        try { [void]$PS.EndInvoke($a) } catch {
          # 语法错误不会进 $Fmt 的 catch（脚本根本没跑起来），而是从这里冒出，
          # 同样要剥掉 EndInvoke 的包装层再交付。
          $__e = $_.Exception
          while ($null -ne $__e.InnerException) { $__e = $__e.InnerException }
          $ProtoOut.WriteLine('X:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$__e.Message)))
        }
      }
      while ($out.Count -gt $emitted) { $item = $out[$emitted]; $emitted++; if ($null -ne $item) { if ([string]$item -like 'S:*') { $sawSentinel = $true }; $ProtoOut.WriteLine([string]$item) } }
    }
    # 错误 / 警告已在管道内按类型打标，这里不再重复汇总，
    # 只兜底那些没能进入管道的残留（例如 runspace 级错误）。
    foreach ($er in $PS.Streams.Error) { $ProtoOut.WriteLine('E:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes([string]$er))) }
    $PS.Streams.Error.Clear()
    $PS.Dispose()
    # 哨兵兜底：$Fmt 没能执行（语法错误 / BeginInvoke 就失败）时补一条，
    # 让客户端始终能区分「跑完了」「抛异常了」「被中断了」。
    if (-not $sawSentinel) {
      $__n = 'threw'; if ($timedOut) { $__n = 'ran' }
      $ProtoOut.WriteLine('S:' + [Convert]::ToBase64String([Text.Encoding]::UTF8.GetBytes($__n)))
    }
    $ProtoOut.WriteLine('<<<T:' + $cid + ':' + [int]$timedOut + '>>>')
    $ProtoOut.WriteLine('<<<E:' + $cid + '>>>')
    $ProtoOut.Flush()
}
$ProtoOut.WriteLine('<<<BYE>>>'); $ProtoOut.Flush()