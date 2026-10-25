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

/** 起一个插件实例，返回 { registration, dispose }。 */
function boot(config) {
  let registration = null
  const disposers = []
  const ctx = {
    subprocess,
    tools: {
      register(def) {
        registration = def
        return () => {
          registration = null
        }
      },
    },
    get(name) {
      if (name === 'workingDirectory') return { async ensure() { return process.cwd() } }
      return undefined
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