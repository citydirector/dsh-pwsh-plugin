import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,readFileSync,existsSync,symlinkSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {installFileTools} from '../plugin/file-tools.mjs'
import {fileScanLimits,inventoryStream,inventoryPage,FileOperations} from '../plugin/file-scan.mjs'
import {importFromDsh} from './support.mjs'
let pass=0
const check=(name,fn)=>{fn();pass++;console.log('PASS '+name)}
check('scan-limits-are-independent-and-validated',()=>{assert.equal(fileScanLimits().fileScanMaxEntries,250000);assert.throws(()=>fileScanLimits({fileScanMaxEntries:2.5}),/integer/);assert.throws(()=>fileScanLimits({fileScanMaxBytes:536870913}),/integer/)})
check('ndjson-preserves-split-utf8-and-rejects-truncation',()=>{
 const rows=[],stream=inventoryStream({onEntry:e=>rows.push(e)})
 const bytes=Buffer.from(JSON.stringify({type:'entry',entry:{path:'中文'}})+'\n'+JSON.stringify({ok:true,result:{}})+'\n')
 for(const byte of bytes)stream.push(Buffer.from([byte]));assert(stream.finish().ok);assert.equal(rows[0].path,'中文')
 const incomplete=inventoryStream();incomplete.push('{"type":"progress"}\n');assert.throws(()=>incomplete.finish(),/before a complete result/)
 const tooBig=inventoryStream();assert.throws(()=>tooBig.push('x'.repeat(262145)),/byte budget/)
})
check('inventory-page-bounds-do-not-silently-truncate',()=>{
 const entries=Array.from({length:600},(_,i)=>({path:'f'+i}));assert.equal(inventoryPage(entries,256,256).nextOffset,512);assert.equal(inventoryPage(entries,512,256).nextOffset,null)
 assert.throws(()=>inventoryPage(entries,601),/outside/);assert.throws(()=>inventoryPage(entries,0,257),/between/)
})
const jobs=new FileOperations(),job=jobs.start('cancel',{},'test',async j=>{await new Promise((resolve,reject)=>j.controller.signal.addEventListener('abort',()=>reject(j.controller.signal.reason),{once:true}))})
await Promise.resolve();job.controller.abort(Error('cancelled fixture'));await jobs.wait(job,10000)
check('operation-cancellation-has-final-status-and-stable-time',()=>{assert.equal(jobs.view(job).status,'cancelled');assert(jobs.view(job).inspectRemaining);assert.equal(jobs.view(job).elapsedMs,jobs.view(job).elapsedMs)})
const [cordis,local,sandboxModule]=await Promise.all([importFromDsh('cordis/lib/index.js'),importFromDsh('dsh-subprocess-local/lib/index.js'),importFromDsh('dsh-sandbox-local/lib/index.js')])
assert(cordis&&local&&sandboxModule,'Real DSH runtime required')
const boot=new cordis.Context();boot.plugin(sandboxModule.default??sandboxModule,{});await new Promise(r=>setTimeout(r,500))
const native=new local.LocalSubprocessRuntime(boot)
const root=resolve('_skadi_temp/file-large-'+Date.now()),outside=join(root,'external'),tree=join(root,'node_modules')
mkdirSync(outside,{recursive:true});writeFileSync(join(outside,'KEEP.txt'),'external sentinel');mkdirSync(tree)
for(let i=0;i<1200;i++){const p=join(tree,'pkg-'+Math.floor(i/100));mkdirSync(p,{recursive:true});writeFileSync(join(p,'file-'+i+'.txt'),'data '+i)}
writeFileSync(join(tree,"中文'$[].txt"),'unicode path')
symlinkSync(outside,join(tree,'dependency'),'junction')
symlinkSync(join(root,'missing'),join(tree,'broken-dependency'),'junction')
const sets=[]
let mode='danger-full-access',onProgress,lastHandle
const exec={agent:{session:{id:'file-large',header:{cwd:root}}}}
const setup=config=>{
 const effects=[],defs=new Map()
 const subprocess={resolveExecutable:(...a)=>native.resolveExecutable(...a),spawn(spec){const h=native.spawn(spec);lastHandle=h;if(h.stdout&&onProgress){const observe=inventoryStream({onProgress:p=>onProgress?.(p)});h.stdout.on('data',b=>{try{observe.push(b)}catch(e){console.error('Observer: '+e.message)}})}return h}}
 const ctx={subprocess,tools:{register(d){defs.set(d.name,d);return()=>defs.delete(d.name)}},effect(fn){const d=fn();effects.push(d);return d},get(n){if(n==='sandbox')return boot.get('sandbox');if(n==='workingDirectory')return{async ensure(){return root}}}}
 installFileTools(ctx,{pwshPath:process.env.PWSH_BIN??'pwsh',...config},()=>({mode,workspaceRoot:root}));sets.push(effects)
 const call=async(name,args,e=exec)=>JSON.parse((await defs.get(name).execute(args,e)).text)
 const settle=async(name,r)=>{
  if(!r.operationId)return r
  for(let i=0;i<60&&r.status==='running';i++)r=await call(name,{action:'status',operationId:r.operationId,waitMs:10000})
  assert.notEqual(r.status,'running','operation did not settle')
  if(r.status!=='completed'){const error=Error(r.error);error.removed=r.removed;throw error}return r.result
 }
 return {call,settle}
}
const normal=setup({})
const plan=async(p,client=normal)=>client.settle('file_remove',await client.call('file_remove',{action:'plan',paths:[p],waitMs:0}))
try{
 const initial=await normal.call('file_remove',{action:'plan',paths:[tree],waitMs:0})
 check('large-plan-returns-observable-operation',()=>assert(initial.operationId&&initial.status==='running'))
 const p=await normal.settle('file_remove',initial)
 check('large-summary-counts-entire-tree-with-links',()=>{assert.equal(p.summary.files,1201);assert.equal(p.summary.directories,13);assert.equal(p.summary.links,2);assert.equal(p.summary.entries,1216);assert(!p.entries);assert.equal(p.preview.length,32)})
 const rows=[];let offset=0
 do{const page=await normal.call('file_remove',{action:'list',planId:p.planId,offset,limit:128});rows.push(...page.entries);offset=page.nextOffset}while(offset!==null)
 check('all-large-plan-pages-are-complete-without-following-links',()=>{assert.equal(rows.length,1216);assert.equal(new Set(rows.map(e=>e.path)).size,1216);assert(!rows.some(e=>e.path.endsWith('KEEP.txt')));assert(rows.some(e=>e.kind==='link'&&e.path.endsWith('broken-dependency')))})
 const other={agent:{session:{id:'other',header:{cwd:root}}}}
 await assert.rejects(()=>normal.call('file_remove',{action:'list',planId:p.planId},other),/boundary/)
 check('paged-inventory-keeps-session-boundary',()=>{})
 writeFileSync(join(tree,'pkg-11','file-1199.txt'),'changed deep file after planning')
 await assert.rejects(async()=>normal.settle('file_remove',await normal.call('file_remove',{action:'execute',planId:p.planId,waitMs:0})),/changed/)
 check('deep-change-invalidates-large-plan-without-removal',()=>assert(existsSync(tree)&&readFileSync(join(outside,'KEEP.txt'),'utf8')==='external sentinel'))
 await assert.rejects(()=>plan(join(tree,'dependency')),/Link|reparse/)
 check('direct-junction-target-still-refused',()=>{})
 const bounded=setup({fileScanMaxEntries:1000})
 await assert.rejects(()=>plan(tree,bounded),/budget/)
 check('entry-budget-fails-closed-with-target-intact',()=>assert(existsSync(tree)))
 const byteBounded=setup({fileScanMaxBytes:1000})
 await assert.rejects(()=>plan(tree,byteBounded),/budget/)
 check('byte-budget-fails-closed-with-target-intact',()=>assert(existsSync(tree)))
 const short=setup({fileScanTimeoutMs:1})
 await assert.rejects(()=>plan(tree,short),/timed out/)
 check('scan-timeout-creates-no-executable-plan',()=>assert(existsSync(tree)))
 let release,timeout
 const started=new Promise((resolve,reject)=>{release=resolve;timeout=setTimeout(()=>reject(Error('No scan progress observed.')),20000)})
 onProgress=p=>{if(p.phase==='scanning'&&p.entries>=128){onProgress=undefined;release(p)}}
 const cancel=await normal.call('file_remove',{action:'plan',paths:[tree],waitMs:0})
 const progress=await started;clearTimeout(timeout)
 let cancelled=await normal.call('file_remove',{action:'cancel',operationId:cancel.operationId,waitMs:10000})
 while(cancelled.status==='running')cancelled=await normal.call('file_remove',{action:'status',operationId:cancel.operationId,waitMs:10000})
 check('cancel-mid-scan-reports-progress-and-retains-tree',()=>{assert(progress.entries>=128);assert.equal(cancelled.status,'cancelled');assert(!cancelled.result?.planId);assert(existsSync(tree))})
 let boundaryReady,boundaryTimer
 const changedBoundary=new Promise((resolve,reject)=>{boundaryReady=resolve;boundaryTimer=setTimeout(()=>reject(Error('No boundary probe progress.')),20000)})
 onProgress=p=>{if(p.phase==='scanning'&&p.entries>=128){onProgress=undefined;mode='read-only';boundaryReady()}}
 const boundaryJob=await normal.call('file_remove',{action:'plan',paths:[tree],waitMs:0})
 await changedBoundary;clearTimeout(boundaryTimer)
 try{await lastHandle.done}catch(error){assert(error instanceof Error)}
 await new Promise(resolve=>setImmediate(resolve));mode='danger-full-access'
 const boundaryResult=await normal.call('file_remove',{action:'status',operationId:boundaryJob.operationId,waitMs:10000})
 check('live-policy-change-prevents-background-plan-completion',()=>{assert(['failed','cancelled'].includes(boundaryResult.status));assert(!boundaryResult.result?.planId);assert(existsSync(tree))})
 const shortOperation=setup({fileOperationTimeoutMs:1}),shortPlan=await plan(tree,shortOperation)
 await assert.rejects(async()=>shortOperation.settle('file_remove',await shortOperation.call('file_remove',{action:'execute',planId:shortPlan.planId,waitMs:0})),/timed out|aborted/i)
 check('operation-budget-aborts-before-recycling-and-preserves-tree',()=>assert(existsSync(tree)))
 const final=await plan(tree)
 const removed=await normal.settle('file_remove',await normal.call('file_remove',{action:'execute',planId:final.planId,waitMs:0}))
 check('large-tree-recycled-and-external-junction-target-preserved',()=>{assert.equal(removed.method,'windows-recycle-bin');assert(!existsSync(tree));assert.equal(readFileSync(join(outside,'KEEP.txt'),'utf8'),'external sentinel')})
 mode='workspace-write'
 const temp=await normal.call('file_temp',{action:'create'})
 for(let i=0;i<750;i++)writeFileSync(join(temp.path,'temp-'+i),'temporary')
 symlinkSync(outside,join(temp.path,'dependency'),'junction')
 const cleaned=await normal.settle('file_temp',await normal.call('file_temp',{action:'clean',tempId:temp.tempId,waitMs:0}))
 check('low-large-managed-temp-cleanup-does-not-follow-junction',()=>{assert.equal(cleaned.summary.files,751);assert.equal(cleaned.summary.links,1);assert(!existsSync(temp.path));assert.equal(readFileSync(join(outside,'KEEP.txt'),'utf8'),'external sentinel')})
 mode='danger-full-access'
 const cleanup=await plan(outside)
 await normal.settle('file_remove',await normal.call('file_remove',{action:'execute',planId:cleanup.planId,waitMs:0}))
 console.log('SUMMARY pass='+pass+' fail=0')
}finally{
 for(const effects of sets)for(const d of effects.reverse())d?.()
}
