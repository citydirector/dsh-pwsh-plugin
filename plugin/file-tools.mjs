import { readFileSync } from 'node:fs'
import { randomUUID } from 'node:crypto'
import { gzipSync } from 'node:zlib'
import path from 'node:path'
import { serviceIdentity } from './service-identity.mjs'
import { fileScanLimits, inventoryStream, inventoryPage, FileOperations, PLAN_TTL, PAGE_BYTES } from './file-scan.mjs'
import { apply as applyBash } from '../wsl/custom-bash.mjs'

const recycleSource = readFileSync(new URL('./file-recycle.cs', import.meta.url), 'utf8')
const WINDOWS_SOURCE = readFileSync(new URL('./file-worker.ps1', import.meta.url), 'utf8').replace('# RECYCLE_HELPER',()=>"$null = Add-Type -TypeDefinition ([Text.Encoding]::UTF8.GetString([Convert]::FromBase64String('"+Buffer.from(recycleSource).toString('base64')+"')))")
const WINDOWS_BOOT = "$s=[IO.MemoryStream]::new([Convert]::FromBase64String('"+gzipSync(WINDOWS_SOURCE).toString('base64')+"'));$g=[IO.Compression.GzipStream]::new($s,[IO.Compression.CompressionMode]::Decompress);$r=[IO.StreamReader]::new($g);try{& ([ScriptBlock]::Create($r.ReadToEnd()))}finally{$r.Dispose();$s.Dispose()}"
const POSIX_SOURCE = readFileSync(new URL('./file-worker.cjs', import.meta.url), 'utf8')
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
 const plans=new Map(), temporary=new Map(), reservations=new Map(), cleaning=new Set(), operations=new FileOperations()
 const limits=fileScanLimits(config)
 let stopped=false
 const shutdown=new AbortController()
 ctx.effect(()=>()=>{stopped=true;shutdown.abort();operations.dispose();plans.clear();temporary.clear();reservations.clear()},'pwsh-run.file-plans')
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
  const sandbox=ctx.get('sandbox')
  return {policy,cwd,session:session.id,key:stable([session.id,cwd,policy]),sandbox,backendIdentity:serviceIdentity(sandbox)}
 }
 const workerCwd=(backend,cwd)=>backend==='wsl'?cwd.replace(/^([A-Za-z]):[\\/]/,(_m,d)=>'/mnt/'+d.toLowerCase()+'/').replaceAll(String.fromCharCode(92),'/'):cwd
 const run=async(q,c,exec,policy=c.policy,onEntry=()=>{},onProgress=()=>{})=>{
  const controller=new AbortController(), timeout=q.op==='inspect'?limits.fileScanTimeoutMs+5000:limits.fileOperationTimeoutMs
  const timer=setTimeout(()=>controller.abort(Error('File operation timed out; inspect remaining targets before retrying.')),timeout)
  const signal=AbortSignal.any([shutdown.signal,controller.signal,...(exec?.signal?[exec.signal]:[])])
  let parsingError, lastProgress={removed:[]}, handle
  const parsed=inventoryStream({onEntry,onProgress:value=>{lastProgress=value;onProgress(value)}})
  // 使用同一严格解析器贯穿整个 stdout；collect 截断不能成为计划成功的依据。
  const receiveFrame=chunk=>{try{parsed.push(chunk)}catch(error){parsingError=error;controller.abort(error)}}
  const bind=h=>{handle=h;if(!h.stdout?.on)throw Error('File worker requires streaming subprocess stdout.');h.stdout.on('data',receiveFrame);h.stdout.on('error',error=>{parsingError=error;controller.abort(error)})}
  try {
   signal.throwIfAborted()
   let outcome
   if(q.backend==='wsl') {
    let tool;const effects=[],encoded=Buffer.from(POSIX_SOURCE).toString('base64')
    const subprocess={resolveExecutable:(...args)=>ctx.subprocess.resolveExecutable(...args),spawn(spec){
     if(spec.stdio?.stdin?.data?.includes(encoded)) {
      const h=ctx.subprocess.spawn({...spec,stdio:{...spec.stdio,stdout:'pipe',stderr:{maxBytes:65536}}});bind(h);return h
     }
     return ctx.subprocess.spawn(spec)
    }}
    applyBash({subprocess,tools:{register(def){tool=def;return()=>{}}},get(name){return name==='sandboxPolicy'?{resolve:()=>policy}:ctx.get(name)},effect(fn){const d=fn();effects.push(d);return d}}, {timeoutMs:timeout,maxOutputBytes:65536})
    try {
     const program="import('node:module').then(({createRequire})=>new Function('require',Buffer.from('"+encoded+"','base64').toString())(createRequire(process.cwd()+'/file-worker.cjs'))).catch(e=>{console.error(e.message);process.exitCode=1})"
     const script="printf %s "+quote(Buffer.from(JSON.stringify({...q,limits})).toString('base64'))+" | base64 -d | node -e "+quote(program)
     await tool.execute({command:script,workdir:c.cwd},{...exec,signal})
     if(!handle)throw Error('WSL file worker did not start.')
     outcome=await handle.done
    }finally{for(const d of effects.reverse())d?.()}
   } else {
    const windows=q.backend==='windows'
    const executable=windows?await ctx.subprocess.resolveExecutable(config?.pwshPath??'pwsh',undefined,signal):process.execPath
    let argv=windows?[executable,'-NoLogo','-NoProfile','-NonInteractive','-EncodedCommand',Buffer.from(WINDOWS_BOOT,'utf16le').toString('base64')]:[executable,'-e',POSIX_SOURCE]
    if(policy.mode!=='danger-full-access') {
     if(!c.sandbox) throw Error('File tools require sandbox.confine in restricted modes.')
     argv=(await c.sandbox.confine(argv,policy,signal))?.argv
     if(!Array.isArray(argv)||!argv.length) throw Error('sandbox.confine returned invalid argv.')
    }
    bind(ctx.subprocess.spawn({argv,cwd:c.cwd,stdio:{stdin:{data:JSON.stringify({...q,limits})},stdout:'pipe',stderr:{maxBytes:65536}},signal,graceMs:3000}))
    outcome=await handle.done
   }
   if(parsingError)throw parsingError
   if(signal.aborted)throw signal.reason??Error('File operation cancelled.')
   let result
   try{result=parsed.finish()}catch(error){error.message+=' '+(handle?.collected.stderr.readFrom(0).text??'').slice(-4096);throw error}
   if(!result.ok) {
    const detail={removed:result.removed??lastProgress.removed??[],diagnostic:result.diagnostic}
    const error=Error(result.error+'\n'+JSON.stringify(detail));Object.assign(error,detail);throw error
   }
   if(outcome.exitCode!==0)throw Error('File worker failed after emitting a result: '+(handle?.collected.stderr.readFrom(0).text??''))
   return result.result
  }catch(error){if(!error.removed)error.removed=lastProgress.removed??[];throw error}
  finally{clearTimeout(timer);if(handle&&signal.aborted){handle.terminate();await handle.waitForExit()}}
 }
 const approve=async(args,c,exec,targets)=>{
  if(c.policy.mode==='danger-full-access') return c.policy
  if(args.sandbox_permissions!=='danger-full-access'||typeof args.justification!=='string'||!args.justification.trim()) throw Error('Recycling writes outside the workspace. Request sandbox_permissions="danger-full-access" with justification for this exact plan; it will require Host approval.')
  const approval=ctx.get('approval')
  if(!approval||!exec.agent) throw Error('No Host approval service is available; no deletion was performed.')
  const decision=await approval.request({agent:exec.agent,toolName:'file_remove',callId:exec.callId??exec.id,reason:'escalate sandbox to danger-full-access: recycle these fixed targets only: '+JSON.stringify(targets)+'. '+args.justification,displayReason:'将已确认的固定清单送入回收站（回收站位于工作区外）：'+targets.join(', '),signal:exec.signal})
  if(decision!=='allowed-once') throw Error('Host approval '+decision+'; deletion remains denied. Do not work around this decision.')
  const current=await context(exec)
  if(current.key!==c.key||current.backendIdentity!==c.backendIdentity) throw Error('Sandbox boundary changed during approval; create a new plan.')
  return {...c.policy,mode:'danger-full-access'}
 }
 const prunePlans=()=>{for(const [id,p] of plans)if(p.expires<=Date.now()){plans.delete(id);reservations.delete(id)}}
 const owned=(owner,c)=>owner.key===c.key&&owner.backendIdentity===c.backendIdentity
 const getPlan=(id,c)=>{
  prunePlans();const plan=plans.get(id)
  if(!plan)throw Error('Unknown, expired or already-used plan; create a new plan.')
  if(!owned(plan,c))throw Error('Plan belongs to another session, directory or sandbox boundary.')
  return plan
 }
 const ownedOperation=(id,c,name)=>{
  operations.prune();const job=operations.jobs.get(id)
  if(!job||!job.action.startsWith(name+':')||!owned(job.owner,c))throw Error('Unknown operation or changed session/sandbox boundary.')
  return job
 }
 const register=(name,description,properties,required,execute)=>ctx.effect(()=>ctx.tools.register({name,description,parameters:{type:'object',properties,required,additionalProperties:false},output,execute}),'pwsh-run.'+name)
 const waitMs={type:'integer',minimum:0,maximum:10000},operationId={type:'string'}
 const start=async(c,exec,name,action,wait,task)=>{
  if(!Number.isSafeInteger(wait)||wait<0||wait>10000)throw Error('waitMs must be between 0 and 10000.')
  const job=operations.start(randomUUID(),c,name+':'+action,async job=>{
   const signal=AbortSignal.any([shutdown.signal,job.controller.signal,...(exec?.signal?[exec.signal]:[])])
   let checking=false
   const monitor=setInterval(async()=>{
    if(checking||signal.aborted)return
    checking=true
    try{const current=await context({...exec,signal});if(!owned(c,current))job.controller.abort(Error('Session or sandbox boundary changed during the file operation.'))}
    catch(error){job.controller.abort(error)}finally{checking=false}
   },250)
   try{return await task(job,{...exec,signal})}finally{clearInterval(monitor)}
  })
  await operations.wait(job,wait)
  if(job.status==='completed')return response(job.result)
  if(job.status==='failed')throw job.error
  return response(operations.view(job))
 }
 const poll=async(args,c,name)=>{
  const job=ownedOperation(args.operationId,c,name)
  if(args.action==='cancel'&&job.status==='running')job.controller.abort(Error('File operation cancelled; inspect remaining targets before retrying.'))
  await operations.wait(job,args.waitMs??0)
  return response(operations.view(job))
 }
 register('file_remove','Two-phase recycling. action=plan fully scans targets: small plans show every entry; large plans show exact roots, counts, bytes and a preview. action=list pages the complete inventory. Review it, then action=execute with planId. Longer calls return operationId; use status/cancel and waitMs (0..10000). No executable plan is created after truncation or a budget/scan failure. Plans expire two minutes after scanning completes and are single-use. Internal symlinks/junctions are recorded and never traversed; target/ancestor links, mounted filesystems, protected roots and changed plans are refused. Recycling only, no permanent fallback or ACL repair. /mnt/c and /mnt/d use the Windows Recycle Bin; restricted sessions require explicit one-call Host approval.',{
  action:{type:'string',enum:['plan','list','execute','status','cancel']},paths:{type:'array',items:{type:'string'},minItems:1,maxItems:64},planId:{type:'string'},operationId,waitMs,offset:{type:'integer',minimum:0},limit:{type:'integer',minimum:1,maximum:256},sandbox_permissions:{type:'string',enum:['danger-full-access']},justification:{type:'string'}
 },['action'],async(args,exec)=>{
  const c=await context(exec)
  if(c.policy.mode==='read-only') throw Error('File removal tools are unavailable in read-only mode; change session permissions before planning or removing files.')
  if(args.action==='status'||args.action==='cancel')return poll(args,c,'file_remove')
  if(args.action==='list') {const p=getPlan(args.planId,c);return response({action:'list',planId:args.planId,expiresAt:new Date(p.expires).toISOString(),...inventoryPage(p.entries,args.offset,args.limit)})}
  if(args.action==='plan') {
   if(!Array.isArray(args.paths)||!args.paths.length||args.paths.length>64||args.paths.some(p=>typeof p!=='string'||!p||p.length>32768||p.includes('\0'))) throw Error('Provide 1 to 64 nonempty literal paths; only final-component wildcards are supported.')
   const {backend,paths}=fileBackend(args.paths),cwd=workerCwd(backend,c.cwd),boundary=workerCwd(backend,c.policy.workspaceRoot??c.cwd)
   assertRemovable(paths.map(p=>(backend==='windows'?path.win32:path.posix).resolve(cwd,p)),boundary,null,backend==='windows')
   prunePlans();if(reservations.size>=32)throw Error('Too many pending removal plans; wait for one to expire.')
   const planId=randomUUID(),reservation={bytes:0,entries:0};reservations.set(planId,reservation)
   try{return await start(c,exec,'file_remove','plan',args.waitMs??10000,async(job,activeExec)=>{
    const entries=[];let retained=false
    try {
     const result=await run({op:'inspect',backend,paths,cwd,boundary},c,activeExec,c.policy,(entry,bytes)=>{
      assertRemovable([entry.path],boundary,null,backend==='windows')
      reservation.entries++;reservation.bytes+=bytes+1
      if(reservation.entries>limits.fileScanMaxEntries||[...reservations.values()].reduce((n,r)=>n+r.bytes,0)>limits.fileScanMaxBytes)throw Error('File scan inventory budget exceeded; no executable plan was created.')
      entries.push(entry)
     },progress=>{job.progress={...job.progress,...progress}})
     activeExec.signal.throwIfAborted()
     assertRemovable(result.paths,boundary,result.home,backend==='windows')
     if(result.summary?.entries!==entries.length||result.summary.inventoryBytes!==reservation.bytes||result.digest!==result.summary.digest)throw Error('Incomplete file inventory; no executable plan was created.')
     const current=await context(activeExec)
     if(!owned(c,current))throw Error('Sandbox boundary changed while scanning; create a new plan.')
     const expires=Date.now()+PLAN_TTL,small=entries.length<=512&&Buffer.byteLength(JSON.stringify({entries},null,2))<PAGE_BYTES-8192
     plans.set(planId,{...result,entries,backend,cwd,boundary,key:c.key,backendIdentity:c.backendIdentity,expires});retained=true
     return {action:'plan',planId,expiresAt:new Date(expires).toISOString(),method:backend==='windows'?'windows-recycle-bin':'linux-trash',targets:result.paths,summary:result.summary,...(small?{entries}:{preview:inventoryPage(entries,0,32).entries,inventory:{totalEntries:entries.length,pageAction:'list',nextOffset:0}}),requiresHostApproval:c.policy.mode!=='danger-full-access',next:'Review the exact targets and complete summary; use action=list for full inventory, then separately execute this planId. Agent confirmation is not Host approval.'}
    }finally{if(!retained)reservations.delete(planId)}
   })}catch(error){reservations.delete(planId);throw error}
  }
  if(args.action!=='execute'||typeof args.planId!=='string')throw Error('Expected plan, list, execute, status or cancel.')
  const plan=getPlan(args.planId,c)
  // 单次消费在审批和重扫之前；取消或部分失败只能重新扫描，不能重放。
  plans.delete(args.planId);reservations.delete(args.planId)
  return start(c,exec,'file_remove','execute',args.waitMs??10000,async(job,activeExec)=>{
   const policy=await approve(args,c,activeExec,plan.paths)
   if(plan.expires<=Date.now())throw Error('Plan expired while waiting for approval; create a new plan.')
   const result=await run({op:'recycle',backend:plan.backend,paths:plan.paths,cwd:plan.cwd,boundary:plan.boundary,digest:plan.digest,expires:plan.expires},c,activeExec,policy,()=>{},progress=>{job.progress={...job.progress,...progress}})
   return {action:'execute',...result}
  })
 })
 register('file_temp','Create a new registered temporary directory inside this workspace. clean with tempId authorizes permanent cleanup of this new directory only. Existing directories cannot be registered. Complete-tree budgets and progress also apply to large temporary trees; long calls return operationId for status/cancel. Identity, owner marker, session and sandbox must still match. Internal links are removed as links; target/ancestor links and unsupported mounts are refused. This exemption does not cover arbitrary paths named temp.',{action:{type:'string',enum:['create','clean','status','cancel']},backend:{type:'string',enum:['windows','wsl','posix']},tempId:{type:'string'},operationId,waitMs},['action'],async(args,exec)=>{
  const c=await context(exec)
  if(c.policy.mode==='read-only')throw Error('Temporary writes and cleanup are unavailable in read-only mode.')
  if(args.action==='status'||args.action==='cancel')return poll(args,c,'file_temp')
  if(args.action==='create') {
   if(temporary.size>=32)throw Error('Too many registered temporary directories; clean one first.')
   const backend=args.backend??(process.platform==='win32'?'windows':'posix')
   if(!['windows','wsl','posix'].includes(backend)||((backend==='windows'||backend==='wsl')&&process.platform!=='win32')||(backend==='posix'&&process.platform==='win32'))throw Error('Unsupported temporary backend for this host.')
   const parent=workerCwd(backend,c.policy.workspaceRoot??c.cwd),cwd=workerCwd(backend,c.cwd),id=randomUUID()
   if(backend==='wsl'&&/^\/mnt\/[a-z](\/|$)/i.test(parent))throw Error('This workspace is on a Windows drive. Use the Windows temporary backend for its Recycle Bin and ACL semantics.')
   const result=await run({op:'create',backend,parent,cwd,id},c,exec)
   temporary.set(id,{...result,backend,cwd,key:c.key,backendIdentity:c.backendIdentity})
   return response({tempId:id,path:result.path,cleanup:'Call file_temp action=clean with this tempId. Only this new directory is authorized for permanent temporary cleanup.'})
  }
  const t=temporary.get(args.tempId)
  if(args.action!=='clean'||!t||!owned(t,c))throw Error('Unknown temporary directory or changed session/sandbox boundary.')
  if(cleaning.has(args.tempId))throw Error('This temporary directory is already being cleaned; inspect the active operation.')
  cleaning.add(args.tempId)
  try{return await start(c,exec,'file_temp','clean',args.waitMs??10000,async(job,activeExec)=>{
   try{const result=await run({op:'clean',backend:t.backend,cwd:t.cwd,paths:[t.path],id:args.tempId,identity:t.id},c,activeExec,c.policy,()=>{},progress=>{job.progress={...job.progress,...progress}});temporary.delete(args.tempId);return result}
   finally{cleaning.delete(args.tempId)}
  })}catch(error){cleaning.delete(args.tempId);throw error}
 })
}
