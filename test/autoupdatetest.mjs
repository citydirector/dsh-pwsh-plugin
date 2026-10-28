#!/usr/bin/env node
/**
 * 自动更新的单元测试 —— 纯 node，不需要 DSH。
 *
 * 被替换下来的都是真对象：checker 是 UpdateChecker 的真实例（发布源指向本地假 registry，真 HTTP），
 * hmr 用一个 AsyncLocalStorage 复刻真实服务的嵌套检查语义，pluginManager 用一个记账的假安装器。
 * 于是「在 HMR 上下文里调会失败、在外层调才会成功」这条实测结论也被钉住了。
 */

import { AsyncLocalStorage } from 'node:async_hooks'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { installReleaseLive, startAutoUpdate } from '../plugin/auto-update.mjs'
import { describeInstallOutcome } from '../plugin/update-apply.mjs'
import { UpdateChecker, packageVersion, updateSource } from '../plugin/update-check.mjs'
import { packageDocument, startRegistry } from './support.mjs'

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail) {
  if (ok) { pass += 1; console.log('  PASS  ' + label) }
  else { fail += 1; problems.push(label + (detail === undefined ? '' : ' :: ' + detail)); console.log('  FAIL  ' + label + (detail === undefined ? '' : ' :: ' + detail)) }
}

const realSetTimeout = globalThis.setTimeout
const sleep = (ms) => new Promise((resolve) => realSetTimeout(resolve, ms))

/** 等到条件成立或超时。定时循环里有真 HTTP 往返，固定 sleep 会假失败。 */
async function waitFor(predicate, timeoutMs = 8000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (predicate()) return true
    await sleep(25)
  }
  return predicate()
}

/** 复刻 HMR 的 executing 语义：run(undefined, cb) 在异步延续里都清空 store。 */
function makeFakeHmr() {
  const executing = new AsyncLocalStorage()
  return { hmr: { executing, runExclusive(operation) {
    if (executing.getStore()) return Promise.reject(new Error('HMR transactions cannot be nested'))
    return Promise.resolve().then(() => executing.run(true, operation))
  } }, executing }
}

/** 假 pluginManager：记录每次 installBundle 时 HMR 上下文的样子。 */
function makeFakeManager(hmrState, results) {
  const attempts = []
  let index = 0
  return {
    attempts,
    async installBundle(spec, options) {
      attempts.push({ spec, requestId: options?.requestId, store: hmrState.executing.getStore() })
      const next = results[Math.min(index, results.length - 1)]
      index += 1
      if (typeof next === 'function') return await next(spec)
      return next
    },
  }
}

/** 造一份装好的 profile：package.json 记着安装规格，node_modules 里躺着真装件的 package.json。 */
function makeProfile(dependency, installedVersion) {
  const dir = mkdtempSync(join(tmpdir(), 'pwsh-run-profile-'))
  writeFileSync(join(dir, 'package.json'), JSON.stringify({ dependencies: dependency === undefined ? {} : { 'dsh-pwsh-plugin': dependency } }))
  if (installedVersion !== undefined) {
    const pkgDir = join(dir, 'node_modules', 'dsh-pwsh-plugin')
    mkdirSync(pkgDir, { recursive: true })
    writeFileSync(join(pkgDir, 'package.json'), JSON.stringify({ name: 'dsh-pwsh-plugin', version: installedVersion }))
  }
  return dir
}

const registry = await startRegistry({ 'dsh-pwsh-plugin': packageDocument({ latest: '0.0.2' }, { '0.0.1': {}, '0.0.2': {} }) })
const source = updateSource({ DSH_PWSH_UPDATE_REGISTRY: registry.url })

try {
  // ── 1. describeInstallOutcome 的两种语义 ─────────────────────────────────
  console.log('\n[1] describeInstallOutcome')
  {
    const live = describeInstallOutcome({ application: 'applied' }, { live: true })
    check('live 时不提重启', live.ok === true && !/Restart DSH/.test(live.text), live.text)
    check('live 时说新代码已在跑', /already running/.test(live.text), live.text)
    const dead = describeInstallOutcome({ application: 'applied' }, { live: false })
    check('非 live 时要求重启', /Restart DSH/.test(dead.text), dead.text)
    const failed = describeInstallOutcome({ application: 'failed', error: { code: 'operation-error', diagnostic: 'x' } }, { live: true })
    check('失败优先于 live', failed.ok === false, failed.text)
  }

  // ── 2. installReleaseLive 把安装放到 HMR 事务之外 ───────────────────────
  console.log('\n[2] installReleaseLive')
  {
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    // 模拟插件的真实处境：调用点自己在 HMR 事务里。
    const inside = await state.executing.run(true, () => installReleaseLive(ctx, 'dsh-pwsh-plugin@0.0.2'))
    check('事务里发起也成功', inside.ok === true, inside.text)
    check('安装时上下文已清空', manager.attempts[0]?.store === undefined, String(manager.attempts[0]?.store))
    check('结果按 live 措辞', /already running/.test(inside.text), inside.text)
  }
  {
    const manager = makeFakeManager({ executing: new AsyncLocalStorage() }, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : undefined) }
    const noHmr = await installReleaseLive(ctx, 'dsh-pwsh-plugin@0.0.3')
    check('没有 HMR 时仍能装', noHmr.ok === true, noHmr.text)
    check('没有 HMR 时要求重启', /Restart DSH/.test(noHmr.text), noHmr.text)
  }
  {
    const ctx = { get: () => undefined }
    const noManager = await installReleaseLive(ctx, 'dsh-pwsh-plugin@0.0.3')
    check('没有 pluginManager 时 ok=false', noManager.ok === false, noManager.text)
    check('没有 pluginManager 时给出 no-manager', noManager.outcome === 'no-manager', noManager.outcome)
  }

  // ── 3. 定时循环：查到新版就装，装过的不再装 ───────────────────────────────
  console.log('\n[3] startAutoUpdate 正常一轮')
  {
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    const logs = []
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, log: (line) => logs.push(line) })
    await waitFor(() => manager.attempts.length >= 1)
    check('装了一次', manager.attempts.length === 1, 'attempts=' + manager.attempts.length)
    // 装的是「包名@版本」，不是 git 规格：新机制下 profile 里记的就是这一串。
    check('装的是钉住版本的 registry 规格', manager.attempts[0]?.spec === 'dsh-pwsh-plugin@0.0.2', String(manager.attempts[0]?.spec))
    check('requestId 标明来源', manager.attempts[0]?.requestId === 'pwsh-run-auto-update', String(manager.attempts[0]?.requestId))
    check('日志提到在装', logs.some((line) => /installing 0\.0\.2/.test(line)), JSON.stringify(logs))
    // 装完运行版本仍是 0.0.1（真机上 HMR 会换掉模块，这里换不掉），第二轮查到的还是同一个版本。
    check('同一版本不重复装', manager.attempts.length === 1, 'attempts=' + manager.attempts.length)
    await sleep(120)
    check('停止前已只装一次', manager.attempts.length === 1, 'attempts=' + manager.attempts.length)
    stop()
    const after = manager.attempts.length
    await sleep(80)
    check('停止后不再装', manager.attempts.length === after, 'attempts=' + manager.attempts.length)
  }

  // ── 3b. 有调用在跑时先不装：热替换会掐断它 ────────────────────────────────
  console.log('\n[3b] 忙时推迟安装')
  {
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    let busy = true
    let acquired = 0
    let released = 0
    const installGate = {
      tryAcquire() {
        if (busy) return false
        acquired += 1
        return true
      },
      release() { released += 1 },
    }
    const logs = []
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, busyRetryMs: 25, installGate, log: (line) => logs.push(line) })
    await waitFor(() => logs.some((line) => /postponing the install/.test(line)))
    check('忙时一次都没装', manager.attempts.length === 0, 'attempts=' + manager.attempts.length)
    check('日志说清在等安静', logs.some((line) => /a call is running — postponing/.test(line)), JSON.stringify(logs))
    check('忙说明只记一次', logs.filter((line) => /postponing the install/.test(line)).length === 1, JSON.stringify(logs))
    busy = false
    await waitFor(() => manager.attempts.length >= 1)
    check('闲下来就装', manager.attempts.length === 1, 'attempts=' + manager.attempts.length)
    check('装了才拿到闸门', acquired === 1, 'acquired=' + acquired)
    check('装完把闸门还回去', released >= 1, 'released=' + released)
    stop()
  }

  // ── 3c. 装了也白装的两种情形：别去试，也别重试 ────────────────────────────
  // 这一节钉的是真机上踩过的坑：dsh-plugin-manager 对「规格与 profile 记的完全相同」的安装
  // 会在 pnpm 之前抛 already-installed，于是一个静默的「有新版、装不进去」循环就此成立。
  console.log('\n[3c] 预检拦下的不装')
  {
    // 发布坏了：profile 已指向 0.0.2，而磁盘上的包版本与它不同（发版忘了升版本号）。
    const profileDir = makeProfile('dsh-pwsh-plugin@0.0.2', '0.0.1')
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = {
      get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : name === 'profileContext' ? { dir: profileDir } : undefined),
    }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    const logs = []
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, log: (line) => logs.push(line) })
    await waitFor(() => logs.some((line) => /broken-release/.test(line)))
    check('发布坏了就不去装', manager.attempts.length === 0, 'attempts=' + manager.attempts.length)
    check('日志点明是发布本身的问题', logs.some((line) => /broken-release/.test(line) && /without bumping package\.json/.test(line)), JSON.stringify(logs))
    await sleep(120)
    check('发布坏了也不反复重试', logs.filter((line) => /broken-release/.test(line)).length === 1, JSON.stringify(logs))
    stop()
    rmSync(profileDir, { recursive: true, force: true })
  }
  {
    // 别人已经装好了，只是进程还没重启：磁盘已等于最新，运行版本更旧。
    const latest = packageVersion()
    const previous = { latest: '0.0.2' }
    registry.set('dsh-pwsh-plugin', packageDocument({ latest }, { [latest]: {} }))
    const profileDir = makeProfile('dsh-pwsh-plugin@' + latest, latest)
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = {
      get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : name === 'profileContext' ? { dir: profileDir } : undefined),
    }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    const logs = []
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, log: (line) => logs.push(line) })
    await waitFor(() => logs.some((line) => /restart-required/.test(line)))
    check('磁盘已是最新就不装', manager.attempts.length === 0, 'attempts=' + manager.attempts.length)
    check('说清要重启而不是再装一次', logs.some((line) => /restart-required/.test(line) && /Restart DSH/.test(line)), JSON.stringify(logs))
    await sleep(120)
    check('同一版本不重复试', logs.filter((line) => /restart-required/.test(line)).length === 1, JSON.stringify(logs))
    stop()
    registry.set('dsh-pwsh-plugin', packageDocument({ latest: previous.latest }, { '0.0.1': {}, '0.0.2': {} }))
    rmSync(profileDir, { recursive: true, force: true })
  }

  // ── 3d. 冷却期：装到了更旧的版本，目标版本要留着下次再试 ──────────────────
  // pnpm 的 minimumReleaseAge 会让「请求 0.0.2、落回 0.0.1」成为正常结果。若把这个目标当成
  // 已经装过，这个进程就再也升不上去了 —— 这一节钉的就是那条「撤掉记录」。
  console.log('\n[3d] 冷却期落地后重新排队')
  {
    registry.set('dsh-pwsh-plugin', packageDocument({ latest: '0.0.2' }, { '0.0.1': {}, '0.0.2': {} }))
    const profileDir = makeProfile(undefined, '0.0.1')
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = {
      get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : name === 'profileContext' ? { dir: profileDir } : undefined),
    }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    const logs = []
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, cooldownRetryMs: 25, log: (line) => logs.push(line) })
    await waitFor(() => manager.attempts.length >= 1)
    check('先真装了一次', manager.attempts.length === 1, 'attempts=' + manager.attempts.length)
    check('说清装到了更旧的版本', logs.some((line) => /installed 0\.0\.1 rather than 0\.0\.2/.test(line)), JSON.stringify(logs))
    // 第二轮应该被认出是冷却期：不再去装，但要继续看着。
    await waitFor(() => logs.some((line) => /cooling-down/.test(line)))
    check('第二轮认出冷却期', logs.some((line) => /cooling-down/.test(line)), JSON.stringify(logs))
    check('冷却期不重复去装', manager.attempts.length === 1, 'attempts=' + manager.attempts.length)
    await waitFor(() => logs.filter((line) => /cooling-down/.test(line)).length >= 2)
    check('冷却期里仍在看着（没停死）', logs.filter((line) => /cooling-down/.test(line)).length >= 2, JSON.stringify(logs))
    stop()
    rmSync(profileDir, { recursive: true, force: true })
  }

  // ── 4. 装失败要撤记录并退避 ──────────────────────────────────────────────
  console.log('\n[4] 失败退避')
  {
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [
      { application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'pnpm exited 1' } },
      { application: 'applied' },
    ])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, retryBaseMs: 15, retryMaxMs: 40 })
    await waitFor(() => manager.attempts.length >= 2)
    check('失败后会重试', manager.attempts.length >= 2, 'attempts=' + manager.attempts.length)
    stop()
  }
  {
    // 退避本身：连续失败时下一次调度应当越来越晚。用记录调度间隔的假定时器验证。
    // 这一节刻意用一个不联网的假 checker：压缩全局 setTimeout 会连带缩短 undici 内部
    // 的解析器超时计时器，让它在空闲连接上抛 TypeError（实测过），与本插件毫无关系。
    // 退避只跟「查到的状态」有关，与 checker 的实现无关。
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'failed', changed: false, error: { code: 'operation-error' } }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const checker = { async check() { return { state: 'available', latest: '0.0.2' } }, document: () => ({ state: 'available', latest: '0.0.2', spec: 'dsh-pwsh-plugin@0.0.2' }) }
    const delays = []
    globalThis.setTimeout = (fn, ms) => { delays.push(ms); return realSetTimeout(fn, 2) }
    let stop
    try {
      stop = startAutoUpdate(ctx, checker, { firstDelayMs: 0, intervalMs: 100000, retryBaseMs: 10, retryMaxMs: 40 })
      await waitFor(() => manager.attempts.length >= 4)
    } finally {
      globalThis.setTimeout = realSetTimeout
      stop?.()
    }
    const retries = delays.filter((ms) => ms !== 100000)
    check('重试间隔逐次加长', retries.length >= 3 && retries[1] > retries[0] && retries[2] > retries[1], JSON.stringify(retries))
    check('退避有上限', retries.every((ms) => ms <= 40), JSON.stringify(retries))
  }

  // ── 5. 查不到发布时不该乱装 ──────────────────────────────────────────────
  console.log('\n[5] 查不到就不动')
  {
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const broken = { async check() { return { state: 'failed', error: 'offline' } }, document: () => ({ state: 'failed' }) }
    const stop = startAutoUpdate(ctx, broken, { firstDelayMs: 5, intervalMs: 20, retryBaseMs: 10 })
    await sleep(70)
    check('查失败时不装', manager.attempts.length === 0, 'attempts=' + manager.attempts.length)
    stop()
  }
  {
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const current = { async check() { return { state: 'current', latest: '0.0.1' } }, document: () => ({ state: 'current', latest: '0.0.1' }) }
    const stop = startAutoUpdate(ctx, current, { firstDelayMs: 5, intervalMs: 20 })
    await sleep(60)
    check('已是最新时不装', manager.attempts.length === 0, 'attempts=' + manager.attempts.length)
    stop()
  }
  {
    // 真 checker 遇上真 404：registry 上没有这个包名。
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const logs = []
    // checker 自己的日志与 auto-update 的日志在插件里都汇进同一个 logger，所以这里也共用一个数组。
    const missing = new UpdateChecker({
      source: { kind: 'registry', registry: registry.url, name: 'no-such-package', spec: 'no-such-package' },
      version: '0.0.1',
      log: (line) => logs.push(line),
    })
    const stop = startAutoUpdate(ctx, missing, { firstDelayMs: 5, intervalMs: 20, retryBaseMs: 10, retryMaxMs: 20, log: (line) => logs.push(line) })
    await sleep(80)
    check('404 时不装', manager.attempts.length === 0, 'attempts=' + manager.attempts.length)
    check('404 落进日志', logs.some((line) => /not published on/.test(line)), JSON.stringify(logs))
    check('404 记为失败而不是最新', /state: failed|failed/.test(JSON.stringify(missing.document())), JSON.stringify(missing.document()))
    stop()
  }

  // ── 5b. 没有 HMR 的宿主上不自动装（装上也换不掉，只会谎报版本）─────────────
  console.log('\n[5b] 没有 HMR 时不自动装')
  {
    const manager = makeFakeManager({ executing: new AsyncLocalStorage() }, [{ application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : undefined) }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    const logs = []
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, log: (line) => logs.push(line) })
    await waitFor(() => logs.length > 0, 8000)
    check('没有 HMR 就不装', manager.attempts.length === 0, 'attempts=' + manager.attempts.length)
    check('但要说清为什么', logs.some((line) => /no HMR/.test(line)), JSON.stringify(logs))
    stop()
  }

  // ── 6. 安装抛错不打断循环 ────────────────────────────────────────────────
  console.log('\n[6] 抛错也要活下来')
  {
    const state = makeFakeHmr()
    const manager = makeFakeManager(state, [() => { throw new Error('profile is locked') }, { application: 'applied' }])
    const ctx = { get: (name) => (name === 'pluginManager' ? manager : name === 'hmr' ? state.hmr : undefined) }
    const checker = new UpdateChecker({ source, version: '0.0.1' })
    const stop = startAutoUpdate(ctx, checker, { firstDelayMs: 5, intervalMs: 20, retryBaseMs: 15, retryMaxMs: 40 })
    await waitFor(() => manager.attempts.length >= 2)
    check('抛错后仍会再试', manager.attempts.length >= 2, 'attempts=' + manager.attempts.length)
    stop()
  }
} finally {
  await registry.close()
}

console.log('\n' + '='.repeat(56))
console.log('TOTAL  pass=' + pass + '  fail=' + fail)
if (fail > 0) {
  console.log('\n失败项：')
  for (const problem of problems) console.log('  - ' + problem)
}
process.exit(fail === 0 ? 0 : 1)