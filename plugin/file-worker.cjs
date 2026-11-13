// 独立进程只接受工具构造的数据；不求值调用者提供的脚本。
const fs = require('node:fs/promises'), path = require('node:path'), os = require('node:os'), crypto = require('node:crypto'), cp = require('node:child_process')
async function main(q) {
 const plain = async p => { for(let part=p;;part=path.dirname(part)) { const s=await fs.lstat(part); if(s.isSymbolicLink()) throw Error('Link refused: '+part); if(part===path.dirname(part)) break } }
 const snapshot = async targets => {
  const rows=[], pending=[...targets]
  for(const t of targets) await plain(t)
  while(pending.length) {
   if(rows.length>=512) throw Error('Deletion plan exceeds 512 entries; choose a smaller target.')
   const p=pending.pop(), s=await fs.lstat(p,{bigint:true})
   if(s.isSymbolicLink() || (!s.isFile() && !s.isDirectory())) throw Error('Links and special files are refused: '+p)
   rows.push({path:p,kind:s.isDirectory()?'directory':'file',id:s.dev+':'+s.ino,size:String(s.size),mtime:String(s.mtimeNs),ctime:String(s.ctimeNs),mode:String(s.mode)})
   if(s.isDirectory()) for await(const entry of await fs.opendir(p)) {
    if(rows.length+pending.length>=512) throw Error('Deletion plan exceeds 512 entries; choose a smaller target.')
    pending.push(path.join(p,entry.name))
   }
  }
  return rows.sort((a,b)=>a.path<b.path?-1:a.path>b.path?1:0)
 }
 const digest=rows=>crypto.createHash('sha256').update(JSON.stringify(rows)).digest('hex')
 const targets=(q.paths??[]).map(p=>path.resolve(q.cwd,p))
 const assertNative = p => { if(/^\/mnt\/[a-z](\/|$)/i.test(p)) throw Error('Windows mount paths must use the Windows Recycle Bin worker.') }
 for(const p of targets) assertNative(p)
 if(q.op==='inspect') {
  const expanded=[]
  for(const p of targets) {
   if(/[*?]/.test(p)) {
    const parent=path.dirname(p); if(/[*?]/.test(parent)) throw Error('Wildcards are supported only in the final component.')
    await plain(parent)
    const escaped=Array.from(path.basename(p),ch=>ch==='*'?'.*':ch==='?'?'.':'\\.^$+{}()|[]'.includes(ch)?'\\'+ch:ch).join('')
    const pattern=new RegExp('^'+escaped+String.fromCharCode(36))
    for await(const entry of await fs.opendir(parent)) if(pattern.test(entry.name)) {
     if(expanded.length>=64) throw Error('Expected 1 to 64 matched targets.')
     expanded.push(path.join(parent,entry.name))
    }
   } else expanded.push(p)
  }
  const unique=[...new Set(expanded)].filter(p=>!expanded.some(other=>p.startsWith(other+'/')))
  if(!unique.length||unique.length>64) throw Error('Expected 1 to 64 matched targets.')
  const entries=await snapshot(unique)
  return {paths:unique,entries,digest:digest(entries),home:os.homedir()}
 }
 if(q.op==='create') {
  const parent=path.resolve(q.parent); assertNative(parent); await plain(parent)
  const p=path.join(parent,'file-temp-'+q.id); await fs.mkdir(p,{mode:0o700}); await fs.writeFile(path.join(p,'.file-temp-owner'),q.id,{flag:'wx',mode:0o600})
  const s=await fs.lstat(p,{bigint:true}); return {path:p,id:s.dev+':'+s.ino}
 }
 const rows=await snapshot(targets)
 if(q.op==='recycle') {
  if(digest(rows)!==q.digest) throw Error('Targets changed since planning; create a new plan.')
 } else if(q.op==='clean') {
  if(targets.length!==1||rows.find(x=>x.path===targets[0])?.id!==q.identity||await fs.readFile(path.join(targets[0],'.file-temp-owner'),'utf8')!==q.id) throw Error('Temporary directory identity changed; cleanup refused.')
 } else throw Error('Unsupported file worker operation.')
 const removed=[]
 for(const p of targets) {
  await plain(p)
  try {
   if(q.op==='clean') await fs.rm(p,{recursive:true})
   else await new Promise((resolve,reject)=> { const child=cp.spawn('gio',['trash','--',p],{stdio:['ignore','ignore','pipe']}); let error=''; child.stderr.on('data',b=>error+=b); child.on('error',reject); child.on('exit',code=>code===0?resolve():reject(Error(error||'gio trash failed'))); const timer=setTimeout(()=>{child.kill();reject(Error('gio trash timed out'))},15000); timer.unref(); child.on('close',()=>clearTimeout(timer)) })
   try { await fs.lstat(p); throw Error('Target remains after removal: '+p) } catch(e) { if(e.code!=='ENOENT') throw e }
   removed.push(p)
  } catch(e) { e.removed=removed; throw e }
 }
 return {removed,method:q.op==='clean'?'managed-temp-cleanup':'linux-trash'}
}
main(JSON.parse(require('node:fs').readFileSync(0,'utf8'))).then(result=>console.log(JSON.stringify({ok:true,result}))).catch(e=>{console.log(JSON.stringify({ok:false,error:e.message,removed:e.removed??[],diagnostic:'No permanent-delete fallback or permission repair was attempted.'}));process.exitCode=1})
