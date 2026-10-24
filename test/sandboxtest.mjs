// 沙箱边界测试：真 LocalSandboxProvider + 真 confine，验证常驻会话与原生工具同边界
import { spawn } from 'node:child_process'
import { apply } from '../plugin/index.mjs'
import { existsSync, rmSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { importFromDsh, SKIP_HINT } from './support.mjs'

const PWSH = process.env.PWSH_BIN ?? 'pwsh'
const WS = process.cwd()
// 工作区外的一个位置：围栏必须拦住它。
const OUTSIDE = resolve(dirname(WS), '_skadi_sbx_outside.txt')
const INSIDE = WS + '\\_skadi_sbx_inside.txt'

const subprocess = {
  async resolveExecutable(command) { return command === 'pwsh' ? PWSH : command },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe','pipe','pipe'], windowsHide: true })
    return {
      stdin: child.stdin, stdout: child.stdout, stderr: child.stderr,
      done: new Promise((r) => child.on('exit', (code, signal) => r({ exitCode: code, signal }))),
      terminate() { try { child.kill() } catch {} },
      async waitForExit() { return await new Promise((res) => { if (child.exitCode !== null) return res(true); child.once('exit', () => res(true)) }) },
    }
  },
}

// 真 LocalSandboxProvider 由 support.mjs 按环境变量或默认布局探测（桌面端 asar 优先，退回便携包）。
const sandboxMod = await importFromDsh('dsh-sandbox-local/lib/index.js')
const cordis = await importFromDsh('cordis/lib/index.js')
if (sandboxMod === undefined || cordis === undefined) { console.log(SKIP_HINT); process.exit(0) }
const { Context } = cordis
const boot = new Context()
boot.plugin(sandboxMod.default ?? sandboxMod, {})
await new Promise((r) => setTimeout(r, 800))
const LocalSandbox = boot.get('sandbox')
if (LocalSandbox === undefined) { console.log('SKIP: ctx.sandbox unavailable'); process.exit(0) }

const WS_POLICY = { mode: 'workspace-write', workspaceRoot: WS }
let registration = null
const disposed = []
const ctx = {
  subprocess,
  tools: { register(def) { registration = def; return () => { registration = null } } },
  get(name) {
    if (name === 'workingDirectory') return { async ensure() { return WS } }
    if (name === 'sandbox') return LocalSandbox
    if (name === 'sandboxPolicy') return { resolve() { return WS_POLICY } }
    return undefined
  },
  effect(fn) { const d = fn(); disposed.push(d); return d },
  on() {},
}
apply(ctx, {})

const results = []
const check = (label, pass, detail) => results.push((pass ? 'PASS ' : 'FAIL ') + label + (detail ? '  ::  ' + detail : ''))
const exec = { agent: { session: { id: 'sbx-1', header: { cwd: WS } } }, signal: undefined }
const run = (script, extra) => registration.execute({ script, ...(extra ?? {}) }, exec)

for (const p of [OUTSIDE, INSIDE]) rmSync(p, { force: true, ignoreCase: true })

// 1. 工作区内可写（沙箱不能把正常功能也锁死）
let r = await run("Set-Content -LiteralPath '" + INSIDE.replace(/'/g, "''") + "' -Value ok -EA Stop; 'WROTE'")
check('inside-writable', r.text.trim() === 'WROTE' && existsSync(INSIDE), JSON.stringify(r.text.trim()))

// 2. workspace 外被拒
r = await run("try { Set-Content -LiteralPath '" + OUTSIDE.replace(/'/g, "''") + "' -Value x -EA Stop; 'WROTE' } catch { 'DENIED' }")
check('outside-denied', r.text.trim() === 'DENIED' && !existsSync(OUTSIDE), JSON.stringify(r.text.trim()))

// 3. 受限会话仍是 FullLanguage（沙箱不能把脚本能力降级）
r = await run('Write-Output $ExecutionContext.SessionState.LanguageMode')
check('fulllanguage', r.text.trim() === 'FullLanguage', JSON.stringify(r.text.trim()))

// 4. 受限会话里状态照样跨调用保留
await run('$global:sbx = 7')
r = await run('Write-Output $global:sbx')
check('state-in-sandbox', r.text.trim() === '7', JSON.stringify(r.text.trim()))

// 5. read-only 模式拒绝启动并给出明确指引
WS_POLICY.mode = 'read-only'
const exec2 = { agent: { session: { id: 'sbx-ro', header: { cwd: WS } } }, signal: undefined }
let roText = ''
try { await registration.execute({ script: 'Write-Output 1' }, exec2) } catch (e) { roText = String(e?.message ?? e) }
check('read-only-refused', roText.includes('read-only') && roText.includes('native pwsh'), JSON.stringify(roText.slice(0, 90)))
WS_POLICY.mode = 'workspace-write'

// 6. 策略服务缺席时必须 fail-closed（而不是悄悄跑一个不受约束的会话）
{
  let reg2 = null
  const disposed2 = []
  const ctx2 = {
    subprocess,
    tools: { register(def) { reg2 = def; return () => { reg2 = null } } },
    get(name) {
      if (name === 'workingDirectory') return { async ensure() { return WS } }
      if (name === 'sandbox') return LocalSandbox
      return undefined // 故意不给 sandboxPolicy
    },
    effect(fn) { const d = fn(); disposed2.push(d); return d },
    on() {},
  }
  apply(ctx2, {})
  let errText = ''
  try {
    await reg2.execute({ script: 'Write-Output 1' }, { agent: { session: { id: 'sbx-nopolicy', header: { cwd: WS } } }, signal: undefined })
  } catch (e) { errText = String(e?.message ?? e) }
  check('policy-absent-refused', errText.includes('sandboxPolicy is absent') && errText.includes('allowUnconfined'), JSON.stringify(errText.slice(0, 80)))
  for (const d of disposed2.reverse()) if (typeof d === 'function') d()
}

// 7. 策略解析必须带上会话：sandboxPolicy.resolve 只有收到 session 才能拿到
//    会话的 cwd 与 sandbox/mode 覆盖。传成 ToolExecution（agent 挂在 exec.agent 上）
//    会静默退回部署默认值，边界就落到 profile 目录去了 —— 这个用例专门钉住形状。
{
  const seen = []
  const strictPolicy = {
    resolve(request = {}) {
      const session = request.session
      return {
        mode: 'workspace-write',
        workspaceRoot: session === undefined ? 'D:\\__fallback_root__' : session.header.cwd,
      }
    },
  }
  const fakeSandbox = {
    async confine(argv, policy) {
      seen.push(policy)
      return { argv, enforcement: 'full', denialSignatures: [], runnerFailureRules: [] }
    },
  }
  let reg3 = null
  const disposed3 = []
  const ctx3 = {
    subprocess,
    tools: { register(def) { reg3 = def; return () => { reg3 = null } } },
    get(name) {
      if (name === 'workingDirectory') return { async ensure() { return WS } }
      if (name === 'sandbox') return fakeSandbox
      if (name === 'sandboxPolicy') return strictPolicy
      return undefined
    },
    effect(fn) { const d = fn(); disposed3.push(d); return d },
    on() {},
  }
  apply(ctx3, {})
  let shapeText = ''
  try {
    const out = await reg3.execute({ script: 'Write-Output shape-ok' }, { agent: { session: { id: 'sbx-shape', header: { cwd: WS } } }, signal: undefined })
    shapeText = out.text.trim()
  } catch (e) { shapeText = 'ERR ' + String(e?.message ?? e).slice(0, 60) }
  check('policy-carries-session', seen.length > 0 && seen[0].workspaceRoot === WS && shapeText === 'shape-ok',
    JSON.stringify({ root: seen[0]?.workspaceRoot, text: shapeText }))
  for (const d of disposed3.reverse()) if (typeof d === 'function') d()
}

for (const d of disposed.reverse()) if (typeof d === 'function') d()
await new Promise((res) => setTimeout(res, 500))
rmSync(INSIDE, { force: true })
rmSync(OUTSIDE, { force: true })

console.log(results.join('\n'))
const fails = results.filter((x) => x.startsWith('FAIL')).length
console.log('\nSUMMARY pass=' + (results.length - fails) + ' fail=' + fails)
process.exit(0)