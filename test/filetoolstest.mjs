import assert from 'node:assert/strict'
import {mkdirSync,writeFileSync,existsSync,readFileSync,renameSync,symlinkSync} from 'node:fs'
import {resolve,join} from 'node:path'
import {installFileTools,fileBackend,assertRemovable} from '../plugin/file-tools.mjs'
import {deletionCommand,installDeletionGuard} from '../plugin/deletion-guard.mjs'
import {importFromDsh} from './support.mjs'
import {spawn,spawnSync} from 'node:child_process'
const cordis=await importFromDsh('cordis/lib/index.js'), local=await importFromDsh('dsh-subprocess-local/lib/index.js'), sandboxModule=await importFromDsh('dsh-sandbox-local/lib/index.js')
if(!cordis||!local||!sandboxModule)throw Error('Real DSH runtime is required for deletion tests.')
const [toolModule,nativeModule]=await Promise.all([importFromDsh('dsh-tools/lib/index.js'),importFromDsh('dsh-tool-executor-native/lib/index.js')])
const boot=new cordis.Context();boot.provide('systemPrompt',{tools(){return()=>{}},getSectionOrder(){return 0}});new toolModule.ToolsService(boot)
boot.plugin(sandboxModule.default??sandboxModule,{});await new Promise(r=>setTimeout(r,600))
const subprocess=new local.LocalSubprocessRuntime(boot)
let replacementSandbox
const root=resolve('_skadi_temp/file-tools-test-'+Date.now());mkdirSync(root,{recursive:true})
let mode='danger-full-access', approvalResult='allowed-once', approvalHook, approvals=0, pass=0, currentCwd=root
const effects=[],tools=new Map(), guards=[]
const policy=()=>({mode,workspaceRoot:root})
const ctx={subprocess,tools:{register(def){tools.set(def.name,def);const d=boot.tools.register(def);return()=>{d();tools.delete(def.name)}},guard(fn){guards.push(fn);const d=boot.tools.guard(fn);return()=>{d();guards.splice(guards.indexOf(fn),1)}}},effect(fn){const d=fn();effects.push(d);return d},get(name){if(name==='sandbox')return replacementSandbox??boot.get('sandbox');if(name==='workingDirectory')return{async ensure(){return currentCwd}};if(name==='approval')return{async request(q){assert(q.reason.includes('fixed targets'));approvals++;approvalHook?.();return approvalResult}}}}
installFileTools(ctx,{pwshPath:process.env.PWSH_BIN??'pwsh'},policy)
const exec={agent:{ctx:boot,session:{id:'files-test',header:{cwd:root},append(){}}},callId:'test-removal'}
const native=new nativeModule.NativeToolExecutor(boot)
let seq=0
const dispatch=async(name,args)=>{const r=await native.execute({agent:exec.agent,signal:new AbortController().signal,calls:[{type:'tool-call',id:'file-native-'+(++seq),name,arguments:JSON.stringify(args)}]});return r.results[0].result}
const call=async(name,args,e=exec)=>JSON.parse((await tools.get(name).execute(args,e)).text)
const check=(name,fn)=>{fn();pass++;console.log('PASS '+name)}
const plan=p=>call('file_remove',{action:'plan',paths:[p]})
const remove=planId=>call('file_remove',{action:'execute',planId,sandbox_permissions:'danger-full-access',justification:'Recycle only the generated integration-test fixture after reviewing its plan.'})
try {
 check('real-service-proxies-change-between-lookups',()=>assert.notEqual(boot.get('sandbox'),boot.get('sandbox')))
 check('windows-mount-selects-real-recycle-bin',()=>assert.deepEqual(fileBackend(['/mnt/d/a'],'win32'),{backend:'windows',paths:['D:\\a']}))
 check('mixed-backends-refused',()=>assert.throws(()=>fileBackend(['/home/a','D:/a'],'win32')))
 check('workspace-and-home-ancestors-protected',()=>{assert.throws(()=>assertRemovable(['C:/Users'],'D:/project','C:/Users/u',true));assert.throws(()=>assertRemovable(['D:/project'],'D:/project','C:/Users/u',true))})
 const target=join(root,'one.txt');writeFileSync(target,'one')
 const dispatched=await dispatch('file_remove',{action:'plan',paths:[target]})
 check('real-native-pipeline-accepts-file-tool-schema',()=>assert(!dispatched.isError&&dispatched.content.some(x=>x.type==='text'&&x.text.includes('planId'))))
 let p=JSON.parse(dispatched.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))
 check('planning-does-not-delete',()=>assert(existsSync(target)&&p.entries.length===1&&p.targets[0]===target))
 const nativeRemoved=await dispatch('file_remove',{action:'execute',planId:p.planId})
 assert(!nativeRemoved.isError,JSON.stringify(nativeRemoved))
 const r=JSON.parse(nativeRemoved.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))
 check('windows-recycle-bin-executed',()=>assert(!existsSync(target)&&r.method==='windows-recycle-bin'&&r.removed.length===1))
 const q=s=>"'"+s.replaceAll("'","''")+"'"
 const verification=spawnSync(process.env.PWSH_BIN??'pwsh',['-NoProfile','-NonInteractive','-Command',
  '$null=Add-Type -TypeDefinition ([IO.File]::ReadAllText('+q(resolve('plugin/file-recycle.cs'))+'));$s=[StrictRecycle+RecycleSink]::new();$rb=(New-Object -ComObject Shell.Application).Namespace(10);$found=0;foreach($i in @($rb.Items())){if($rb.GetDetailsOf($i,1) -eq '+q(root)+'){$found++}};@{refused=$s.PreDeleteItem(0,$null);allowed=$s.PreDeleteItem(128,$null);inRecycleBin=$found}|ConvertTo-Json -Compress'],{encoding:'utf8',timeout:20000})
 assert.equal(verification.status,0,verification.stderr);const verified=JSON.parse(verification.stdout.trim())
 check('recycle-sink-vetoes-permanent-delete',()=>assert(verified.refused<0&&verified.allowed===0))
 check('recycled-item-visible-in-windows-bin',()=>assert(verified.inRecycleBin===1))
 await assert.rejects(()=>remove(p.planId),/used|Unknown/);check('plans-are-single-use',()=>{})
 // 每次 PTC 程序各自绑定 SDK，计划跨程序调用仍归属于同一真实会话。
 const {PtcExecutor}=await importFromDsh('dsh-tool-executor-ptc/lib/index.js')
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor
 boot.provide('workingDirectory',{async ensure(){return root}})
 boot.provide('ptcRuntime',{
  language:'typescript',programFormat:'function-body',retainsState:false,
  resolve(request){return {...request,timeoutMs:20000}},
  async run(spec){try{return {logs:[],value:await new AsyncFunction('tools',spec.program)(spec.bindings[0].functions)}}catch(e){return {logs:[],error:{kind:'exception',message:String(e.message)}}}},
  async release(){},
 })
 const ptc=new PtcExecutor(boot)
 const ptcCall=async args=>{
  const out=await ptc.execute({agent:exec.agent,signal:new AbortController().signal,calls:[{type:'tool-call',id:'file-ptc-'+(++seq),name:'run_code',arguments:JSON.stringify({code:'return (await tools.file_remove('+JSON.stringify(args)+')).text',description:'Exercise fixed removal plan across PTC programs'})}]})
  const result=out.results[0].result;assert(!result.isError,JSON.stringify(result))
  return JSON.parse(result.content.filter(x=>x.type==='text').map(x=>x.text).join('\n'))
 }
 const ptcRoot=join(root,'ptc-inventory');mkdirSync(ptcRoot)
 for(let i=0;i<180;i++)writeFileSync(join(ptcRoot,'fixture-'+i+'.txt'),'fixture')
 const ptcPlan=await ptcCall({action:'plan',paths:[ptcRoot]})
 check('real-ptc-plan-lists-180-files',()=>assert.equal(ptcPlan.entries.length,181))
 const ptcRemoved=await ptcCall({action:'execute',planId:ptcPlan.planId})
 check('real-ptc-execute-survives-new-service-proxies',()=>assert(!existsSync(ptcRoot)&&ptcRemoved.removed.length===1))

 writeFileSync(target,'before');p=await plan(target);writeFileSync(target,'after larger')
 await assert.rejects(()=>remove(p.planId),/changed/);check('changed-file-retained',()=>assert(existsSync(target)))
 p=await plan(target)
 await assert.rejects(()=>call('file_remove',{action:'execute',planId:p.planId},{...exec,agent:{session:{id:'other',header:{cwd:root}}}}),/another session/);check('cross-session-plan-refused',()=>assert(existsSync(target)))
 p=await plan(target);replacementSandbox={confine(){throw Error('must not run')}}
 try{await assert.rejects(()=>remove(p.planId),/sandbox boundary/)}finally{replacementSandbox=undefined}
 check('real-backend-replacement-invalidates-plan',()=>assert(existsSync(target)))
 p=await plan(target);currentCwd=resolve(root,'different-cwd')
 try{await assert.rejects(()=>remove(p.planId),/directory/)}finally{currentCwd=root}
 check('working-directory-change-invalidates-plan',()=>assert(existsSync(target)))
 p=await plan(target);mode='read-only'
 await assert.rejects(()=>remove(p.planId),/boundary|read-only/);check('policy-change-invalidates-plan',()=>assert(existsSync(target)))
 mode='danger-full-access';p=await plan(target);const now=Date.now;Date.now=()=>now()+130000
 try {await assert.rejects(()=>remove(p.planId),/expired/)}finally{Date.now=now}check('expiry-retains-target',()=>assert(existsSync(target)))
 mode='workspace-write';p=await plan(target)
 await assert.rejects(()=>call('file_remove',{action:'execute',planId:p.planId}),/Host approval/);check('recycle-never-silently-elevates',()=>assert(existsSync(target)&&approvals===0))
 p=await plan(target);approvalResult='rejected';await assert.rejects(()=>remove(p.planId),/rejected/);check('host-denial-retains-target',()=>assert(existsSync(target)&&approvals===1))
 approvalResult='allowed-once';p=await plan(target);await remove(p.planId);check('approved-fixed-plan-recycled',()=>assert(!existsSync(target)&&approvals===2))
 const clockTarget=join(root,'clock.txt');writeFileSync(clockTarget,'clock')
 p=await plan(clockTarget);const realNow=Date.now
 approvalHook=()=>{Date.now=()=>realNow()+130000}
 try{await assert.rejects(()=>remove(p.planId),/expired while/)}finally{Date.now=realNow;approvalHook=undefined}
 check('approval-wait-does-not-extend-plan-expiry',()=>assert(existsSync(clockTarget)))
 p=await plan(clockTarget);approvalHook=()=>{mode='read-only'}
 try{await assert.rejects(()=>remove(p.planId),/boundary changed/)}finally{mode='workspace-write';approvalHook=undefined}
 check('approval-rechecks-live-sandbox',()=>assert(existsSync(clockTarget)))
 p=await plan(clockTarget);approvalHook=()=>{replacementSandbox={confine(){throw Error('must not run')}}}
 try{await assert.rejects(()=>remove(p.planId),/boundary changed/)}finally{replacementSandbox=undefined;approvalHook=undefined}
 check('approval-rechecks-real-backend-identity',()=>assert(existsSync(clockTarget)))
 const cancelled=new AbortController();cancelled.abort()
 await assert.rejects(()=>call('file_remove',{action:'plan',paths:[clockTarget]},{...exec,signal:cancelled.signal}),/cancelled/)
 check('cancelled-request-never-inspects-or-deletes',()=>assert(existsSync(clockTarget)))
 mode='danger-full-access'
 const pa=join(root,'partial-a.txt'),pz=join(root,'partial-z.txt');writeFileSync(pa,'a');writeFileSync(pz,'z')
 const hold=spawn(process.env.PWSH_BIN??'pwsh',['-NoProfile','-NonInteractive','-Command',
  '$s=[IO.File]::Open('+q(pz)+',"Open","ReadWrite","None");[Console]::WriteLine("READY");$null=[Console]::In.ReadLine();$s.Dispose()'],{stdio:['pipe','pipe','pipe']})
 try{
  await new Promise((resolve,reject)=>{let text='';const timer=setTimeout(()=>reject(Error('lock startup timed out')),10000);hold.stdout.on('data',b=>{text+=b;if(text.includes('READY')){clearTimeout(timer);resolve()}});hold.on('error',e=>{clearTimeout(timer);reject(e)})})
  const partial=await call('file_remove',{action:'plan',paths:[pa,pz]})
  await assert.rejects(()=>remove(partial.planId),e=>{assert(e.removed.includes(pa));const rendered=JSON.parse(e.message.split('\n').at(-1));assert(rendered.removed.includes(pa)&&rendered.diagnostic);return true})
  check('partial-failure-reports-recycled-paths',()=>assert(!existsSync(pa)&&existsSync(pz)))
 }finally{hold.stdin.end('done\n');await new Promise(resolve=>{const timer=setTimeout(()=>{hold.kill();resolve()},5000);hold.on('close',()=>{clearTimeout(timer);resolve()})})}
 mode='workspace-write'
 const temp=await call('file_temp',{action:'create'})
 check('low-creates-user-readable-managed-directory',()=>assert(existsSync(temp.path)&&readFileSync(join(temp.path,'.file-temp-owner'),'utf8')===temp.tempId))
 replacementSandbox={confine(){throw Error('must not run')}}
 try{await assert.rejects(()=>call('file_temp',{action:'clean',tempId:temp.tempId}),/boundary/)}finally{replacementSandbox=undefined}
 check('managed-temp-rejects-real-backend-replacement',()=>assert(existsSync(temp.path)))
 writeFileSync(join(temp.path,'from-normal-token.txt'),'normal')
 await call('file_temp',{action:'clean',tempId:temp.tempId})
 check('low-cleanup-preserves-normal-user-access',()=>assert(!existsSync(temp.path)))
 const temp2=await call('file_temp',{action:'create'});writeFileSync(join(temp2.path,'.file-temp-owner'),'tampered')
 await assert.rejects(()=>call('file_temp',{action:'clean',tempId:temp2.tempId}),/identity/);check('tampered-temp-is-not-cleaned',()=>assert(existsSync(temp2.path)))
 await assert.rejects(()=>call('file_temp',{action:'clean',tempId:'arbitrary'}),/Unknown/);check('unregistered-temp-refused',()=>{})
 mode='read-only';await assert.rejects(()=>call('file_temp',{action:'create'}),/read-only/);check('read-only-refuses-scratch-writes',()=>{});mode='danger-full-access'
 const dir=join(root,'directory');mkdirSync(dir);writeFileSync(join(dir,'child.txt'),'child')
 p=await call('file_remove',{action:'plan',paths:[dir,join(dir,'child.txt')]});check('nested-targets-deduplicated',()=>assert(p.targets.length===1&&p.entries.length===2))
 const link=join(root,'junction');symlinkSync(dir,link,'junction');await assert.rejects(()=>plan(link),/Link|reparse/);check('junction-not-followed',()=>assert(existsSync(dir)))
 // 链接只用于拒绝测试；解除测试链接不触碰其目标。
 const {unlinkSync}=await import('node:fs');unlinkSync(link)
 writeFileSync(join(root,'glob-a.txt'),'a');writeFileSync(join(root,'glob-b.txt'),'b')
 p=await plan(join(root,'glob-*.txt'));check('wildcard-plan-is-expanded',()=>assert(p.targets.length===2));await remove(p.planId)
 const guardFlag={value:false,get(){return this.value}};installDeletionGuard(ctx,guardFlag)
 check('guard-disabled-preserves-existing-tests',()=>assert.equal(guards[0]({name:'pwsh_run',arguments:{script:'Remove-Item fixture'}}),undefined))
 guardFlag.value=true
 let nativeBody=0
 const nativeFixture=boot.tools.register({name:'pwsh_run',description:'Unexecuted deletion entry fixture',parameters:{type:'object',properties:{script:{type:'string'}},required:['script'],additionalProperties:false},output:{schema:{type:'string'},render:(_a,v)=>[{type:'text',text:v}]},execute(){nativeBody++;return 'body'}})
 const blocked=await dispatch('pwsh_run',{script:'Remove-Item fixture'})
 check('real-pipeline-blocks-before-delete-body',()=>assert(blocked.isError&&nativeBody===0))
 const forwarded=await dispatch('pwsh_run',{script:'node test/itest.mjs'})
 check('real-pipeline-preserves-test-program-calls',()=>assert(!forwarded.isError&&nativeBody===1))
 nativeFixture()
 check('guard-live-blocks-native-and-persistent',()=>{for(const name of ['pwsh','pwsh_run'])assert(guards[0]({name,arguments:{command:'Remove-Item fixture',script:'Remove-Item fixture'}})?.includes('file_remove'))})
 check('guard-blocks-bash-and-common-APIs',()=>{assert(deletionCommand('rm -rf /tmp/a','bash'));assert(deletionCommand('[IO.File]::Delete($p)','pwsh'));assert(deletionCommand('fs.rmSync(p)','bash'))})
 check('guard-allows-reading-and-test-processes',()=>{assert.equal(deletionCommand('Get-Item x # Remove-Item x','pwsh'),null);assert.equal(guards[0]({name:'pwsh_run',arguments:{script:'node test/itest.mjs'}}),undefined)})
 check('file-tools-are-not-blocked-by-guard',()=>assert.equal(guards[0]({name:'file_remove',arguments:{action:'execute'}}),undefined))
 // 最后仅回收此脚本创建且清单可见的夹具目录内容，保留工作区根。
 const cleanup=await plan(join(root,'*'));await remove(cleanup.planId)
 console.log('SUMMARY pass='+pass+' fail=0 fixtureRoot='+root)
}finally{for(const d of effects.reverse())d?.();process.exitCode=0}
