// 固定工作进程：逐条扫描、哈希和进度；不求值调用者的代码。
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process')
const emit = value => new Promise((resolve, reject) => process.stdout.write(JSON.stringify(value) + '\n', error => error ? reject(error) : resolve()))
async function main(q) {
 const limits = q.limits ?? { fileScanMaxEntries:250000, fileScanMaxBytes:67108864, fileScanTimeoutMs:120000 }
 const removed=[]
 const mounted=new Set()
 if(process.platform==='linux') {
  const text=await fs.readFile('/proc/self/mountinfo','utf8')
  for(const line of text.trim().split(String.fromCharCode(10))) { const field=line.split(' ')[4];if(field)mounted.add(field.replace(new RegExp(String.fromCharCode(92,92)+'([0-7]{3})','g'),(_m,n)=>String.fromCharCode(parseInt(n,8)))) }
 }
 const assertNative = p => { if(/^\/mnt\/[a-z](\/|$)/i.test(p)) throw Error('Windows mount paths must use the Windows Recycle Bin worker.') }
 const plain = async p => { for(let part=p;;part=path.dirname(part)) { const s=await fs.lstat(part); if(s.isSymbolicLink()) throw Error('Link refused: '+part); if(part===path.dirname(part)) break } }
 const protect = p => {
  if(q.op==='clean') return
  for(const root of [q.boundary,os.homedir()].filter(Boolean).map(p=>path.resolve(p))) if(root===p||root.startsWith(p+'/')) throw Error('Protected home or workspace ancestor: '+p)
  if(p==='/'||p.split('/').includes('.git')) throw Error('Protected root or .git target: '+p)
 }
 const snapshot = async targets => {
  const hash=crypto.createHash('sha256'), start=Date.now(), summary={entries:0,files:0,directories:0,links:0,bytes:0,inventoryBytes:0}
  const stack=[]
  for(const p of [...targets].sort().reverse()) { assertNative(p);protect(p);await plain(p);stack.push({p,dev:(await fs.lstat(p,{bigint:true})).dev}) }
  while(stack.length) {
   if(Date.now()-start>limits.fileScanTimeoutMs) throw Error('File scan timed out before a complete inventory; no removal performed.')
   if(summary.entries>=limits.fileScanMaxEntries) throw Error('File scan entry budget exceeded; no executable plan was created.')
   const {p,dev}=stack.pop();protect(p)
   const s=await fs.lstat(p,{bigint:true}),link=s.isSymbolicLink()
   if(!link&&!s.isFile()&&!s.isDirectory()) throw Error('Special files are refused: '+p)
   if(!link&&(s.dev!==dev||mounted.has(p))) throw Error('Nested filesystem mounts are refused: '+p)
   const row={path:p,kind:link?'link':s.isDirectory()?'directory':'file',id:s.dev+':'+s.ino,size:link||s.isDirectory()?'0':String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),mode:String(s.mode)}
   if(link)row.target=await fs.readlink(p)
   const json=JSON.stringify(row),bytes=Buffer.byteLength(json)+1
   summary.inventoryBytes+=bytes
   if(summary.inventoryBytes>limits.fileScanMaxBytes) throw Error('File scan inventory byte budget exceeded; no executable plan was created.')
   hash.update(json+'\n');summary.entries++
   if(link)summary.links++;else if(s.isDirectory())summary.directories++;else{summary.files++;summary.bytes+=Number(s.size)}
   if(q.op==='inspect') await emit({type:'entry',entry:row})
   if(summary.entries%128===0) await emit({type:'progress',phase:q.op==='inspect'?'scanning':'revalidating',...summary,removed:[...removed]})
   if(!link&&s.isDirectory()) {
    // 按单个目录排序以固定哈希次序，不缓存整棵树，也不展开链接目标。
    const children=[]
    for await(const entry of await fs.opendir(p)) {
     if(children.length+stack.length+summary.entries>=limits.fileScanMaxEntries) throw Error('File scan entry budget exceeded; no executable plan was created.')
     children.push(entry.name)
    }
    children.sort().reverse()
    for(const name of children)stack.push({p:path.join(p,name),dev})
   }
  }
  const result={...summary,digest:hash.digest('hex')}
  await emit({type:'progress',phase:q.op==='inspect'?'scanned':'revalidated',...summary,removed:[...removed]})
  return result
 }
 const targets=(q.paths??[]).map(p=>path.resolve(q.cwd,p))
 for(const p of targets)assertNative(p)
 try {
  if(q.op==='inspect') {
   const expanded=[]
   for(const p of targets) {
    protect(p)
    if(/[*?]/.test(p)) {
     const parent=path.dirname(p); if(/[*?]/.test(parent)) throw Error('Wildcards are supported only in the final component.')
     await plain(parent)
     const escaped=Array.from(path.basename(p),ch=>ch==='*'?'.*':ch==='?'?'.':'\\.^$+{}()|[]'.includes(ch)?'\\'+ch:ch).join('')
     const pattern=new RegExp('^'+escaped+String.fromCharCode(36))
     for await(const entry of await fs.opendir(parent))if(pattern.test(entry.name)) {
      if(expanded.length>=64)throw Error('Expected 1 to 64 matched targets.')
      expanded.push(path.join(parent,entry.name))
     }
    }else expanded.push(p)
   }
   const unique=[...new Set(expanded)].sort().filter(p=>!expanded.some(other=>p.startsWith(other+'/')))
   if(!unique.length||unique.length>64)throw Error('Expected 1 to 64 matched targets.')
   const summary=await snapshot(unique)
   return {paths:unique,summary,digest:summary.digest,home:os.homedir()}
  }
  if(q.op==='create') {
   const parent=path.resolve(q.parent);assertNative(parent);await plain(parent)
   const p=path.join(parent,'file-temp-'+q.id);await fs.mkdir(p,{mode:0o700});await fs.writeFile(path.join(p,'.file-temp-owner'),q.id,{flag:'wx',mode:0o600})
   const s=await fs.lstat(p,{bigint:true});return {path:p,id:s.dev+':'+s.ino}
  }
  if(q.op!=='recycle'&&q.op!=='clean')throw Error('Unsupported file worker operation.')
  if(q.op==='clean') {
   if(targets.length!==1)throw Error('Temporary directory identity changed; cleanup refused.')
   await plain(targets[0]);const s=await fs.lstat(targets[0],{bigint:true})
   if(s.dev+':'+s.ino!==q.identity||await fs.readFile(path.join(targets[0],'.file-temp-owner'),'utf8')!==q.id)throw Error('Temporary directory identity changed; cleanup refused.')
  }
  const summary=await snapshot(targets)
  if(q.op==='recycle'&&summary.digest!==q.digest)throw Error('Targets changed since planning; create a new plan.')
  if(q.expires&&Date.now()>=q.expires)throw Error('Plan expired during revalidation; create a new plan.')
  for(const p of targets) {
   await plain(p)
   await emit({type:'progress',phase:'removing',...summary,removed:[...removed],currentTarget:p})
   if(q.op==='clean')await fs.rm(p,{recursive:true})
   else await new Promise((resolve,reject)=>{
    const child=cp.spawn('gio',['trash','--',p],{stdio:['ignore','ignore','pipe']});let error=''
    child.stderr.on('data',b=>error=(error+b).slice(-8192));child.on('error',reject);child.on('exit',code=>code===0?resolve():reject(Error(error||'gio trash failed')))
   })
   try{await fs.lstat(p);throw Error('Target remains after removal: '+p)}catch(e){if(e.code!=='ENOENT')throw e}
   removed.push(p)
   await emit({type:'progress',phase:'removing',...summary,removed:[...removed]})
  }
  return {removed,summary,method:q.op==='clean'?'managed-temp-cleanup':'linux-trash'}
 }catch(e){e.removed=removed;throw e}
}
main(JSON.parse(require('node:fs').readFileSync(0,'utf8'))).then(result=>emit({ok:true,result})).catch(async e=>{await emit({ok:false,error:e.message,removed:e.removed??[],diagnostic:'No permanent-delete fallback or permission repair was attempted.'});process.exitCode=1})
