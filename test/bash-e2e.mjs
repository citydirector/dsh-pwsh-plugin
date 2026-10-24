// custom-bash 真 runtime 端到端：真 LocalSubprocessRuntime + 真 llrun
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { apply } from '../wsl/custom-bash.mjs'
import { importFromDsh, SKIP_HINT, toWslPath } from './support.mjs'

const RT = await importFromDsh('dsh-subprocess-local/lib/index.js')
const cordis = await importFromDsh('cordis/lib/index.js')
if (RT === undefined || cordis === undefined) { console.log(SKIP_HINT); process.exit(0) }
const { Context } = cordis
const boot = new Context()
boot.plugin(RT.default ?? RT, {})
await new Promise((r) => setTimeout(r, 800))
const rt = boot.get('subprocess')
if (rt === undefined) { console.log('SKIP: ctx.subprocess unavailable'); process.exit(0) }
console.log('executable:', await rt.resolveExecutable('bash'))

const WS = process.cwd()
// 仓库自带一份 llrun 二进制；部署过自己那份的话用 LLRUN 指过去。
const LLRUN = process.env.LLRUN ?? toWslPath(WS) + '/wsl/llrun'
// 工作区外的一个位置，用来验证围栏确实拦住了跨目录写入。
const OUTSIDE_WIN = resolve(dirname(WS), '_skadi_e2e_out.txt')
const OUTSIDE_WSL = toWslPath(OUTSIDE_WIN)
let POLICY = { mode: 'workspace-write', workspaceRoot: WS }
let REG = null
const ctx = {
  subprocess: rt,
  tools: { register(d) { REG = d; return () => { REG = null } } },
  get(n) {
    if (n === 'workingDirectory') return { async ensure() { return WS } }
    if (n === 'sandboxPolicy') return { resolve() { return POLICY } }
    return undefined
  },
  effect(fn) { return fn() },
  on() {},
}
apply(ctx, { llrunPath: LLRUN })

const results = []
const check = (l, p, d) => results.push((p ? 'PASS ' : 'FAIL ') + l + (d ? '  ::  ' + d : ''))
const exec = { agent: { session: { id: 'cbe2e-1', header: { cwd: WS } } }, signal: undefined }
const run = (command, extra) => REG.execute({ command, ...(extra ?? {}) }, exec)

// 1. stdin {data} 模式在真 runtime 上可用
let r = await run('echo STDIN-OK')
check('stdin-data-mode', r.text.includes('STDIN-OK'), JSON.stringify(r.text))

// 2. 多行脚本原样送达（stdin 无 argv 引号问题）
r = await run('A=1\nB=2\necho "$A$B"')
check('multiline-script', r.text.trim() === '12', JSON.stringify(r.text))

// 3. 中文与特殊字符
r = await run('echo "中文 \\$ 反斜杠 ok"')
check('unicode', r.text.includes('中文') && r.text.includes('反斜杠'), JSON.stringify(r.text))

// 4. 工作区内可写（真 llrun 围栏）
r = await run('echo ok > _skadi_e2e_in.txt && echo WROTE')
check('fence-inside-writable', r.text.includes('WROTE'), JSON.stringify(r.text))

// 5. 工作区外被拒
r = await run('echo x > ' + OUTSIDE_WSL + ' 2>&1; echo rc=$?')
check('fence-outside-denied', /rc=[1-9]/.test(r.text), JSON.stringify(r.text))

// 6. POSIX workdir 经 -C
r = await run('pwd', { workdir: '/tmp' })
check('workdir-posix-llrun', r.text.trim() === '/tmp', JSON.stringify(r.text))

// 7. Windows workdir 作进程 cwd（换成该盘符路径的 WSL 视角再比）
r = await run('pwd', { workdir: process.cwd() })
check('workdir-windows', r.text.trim() === toWslPath(process.cwd()), JSON.stringify(r.text))

// 8. read-only 档
POLICY = { mode: 'read-only', workspaceRoot: WS }
r = await run('echo x > _skadi_e2e_ro.txt 2>&1; echo rc=$?')
check('ro-denied', /rc=[1-9]/.test(r.text), JSON.stringify(r.text))

// 9. danger-full-access 不挂围栏
POLICY = { mode: 'danger-full-access', workspaceRoot: WS }
r = await run('echo x > ' + OUTSIDE_WSL + ' && echo WROTE')
check('full-no-fence', r.text.includes('WROTE') && existsSync(OUTSIDE_WIN), JSON.stringify(r.text))

// 10. 退出码 + stderr 分离
POLICY = { mode: 'workspace-write', workspaceRoot: WS }
r = await run('echo OUT; echo ERR >&2; exit 7')
check('streams-and-exit', r.text.includes('OUT') && r.text.includes('ERR') && r.text.includes('exit code: 7'), JSON.stringify(r.text))

// 11. 大输出
r = await run('for i in $(seq 1 2000); do echo line$i; done')
check('large-output', r.text.includes('line2000'), 'len=' + r.text.length)

// 清掉本测试自己建的产物（自己刚建的明确目标，永久删安全）
const fs = await import('node:fs/promises')
for (const name of ['_skadi_e2e_in.txt', '_skadi_e2e_ro.txt']) await fs.rm(name, { force: true })
await fs.rm(OUTSIDE_WIN, { force: true })

console.log(results.join('\n'))
console.log('TOTAL pass=' + results.filter((x) => x.startsWith('PASS')).length + ' fail=' + results.filter((x) => x.startsWith('FAIL')).length)