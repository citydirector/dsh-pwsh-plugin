// custom-bash 围栏测试：mock sandboxPolicy 驱动 mode 分诊，真 llrun 做边界
import { spawn } from 'node:child_process'
import { chmodSync, existsSync, mkdirSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, resolve } from 'node:path'
import { apply, llrunProbeScript } from '../wsl/custom-bash.mjs'
import { toWslPath } from './support.mjs'

const WSL_BASH = process.env.BASH_BIN ?? 'C:\\Windows\\System32\\bash.exe'
const WS = process.cwd()
// 已经是 POSIX 路径（在 WSL 里跑测试时 cwd 就是 /mnt/d/...）就原样用，不必再转。
const asPosix = (path) => path.startsWith('/') ? path : toWslPath(path)
const WS_WSL = asPosix(WS)
// 仓库自带一份 llrun 二进制；部署过自己那份的话用 LLRUN 指过去。
const LLRUN = process.env.LLRUN ?? WS_WSL + '/wsl/llrun'
// 工作区外的一个位置，用来验证围栏确实拦住了跨目录写入。
const OUTSIDE_WIN = resolve(dirname(WS), '_skadi_cb_outside.txt')
const OUTSIDE_WSL = asPosix(OUTSIDE_WIN)
// 本进程自己能 stat 的那个路径形式：WSL 侧认 /mnt/d/...，Windows 侧认 D:...
const localPath = (winPath) => process.platform === 'win32' ? winPath : asPosix(winPath)
const POSIX_RUN = process.platform !== 'win32'

// llrun 在没有 user namespace 时会把两条 warning 写到 stderr（嵌套 llrun 的情况：
// 测试本身已经跑在宿主围栏内）。它们是提示，不是命令输出，比对正文前先剥掉。
const stripWarnings = (text) => String(text ?? '')
  .split('\n').filter((line) => !line.startsWith('llrun: warning:')).join('\n').trim()

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
// 边跑边报：整套要起十几次 bash + llrun，卡住时得知道停在哪一项。
const check = (label, pass, detail) => {
  const line = (pass ? 'PASS ' : 'FAIL ') + label + (detail ? '  ::  ' + detail : '')
  results.push(line)
  process.stderr.write(line + '\n')
}
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
const insidePath = join(WS, '_skadi_cb_inside.txt')
const insideExists = existsSync(insidePath)
check('ws-write-inside', r.text.includes('WROTE') && insideExists, JSON.stringify(r.text))
rmSync(insidePath, { force: true })

// 工作区外被拒
r = await run('echo x > ' + OUTSIDE_WSL + ' 2>&1; echo "rc=$?"')
check('ws-write-outside-denied', !existsSync(localPath(OUTSIDE_WIN)) && r.text.includes('rc='), JSON.stringify(r.text))

// Windows exe 被封（WSL interop 依赖 /init）
r = await run('cmd.exe /c echo RAN 2>&1 | head -1; echo END')
check('win-exe-blocked', !r.text.includes('RAN'), JSON.stringify(r.text))

// docker socket 被封
r = await run('docker ps 2>&1 | head -1')
check('docker-blocked', !/CONTAINER ID/.test(r.text), JSON.stringify(r.text))

// B. read-only
POLICY = { mode: 'read-only', workspaceRoot: WS }
r = await run('echo x > _skadi_cb_ro.txt 2>&1; echo "rc=$?"; ls > /dev/null && echo READ-OK')
check('ro-write-denied', !existsSync(join(WS, '_skadi_cb_ro.txt')) && r.text.includes('READ-OK'), JSON.stringify(r.text))
r = await run('echo x > /tmp/_skadi_cb_ro 2>&1; echo "rc=$?"')
check('ro-tmp-denied', /rc=[1-9]/.test(r.text) || /denied|Read-only/i.test(r.text), JSON.stringify(r.text))

// C. danger-full-access 不挂围栏
POLICY = { mode: 'danger-full-access', workspaceRoot: WS }
// 外层若已有围栏（例如测试本身跑在 llrun 里），danger-full-access 也写不出去，
// 这一项就失去意义 —— 先自己试一次，写不出去就显式跳过，不冒充通过。
let hostCanWriteOutside = true
try { writeFileSync(OUTSIDE_WIN, 'probe'); rmSync(OUTSIDE_WIN, { force: true }) } catch { hostCanWriteOutside = false }
if (hostCanWriteOutside) {
  r = await run('echo x > ' + OUTSIDE_WSL + ' && echo WROTE')
  check('full-no-fence', r.text.includes('WROTE') && existsSync(localPath(OUTSIDE_WIN)), JSON.stringify(r.text))
  rmSync(localPath(OUTSIDE_WIN), { force: true })
} else {
  process.stderr.write('SKIP full-no-fence (host is already fenced)\n')
}

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
check('llrun-missing-refused', threw2.includes('llrun was not found') && threw2.includes(LLRUN + '-nope') && threw2.includes('fence: false'), threw2.slice(0, 160))

// F. workdir 走 -C（POSIX 路径）
apply(ctxBase, { llrunPath: LLRUN })
r = await run('pwd', { workdir: '/tmp' })
check('workdir-posix', r.text.split('\n')[0].trim() === '/tmp', JSON.stringify(r.text))

// G. workdir 走 Windows 路径（进程 cwd）。WSL 侧的 node 起不了 cwd=D:\ 的子进程，
// 这一项只在 Windows 侧有意义，另一侧就跳过（显式打印，免得看着像通过）。
if (process.platform === 'win32') {
  r = await run('pwd', { workdir: 'D:\\' })
  check('workdir-windows', r.text.split('\n')[0].trim() === '/mnt/d', JSON.stringify(r.text))
} else {
  process.stderr.write('SKIP workdir-windows (not host win32)\n')
}

// H. 退出码呈现
r = await run('exit 42')
check('exit-code', r.text.includes('exit code: 42'), JSON.stringify(r.text))

// I. 空输出
r = await run('true')
check('empty-output', r.text.includes('no output') || stripWarnings(r.text) === '', JSON.stringify(r.text))

// J. timeout
r = await run('sleep 5', { })
check('no-timeout-by-default', stripWarnings(r.text) === '' || r.text.includes('exit code'), JSON.stringify(r.text).slice(0, 80))

// K. 候选探测：不配 llrunPath 时按 $LLRUN 找到那份 llrun。
// 探测脚本经 stdin 送入，所以这条同时钉住「bash.exe 不改写正文」——
// 走 bash -c 的版本在这里会算出错误序号，报 /usr/local/bin/llrun: No such file or directory。
const savedLlrun = process.env.LLRUN
try {
  process.env.LLRUN = LLRUN
  apply(ctxBase, {})
  r = await run('echo env-candidate')
  check('llrun-env-candidate', r.text.includes('env-candidate'), JSON.stringify(r.text).slice(0, 120))
} finally {
  if (savedLlrun === undefined) delete process.env.LLRUN
  else process.env.LLRUN = savedLlrun
}

// L. 包内候选：$LLRUN、DSH_HOME、系统目录全都没有时，同目录那份 wsl/llrun 必须被找到。
// 这是「装完即用」的地基 —— 新用户的机器上只有包里这一份。
// HOME 也要指到空目录：探测脚本里的 ~/.local/bin 由 bash 展开，
// 开发机上往往真装过 llrun，不挪开就会测成那条分支。
const savedDshHome = process.env.DSH_HOME
const savedHome = process.env.HOME
const emptyHome = join(tmpdir(), '_skadi_empty_home')
try {
  mkdirSync(emptyHome, { recursive: true })
  process.env.HOME = emptyHome
  delete process.env.LLRUN
  delete process.env.DSH_LLRUN
  delete process.env.DSH_HOME
  apply(ctxBase, {})
  r = await run('echo packaged-candidate')
  check('llrun-packaged-candidate', r.text.includes('packaged-candidate'), JSON.stringify(r.text).slice(0, 160))
} finally {
  if (savedDshHome !== undefined) process.env.DSH_HOME = savedDshHome
  if (savedHome === undefined) delete process.env.HOME
  else process.env.HOME = savedHome
  rmSync(emptyHome, { recursive: true, force: true })
}
apply(ctxBase, { llrunPath: LLRUN })

// M. bash 后备：PATH 上解不出 `bash` 时退回 System32 那个 WSL 垫片。
// 进程 PATH 缺 System32 是真实会发生的（环境块停在旧快照上），
// 那时整个 bash 工具会报 "not found on PATH" —— 后备只为这一种情况存在。
const FALLBACK_BASH = 'C:\\Windows\\System32\\bash.exe'
const makeCtx = (lookup) => {
  let R = null
  const ctx = {
    subprocess: { ...subprocess, async resolveExecutable(command, env, signal) { return lookup(command, env, signal) } },
    tools: { register(d) { R = d; return () => {} } },
    get(name) { return ctxBase.get(name) },
    effect(fn) { return fn() },
    on() {},
  }
  return { ctx, get: () => R }
}

// M 组三项测的是 Windows 那个 WSL 垫片后备，只对 win32 宿主有意义。
if (process.platform !== 'win32') {
  process.stderr.write('SKIP bash-fallback-used / bash-path-first / bash-explicit-not-fallback (not host win32)\n')
} else {
// 只有绝对路径能解出来：断言后备被用上，且命令真的跑起来了
{
  const seen = []
  const { ctx, get } = makeCtx((command) => {
    seen.push(command)
    if (command === 'bash') throw new Error('subprocess-local: command "bash" was not found on PATH')
    if (command === FALLBACK_BASH) return command
    throw new Error('unexpected candidate ' + command)
  })
  apply(ctx, { llrunPath: LLRUN })
  const out = await get().execute({ command: 'echo fallback-shell' }, exec)
  check('bash-fallback-used', out.text.includes('fallback-shell') && seen.includes(FALLBACK_BASH), JSON.stringify(seen) + ' ' + JSON.stringify(out.text).slice(0, 80))
}

// 裸名能解出来时不该碰后备：多问一次会掩盖 PATH 的真实状态
{
  const seen = []
  const { ctx, get } = makeCtx((command) => {
    seen.push(command)
    if (command === 'bash') return WSL_BASH
    throw new Error('should not probe ' + command)
  })
  apply(ctx, { llrunPath: LLRUN })
  await get().execute({ command: 'echo first-wins' }, exec)
  check('bash-path-first', seen.length === 1 && seen[0] === 'bash', JSON.stringify(seen))
}

// 显式绝对路径只认那一个：配置写错时应当报错，而不是被悄悄换成能用的那份
{
  const seen = []
  const { ctx, get } = makeCtx((command) => {
    seen.push(command)
    throw new Error('subprocess-local: command ' + JSON.stringify(command) + ' is not an executable file')
  })
  apply(ctx, { bashPath: 'C:\\nowhere\\bash.exe', llrunPath: LLRUN })
  let msg = 'NO-ERROR'
  try { await get().execute({ command: 'echo x' }, exec) } catch (error) { msg = String(error?.message ?? error) }
  check('bash-explicit-not-fallback', msg.includes('is not an executable file') && seen.length === 1 && seen[0] === 'C:\\nowhere\\bash.exe', JSON.stringify(seen) + ' ' + msg.slice(0, 90))
}
}

// N. 执行位：npm 打包在 Windows 上把 llrun 写成 644，装到真实 Linux 后不可执行。
// 探测脚本必须自己补上执行位（是我们发的、属主就是装包的人），而不是报「找不到」。
// 用 /tmp（ext4）而不是工作区：/mnt/d 是 9p，一律 rwx，测不出这件事。
{
  const dir = join(tmpdir(), '_skadi_llrun_mode')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const lax = join(dir, 'llrun')
  writeFileSync(lax, '#!/bin/sh\nexec /bin/bash -s\n')
  chmodSync(lax, 0o644)
  const posix = asPosix(lax)
  const before = statSync(lax).mode & 0o777
  const { ctx, get } = makeCtx((c) => c)
  apply(ctx, { llrunPath: posix })
  const out = await get().execute({ command: 'echo fenced-ran' }, exec).catch((error) => ({ text: String(error?.message ?? error) }))
  const after = statSync(lax).mode & 0o777
  // 权限位只有 POSIX 文件系统说了算。Windows 侧这份假 llrun 落在 NTFS 上，
  // node 读回来恒是 0666，chmod 不改变任何东西 —— 那里只能验「命令跑通了」。
  // 真正的执行位问题（npm 打包写 644）只会在 Linux 上发生，所以严格断言留在那一侧。
  const modeOk = process.platform === 'win32' || (before === 0o644 && after === 0o755)
  check('llrun-chmod-on-probe', modeOk && out.text.includes('fenced-ran'),
    'host=' + process.platform + ' before=' + before.toString(8) + ' after=' + after.toString(8) + ' ' + JSON.stringify(out.text).slice(0, 120))
  rmSync(dir, { recursive: true, force: true })
}

// O. 「有文件但用不了」要指名道姓。属主改不掉时（/usr/local/bin 那类要 root 的，
// 或别人的文件）chmod 会失败，此时必须说「存在但不可执行」，而不是报成「一个都没找到」。
const lockedLlrun = '/etc/hostname'
{
  const { ctx, get } = makeCtx((c) => c)
  apply(ctx, { llrunPath: lockedLlrun })
  let msg = 'NO-ERROR'
  try { await get().execute({ command: 'echo x' }, exec) } catch (error) { msg = String(error?.message ?? error) }
  check('llrun-unusable-named', msg.includes('exists but is not executable') && msg.includes(lockedLlrun), msg.slice(0, 160))
}

// P. 候选顺序不能被一个无关的「存在但不可执行」文件挡住：
// 前面有一个用不了的文件时，后面那份能用的仍然要胜出（退出码 2 而不是 101）。
{
  const dir = join(tmpdir(), '_skadi_llrun_order')
  rmSync(dir, { recursive: true, force: true })
  mkdirSync(dir, { recursive: true })
  const good = join(dir, 'llrun')
  writeFileSync(good, '#!/bin/sh\nexec /bin/bash -s\n')
  chmodSync(good, 0o755)
  const script = llrunProbeScript(['/etc/hostname', asPosix(good)])
  const probe = subprocess.spawn({ argv: [WSL_BASH, '-s'], stdio: { stdin: { data: script } } })
  const outcome = await probe.done
  check('llrun-unusable-later-wins', outcome.exitCode === 2, 'exit=' + String(outcome.exitCode))
  rmSync(dir, { recursive: true, force: true })
}

console.log(results.join('\n'))
console.log('TOTAL pass=' + results.filter((x) => x.startsWith('PASS')).length + ' fail=' + results.filter((x) => x.startsWith('FAIL')).length)