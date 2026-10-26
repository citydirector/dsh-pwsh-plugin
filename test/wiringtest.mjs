// 钉住 plugin/index.mjs 里「更新提示 → 工具输出末尾」这条接线。
// 更新检查本身在 updatetest.mjs 里测过；这里只验证它真的接到了 execute 的返回文本上。
import { spawn } from 'node:child_process'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { apply } from '../plugin/index.mjs'

const PWSH = process.env.PWSH_BIN ?? 'pwsh'

let pass = 0
let fail = 0
const problems = []
const check = (label, ok, detail) => {
  if (ok) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    problems.push(label + (detail === undefined ? '' : ' :: ' + detail))
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' :: ' + detail))
  }
}

const subprocess = {
  async resolveExecutable(command) {
    return command === 'pwsh' ? PWSH : command
  },
  spawn(spec) {
    const child = spawn(spec.argv[0], spec.argv.slice(1), { cwd: spec.cwd, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    return {
      stdin: child.stdin,
      stdout: child.stdout,
      stderr: child.stderr,
      done: new Promise((resolve) => child.on('exit', (code) => resolve({ exitCode: code }))),
      terminate() {
        try {
          child.kill()
        } catch {
          /* 已经退了 */
        }
      },
      async waitForExit() {
        return await new Promise((resolve) => {
          if (child.exitCode !== null) return resolve(true)
          child.once('exit', () => resolve(true))
        })
      },
    }
  },
}

/** 起一个插件实例，返回 { registration, update, dispose }。services 用来补 pluginManager 之类的服务。 */
function boot(config, services = {}) {
  let registration = null
  let update = null
  const disposers = []
  const ctx = {
    subprocess,
    tools: {
      register(def) {
        if (def?.name === 'pwsh_run_update') update = def
        else registration = def
        return () => {
          if (def?.name === 'pwsh_run_update') update = null
          else registration = null
        }
      },
    },
    get(name) {
      if (name === 'workingDirectory') return { async ensure() { return process.cwd() } }
      return services[name]
    },
    effect(fn) {
      const dispose = fn()
      disposers.push(dispose)
      return dispose
    },
    on() {},
    logger: { info() {} },
  }
  apply(ctx, config)
  return {
    registration,
    update,
    dispose() {
      for (const d of disposers) {
        try {
          d?.()
        } catch {
          /* 清理失败不影响结论 */
        }
      }
    },
  }
}

const sandbox = mkdtempSync(join(tmpdir(), 'pwsh-wiring-'))
const repo = join(sandbox, 'release-repo')
mkdirSync(repo, { recursive: true })
const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
git('init', '-q', '-b', 'main')
git('config', 'user.email', 'test@local')
git('config', 'user.name', 'test')
writeFileSync(join(repo, 'payload.txt'), 'x\n')
git('add', '.')
git('commit', '-q', '-m', 'release')
git('tag', 'v9.9.9')

const source = 'git+file://' + repo.replace(/\\/g, '/')
process.env.DSH_PWSH_UPDATE_SOURCE = source
process.env.DSH_PWSH_UPDATE_DELAY_MS = '0'

const exec = { agent: { session: { id: 'wiring-A', header: { cwd: process.cwd() } } } }

try {
  // ── 1. 自动更新关掉时，新版本提示挂在输出末尾，且只挂一次 ────────────────
  // 自动更新开着时不发提示（它自己会装），所以这一节必须显式关掉它。
  console.log('\n[1] 提示出现在输出末尾（只一次）')
  const plugin = boot({ allowUnconfined: true, autoUpdate: false })
  // 首次检查延迟 0，本地 git ls-remote 几十毫秒；给 3 秒余量。
  await new Promise((resolve) => setTimeout(resolve, 3000))

  const first = await plugin.registration.execute({ script: "Write-Output 'body-line'" }, exec)
  check('脚本本体照常返回', first.text.startsWith('body-line'), JSON.stringify(first.text))
  check('末尾有更新提示', first.text.includes('a newer pwsh-run release exists'), JSON.stringify(first.text))
  check('提示里带版本号', first.text.includes('v9.9.9'), JSON.stringify(first.text))
  check('提示里带钉了 tag 的安装规格', first.text.includes(source + '#v9.9.9'), JSON.stringify(first.text))
  check('提示里说明自动更新已关', first.text.includes('Auto-update is off in this profile'), JSON.stringify(first.text))

  const second = await plugin.registration.execute({ script: "Write-Output 'again'" }, exec)
  check('第二次不再重复提示', !second.text.includes('a newer pwsh-run release exists'), JSON.stringify(second.text))
  check('第二次脚本本体正常', second.text === 'again', JSON.stringify(second.text))

  plugin.dispose()

  // ── 1b. 自动更新开着时不再发提示（它自己会装，再提示就是噪音）─────────────
  console.log('\n[1b] 自动更新开着时不发提示')
  // mock ctx 没有 pluginManager，安装必然失败——这一节只看提示，不看安装结果。
  const auto = boot({ allowUnconfined: true, autoUpdate: true, autoUpdateDelayMs: 0 })
  await new Promise((resolve) => setTimeout(resolve, 3000))
  const autoOut = await auto.registration.execute({ script: "Write-Output 'auto-line'" }, exec)
  check('自动更新开着时不挂提示', !autoOut.text.includes('a newer pwsh-run release exists'), JSON.stringify(autoOut.text))
  check('脚本本体照常返回', autoOut.text === 'auto-line', JSON.stringify(autoOut.text))
  auto.dispose()

  // ── 1c. 有调用在跑时，手动安装也要推迟：热替换会掐断那条调用 ─────────────
  console.log('\n[1c] 调用在跑时推迟安装')
  {
    const attempts = []
    const manager = {
      async installBundle(spec, options) {
        attempts.push({ spec, requestId: options?.requestId })
        return { application: 'applied', version: '9.9.9' }
      },
    }
    const gate = boot({ allowUnconfined: true, autoUpdate: false }, { pluginManager: manager })
    await new Promise((resolve) => setTimeout(resolve, 3000))

    // 一条跑到一半的调用：闸门应当把它算进去。
    const slow = gate.registration.execute({ script: 'Start-Sleep -Milliseconds 1500' }, exec)
    const postponed = await gate.update.execute({ action: 'install' })
    check('忙时安装被推迟', /install: postponed/.test(postponed.text), JSON.stringify(postponed.text))
    check('推迟时说明原因', /call is running right now/.test(postponed.text), JSON.stringify(postponed.text))
    check('推迟时一次都没装', attempts.length === 0, 'attempts=' + attempts.length)
    await slow

    // 空闲下来之后同一条命令就该真的装上。
    const done = await gate.update.execute({ action: 'install' })
    check('闲时照常安装', /install: applied/.test(done.text), JSON.stringify(done.text))
    check('闲时装了一次', attempts.length === 1, 'attempts=' + attempts.length)
    gate.dispose()
  }

  // ── 1d. 装之前先问值不值得装：profile 已指向该 tag 而包内版本没变时不发起安装 ──
  // 这条钉的是「发版忘了升版本号」在真机上造成的静默循环：每一轮都想装，每一轮都被
  // plugin-manager 判 already-installed，用户什么也看不到。预检要在这里拦住它。
  console.log('\n[1d] 预检拦下注定失败的安装')
  {
    const attempts = []
    const manager = {
      async installBundle(spec, options) {
        attempts.push({ spec, requestId: options?.requestId })
        return { application: 'applied', version: '9.9.9' }
      },
    }
    // 假 profile：依赖里已经钉着 v9.9.9，而装件里的版本是测试自己的版本，两者对不上。
    const profileDir = join(sandbox, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pwsh-plugin': source + '#v9.9.9' } }))
    const gated = boot({ allowUnconfined: true, autoUpdate: false }, { pluginManager: manager, profileContext: { dir: profileDir } })
    await new Promise((resolve) => setTimeout(resolve, 3000))

    const refused = await gated.update.execute({ action: 'install' })
    check('坏发布被预检拦下', /install: broken-release/.test(refused.text), JSON.stringify(refused.text))
    check('一次都没去装', attempts.length === 0, 'attempts=' + attempts.length)
    check('说清是 tag 存在但版本没升', /not bumped/.test(refused.text), JSON.stringify(refused.text))
    gated.dispose()

    // 同一条命令在 profile 记录的是别的 tag 时就该照常装上——预检不能把正常升级也挡了。
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pwsh-plugin': source + '#v0.0.1' } }))
    const allowed = boot({ allowUnconfined: true, autoUpdate: false }, { pluginManager: manager, profileContext: { dir: profileDir } })
    await new Promise((resolve) => setTimeout(resolve, 3000))
    const installed = await allowed.update.execute({ action: 'install' })
    check('正常升级照常安装', /install: applied/.test(installed.text), JSON.stringify(installed.text))
    check('正常升级真的调了安装器', attempts.length === 1, 'attempts=' + attempts.length)
    allowed.dispose()
  }

  // ── 2. updateCheck: false 时完全不查 ────────────────────────────────────
  console.log('\n[2] updateCheck: false')
  const quiet = boot({ allowUnconfined: true, updateCheck: false })
  await new Promise((resolve) => setTimeout(resolve, 500))
  const silent = await quiet.registration.execute({ script: "Write-Output 'quiet'" }, exec)
  check('没有提示', !silent.text.includes('a newer pwsh-run release exists'), JSON.stringify(silent.text))
  check('脚本仍正常执行', silent.text === 'quiet', JSON.stringify(silent.text))
  quiet.dispose()
} finally {
  delete process.env.DSH_PWSH_UPDATE_SOURCE
  delete process.env.DSH_PWSH_UPDATE_DELAY_MS
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 测试自己的临时目录 */
  }
}

console.log('\n' + '='.repeat(56))
console.log('SUMMARY pass=' + pass + ' fail=' + fail)
if (fail > 0) {
  console.log('\n失败项：')
  for (const problem of problems) console.log('  - ' + problem)
}
process.exit(fail === 0 ? 0 : 1)