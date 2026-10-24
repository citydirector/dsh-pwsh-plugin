// custom-bash 围栏测试：mock sandboxPolicy 驱动 mode 分诊，真 llrun 做边界
import { spawn } from 'node:child_process'
import { existsSync, rmSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { apply } from '../wsl/custom-bash.mjs'
import { toWslPath } from './support.mjs'

const WSL_BASH = process.env.BASH_BIN ?? 'C:\\Windows\\System32\\bash.exe'
const WS = process.cwd()
const WS_WSL = toWslPath(WS)
// 仓库自带一份 llrun 二进制；部署过自己那份的话用 LLRUN 指过去。
const LLRUN = process.env.LLRUN ?? WS_WSL + '/wsl/llrun'
// 工作区外的一个位置，用来验证围栏确实拦住了跨目录写入。
const OUTSIDE_WIN = resolve(dirname(WS), '_skadi_cb_outside.txt')
const OUTSIDE_WSL = toWslPath(OUTSIDE_WIN)

const subprocess = {
  async resolveExecutable(command) { return command === 'bash' ? WSL_BASH : command },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe','pipe','pipe'], windowsHide: true })
    if (spec.stdio?.stdin !== undefined && typeof spec.stdio.stdin === 'object' && typeof spec.stdio.stdin.data === 'string') {
      child.stdin.end(spec.stdio.stdin.data)
    } else {
      child.stdin.end()
    }
    const buf = { out: '', err: '' }
    child.stdout.on('data', (d) => { buf.out += d })
    child.stderr.on('data', (d) => { buf.err += d })
    return {
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      done: new Promise((r) => child.on('exit', (code, signal) => r({ exitCode: code, signal }))),
      terminate() { try { child.kill() } catch {} },
      async waitForExit() { return await new Promise((res) => { if (child.exitCode !== null) return res(true); child.once('exit', () => res(true)) }) },
      collected: { stdout: { readFrom: () => ({ text: buf.out }) }, stderr: { readFrom: () => ({ text: buf.err }) } },
    }
  },
}

let POLICY = { mode: 'workspace-write', workspaceRoot: WS }
let REG = null
const ctxBase = {
  subprocess,
  tools: { register(def) { REG = def; return () => { REG = null } } },
  get(name) {
    if (name === 'workingDirectory') return { async ensure() { return WS } }
    if (name === 'sandboxPolicy') return { resolve() { return POLICY } }
    if (name === 'sandbox') return { confine(argv) { return { argv, enforcement: 'partial' } } }
    return undefined
  },
  effect(fn) { return fn() },
  on() {},
}

const results = []
const check = (label, pass, detail) => results.push((pass ? 'PASS ' : 'FAIL ') + label + (detail ? '  ::  ' + detail : ''))
const exec = { agent: { session: { id: 'cb-1', header: { cwd: WS } } }, signal: undefined }
const run = (command, extra) => REG.execute({ command, ...(extra ?? {}) }, exec)

for (const p of [OUTSIDE_WIN]) rmSync(p, { force: true, ignoreCase: true })

// A. workspace-write
apply(ctxBase, { llrunPath: LLRUN })
check('registered', REG !== null && REG.name === 'bash')
let r = await run('echo WS-OK')
check('ws-write-basic', r.text.includes('WS-OK'), JSON.stringify(r.text))

// 原始文本经 stdin 可达：单双引号、反引号、$() 都在 bash 语义下正常工作
r = await run('X="a b"; echo "[$X]"; echo \'sq\'; echo "$(echo sub)"')
check('verbatim-script', r.text.includes('[a b]') && r.text.includes('sq') && r.text.includes('sub'), JSON.stringify(r.text))

// 工作区内可写
r = await run('echo ok > _skadi_cb_inside.txt && echo WROTE')
const insideExists = existsSync(WS + '\\_skadi_cb_inside.txt')
check('ws-write-inside', r.text.includes('WROTE') && insideExists, JSON.stringify(r.text))
rmSync(WS + '\\_skadi_cb_inside.txt', { force: true })

// 工作区外被拒
r = await run('echo x > ' + OUTSIDE_WSL + ' 2>&1; echo "rc=$?"')
check('ws-write-outside-denied', !existsSync(OUTSIDE_WIN) && r.text.includes('rc='), JSON.stringify(r.text))

// Windows exe 被封（WSL interop 依赖 /init）
r = await run('cmd.exe /c echo RAN 2>&1 | head -1; echo END')
check('win-exe-blocked', !r.text.includes('RAN'), JSON.stringify(r.text))

// docker socket 被封
r = await run('docker ps 2>&1 | head -1')
check('docker-blocked', !/CONTAINER ID/.test(r.text), JSON.stringify(r.text))

// B. read-only
POLICY = { mode: 'read-only', workspaceRoot: WS }
r = await run('echo x > _skadi_cb_ro.txt 2>&1; echo "rc=$?"; ls > /dev/null && echo READ-OK')
check('ro-write-denied', !existsSync(WS + '\\_skadi_cb_ro.txt') && r.text.includes('READ-OK'), JSON.stringify(r.text))
r = await run('echo x > /tmp/_skadi_cb_ro 2>&1; echo "rc=$?"')
check('ro-tmp-denied', /rc=[1-9]/.test(r.text) || /denied|Read-only/i.test(r.text), JSON.stringify(r.text))

// C. danger-full-access 不挂围栏
POLICY = { mode: 'danger-full-access', workspaceRoot: WS }
r = await run('echo x > ' + OUTSIDE_WSL + ' && echo WROTE')
check('full-no-fence', r.text.includes('WROTE') && existsSync(OUTSIDE_WIN), JSON.stringify(r.text))
rmSync(OUTSIDE_WIN, { force: true })

// D. sandboxPolicy 缺席 → fail-closed
POLICY = { mode: 'workspace-write', workspaceRoot: WS }
let threw = ''
try {
  const ctxNoPolicy = { ...ctxBase, get(n) { if (n === 'sandboxPolicy') return undefined; return ctxBase.get(n) } }
  let R2 = null
  const ctx2 = { ...ctxNoPolicy, tools: { register(d) { R2 = d; return () => {} } } }
  apply(ctx2, {})
  await R2.execute({ command: 'echo hi' }, exec)
  threw = 'NO-ERROR'
} catch (error) { threw = String(error?.message ?? error) }
check('policy-absent-refused', threw.includes('sandboxPolicy is absent'), threw.slice(0, 90))

// E. llrun 缺失 → fail-closed（不静默降级）
let threw2 = ''
try {
  let R3 = null
  const ctx3 = { ...ctxBase, tools: { register(d) { R3 = d; return () => {} } } }
  apply(ctx3, { llrunPath: LLRUN + '-nope' })
  await R3.execute({ command: 'echo hi' }, exec)
  threw2 = 'NO-ERROR'
} catch (error) { threw2 = String(error?.message ?? error) }
check('llrun-missing-refused', threw2.includes('not executable') && threw2.includes('fence: false'), threw2.slice(0, 120))

// F. workdir 走 -C（POSIX 路径）
apply(ctxBase, { llrunPath: LLRUN })
r = await run('pwd', { workdir: '/tmp' })
check('workdir-posix', r.text.trim().endsWith('/tmp'), JSON.stringify(r.text))

// G. workdir 走 Windows 路径（进程 cwd）
r = await run('pwd', { workdir: 'D:\\' })
check('workdir-windows', r.text.trim() === '/mnt/d', JSON.stringify(r.text))

// H. 退出码呈现
r = await run('exit 42')
check('exit-code', r.text.includes('exit code: 42'), JSON.stringify(r.text))

// I. 空输出
r = await run('true')
check('empty-output', r.text.includes('no output') || r.text.trim() === '', JSON.stringify(r.text))

// J. timeout
r = await run('sleep 5', { })
check('no-timeout-by-default', r.text.trim() === '' || r.text.includes('exit code'), JSON.stringify(r.text).slice(0, 80))

console.log(results.join('\n'))
console.log('TOTAL pass=' + results.filter((x) => x.startsWith('PASS')).length + ' fail=' + results.filter((x) => x.startsWith('FAIL')).length)