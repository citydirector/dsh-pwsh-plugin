// 入口检查可解释常见删除语法，不代替操作系统的文件权限。
export function deletionCommand(source, dialect) {
 if(typeof source!=='string') return null
 const commands=[]
 const masked=source.replace(/#[^\r\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:\x60.|\\.|[^"\\])*"/g,(token,offset)=>{
  if(token[0]==='#'||token.startsWith('/*')) return ' '.repeat(token.length)
  if(/[&.]\s*$/.test(source.slice(0,offset))) commands.push(token.slice(1,-1))
  return ' '.repeat(token.length)
 })
 const text=masked+String.fromCharCode(10)+commands.join(String.fromCharCode(10))
 const pattern=dialect==='bash'?/(?:^|[\s;&|()])(?:sudo\s+)?(?:[\w/.-]*\/)?(rm|rmdir|unlink)(?=\s|$)|\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync|Delete|DeleteDirectory|DeleteFile)\s*\(/i:/(?:^|[\s;&|()])(?:[\w.-]+\\)?(Remove-Item|Remove-ItemProperty|Clear-RecycleBin|del|erase|rd|rmdir|rm|ri)(?=\s|$)|::(?:Delete|DeleteDirectory|DeleteFile)\s*\(|\.(?:rm|rmSync|unlink|unlinkSync|rmdir|rmdirSync)\s*\(/i
 return pattern.exec(text)?.[0]?.trim()??null
}
export function installDeletionGuard(ctx, enabled) {
 const live=enabled&&typeof enabled.get==='function'
 const read=()=>{const value=live?enabled.get():enabled;if(value!==undefined&&typeof value!=='boolean')throw Error('pwsh_run enforceFileRemoval must be a boolean');return value===true}
 if(!read()&&!live)return
 if(typeof ctx.tools.guard!=='function')throw Error('The deletion guard requires DSH tools.guard().')
 ctx.effect(()=>ctx.tools.guard(exec=>{
  if(!read()||!['pwsh','pwsh_run','bash'].includes(exec.name))return
  const found=deletionCommand(exec.arguments?.[exec.name==='pwsh_run'?'script':'command'],exec.name==='bash'?'bash':'pwsh')
  if(found)return 'Deletion command '+found+' was blocked before execution. Use file_remove action=plan, review the final inventory, then action=execute with planId. For automatically cleaned scratch files, first create a registered directory with file_temp and later clean by tempId. The original script was not executed. This guard recognizes common syntax; it does not inspect arbitrary child programs.'
 }),'pwsh-run.deletion-guard')
}
