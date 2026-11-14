$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$skadiRequest = [Console]::In.ReadToEnd() | ConvertFrom-Json -Depth 64
$null = Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class FileRemoveNative {
 [StructLayout(LayoutKind.Sequential,Pack=4)] struct Info { public uint attr; public long created; public long accessed; public long written; public uint volume; public uint high; public uint low; public uint links; public uint indexHigh; public uint indexLow; }
 [StructLayout(LayoutKind.Sequential)] struct SA { public int size; public IntPtr sd; public int inherit; }
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern SafeFileHandle CreateFileW(string path,uint access,uint share,IntPtr sa,uint disposition,uint flags,IntPtr template);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool GetFileInformationByHandle(SafeFileHandle file,out Info info);
 [DllImport("kernel32.dll",SetLastError=true)] static extern bool DeviceIoControl(SafeFileHandle h,uint code,IntPtr input,int inputSize,byte[] output,int outputSize,out int returned,IntPtr overlapped);
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,int revision,out IntPtr sd,out int length);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,ref SA sa);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string Identity(string path) { using(var h=CreateFileW(path,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) { if(h.IsInvalid) throw new System.ComponentModel.Win32Exception(); Info i; if(!GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception(); return i.volume+":"+i.indexHigh+":"+i.indexLow; } }
 public static uint ReparseTag(string path) { using(var h=CreateFileW(path,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) { if(h.IsInvalid) throw new System.ComponentModel.Win32Exception(); var b=new byte[16384];int n;if(!DeviceIoControl(h,0x900a8,IntPtr.Zero,0,b,b.Length,out n,IntPtr.Zero))throw new System.ComponentModel.Win32Exception();return BitConverter.ToUInt32(b,0); } }
 public static void Create(string path,string sddl) { IntPtr sd;int length;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out sd,out length))throw new System.ComponentModel.Win32Exception();try { var sa=new SA{size=Marshal.SizeOf<SA>(),sd=sd};if(!CreateDirectoryW(path,ref sa))throw new System.ComponentModel.Win32Exception(); } finally { LocalFree(sd); } }
}
'@
# RECYCLE_HELPER
function Write-Frame($skadiValue) { [Console]::WriteLine((ConvertTo-Json -InputObject $skadiValue -Depth 20 -Compress)) }
function Assert-PlainPath([string]$skadiPath) {
 if ($skadiPath -notmatch '^[A-Za-z]:\\' -or $skadiPath.Substring(2).Contains(':')) { throw 'Only local drive paths are supported; UNC, devices and streams are refused.' }
 $skadiPart = $skadiPath
 while ($skadiPart) {
  try { $skadiAttr=[IO.File]::GetAttributes($skadiPart) } catch [IO.FileNotFoundException] { throw ('Path does not exist: '+$skadiPart) } catch [IO.DirectoryNotFoundException] { throw ('Path does not exist: '+$skadiPart) }
  if (($skadiAttr -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Link/reparse point refused: '+$skadiPart) }
  $skadiPart=[IO.Path]::GetDirectoryName($skadiPart)
 }
}
function Assert-ProtectedPath([string]$skadiPath) {
 if ($skadiRequest.op -eq 'clean') { return }
 if ([IO.Path]::GetPathRoot($skadiPath) -eq $skadiPath -or ($skadiPath.Split([char]92) -contains '.git')) { throw ('Protected root or .git target: '+$skadiPath) }
 foreach($skadiRoot in @($skadiRequest.boundary,$env:USERPROFILE)) {
  if ($skadiRoot) {
   $skadiResolved=[IO.Path]::GetFullPath($skadiRoot)
   if ($skadiResolved.Equals($skadiPath,[StringComparison]::OrdinalIgnoreCase) -or $skadiResolved.StartsWith($skadiPath.TrimEnd([char]92)+[char]92,[StringComparison]::OrdinalIgnoreCase)) { throw ('Protected home or workspace ancestor: '+$skadiPath) }
  }
 }
}
function Get-Info([string]$skadiPath) {
 $skadiAttr=[IO.File]::GetAttributes($skadiPath)
 if (($skadiAttr -band [IO.FileAttributes]::Directory) -ne 0) { return [IO.DirectoryInfo]::new($skadiPath) }
 return [IO.FileInfo]::new($skadiPath)
}
function Get-Snapshot($skadiTargets) {
 $skadiSummary=[ordered]@{entries=0;files=0;directories=0;links=0;bytes=[long]0;inventoryBytes=[long]0}
 $skadiHash=[Security.Cryptography.IncrementalHash]::CreateHash([Security.Cryptography.HashAlgorithmName]::SHA256)
 $skadiClock=[Diagnostics.Stopwatch]::StartNew()
 $skadiWalk=[Collections.Generic.Stack[IO.FileSystemInfo]]::new()
 try {
  $skadiSorted=[string[]]@($skadiTargets);[Array]::Sort($skadiSorted,[StringComparer]::Ordinal)
  for($skadiI=$skadiSorted.Count-1;$skadiI -ge 0;$skadiI--) { Assert-PlainPath $skadiSorted[$skadiI];Assert-ProtectedPath $skadiSorted[$skadiI];$skadiWalk.Push((Get-Info $skadiSorted[$skadiI])) }
  while($skadiWalk.Count -gt 0) {
   if($skadiClock.ElapsedMilliseconds -gt $skadiRequest.limits.fileScanTimeoutMs) { throw 'File scan timed out before a complete inventory; no removal performed.' }
   if($skadiSummary.entries -ge $skadiRequest.limits.fileScanMaxEntries) { throw 'File scan entry budget exceeded; no executable plan was created.' }
   $skadiItem=$skadiWalk.Pop();$skadiItem.Refresh();$skadiPath=$skadiItem.FullName;Assert-ProtectedPath $skadiPath
   $skadiLink=($skadiItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0
   $skadiDirectory=($skadiItem.Attributes -band [IO.FileAttributes]::Directory) -ne 0
   $skadiRow=[ordered]@{path=$skadiPath;kind=$(if($skadiLink){'link'}elseif($skadiDirectory){'directory'}else{'file'});id=[FileRemoveNative]::Identity($skadiPath);size=$(if($skadiDirectory -or $skadiLink){0}else{$skadiItem.Length});mtime=$skadiItem.LastWriteTimeUtc.Ticks.ToString();ctime=$skadiItem.CreationTimeUtc.Ticks.ToString();attributes=[int]$skadiItem.Attributes}
   if($skadiLink) {
    $skadiTag=[FileRemoveNative]::ReparseTag($skadiPath)
    if($skadiTag -notin @([uint32]2684354572,[uint32]2684354563) -or $skadiItem.LinkTarget -match 'Volume\{') { throw ('Unsupported reparse point or mounted volume: '+$skadiPath) }
    $skadiRow.target=$skadiItem.LinkTarget;$skadiRow.reparseTag=$skadiTag
   }
   $skadiJson=ConvertTo-Json -InputObject $skadiRow -Depth 12 -Compress
   $skadiBytes=[Text.Encoding]::UTF8.GetBytes($skadiJson+[char]10)
   $skadiSummary.inventoryBytes+=$skadiBytes.Length
   if($skadiSummary.inventoryBytes -gt $skadiRequest.limits.fileScanMaxBytes) { throw 'File scan inventory byte budget exceeded; no executable plan was created.' }
   $skadiHash.AppendData($skadiBytes);$skadiSummary.entries++
   if($skadiLink){$skadiSummary.links++}elseif($skadiDirectory){$skadiSummary.directories++}else{$skadiSummary.files++;$skadiSummary.bytes+=$skadiItem.Length}
   if($skadiRequest.op -eq 'inspect') { [Console]::WriteLine('{"type":"entry","entry":'+$skadiJson+'}') }
   if($skadiSummary.entries % 128 -eq 0) { Write-Frame (@{type='progress';phase=$(if($skadiRequest.op -eq 'inspect'){'scanning'}else{'revalidating'});removed=@($skadiDone)}+$skadiSummary) }
   if($skadiDirectory -and -not $skadiLink) {
    $skadiChildren=[Collections.Generic.List[IO.FileSystemInfo]]::new()
    foreach($skadiChild in ([IO.DirectoryInfo]$skadiItem).EnumerateFileSystemInfos()) {
     if($skadiSummary.entries+$skadiWalk.Count+$skadiChildren.Count -ge $skadiRequest.limits.fileScanMaxEntries) { throw 'File scan entry budget exceeded; no executable plan was created.' }
     $skadiChildren.Add($skadiChild)
    }
    $skadiChildren.Sort([Comparison[IO.FileSystemInfo]]{param($skadiA,$skadiB) [StringComparer]::Ordinal.Compare($skadiA.FullName,$skadiB.FullName)})
    for($skadiI=$skadiChildren.Count-1;$skadiI -ge 0;$skadiI--) { $skadiWalk.Push($skadiChildren[$skadiI]) }
   }
  }
  $skadiSummary.digest=[Convert]::ToHexString($skadiHash.GetHashAndReset())
  Write-Frame (@{type='progress';phase=$(if($skadiRequest.op -eq 'inspect'){'scanned'}else{'revalidated'});removed=@($skadiDone)}+$skadiSummary)
  return $skadiSummary
 } finally { $skadiHash.Dispose() }
}
function Remove-ManagedTree([string]$skadiRoot) {
 # 每个内部链接仅解除自身；不把递归删除委托给链接目标。
 $skadiWalk=[Collections.Generic.Stack[object]]::new();$skadiWalk.Push(@{path=$skadiRoot;visited=$false});$skadiDeleted=0
 while($skadiWalk.Count -gt 0) {
  $skadiNode=$skadiWalk.Pop();$skadiItem=Get-Info $skadiNode.path;$skadiAttr=$skadiItem.Attributes
  $skadiDir=($skadiAttr -band [IO.FileAttributes]::Directory) -ne 0;$skadiLink=($skadiAttr -band [IO.FileAttributes]::ReparsePoint) -ne 0
  if($skadiDir -and -not $skadiLink -and -not $skadiNode.visited) {
   $skadiWalk.Push(@{path=$skadiItem.FullName;visited=$true})
   foreach($skadiChild in ([IO.DirectoryInfo]$skadiItem).EnumerateFileSystemInfos()) { $skadiWalk.Push(@{path=$skadiChild.FullName;visited=$false}) }
  } else {
   if($skadiDir){[IO.Directory]::Delete($skadiItem.FullName,$false)}else{[IO.File]::Delete($skadiItem.FullName)}
   $skadiDeleted++
   if($skadiDeleted % 128 -eq 0){Write-Frame @{type='progress';phase='removing';deletedEntries=$skadiDeleted;removed=@($skadiDone)}}
  }
 }
}
$skadiDone=[Collections.Generic.List[string]]::new()
try {
 if(-not $skadiRequest.limits) { $skadiRequest | Add-Member limits ([pscustomobject]@{fileScanMaxEntries=250000;fileScanMaxBytes=67108864;fileScanTimeoutMs=120000}) }
 $skadiTargets=@($skadiRequest.paths | ForEach-Object { [IO.Path]::GetFullPath($_,$skadiRequest.cwd) })
 switch($skadiRequest.op) {
  'inspect' {
   $skadiExpanded=[Collections.Generic.List[string]]::new()
   foreach($skadiTarget in $skadiTargets) {
    Assert-ProtectedPath $skadiTarget
    if($skadiTarget.IndexOfAny([char[]]'*?[]') -ge 0) {
     $skadiParent=[IO.Path]::GetDirectoryName($skadiTarget);Assert-PlainPath $skadiParent
     if($skadiParent.IndexOfAny([char[]]'*?[]') -ge 0){throw 'Wildcards are supported only in the final path component.'}
     foreach($skadiMatch in [IO.Directory]::EnumerateFileSystemEntries($skadiParent)) {
      if([IO.Path]::GetFileName($skadiMatch) -like [IO.Path]::GetFileName($skadiTarget)) {
       if($skadiExpanded.Count -ge 64){throw 'Expected 1 to 64 matched targets.'};$skadiExpanded.Add($skadiMatch)
      }
     }
    }else{$skadiExpanded.Add($skadiTarget)}
   }
   $skadiTargets=@($skadiExpanded | Sort-Object -Unique)
   if($skadiTargets.Count -eq 0 -or $skadiTargets.Count -gt 64){throw 'Expected 1 to 64 matched targets.'}
   $skadiTargets=@($skadiTargets | Where-Object {$skadiCandidate=$_;-not @($skadiTargets | Where-Object {$skadiCandidate.StartsWith($_.TrimEnd([char]92)+[char]92,[StringComparison]::OrdinalIgnoreCase)}).Count})
   $skadiSummary=Get-Snapshot $skadiTargets
   $skadiResult=@{paths=$skadiTargets;summary=$skadiSummary;digest=$skadiSummary.digest;home=$env:USERPROFILE}
  }
  'create' {
   $skadiParent=[IO.Path]::GetFullPath($skadiRequest.parent);Assert-PlainPath $skadiParent
   $skadiPath=Join-Path $skadiParent ('file-temp-'+$skadiRequest.id)
   # 只在新对象创建时携带父级能力授权，保留所有拒绝项；绝不修写已有对象的 ACL。
   $skadiAcl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($skadiParent))
   $skadiRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
   $skadiAcl.AddAccessRule($skadiRule)
   [FileRemoveNative]::Create($skadiPath,$skadiAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
   [IO.File]::WriteAllText((Join-Path $skadiPath '.file-temp-owner'),$skadiRequest.id)
   $skadiResult=@{path=$skadiPath;id=[FileRemoveNative]::Identity($skadiPath)}
  }
  {$_ -eq 'recycle' -or $_ -eq 'clean'} {
   if($skadiRequest.op -eq 'clean') {
    if($skadiTargets.Count -ne 1){throw 'Temporary directory identity changed; cleanup refused.'}
    Assert-PlainPath $skadiTargets[0]
    if([FileRemoveNative]::Identity($skadiTargets[0]) -ne $skadiRequest.identity -or [IO.File]::ReadAllText((Join-Path $skadiTargets[0] '.file-temp-owner')) -ne $skadiRequest.id){throw 'Temporary directory identity changed; cleanup refused.'}
   }
   $skadiSummary=Get-Snapshot $skadiTargets
   if($skadiRequest.op -eq 'recycle' -and $skadiSummary.digest -ne $skadiRequest.digest){throw 'Targets changed since planning; create a new plan.'}
   if($skadiRequest.expires -and [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds() -ge $skadiRequest.expires){throw 'Plan expired during revalidation; create a new plan.'}
   foreach($skadiTarget in $skadiTargets) {
    Assert-PlainPath $skadiTarget
    Write-Frame @{type='progress';phase='removing';entries=$skadiSummary.entries;removed=@($skadiDone);currentTarget=$skadiTarget}
    if($skadiRequest.op -eq 'clean') {
     if([FileRemoveNative]::Identity($skadiTarget) -ne $skadiRequest.identity -or [IO.File]::ReadAllText((Join-Path $skadiTarget '.file-temp-owner')) -ne $skadiRequest.id){throw 'Temporary directory identity changed; cleanup refused.'}
     Remove-ManagedTree $skadiTarget
    }else{[StrictRecycle]::Send($skadiTarget)}
    if([IO.File]::Exists($skadiTarget) -or [IO.Directory]::Exists($skadiTarget)){throw ('Target remains after removal: '+$skadiTarget)}
    $skadiDone.Add($skadiTarget);Write-Frame @{type='progress';phase='removing';removed=@($skadiDone);entries=$skadiSummary.entries}
   }
   $skadiResult=@{removed=@($skadiDone);summary=$skadiSummary;method=$(if($skadiRequest.op -eq 'clean'){'managed-temp-cleanup'}else{'windows-recycle-bin'})}
  }
  default{throw 'Unsupported file worker operation.'}
 }
 Write-Frame @{ok=$true;result=$skadiResult}
}catch{
 $skadiDiagnostic=@{note='No permanent-delete fallback or ACL repair was attempted. AccessDenied can involve integrity labels, OWNER RIGHTS, DELETE permissions, a lock, or Recycle Bin policy.'}
 Write-Frame @{ok=$false;error=$_.Exception.Message;removed=@($skadiDone);diagnostic=$skadiDiagnostic}
 exit 1
}
