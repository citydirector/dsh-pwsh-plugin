import assert from 'node:assert/strict'
import {readFileSync,mkdirSync} from 'node:fs'
import {resolve} from 'node:path'
import {spawnSync} from 'node:child_process'
import {installFileTools} from '../plugin/file-tools.mjs'
import {importFromDsh} from './support.mjs'
const wsl=process.env.WSL_BIN??'C:/Windows/System32/wsl.exe'
const shell=(script,expected=0)=>{const r=spawnSync(wsl,['-e','node','-e',script],{encoding:'utf8',timeout:20000});assert.equal(r.status,expected,r.stderr||r.error?.message);return r.stdout.trim()}
const root=resolve('_skadi_temp/file-tools-wsl-host');mkdirSync(root,{recursive:true})
const fixture=JSON.parse(shell("const fs=require('fs'),path=require('path'),os=require('os');const parent=path.join(os.homedir(),'_skadi_temp');const created=!fs.existsSync(parent);fs.mkdirSync(parent,{recursive:true});const root=fs.mkdtempSync(path.join(parent,'file-tools-wsl-'));console.log(JSON.stringify({root,parent,created}));"))
console.log('FIXTURE '+fixture.root)
const [cordis,local]=await Promise.all([importFromDsh('cordis/lib/index.js'),importFromDsh('dsh-subprocess-local/lib/index.js')])
assert(cordis&&local,'Real DSH runtime is required')
const subprocess=new local.LocalSubprocessRuntime(new cordis.Context()),effects=[],tools=new Map()
let mode='workspace-write',boundary=fixture.root,pass=0
const policy=()=>({mode,workspaceRoot:boundary})
const ctx={subprocess,tools:{register(d){tools.set(d.name,d);return()=>tools.delete(d.name)}},effect(fn){const d=fn();effects.push(d);return d},get(n){if(n==='workingDirectory')return{async ensure(){return root}}}}
installFileTools(ctx,{},policy)
const exec={agent:{session:{id:'wsl-files',header:{cwd:root}}}}
const call=async(name,args)=>JSON.parse((await tools.get(name).execute(args,exec)).text)
const check=(n,fn)=>{fn();pass++;console.log('PASS '+n)}
const inspect=p=>JSON.parse(shell('const fs=require("fs");console.log(JSON.stringify({exists:fs.existsSync('+JSON.stringify(p)+')}))'))
try{
 const temp=await call('file_temp',{action:'create',backend:'wsl'})
 check('wsl-temp-created-inside-fenced-workspace',()=>assert(temp.path.startsWith(fixture.root+'/')&&inspect(temp.path).exists))
 shell('require("fs").writeFileSync('+JSON.stringify(temp.path+'/child')+',"fixture")')
 await call('file_temp',{action:'clean',tempId:temp.tempId})
 check('wsl-managed-temp-cleanup',()=>assert(!inspect(temp.path).exists))
 const file=fixture.root+'/trash.txt';shell('require("fs").writeFileSync('+JSON.stringify(file)+',"fixture")')
 const plan=await call('file_remove',{action:'plan',paths:[file]})
 check('wsl-plan-resolves-native-path',()=>assert(plan.method==='linux-trash'&&plan.targets[0]===file&&inspect(file).exists))
 mode='danger-full-access'
 await assert.rejects(()=>call('file_remove',{action:'execute',planId:plan.planId}),/boundary/)
 check('wsl-policy-change-invalidates-plan',()=>assert(inspect(file).exists))
 const approved=await call('file_remove',{action:'plan',paths:[file]})
 const result=await call('file_remove',{action:'execute',planId:approved.planId})
 check('wsl-gio-recycles-without-permanent-fallback',()=>assert(!inspect(file).exists&&result.method==='linux-trash'))
 const settle=async(name,r)=>{
  if(!r.operationId)return r
  for(let i=0;i<30&&r.status==='running';i++)r=await call(name,{action:'status',operationId:r.operationId,waitMs:10000})
  assert.equal(r.status,'completed',r.error);return r.result
 }
 const base=fixture.root, large=base+'/node_modules',external=base+'/external'
 shell('const fs=require("fs");const base='+JSON.stringify(base)+';fs.mkdirSync(base+"/external");fs.writeFileSync(base+"/external/KEEP","outside");fs.mkdirSync(base+"/node_modules");for(let i=0;i<700;i++)fs.writeFileSync(base+"/node_modules/f"+i,"test");fs.symlinkSync(base+"/external",base+"/node_modules/dependency");fs.symlinkSync(base+"/missing",base+"/node_modules/broken");')
 const largePlan=await settle('file_remove',await call('file_remove',{action:'plan',paths:[large],waitMs:0}))
 check('wsl-large-summary-includes-internal-and-dangling-links',()=>assert(largePlan.summary.entries===703&&largePlan.summary.files===700&&largePlan.summary.links===2&&!largePlan.entries))
 const inventory=[];let offset=0
 do{const page=await call('file_remove',{action:'list',planId:largePlan.planId,offset,limit:256});inventory.push(...page.entries);offset=page.nextOffset}while(offset!==null)
 check('wsl-large-inventory-paginates-without-link-traversal',()=>assert(inventory.length===703&&!inventory.some(e=>e.path.endsWith('/KEEP'))))
 await assert.rejects(()=>call('file_remove',{action:'plan',paths:[large+'/dependency']}),/Link/)
 check('wsl-direct-symlink-target-remains-refused',()=>{})
 shell('require("fs").writeFileSync('+JSON.stringify(large+'/f699')+',"changed since planning")')
 await assert.rejects(async()=>settle('file_remove',await call('file_remove',{action:'execute',planId:largePlan.planId,waitMs:0})),/changed/)
 check('wsl-large-plan-revalidation-detects-deep-change',()=>assert(inspect(large).exists))
 const again=await settle('file_remove',await call('file_remove',{action:'plan',paths:[large],waitMs:0}))
 await settle('file_remove',await call('file_remove',{action:'execute',planId:again.planId,waitMs:0}))
 check('wsl-large-gio-recycle-preserves-external-target',()=>assert(!inspect(large).exists&&inspect(external+'/KEEP').exists))
 mode='workspace-write'
 const largeTemp=await call('file_temp',{action:'create',backend:'wsl'})
 shell('const fs=require("fs"),p='+JSON.stringify(largeTemp.path)+';for(let i=0;i<600;i++)fs.writeFileSync(p+"/f"+i,"temporary");fs.symlinkSync('+JSON.stringify(external)+',p+"/dependency");')
 const cleaned=await settle('file_temp',await call('file_temp',{action:'clean',tempId:largeTemp.tempId,waitMs:0}))
 check('wsl-fenced-large-temp-cleanup-preserves-symlink-target',()=>assert(cleaned.summary.files===601&&cleaned.summary.links===1&&!inspect(largeTemp.path).exists&&inspect(external+'/KEEP').exists))
 mode='danger-full-access'
 const externalPlan=await call('file_remove',{action:'plan',paths:[external]});await call('file_remove',{action:'execute',planId:externalPlan.planId})
 const source=readFileSync(new URL('../plugin/file-worker.cjs',import.meta.url),'utf8')
 const run=q=>JSON.parse(shell('(()=>{const fs=require("node:fs"),orig=fs.readFileSync;fs.readFileSync=function(p,...a){return p===0?'+JSON.stringify(JSON.stringify(q))+':orig.call(this,p,...a)}})();'+source,1))
 // 只做只读路径校验，不在 Windows 挂载盘创建伪回收站。
 const deny=run({op:'inspect',cwd:'/',paths:['/mnt/d/should-not-be-read']})
 check('wsl-worker-refuses-windows-mount',()=>assert(!deny.ok&&/Windows Recycle Bin/.test(deny.error)))
 boundary=root
 await assert.rejects(()=>call('file_temp',{action:'create',backend:'wsl'}),/Windows drive/)
 check('windows-workspace-uses-windows-temp-backend',()=>{})
 console.log('SUMMARY pass='+pass+' fail=0')
}finally{
 for(const d of effects.reverse())d?.()
 // 只清除本测试 mkdtemp 的空根；非空即失败，绝不递归扫用户目录。
 shell('const fs=require("fs");fs.rmdirSync('+JSON.stringify(fixture.root)+');'+(fixture.created?'fs.rmdirSync('+JSON.stringify(fixture.parent)+');':''))
}
