# stdin: id timeoutMs base64(utf8 JSON {script,workdir}) outputByteLimit
# stdout: B/T/E framing; typed UTF-8 base64 records; '+' continues one record; L: reports truncation.
# Console and inherited child handles must never carry protocol traffic.
$ErrorActionPreference = 'Stop'
$Utf8 = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = $Utf8
$OutputEncoding = $Utf8
$ProtoIn = [IO.StreamReader]::new([Console]::OpenStandardInput(), $Utf8)
$ProtoOut = [IO.StreamWriter]::new([Console]::OpenStandardOutput(), $Utf8)
$ProtoOut.AutoFlush = $true
[Console]::SetIn([IO.StringReader]::new(''))
[Console]::SetOut([IO.TextWriter]::Null)
[Console]::SetError([IO.TextWriter]::Null)

# C# callbacks drain collections on the producer thread. PowerShell scriptblock event handlers
# need a runspace and cannot safely serve as callbacks from the pipeline's worker thread.
$Types = @'
using System;
using System.IO;
using System.Text;
using System.Management.Automation;
using System.Runtime.InteropServices;

public sealed class PwshRunOutput {
    readonly TextWriter writer;
    readonly object gate = new object();
    int outputLeft, errorLeft = 65536;
    int outputRecords, errorRecords;
    bool truncated;
    public PwshRunOutput(TextWriter writer, int limit) { this.writer = writer; outputLeft = limit; }
    public void Emit(string kind, string text) {
        lock (gate) {
            text = text ?? "";
            bool error = kind == "E" || kind == "X" || kind == "F";
            int separator = (error ? errorRecords : outputRecords) > 0 ? 1 : 0;
            int left = (error ? errorLeft : outputLeft) - separator;
            if (left < 0) {
                if (!truncated) { writer.WriteLine("L:"); truncated = true; }
                return;
            }
            int length = text.Length;
            if (Encoding.UTF8.GetByteCount(text) > left) {
                int lo = 0, hi = length;
                while (lo < hi) {
                    int mid = lo + (hi - lo + 1) / 2;
                    if (Encoding.UTF8.GetByteCount(text.Substring(0, mid)) <= left) lo = mid;
                    else hi = mid - 1;
                }
                length = lo;
                if (length > 0 && char.IsHighSurrogate(text[length - 1])) length--;
                if (!truncated) { writer.WriteLine("L:"); truncated = true; }
            }
            int bytes = Encoding.UTF8.GetByteCount(text.Substring(0, length));
            if (length == 0 && text.Length != 0) return;
            if (error) { errorLeft -= bytes + separator; errorRecords++; }
            else { outputLeft -= bytes + separator; outputRecords++; }
            int offset = 0;
            do {
                int count = Math.Min(4096, length - offset);
                if (count > 0 && offset + count < length && char.IsHighSurrogate(text[offset + count - 1])) count--;
                string payload = Convert.ToBase64String(Encoding.UTF8.GetBytes(text.Substring(offset, count)));
                offset += count;
                writer.WriteLine(kind + (offset < length ? "+:" : ":") + payload);
            } while (offset < length);
        }
    }
    void Wire<T>(PSDataCollection<T> items, string kind) {
        items.DataAdded += (sender, args) => {
            foreach (T item in items.ReadAll()) Emit(kind, item == null ? "" : item.ToString());
        };
    }
    public void Attach(PowerShell ps, PSDataCollection<PSObject> output) {
        Wire(output, "O"); Wire(ps.Streams.Error, "E"); Wire(ps.Streams.Warning, "W");
        Wire(ps.Streams.Verbose, "V"); Wire(ps.Streams.Debug, "D"); Wire(ps.Streams.Information, "I");
        // Progress is not rendered by this noninteractive tool, but must not accumulate.
        ps.Streams.Progress.DataAdded += (sender, args) => { ps.Streams.Progress.ReadAll(); };
    }
}

public static class PwshRunStdio {
    [StructLayout(LayoutKind.Sequential)]
    public struct SecurityAttributes { public int nLength; public IntPtr lpSecurityDescriptor; public bool bInheritHandle; }
    [DllImport("kernel32.dll", SetLastError=true, CharSet=CharSet.Unicode)]
    static extern IntPtr CreateFileW(string n, uint a, uint s, ref SecurityAttributes sa, uint d, uint f, IntPtr t);
    [DllImport("kernel32.dll", SetLastError=true)]
    static extern bool SetStdHandle(int n, IntPtr h);
    public static void Detach() {
        var sa = new SecurityAttributes { nLength = Marshal.SizeOf(typeof(SecurityAttributes)), bInheritHandle = true };
        var input = CreateFileW("NUL", 0x80000000, 3, ref sa, 3, 0, IntPtr.Zero);
        var output = CreateFileW("NUL", 0x40000000, 3, ref sa, 3, 0, IntPtr.Zero);
        if (input == IntPtr.Zero || input == new IntPtr(-1) || output == IntPtr.Zero || output == new IntPtr(-1)
            || !SetStdHandle(-10, input) || !SetStdHandle(-11, output) || !SetStdHandle(-12, output))
            throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error(), "Could not detach child std handles");
    }
}
'@
try {
    $null = Add-Type -TypeDefinition $Types -ErrorAction Stop
    # NUL bounds discarded native output without any temporary drain file. Its handle type can
    # change PowerShell's native-launch denial text; the client recognizes that diagnostic too.
    if ($IsWindows) { [PwshRunStdio]::Detach() }
} catch {
    # A partially detached process must not accept user scripts and expose the protocol handles.
    $ProtoOut.WriteLine('<<<B:c1>>>')
    $ProtoOut.WriteLine('F:' + [Convert]::ToBase64String($Utf8.GetBytes($_.Exception.Message)))
    $ProtoOut.WriteLine('S:' + [Convert]::ToBase64String($Utf8.GetBytes('threw')))
    $ProtoOut.WriteLine('<<<E:c1>>>')
    exit 1
}

$RS = [RunspaceFactory]::CreateRunspace()
$RS.Open()
$RS.SessionStateProxy.SetVariable('ErrorActionPreference', 'Continue')
try {
    while ($true) {
        $line = $ProtoIn.ReadLine()
        if ($null -eq $line -or $line -eq 'QUIT') { break }
        if ($line.Length -eq 0) { continue }
        $parts = $line.Split(' ', 4)
        $cid = $parts[0]
        $timeoutMs = [int]$parts[1]
        $request = [Text.Encoding]::UTF8.GetString([Convert]::FromBase64String($parts[2])) | ConvertFrom-Json
        $limit = [int]$parts[3]
        $ProtoOut.WriteLine('<<<B:' + $cid + '>>>')
        $sink = [PwshRunOutput]::new($ProtoOut, $limit)
        $PS = [PowerShell]::Create()
        $PS.Runspace = $RS
        $out = [System.Management.Automation.PSDataCollection[psobject]]::new()
        $sink.Attach($PS, $out)
        $timedOut = $false
        $sentinel = 'threw'
        try {
            if ($request.workdir) {
                [void]$PS.AddCommand('Microsoft.PowerShell.Management\Set-Location').AddParameter('LiteralPath', $request.workdir).AddParameter('ErrorAction', 'Stop')
                [void]$PS.Invoke()
                if ($PS.HadErrors) { throw 'Could not set the requested working directory' }
                $PS.Commands.Clear()
            }
            # AddScript does not enforce #requires; check its AST contract before user code runs.
            $requirements = [scriptblock]::Create($request.script).Ast.ScriptRequirements
            if ($requirements) {
                if ($requirements.RequiredPSVersion -and $PSVersionTable.PSVersion -lt $requirements.RequiredPSVersion) {
                    throw ('Script requires PowerShell ' + $requirements.RequiredPSVersion)
                }
                if ($requirements.RequiredPSEditions.Count -gt 0 -and $requirements.RequiredPSEditions -notcontains $PSVersionTable.PSEdition) {
                    throw ('Script requires PowerShell edition ' + ($requirements.RequiredPSEditions -join ', '))
                }
                if ($requirements.IsElevationRequired) {
                    $elevated = if ($IsWindows) {
                        [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent()).IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)
                    } else { [Environment]::UserName -eq 'root' }
                    if (-not $elevated) { throw 'Script requires administrator privileges' }
                }
                if ($requirements.RequiredApplicationId -or $requirements.RequiredAssemblies.Count -gt 0) {
                    throw 'pwsh_run does not support #requires -ShellId or -Assembly; load assemblies explicitly'
                }
                if ($requirements.RequiredModules.Count -gt 0) {
                    [void]$PS.AddCommand('Microsoft.PowerShell.Core\Import-Module').AddParameter('FullyQualifiedName', $requirements.RequiredModules).AddParameter('ErrorAction', 'Stop')
                    [void]$PS.Invoke()
                    if ($PS.HadErrors) { throw 'Could not load the modules required by the script' }
                    $PS.Commands.Clear()
                }
            }
            # Run the user's script at top level; formatting is the following pipeline command.
            [void]$PS.AddScript($request.script, $false).AddCommand('Microsoft.PowerShell.Utility\Out-String').AddParameter('Stream').AddParameter('Width', 200)
            $a = $PS.BeginInvoke[psobject, psobject]($null, $out)
            if (-not $a.AsyncWaitHandle.WaitOne($timeoutMs)) {
                $timedOut = $true
                $PS.Stop()
            }
            [void]$PS.EndInvoke($a)
            $sentinel = 'ok'
        } catch {
            if ($timedOut) { $sentinel = 'ran' }
            else {
                $cause = $_.Exception
                while ($null -ne $cause.InnerException) { $cause = $cause.InnerException }
                $sink.Emit('X', $cause.Message)
            }
        } finally {
            $PS.Dispose()
            $out.Dispose()
        }
        $ProtoOut.WriteLine('S:' + [Convert]::ToBase64String($Utf8.GetBytes($sentinel)))
        $ProtoOut.WriteLine('<<<T:' + $cid + ':' + [int]$timedOut + '>>>')
        $ProtoOut.WriteLine('<<<E:' + $cid + '>>>')
    }
} finally { $RS.Dispose() }
$ProtoOut.WriteLine('<<<BYE>>>')