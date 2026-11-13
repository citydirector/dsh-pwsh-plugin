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
 [DllImport("advapi32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool ConvertStringSecurityDescriptorToSecurityDescriptorW(string text,int revision,out IntPtr sd,out int length);
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)] static extern bool CreateDirectoryW(string path,ref SA sa);
 [DllImport("kernel32.dll")] static extern IntPtr LocalFree(IntPtr value);
 public static string Identity(string path) { using(var h=CreateFileW(path,0,7,IntPtr.Zero,3,0x02200000,IntPtr.Zero)) { if(h.IsInvalid) throw new System.ComponentModel.Win32Exception(); Info i; if(!GetFileInformationByHandle(h,out i)) throw new System.ComponentModel.Win32Exception(); return i.volume+":"+i.indexHigh+":"+i.indexLow; } }
 public static void Create(string path,string sddl) { IntPtr sd; int length; if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl,1,out sd,out length)) throw new System.ComponentModel.Win32Exception(); try { var sa=new SA{size=Marshal.SizeOf<SA>(),sd=sd}; if(!CreateDirectoryW(path,ref sa)) throw new System.ComponentModel.Win32Exception(); } finally { LocalFree(sd); } }
}
'@
# RECYCLE_HELPER
function Assert-PlainPath([string]$skadiPath) {
 if ($skadiPath -notmatch '^[A-Za-z]:\\' -or $skadiPath.Substring(2).Contains(':')) { throw 'Only local drive paths are supported; UNC, devices and streams are refused.' }
 $skadiPart = $skadiPath
 while ($skadiPart) {
  if ([IO.File]::Exists($skadiPart) -or [IO.Directory]::Exists($skadiPart)) {
   if (([IO.File]::GetAttributes($skadiPart) -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Link/reparse point refused: ' + $skadiPart) }
  }
  $skadiPart = [IO.Path]::GetDirectoryName($skadiPart)
 }
}
function Get-Snapshot($skadiTargets) {
 $skadiRows = [Collections.Generic.List[object]]::new()
 $skadiWalk = [Collections.Generic.Stack[string]]::new()
 foreach ($skadiTarget in $skadiTargets) { Assert-PlainPath $skadiTarget; $skadiWalk.Push($skadiTarget) }
 while ($skadiWalk.Count -gt 0) {
  $skadiPath = $skadiWalk.Pop()
  if ($skadiRows.Count -ge 512) { throw 'Deletion plan exceeds 512 entries; choose a smaller target.' }
  $skadiItem = Get-Item -LiteralPath $skadiPath -Force -ErrorAction Stop
  if (($skadiItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw ('Link/reparse point refused: ' + $skadiPath) }
  $skadiRows.Add([ordered]@{path=$skadiItem.FullName;kind=$(if($skadiItem.PSIsContainer){'directory'}else{'file'});id=[FileRemoveNative]::Identity($skadiPath);size=$(if($skadiItem.PSIsContainer){0}else{$skadiItem.Length});mtime=$skadiItem.LastWriteTimeUtc.Ticks.ToString();ctime=$skadiItem.CreationTimeUtc.Ticks.ToString();attributes=[int]$skadiItem.Attributes})
  if ($skadiItem.PSIsContainer) { foreach($skadiChild in [IO.Directory]::EnumerateFileSystemEntries($skadiPath)) {
   if($skadiRows.Count + $skadiWalk.Count -ge 512) { throw 'Deletion plan exceeds 512 entries; choose a smaller target.' }
   $skadiWalk.Push($skadiChild)
  } }
 }
 return @($skadiRows | Sort-Object -Property path)
}
function Get-Digest($skadiRows) {
 $skadiJson = ConvertTo-Json -InputObject @($skadiRows) -Depth 16 -Compress
 return [Convert]::ToHexString([Security.Cryptography.SHA256]::HashData([Text.Encoding]::UTF8.GetBytes($skadiJson)))
}
try {
 $skadiTargets = @($skadiRequest.paths | ForEach-Object { [IO.Path]::GetFullPath($_, $skadiRequest.cwd) })
 switch ($skadiRequest.op) {
  'inspect' {
   $skadiExpanded = [Collections.Generic.List[string]]::new()
   foreach($skadiTarget in $skadiTargets) {
    if ($skadiTarget.IndexOfAny([char[]]'*?[]') -ge 0) {
     $skadiParent=[IO.Path]::GetDirectoryName($skadiTarget); Assert-PlainPath $skadiParent
     if($skadiParent.IndexOfAny([char[]]'*?[]') -ge 0) { throw 'Wildcards are supported only in the final path component.' }
     foreach($skadiMatch in [IO.Directory]::EnumerateFileSystemEntries($skadiParent)) {
      if([IO.Path]::GetFileName($skadiMatch) -like [IO.Path]::GetFileName($skadiTarget)) {
       if($skadiExpanded.Count -ge 64) { throw 'Expected 1 to 64 matched targets.' }
       $skadiExpanded.Add($skadiMatch)
      }
     }
    } else { $skadiExpanded.Add($skadiTarget) }
   }
   $skadiTargets=@($skadiExpanded | Sort-Object -Unique)
   if($skadiTargets.Count -eq 0 -or $skadiTargets.Count -gt 64) { throw 'Expected 1 to 64 matched targets.' }
   # 父目录已经包含子目录，避免重复回收以及第二次操作不存在的对象。
   $skadiTargets=@($skadiTargets | Where-Object { $skadiCandidate=$_; -not @($skadiTargets | Where-Object { $skadiCandidate.StartsWith($_.TrimEnd([char]92)+[char]92,[StringComparison]::OrdinalIgnoreCase) }).Count })
   $skadiRows=Get-Snapshot $skadiTargets
   $skadiResult=@{paths=$skadiTargets;entries=@($skadiRows);digest=(Get-Digest $skadiRows);home=$env:USERPROFILE}
  }
  'create' {
   $skadiParent=[IO.Path]::GetFullPath($skadiRequest.parent); Assert-PlainPath $skadiParent
   $skadiPath=Join-Path $skadiParent ('file-temp-'+$skadiRequest.id)
   # 只在新对象创建时携带父级能力授权，保留所有拒绝项；绝不修写已有对象的 ACL。
   $skadiAcl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($skadiParent))
   $skadiRule=[Security.AccessControl.FileSystemAccessRule]::new([Security.Principal.WindowsIdentity]::GetCurrent().User,'FullControl','ContainerInherit,ObjectInherit','None','Allow')
   $skadiAcl.AddAccessRule($skadiRule)
   [FileRemoveNative]::Create($skadiPath,$skadiAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access))
   [IO.File]::WriteAllText((Join-Path $skadiPath '.file-temp-owner'),$skadiRequest.id)
   $skadiResult=@{path=$skadiPath;id=[FileRemoveNative]::Identity($skadiPath)}
  }
  { $_ -eq 'recycle' -or $_ -eq 'clean' } {
   $skadiRows=Get-Snapshot $skadiTargets
   if($skadiRequest.op -eq 'recycle' -and (Get-Digest $skadiRows) -ne $skadiRequest.digest) { throw 'Targets changed since planning; create a new plan.' }
   if($skadiRequest.op -eq 'clean') {
    if($skadiTargets.Count -ne 1 -or [FileRemoveNative]::Identity($skadiTargets[0]) -ne $skadiRequest.identity -or [IO.File]::ReadAllText((Join-Path $skadiTargets[0] '.file-temp-owner')) -ne $skadiRequest.id) { throw 'Temporary directory identity changed; cleanup refused.' }
   }
   $skadiDone=[Collections.Generic.List[string]]::new()
   foreach($skadiTarget in $skadiTargets) {
    Assert-PlainPath $skadiTarget
    if($skadiRequest.op -eq 'clean') { [IO.Directory]::Delete($skadiTarget,$true) }
    else { [StrictRecycle]::Send($skadiTarget) }
    if([IO.File]::Exists($skadiTarget) -or [IO.Directory]::Exists($skadiTarget)) { throw ('Target remains after removal: '+$skadiTarget) }
    $skadiDone.Add($skadiTarget)
   }
   $skadiResult=@{removed=@($skadiDone);method=$(if($skadiRequest.op -eq 'clean'){'managed-temp-cleanup'}else{'windows-recycle-bin'})}
  }
  default { throw 'Unsupported file worker operation.' }
 }
 @{ok=$true;result=$skadiResult} | ConvertTo-Json -Depth 32 -Compress
} catch {
 $skadiFailure=$_.Exception.Message
 $skadiDiagnostic=@{note='No permanent-delete fallback or ACL repair was attempted. AccessDenied can involve integrity labels, OWNER RIGHTS, DELETE permissions, a lock, or Recycle Bin policy.'}
 if($skadiTarget -and [IO.Directory]::Exists($skadiTarget)) {
  try {
   $skadiReadAcl=[IO.FileSystemAclExtensions]::GetAccessControl([IO.DirectoryInfo]::new($skadiTarget))
   $skadiDiagnostic.owner=$skadiReadAcl.Owner
   $skadiDiagnostic.dacl=$skadiReadAcl.GetSecurityDescriptorSddlForm([Security.AccessControl.AccessControlSections]::Access)
  } catch { $skadiDiagnostic.aclReadError=$_.Exception.Message }
 }
 @{ok=$false;error=$skadiFailure;removed=@($skadiDone);diagnostic=$skadiDiagnostic} | ConvertTo-Json -Depth 16 -Compress
 exit 1
}
