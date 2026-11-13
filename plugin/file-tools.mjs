import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { apply as applyBash } from '../wsl/custom-bash.mjs'

const recycleSource = readFileSync(new URL('./file-recycle.cs', import.meta.url), 'utf8')
const WINDOWS_SOURCE = readFileSync(new URL('./file-worker.ps1', import.meta.url), 'utf8').replace('# RECYCLE_HELPER',()=>"$null = Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+Buffer.from(recycleSource).toString('base64')+"')))")
const WINDOWS_BOOT = "$s=[IO.MemoryStream]::new([Convert]::FromBase64String('"+gzipSync(WINDOWS_SOURCE).toString('base64')+"'));$g=[IO.Compression.GzipStream]::new($s,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g);try{& ([ScriptBlock]::Create($r.ReadToEnd()))}finally{$r.Dispose();$s.Dispose()}"
const POSIX_SOURCE = readFileSync(new URL('./file-worker.cjs', import.meta.url), 'utf8')
const TTL = 120000
const quote = value => "'" + value.replaceAll("'", "'\\''") + "'"
const stable = value => JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item) ? Object.fromEntries(Object.keys(item).sort().map(k => [k,item[k]])) : item)
const output = { schema: { type:'object', properties:{text:{type:'string'}}, required:['text'], additionalProperties:false }, render: (_args,v) => [{type:'text',text:v.text}] }
const response = value => ({text:JSON.stringify(value,null,2)})

export function fileBackend(paths, platform = process.platform) {
 if(platform !== 'win32') return {backend:'posix', paths}
 const converted=paths.map(p => { const m=/^\/mnt\/([a-z])(?:\/(.*))?$/i.exec(p); return m ? m[1].toUpperCase()+':\\'+(m[2]??'').replaceAll('/','\\') : p })
 const wsl=converted.filter(p=>p.startsWith('/')).length
 if(wsl && wsl!==converted.length) throw Error('Do not mix Windows and WSL targets in one plan.')
 return {backend:wsl?'wsl':'windows',paths:converted}
}
export function assertRemovable(targets, boundary, home, windows) {
 const api=windows?path.win32:path.posix
 const normalized=p=> { const v=api.resolve(p); return windows?v.toLowerCase():v }
 const inside=(p,root)=>p===root||p.startsWith(root.replace(/[\\/]$/,'')+api.sep)
 const protectedPaths=[boundary,home].filter(Boolean).map(normalized)
 for(const raw of targets) {
  const p=normalized(raw)
  if(p===api.parse(p).root || protectedPaths.some(root=>inside(root,p)) || p.split(/[\\/]/).includes('.git')) throw Error('Protected root, home, workspace ancestor, or .git target: '+raw)
 }
}

/** 每个操作单独取策略并启动受限工作进程；没有宿主直接删除文件的旁路。 */
export function installFileTools(ctx, config, resolvePolicy) {
 const plans=new Map(), temporary=new Map()
 let stopped=false
 const shutdown=new AbortController()
 ctx.effect(()=>()=>{stopped=true;shutdown.abort();plans.clear();temporary.clear()},'pwsh-run.file-plans')
 const context=async exec=>{
  if(stopped||exec?.signal?.aborted) throw Error('File operation cancelled.')
  const session=exec?.agent?.session
  if(typeof session?.id!=='string'||!session.id) throw Error('File tools require a session ID.')
  let policy=resolvePolicy(exec.agent)
  if(!policy || !['read-only','workspace-write','danger-full-access'].includes(policy.mode)) throw Error('File tools require a valid sandbox policy.')
  const cwd=await(ctx.get('workingDirectory')?.ensure(exec.agent,exec.signal)??session.header?.cwd)
  if(typeof cwd!=='string'||!cwd) throw Error('File tools require a working directory.')
  policy=resolvePolicy(exec.agent)
  if(stopped||exec?.signal?.aborted||!policy) throw Error('File operation cancelled or sandbox policy disappeared.')
  return {policy,cwd,session:session.id,key:stable([session.id,cwd,policy]),sandbox:ctx.get('sandbox')}
 }
 const run=async(q, c, exec, policy=c.policy)=>{
  const signal=AbortSignal.any([shutdown.signal,AbortSignal.timeout(30000),...(exec?.signal?[exec.signal]:[])])
  signal.throwIfAborted()
  let text
  if(q.backend==='wsl') {
   let tool;const effects=[]
   applyBash({subprocess:ctx.subprocess,tools:{register(def){tool=def;return()=>{}}},get(name){return name==='sandboxPolicy'?{resolve:()=>policy}:ctx.get(name)},effect(fn){const d=fn();effects.push(d);return d}}, {timeoutMs:30000,maxOutputBytes:1024*1024})
   try {
    const encoded=Buffer.from(POSIX_SOURCE).toString('base64')
    const program="import('node:module').then(({createRequire})=>new Function('require',Buffer.from('"+encoded+"','base64').toString())(createRequire(process.cwd()+'/file-worker.cjs'))).catch(e=>{console.error(e.message);process.exitCode=1})"
    const script="printf %s "+quote(Buffer.from(JSON.stringify(q)).toString('base64'))+" | base64 -d | node -e "+quote(program)
    text=(await tool.execute({command:script,workdir:c.cwd},{...exec,signal})).text
   } finally {for(const d of effects.reverse()) d?.()}
  } else {
   const windows=q.backend==='windows'
   const executable=windows?await ctx.subprocess.resolveExecutable(config?.pwshPath??'pwsh',undefined,signal):process.execPath
   let argv=windows?[executable,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_BOOT,'utf16le').toString('base64')]:[executable,'-e',POSIX_SOURCE]
   if(policy.mode!=='danger-full-access') {
    if(!c.sandbox) throw Error('File tools require sandbox.confine in restricted modes.')
    argv=(await c.sandbox.confine(argv,policy,signal))?.argv
    if(!Array.isArray(argv)||!argv.length) throw Error('sandbox.confine returned invalid argv.')
   }
   const h=ctx.subprocess.spawn({argv,cwd:c.cwd,stdio:{stdin:{data:JSON.stringify(q)},stdout:{maxBytes:1024*1024},stderr:{maxBytes:65536}},signal,graceMs:3000})
   const outcome=await h.done
   text=h.collected.stdout.readFrom(0).text
   if(outcome.exitCode!==0&&!text.trim()) throw Error('File worker failed: '+h.collected.stderr.readFrom(0).text)
  }
  const line=text.split(/\r?\n/).findLast(x=>x.startsWith('{'))
  let result;try {result=JSON.parse(line)} catch {throw Error('File worker did not return valid JSON: '+text.slice(-2048))}
  if(!result.ok) {
   const detail={removed:result.removed??[],diagnostic:result.diagnostic}
   const error=Error(result.error+'\n'+JSON.stringify(detail));Object.assign(error,detail);throw error
  }
  return result.result
 }
 const workerCwd=(backend,cwd)=>backend==='wsl'?cwd.replace(/^([A-Za-z]):[\\/]/,(_m,d)=>'/mnt/'+d.toLowerCase()+'/').replaceAll('\\','/'):cwd
 const approve=async(args,c,exec,targets)=>{
  if(c.policy.mode==='danger-full-access') return c.policy
  if(args.sandbox_permissions!=='danger-full-access'||typeof args.justification!=='string'||!args.justification.trim()) throw Error('Recycling writes outside the workspace. Request sandbox_permissions="danger-full-access" with justification for this exact plan; it will require Host approval.')
  const approval=ctx.get('approval')
  if(!approval||!exec.agent) throw Error('No Host approval service is available; no deletion was performed.')
  const decision=await approval.request({agent:exec.agent,toolName:'file_remove',callId:exec.callId??exec.id,reason:'escalate sandbox to danger-full-access: recycle these fixed targets only: '+JSON.stringify(targets)+'. '+args.justification,displayReason:'将已确认的固定清单送入回收站（回收站位于工作区外）：'+targets.join(', '),signal:exec.signal})
  if(decision!=='allowed-once') throw Error('Host approval '+decision+'; deletion remains denied. Do not work around this decision.')
  const current=await context(exec)
  if(current.key!==c.key||current.sandbox!==c.sandbox) throw Error('Sandbox boundary changed during approval; create a new plan.')
  return {...c.policy,mode:'danger-full-access'}
 }
 const register=(name,description,properties,required,execute)=>ctx.effect(()=>ctx.tools.register({name,description,parameters:{type:'object',properties,required,additionalProperties:false},output,execute}),'pwsh-run.'+name)
 register('file_remove','Two-phase removal. First action=plan resolves exact targets and returns the full bounded inventory. Review it, then make a separate action=execute call with planId. Recycling only; never falls back to permanent deletion or repairs ACLs. Links, protected roots and changed plans are refused. Windows paths, including /mnt/c and /mnt/d, use the real Windows Recycle Bin. Plans expire after two minutes and are single-use. Restricted sessions need explicit one-call Host approval for recycling outside the workspace.',{
  action:{type:'string',enum:['plan','execute']},paths:{type:'array',items:{type:'string'},minItems:1,maxItems:64},planId:{type:'string'},sandbox_permissions:{type:'string',enum:['danger-full-access']},justification:{type:'string'}
 },['action'],async(args,exec)=>{
  const c=await context(exec)
  if(c.policy.mode==='read-only') throw Error('File removal tools are unavailable in read-only mode; change session permissions before planning or removing files.')
  if(args.action==='plan') {
   if(!Array.isArray(args.paths)||!args.paths.length||args.paths.length>64||args.paths.some(p=>typeof p!=='string'||!p||p.length>32768||p.includes('\0'))) throw Error('Provide 1 to 64 nonempty literal paths; only final-component wildcards are supported.')
   const {backend,paths}=fileBackend(args.paths)
   const cwd=workerCwd(backend,c.cwd)
   const boundary=workerCwd(backend,c.policy.workspaceRoot??c.cwd)
   // 在扫描大目录前先拒绝可识别的保护路径，展开后再用真实绝对路径检查一遍。
   assertRemovable(paths.map(p=>(backend==='windows'?path.win32:path.posix).resolve(cwd,p)),boundary,null,backend==='windows')
   const result=await run({op:'inspect',backend,paths,cwd},c,exec)
   assertRemovable(result.entries.map(x=>x.path),boundary,result.home,backend==='windows')
   for(const [id,p] of plans) if(p.expires<=Date.now()) plans.delete(id)
   if(plans.size>=32) throw Error('Too many pending removal plans; wait for one to expire.')
   const planId=randomUUID(), expires=Date.now()+TTL
   plans.set(planId,{...result,backend,cwd,key:c.key,sandbox:c.sandbox,expires})
   return response({action:'plan',planId,expiresAt:new Date(expires).toISOString(),method:backend==='windows'?'windows-recycle-bin':'linux-trash',targets:result.paths,entries:result.entries,requiresHostApproval:c.policy.mode!=='danger-full-access',next:'Review every target, then call file_remove action=execute with this planId. This is an Agent confirmation, not a Host approval.'})
  }
  if(args.action!=='execute'||typeof args.planId!=='string') throw Error('Expected action=plan or action=execute with planId.')
  const plan=plans.get(args.planId); plans.delete(args.planId)
  if(!plan||plan.expires<=Date.now()) throw Error('Unknown, expired or already-used plan; create a new plan.')
  if(plan.key!==c.key||plan.sandbox!==c.sandbox) throw Error('Plan belongs to another session, directory or sandbox boundary.')
  const policy=await approve(args,c,exec,plan.paths)
  if(plan.expires<=Date.now()) throw Error('Plan expired while waiting for approval; create a new plan.')
  const result=await run({op:'recycle',backend:plan.backend,paths:plan.paths,cwd:plan.cwd,digest:plan.digest},c,exec,policy)
  return response({action:'execute',...result})
 })
 register('file_temp','Create a new registered temporary directory inside this session workspace. action=clean with its tempId authorizes permanent cleanup of that directory only, without another removal plan. Existing directories cannot be registered. The identity, owner marker, sandbox boundary and session must still match; links and oversized trees are refused. This exception does not authorize cleanup of arbitrary paths named temp.',{action:{type:'string',enum:['create','clean']},backend:{type:'string',enum:['windows','wsl','posix']},tempId:{type:'string'}},['action'],async(args,exec)=>{
  const c=await context(exec)
  if(c.policy.mode==='read-only') throw Error('Temporary writes and cleanup are unavailable in read-only mode.')
  if(args.action==='create') {
   if(temporary.size>=32) throw Error('Too many registered temporary directories; clean one first.')
   const backend=args.backend??(process.platform==='win32'?'windows':'posix')
   if(!['windows','wsl','posix'].includes(backend)||((backend==='windows'||backend==='wsl')&&process.platform!=='win32')||(backend==='posix'&&process.platform==='win32')) throw Error('Unsupported temporary backend for this host.')
   const parent=workerCwd(backend,c.policy.workspaceRoot??c.cwd), cwd=workerCwd(backend,c.cwd), id=randomUUID()
   if(backend==='wsl'&&/^\/mnt\/[a-z](\/|$)/i.test(parent)) throw Error('This workspace is on a Windows drive. Use the Windows temporary backend for its Recycle Bin and ACL semantics.')
   const result=await run({op:'create',backend,parent,cwd,id},c,exec)
   temporary.set(id,{...result,backend,cwd,key:c.key,sandbox:c.sandbox})
   return response({tempId:id,path:result.path,cleanup:'Call file_temp action=clean with this tempId. Only this new directory is authorized for permanent temporary cleanup.'})
  }
  const t=temporary.get(args.tempId)
  if(args.action!=='clean'||!t||t.key!==c.key||t.sandbox!==c.sandbox) throw Error('Unknown temporary directory or changed session/sandbox boundary.')
  const result=await run({op:'clean',backend:t.backend,cwd:t.cwd,paths:[t.path],id:args.tempId,identity:t.id},c,exec)
  temporary.delete(args.tempId)
  return response(result)
 })
}
