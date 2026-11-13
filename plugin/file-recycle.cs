using System;
using System.Runtime.InteropServices;

// Windows 8+ 的强制回收标志，加上执行前回调，拒绝退化为永久删除。
public static class StrictRecycle {
 [ComImport,Guid("43826D1E-E718-42EE-BC55-A1E261C37BFE"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface Item {}
 [ComImport,Guid("947AAB5F-0A5C-4C13-B4D6-4BF7836FC9F8"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] interface Operation {
  [PreserveSig] int Advise(Sink sink,out uint cookie);
  [PreserveSig] int Unadvise(uint cookie);
  [PreserveSig] int SetOperationFlags(uint flags);
  [PreserveSig] int SetProgressMessage([MarshalAs(UnmanagedType.LPWStr)] string message);
  [PreserveSig] int SetProgressDialog(IntPtr dialog);
  [PreserveSig] int SetProperties(IntPtr properties);
  [PreserveSig] int SetOwnerWindow(uint hwnd);
  [PreserveSig] int ApplyPropertiesToItem(Item item);
  [PreserveSig] int ApplyPropertiesToItems(IntPtr items);
  [PreserveSig] int RenameItem(Item item,[MarshalAs(UnmanagedType.LPWStr)] string name,Sink sink);
  [PreserveSig] int RenameItems(IntPtr items,[MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int MoveItem(Item item,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name,Sink sink);
  [PreserveSig] int MoveItems(IntPtr items,Item folder);
  [PreserveSig] int CopyItem(Item item,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name,Sink sink);
  [PreserveSig] int CopyItems(IntPtr items,Item folder);
  [PreserveSig] int DeleteItem(Item item,Sink sink);
  [PreserveSig] int DeleteItems(IntPtr items);
  [PreserveSig] int NewItem(Item folder,uint attributes,[MarshalAs(UnmanagedType.LPWStr)] string name,[MarshalAs(UnmanagedType.LPWStr)] string template,Sink sink);
  [PreserveSig] int PerformOperations();
  [PreserveSig] int GetAnyOperationsAborted([MarshalAs(UnmanagedType.Bool)] out bool aborted);
 }
 [ComVisible(true),Guid("04B0F1A7-9490-44BC-96E1-4296A31252E2"),InterfaceType(ComInterfaceType.InterfaceIsIUnknown)] public interface Sink {
  [PreserveSig] int StartOperations();
  [PreserveSig] int FinishOperations(int result);
  [PreserveSig] int PreRenameItem(uint flags,Item item,[MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostRenameItem(uint flags,Item item,[MarshalAs(UnmanagedType.LPWStr)] string name,int result,Item created);
  [PreserveSig] int PreMoveItem(uint flags,Item item,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostMoveItem(uint flags,Item item,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name,int result,Item created);
  [PreserveSig] int PreCopyItem(uint flags,Item item,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostCopyItem(uint flags,Item item,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name,int result,Item created);
  [PreserveSig] int PreDeleteItem(uint flags,Item item);
  [PreserveSig] int PostDeleteItem(uint flags,Item item,int result,Item created);
  [PreserveSig] int PreNewItem(uint flags,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name);
  [PreserveSig] int PostNewItem(uint flags,Item folder,[MarshalAs(UnmanagedType.LPWStr)] string name,[MarshalAs(UnmanagedType.LPWStr)] string template,uint attributes,int result,Item created);
  [PreserveSig] int UpdateProgress(uint total,uint done);
  [PreserveSig] int ResetTimer();
  [PreserveSig] int PauseTimer();
  [PreserveSig] int ResumeTimer();
 }
 [ComVisible(true),ClassInterface(ClassInterfaceType.None)] public sealed class RecycleSink:Sink {
  public bool Seen; public int Result=unchecked((int)0x80004004);
  public int StartOperations()=>0;
  public int FinishOperations(int r)=>0;
  public int PreRenameItem(uint f,Item i,string n)=>0;
  public int PostRenameItem(uint f,Item i,string n,int r,Item c)=>0;
  public int PreMoveItem(uint f,Item i,Item d,string n)=>0;
  public int PostMoveItem(uint f,Item i,Item d,string n,int r,Item c)=>0;
  public int PreCopyItem(uint f,Item i,Item d,string n)=>0;
  public int PostCopyItem(uint f,Item i,Item d,string n,int r,Item c)=>0;
  public int PreDeleteItem(uint f,Item i)=>CanRecycle(f)?0:unchecked((int)0x80004004);
  public int PostDeleteItem(uint f,Item i,int r,Item c){Seen=true;Result=r;return r;}
  public int PreNewItem(uint f,Item d,string n)=>0;
  public int PostNewItem(uint f,Item d,string n,string t,uint a,int r,Item c)=>0;
  public int UpdateProgress(uint t,uint d)=>0;
  public int ResetTimer()=>0;public int PauseTimer()=>0;public int ResumeTimer()=>0;
 }
 [DllImport("shell32.dll",CharSet=CharSet.Unicode,PreserveSig=false)] static extern void SHCreateItemFromParsingName(string name,IntPtr context,ref Guid iid,[MarshalAs(UnmanagedType.Interface)] out Item item);
 public static bool CanRecycle(uint flags)=>(flags&0x80)!=0;
 public static void Send(string path){
  Operation operation=null;Item item=null;
  try{
   var iid=typeof(Item).GUID;SHCreateItemFromParsingName(path,IntPtr.Zero,ref iid,out item);
   operation=(Operation)Activator.CreateInstance(Type.GetTypeFromCLSID(new Guid("3AD05575-8857-4850-9277-11B85BDB8E09")));
   Marshal.ThrowExceptionForHR(operation.SetOperationFlags(0x20180414));
   var sink=new RecycleSink();Marshal.ThrowExceptionForHR(operation.DeleteItem(item,sink));
   Marshal.ThrowExceptionForHR(operation.PerformOperations());bool aborted;
   Marshal.ThrowExceptionForHR(operation.GetAnyOperationsAborted(out aborted));
   if(aborted||!sink.Seen)throw new InvalidOperationException("Recycle operation was aborted; permanent deletion is forbidden.");
   Marshal.ThrowExceptionForHR(sink.Result);GC.KeepAlive(sink);
  }finally{if(item!=null)Marshal.ReleaseComObject(item);if(operation!=null)Marshal.ReleaseComObject(operation);}
 }
}
