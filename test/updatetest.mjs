#!/usr/bin/env node
/**
 * 更新检查的单元测试 —— 纯 node，不需要 DSH。
 *
 * 发布源用**本地假 registry**（真 HTTP，见 test/support.mjs 的 startRegistry），
 * 所以这套测试既能在没有网络时跑，也能真正走一遍「取文档 → 比版本 → 下结论」。
 * 用一个假 fetch 返回对象就测不到 accept 头、404 与网络故障的分野、dist-tags 缺失的回落。
 */

import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UpdateChecker,
  compareVersions,
  fetchRegistry,
  packageVersion,
  parseVersion,
  releaseSpec,
  updateSource,
  updateVerdict,
} from '../plugin/update-check.mjs'
import {
  bareVersion,
  checkInstallNeed,
  installRelease,
  preflightInstall,
  readInstalledSpec,
  readVersionAt,
  specVersion,
} from '../plugin/update-apply.mjs'
import { packageDocument, startRegistry } from './support.mjs'

let pass = 0
let fail = 0
const problems = []

function check(label, ok, detail) {
  if (ok) {
    pass += 1
    console.log('  PASS  ' + label)
  } else {
    fail += 1
    problems.push(label + (detail === undefined ? '' : ' :: ' + detail))
    console.log('  FAIL  ' + label + (detail === undefined ? '' : ' :: ' + detail))
  }
}

const same = (label, actual, expected) => check(label, actual === expected, 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))
const deep = (label, actual, expected) => check(label, JSON.stringify(actual) === JSON.stringify(expected), 'expected ' + JSON.stringify(expected) + ', got ' + JSON.stringify(actual))

// ── 1. 版本解析 ────────────────────────────────────────────────────────────
console.log('\n[1] parseVersion')
deep('1.2.3', parseVersion('1.2.3'), { parts: [1, 2, 3] })
deep('带 v 前缀', parseVersion('v1.2.3'), { parts: [1, 2, 3] })
deep('带预发布', parseVersion('1.2.3-rc.1'), { parts: [1, 2, 3], prerelease: 'rc.1' })
same('前后空白容忍', JSON.stringify(parseVersion('  2.0.1  ')?.parts), '[2,0,1]')
same('两段拒绝', parseVersion('1.2'), undefined)
same('四段拒绝', parseVersion('1.2.3.4'), undefined)
same('前导零拒绝', parseVersion('01.2.3'), undefined)
same('非字符串', parseVersion(null), undefined)

// ── 2. 版本比较 ────────────────────────────────────────────────────────────
console.log('\n[2] compareVersions')
check('1.2.3 < 1.2.4', compareVersions('1.2.3', '1.2.4') < 0)
check('v1.2.3 == 1.2.3（带不带 v 都行）', compareVersions('v1.2.3', '1.2.3') === 0)
check('1.10.0 > 1.9.0（按数字不按字面）', compareVersions('1.10.0', '1.9.0') > 0)
check('2.0.0 > 1.99.99', compareVersions('2.0.0', '1.99.99') > 0)
check('解析不出的排在下面', compareVersions('bogus', '0.0.1') < 0)
check('两个解析不出视为相等', compareVersions('bogus', 'nonsense') === 0)
// 预发布必须排在对应的正式版之下：否则自动更新会把用户推向 rc。
check('1.2.3-rc.1 < 1.2.3', compareVersions('1.2.3-rc.1', '1.2.3') < 0)
check('1.2.3 > 1.2.3-rc.1', compareVersions('1.2.3', '1.2.3-rc.1') > 0)
check('1.2.3-rc.1 < 1.2.3-rc.2', compareVersions('1.2.3-rc.1', '1.2.3-rc.2') < 0)

// ── 3. 发布源 ──────────────────────────────────────────────────────────────
console.log('\n[3] updateSource')
deep('默认 npm 公共 registry', updateSource({}), { kind: 'registry', registry: 'https://registry.npmjs.org', name: 'dsh-pwsh-plugin', spec: 'dsh-pwsh-plugin' })
deep('环境变量改成别处', updateSource({ DSH_PWSH_UPDATE_REGISTRY: 'http://127.0.0.1:9/' }), { kind: 'registry', registry: 'http://127.0.0.1:9', name: 'dsh-pwsh-plugin', spec: 'dsh-pwsh-plugin' })
deep('空串退回默认', updateSource({ DSH_PWSH_UPDATE_REGISTRY: '   ' }), { kind: 'registry', registry: 'https://registry.npmjs.org', name: 'dsh-pwsh-plugin', spec: 'dsh-pwsh-plugin' })

// ── 4. 安装规格 ────────────────────────────────────────────────────────────
console.log('\n[4] releaseSpec / specVersion')
same('规格钉版本号', releaseSpec({ name: 'dsh-pwsh-plugin' }, '0.2.13'), 'dsh-pwsh-plugin@0.2.13')
same('带 v 前缀也规范成不带', releaseSpec({ name: 'dsh-pwsh-plugin' }, 'v0.2.13'), 'dsh-pwsh-plugin@0.2.13')
same('从规格里读回版本', specVersion('dsh-pwsh-plugin@0.2.13'), '0.2.13')
same('scope 包也读得对', specVersion('@citydirector/dsh-pwsh-plugin@1.2.3'), '1.2.3')
same('没钉版本', specVersion('dsh-pwsh-plugin'), undefined)
same('非字符串', specVersion(null), undefined)
same('版本段不是三段', specVersion('dsh-pwsh-plugin@latest'), undefined)

// ── 5. 判决 ────────────────────────────────────────────────────────────────
console.log('\n[5] updateVerdict')
deep('有更新的', updateVerdict({ latest: '0.2.0', versions: ['0.1.0', '0.2.0'], deprecated: new Set() }, '0.1.0'), { state: 'available', latest: '0.2.0' })
deep('已是最新', updateVerdict({ latest: '0.1.0', versions: ['0.1.0'], deprecated: new Set() }, '0.1.0'), { state: 'current', latest: '0.1.0' })
deep('线上比本地还旧', updateVerdict({ latest: '0.0.9', versions: ['0.0.9'], deprecated: new Set() }, '0.1.0'), { state: 'current', latest: '0.0.9' })
// dist-tags 缺失时从版本清单里挑：只认正式版，取语义最高。
deep('没有 dist-tags 时自己挑正式版', updateVerdict({ versions: ['0.1.0', '0.10.0', '0.9.0'], deprecated: new Set() }, '0.1.0'), { state: 'available', latest: '0.10.0' })
deep('没有 dist-tags 时不推预发布', updateVerdict({ versions: ['0.1.0', '0.2.0-rc.1'], deprecated: new Set() }, '0.1.0'), { state: 'current', latest: '0.1.0' })
// 被标 deprecated 的 latest 不可信：那是发布者自己说的「别用」。
deep('latest 被废弃时不推它', updateVerdict({ latest: '0.3.0', versions: ['0.1.0', '0.3.0'], deprecated: new Set(['0.3.0']) }, '0.1.0'), { state: 'current', deprecated: '0.3.0' })
deep('废弃版本不进自动挑选', updateVerdict({ versions: ['0.2.0', '0.3.0'], deprecated: new Set(['0.3.0']) }, '0.1.0'), { state: 'available', latest: '0.2.0' })

// ── 6. 本包版本 ────────────────────────────────────────────────────────────
// 只断言"读得到"与"读对了"：发版必然改版本号，把数字写死在断言里等于每次发版都要改测试。
console.log('\n[6] packageVersion')
const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const version = packageVersion()
check('读到 package.json 声明的版本', version === declared, String(version) + ' vs ' + String(declared))
check('是三段版本号', typeof version === 'string' && /^\d+\.\d+\.\d+/.test(version), String(version))

const sandbox = mkdtempSync(join(tmpdir(), 'pwsh-update-'))
const cleanup = () => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 测试自己的临时目录，删不掉也不影响结论 */
  }
}

const registry = await startRegistry({
  'dsh-pwsh-plugin': packageDocument({ latest: '0.2.0' }, { '0.1.0': {}, '0.2.0': {} }),
})
const source = updateSource({ DSH_PWSH_UPDATE_REGISTRY: registry.url })

try {
  // ── 7. 真 HTTP：取文档 ────────────────────────────────────────────────────
  console.log('\n[7] fetchRegistry（本地假 registry，真 HTTP）')
  const document = await fetchRegistry(source)
  same('latest 读得到', document.latest, '0.2.0')
  deep('版本清单', document.versions, ['0.1.0', '0.2.0'])
  check('带了 abbreviated 的 accept 头',
    registry.requests.some((item) => item.accept.includes('application/vnd.npm.install-v1+json')),
    JSON.stringify(registry.requests.map((item) => item.accept)))
  same('请求的是包名', registry.requests.at(-1)?.name, 'dsh-pwsh-plugin')

  // 包不存在与网络不通必须分开：前者重试一万次也不会好。
  const missing = updateSource({ DSH_PWSH_UPDATE_REGISTRY: registry.url + '/nope' })
  let missingError
  try {
    await fetchRegistry(missing)
  } catch (error) {
    missingError = error
  }
  check('404 说成「还没发布」', /not published on/.test(String(missingError?.message)), String(missingError?.message))

  let offlineError
  try {
    await fetchRegistry({ kind: 'registry', registry: 'http://127.0.0.1:1', name: 'dsh-pwsh-plugin', spec: 'dsh-pwsh-plugin' })
  } catch (error) {
    offlineError = error
  }
  check('连不上时抛出', offlineError !== undefined, String(offlineError?.message))

  // ── 8. UpdateChecker 端到端 ──────────────────────────────────────────────
  console.log('\n[8] UpdateChecker（本地 registry，跑 0.1.0）')
  const lines = []
  const checker = new UpdateChecker({ env: {}, source, version: '0.1.0', log: (line) => lines.push(line) })
  const after = await checker.check()
  same('判决 available', after.state, 'available')
  same('最新 0.2.0', after.latest, '0.2.0')
  const doc = checker.document()
  same('doc 带安装规格', doc.spec, 'dsh-pwsh-plugin@0.2.0')
  same('doc 带运行版本', doc.running, '0.1.0')
  same('doc 带发布源', doc.source, 'dsh-pwsh-plugin')
  check('写了一条日志', lines.some((line) => line.includes('available')), JSON.stringify(lines))

  const first = checker.announce
  check('第一次 announce 有内容', first !== undefined && first.latest === '0.2.0', JSON.stringify(first))
  same('announce 里的规格可直接安装', first?.spec, 'dsh-pwsh-plugin@0.2.0')
  same('第二次 announce 不再重复', checker.announce, undefined)

  // 装上新版之后（版本变 0.2.0），同一次检查应判 current。
  const newer = new UpdateChecker({ env: {}, source, version: '0.2.0' })
  const afterNewer = await newer.check()
  same('升到 0.2.0 后判 current', afterNewer.state, 'current')

  // 发布源指错时不抛，只记 failed。
  console.log('\n[9] 失败不抛')
  const broken = new UpdateChecker({ env: {}, source: { kind: 'registry', registry: registry.url, name: 'no-such-package', spec: 'no-such-package' }, version: '0.1.0' })
  const failed = await broken.check()
  same('state=failed', failed.state, 'failed')
  check('带错误信息', typeof failed.error === 'string' && failed.error.length > 0, String(failed.error))
  same('失败时不 announce', broken.announce, undefined)

  // 版本读不出时不联网瞎猜。
  console.log('\n[10] 自身版本读不出')
  const noVersion = new UpdateChecker({ env: {}, source, version: undefined })
  noVersion.version = undefined
  const unreadable = await noVersion.check()
  same('state=failed', unreadable.state, 'failed')
  same('错误文案', unreadable.error, 'own version unreadable')

  // start/stop 能重复调用且不留定时器。
  console.log('\n[11] start / stop')
  const timed = new UpdateChecker({ env: {}, source, version: '0.1.0', delayMs: 60_000, intervalMs: 60_000 })
  timed.start()
  timed.start()
  check('重复 start 不叠定时器', timed.timer !== undefined && timed.interval === undefined)
  timed.stop()
  timed.stop()
  same('stop 之后没有定时器', timed.timer, undefined)
  same('stop 之后没有间隔器', timed.interval, undefined)

  // ---------------------------------------------------------------- 安装
  console.log('\n[12] 安装：交给 pluginManager，并回读磁盘版本')
  {
    const none = await installRelease(undefined, 'dsh-pwsh-plugin@1.0.0')
    same('服务缺席时 outcome=no-manager', none.outcome, 'no-manager')
    check('服务缺席时 ok=false', none.ok === false)

    const shell = await installRelease({}, 'dsh-pwsh-plugin@1.0.0')
    same('没有 installBundle 时也是 no-manager', shell.outcome, 'no-manager')

    const calls = []
    const fake = {
      async installBundle(spec, options) {
        calls.push([spec, options])
        return { application: 'restart-required', changed: true, target: 'dsh-pwsh-plugin' }
      },
    }
    const restarted = await installRelease(fake, 'dsh-pwsh-plugin@1.0.1', { requestId: 'req-1' })
    check('装成功时 ok=true', restarted.ok === true)
    same('outcome 透传 application', restarted.outcome, 'restart-required')
    same('spec 原样传给安装器', calls[0][0], 'dsh-pwsh-plugin@1.0.1')
    same('requestId 原样传给安装器', calls[0][1].requestId, 'req-1')
    check('提示要重启', restarted.text.includes('Restart DSH'), restarted.text)

    const applied = await installRelease({
      async installBundle() { return { application: 'applied', changed: true } },
    }, 'dsh-pwsh-plugin@1.0.1')
    check('applied 但非 live 仍要求重启', applied.text.includes('Restart DSH'), applied.text)

    const failedInstall = await installRelease({
      async installBundle() {
        return { application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'pnpm exited 1' } }
      },
    }, 'dsh-pwsh-plugin@1.0.1')
    check('失败时 ok=false', failedInstall.ok === false)
    check('失败文案带错误码与诊断', failedInstall.text.includes('operation-error') && failedInstall.text.includes('pnpm exited 1'), failedInstall.text)

    const cancelled = await installRelease({
      async installBundle() { return { application: 'cancelled', changed: false } },
    }, 'dsh-pwsh-plugin@1.0.1')
    check('取消也按失败处理', cancelled.ok === false)

    const threw = await installRelease({
      async installBundle() { throw new Error('profile is locked') },
    }, 'dsh-pwsh-plugin@1.0.1')
    same('抛错时 outcome=threw', threw.outcome, 'threw')
    check('抛错文案带上原始原因', threw.text.includes('profile is locked'), threw.text)

    // HMR 在场且安装跑在它的事务之外：代码是真换过来了，这时再要求重启就是误报。
    const inPlace = await installRelease({
      async installBundle() { return { application: 'applied', changed: true } },
    }, 'dsh-pwsh-plugin@1.0.1', { live: true })
    check('live 装成功时 ok=true', inPlace.ok === true)
    check('live 不再要求重启', !inPlace.text.includes('Restart DSH'), inPlace.text)
    check('live 明确说已在跑', inPlace.text.includes('already running'), inPlace.text)

    // 预检拦下来的 already-installed 也要按「已装好」表述，而不是一串 operation-error。
    const refused = await installRelease({
      async installBundle() { return { application: 'failed', changed: false, error: { code: 'already-installed' } } },
    }, 'dsh-pwsh-plugin@1.0.1', { live: true })
    check('already-installed 不再当成失败', refused.ok === true, JSON.stringify(refused))
    check('already-installed 说的是已经装好了', refused.text.includes('already installed'), refused.text)
    check('already-installed 不再印错误码', !refused.text.includes('could not install'), refused.text)
  }

  // ── 13. 冷却期：请求 0.2.13，磁盘上却装的是 0.2.12 ────────────────────────
  // 这一节钉的是 pnpm minimumReleaseAge 造成的真实落差，而 installBundle 的返回值里没有版本号。
  console.log('\n[13] 回读磁盘版本（冷却期）')
  {
    const profileDir = join(sandbox, 'cooled-profile')
    const installedDir = join(profileDir, 'node_modules', 'dsh-pwsh-plugin')
    mkdirSync(installedDir, { recursive: true })
    writeFileSync(join(installedDir, 'package.json'), JSON.stringify({ name: 'dsh-pwsh-plugin', version: '0.2.12' }))
    const manager = { async installBundle() { return { application: 'applied', changed: true } } }
    const cooled = await installRelease(manager, 'dsh-pwsh-plugin@0.2.13', { live: true, profileDir })
    same('回读到实际落地的版本', cooled.installedVersion, '0.2.12')
    check('说清装到了别的版本', cooled.text.includes('0.2.12') && cooled.text.includes('minimumReleaseAge'), cooled.text)
    check('仍然按成功处理（磁盘确实变了）', cooled.ok === true, cooled.text)

    // 落地的正好是请求的那个版本：不该多嘴。
    writeFileSync(join(installedDir, 'package.json'), JSON.stringify({ name: 'dsh-pwsh-plugin', version: '0.2.13' }))
    const exact = await installRelease(manager, 'dsh-pwsh-plugin@0.2.13', { live: true, profileDir })
    check('版本对得上时不提冷却期', !exact.text.includes('minimumReleaseAge'), exact.text)

    // 读不到装件：不编版本号。
    const absent = await installRelease(manager, 'dsh-pwsh-plugin@0.2.13', { live: true, profileDir: join(sandbox, 'no-such-profile') })
    same('读不到装件时没有安装版本', absent.installedVersion, undefined)
    check('读不到装件时不提冷却期', !absent.text.includes('minimumReleaseAge'), absent.text)
  }

  // ── 14. 装之前的预检 ────────────────────────────────────────────────────
  // 这一节钉的是几种「装了也白装」：别人已经装好等重启、发版忘了升版本号、冷却期未过。
  console.log('\n[14] checkInstallNeed（装之前先问值不值得装）')
  {
    same('版本号解析', bareVersion('v1.3.0'), '1.3.0')
    same('预发布也认', bareVersion('1.3.0-rc.1'), '1.3.0-rc.1')
    same('不是版本形态', bareVersion('latest'), undefined)

    // 磁盘比最新旧：该装。
    same('版本旧 → 该装', checkInstallNeed({ latest: '1.3.0', disk: '1.2.0', running: '1.2.0', spec: 'dsh-pwsh-plugin@1.3.0', installed: 'dsh-pwsh-plugin@1.2.0' }), null)
    // 最新版本解析不出来：不判，交给下游。
    same('latest 非法 → 不判', checkInstallNeed({ latest: 'nightly', disk: '1.2.0' }), null)
    // 磁盘与运行都是最新：什么都不用做。
    const current = checkInstallNeed({ latest: '1.3.0', disk: '1.3.0', running: '1.3.0' })
    same('都最新 → already-current', current?.outcome, 'already-current')
    check('都最新时 ok=true', current?.ok === true, JSON.stringify(current))
    // 磁盘新、进程旧：别人装好了没重启。
    const restart = checkInstallNeed({ latest: '1.3.0', disk: '1.3.0', running: '1.2.0' })
    same('磁盘新进程旧 → restart-required', restart?.outcome, 'restart-required')
    check('点出进程里还在跑哪个版本', restart?.text.includes('1.2.0'), String(restart?.text))
    check('说清要重启', /restart/i.test(String(restart?.text)), String(restart?.text))
    check('这时 ok 仍是 true（没坏，只是要重启）', restart?.ok === true, JSON.stringify(restart))
    same('运行版本未知也能判', checkInstallNeed({ latest: '1.3.0', disk: '1.3.0' })?.outcome, 'restart-required')
    // profile 已指向该版本，而包内版本没变：发布本身坏了。
    const brokenRelease = checkInstallNeed({ latest: '1.3.0', disk: '1.2.0', running: '1.2.0', spec: 'dsh-pwsh-plugin@1.3.0', installed: 'dsh-pwsh-plugin@1.3.0' })
    same('发布版本与包内版本对不上 → broken-release', brokenRelease?.outcome, 'broken-release')
    check('broken-release 时 ok=false', brokenRelease?.ok === false, JSON.stringify(brokenRelease))
    check('指出是发了版但没升版本', /not bumped|package\.json/.test(String(brokenRelease?.text)), String(brokenRelease?.text))
    // profile 记录的规格与要装的不同：说明还没装过，照装不误。
    same('profile 记录别的规格 → 该装', checkInstallNeed({ latest: '1.3.0', disk: '1.2.0', spec: 'dsh-pwsh-plugin@1.3.0', installed: 'dsh-pwsh-plugin@1.2.0' }), null)
    // 读不到包内版本时不做「发布坏了」的判断：那是本插件的问题，不是发布的问题。
    same('包内版本读不到 → 不判坏发布', checkInstallNeed({ latest: '1.3.0', disk: undefined, spec: 'dsh-pwsh-plugin@1.3.0', installed: 'dsh-pwsh-plugin@1.3.0' }), null)

    // 冷却期：上一次装 0.2.13 落到了 0.2.12，这次还会重演同一个决定。
    const cooled = checkInstallNeed({ latest: '0.2.13', disk: '0.2.12', running: '0.2.12', spec: 'dsh-pwsh-plugin@0.2.13', installed: 'dsh-pwsh-plugin@0.2.12', cooled: '0.2.12' })
    same('冷却期未过 → cooling-down', cooled?.outcome, 'cooling-down')
    check('指出是 minimumReleaseAge 在拦', /minimumReleaseAge/.test(String(cooled?.text)), String(cooled?.text))
    check('说明要等到期', /24 hours|wait/i.test(String(cooled?.text)), String(cooled?.text))
    check('冷却期不当成故障', cooled?.ok === true, JSON.stringify(cooled))
    // 冷却期落在更旧的版本上、而最新已经追平：不该再判冷却。
    same('冷却版本已追平 → 不判冷却', checkInstallNeed({ latest: '0.2.12', disk: '0.2.12', running: '0.2.11', cooled: '0.2.12' })?.outcome, 'restart-required')

    // 真读一份 profile：依赖表里拿得到、读不到时安静返回 undefined。
    const profileDir = join(sandbox, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'other-plugin': '^1.0.0', 'dsh-pwsh-plugin': 'dsh-pwsh-plugin@1.4.0' } }))
    same('读到 profile 记的规格', readInstalledSpec(profileDir, 'dsh-pwsh-plugin'), 'dsh-pwsh-plugin@1.4.0')
    same('没这条依赖时返回 undefined', readInstalledSpec(profileDir, 'absent-plugin'), undefined)
    same('profile 目录不存在时返回 undefined', readInstalledSpec(join(sandbox, 'no-such-profile'), 'dsh-pwsh-plugin'), undefined)
    same('profile 目录缺席时返回 undefined', readInstalledSpec(undefined, 'dsh-pwsh-plugin'), undefined)
    writeFileSync(join(profileDir, 'package.json'), 'not json')
    same('package.json 坏了也不抛', readInstalledSpec(profileDir, 'dsh-pwsh-plugin'), undefined)
    same('坏 package.json 读版本也不抛', readVersionAt(join(profileDir, 'package.json')), undefined)
    same('文件不存在时读版本返回 undefined', readVersionAt(join(profileDir, 'no-such.json')), undefined)

    // preflightInstall 把 ctx 与 checker 接起来：profile 指向该版本且包内版本没变 → 拦下来。
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pwsh-plugin': 'dsh-pwsh-plugin@1.3.0' } }))
    const fakeCtx = { get: (name) => (name === 'profileContext' ? { dir: profileDir } : undefined) }
    const fakeChecker = { version: '1.2.0' }
    // 本包磁盘版本是测试自己的版本，与 1.3.0 无关，所以这里撞的是 broken-release 分支。
    same('preflight 接上 ctx 与 checker', preflightInstall(fakeCtx, fakeChecker, 'dsh-pwsh-plugin@1.3.0')?.outcome, 'broken-release')
    // profile 指向别的版本时放行。
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pwsh-plugin': 'dsh-pwsh-plugin@1.0.0' } }))
    same('profile 指向别的版本 → 放行', preflightInstall(fakeCtx, fakeChecker, 'dsh-pwsh-plugin@1.3.0'), null)
    // 冷却期的事实要能从 preflight 传进来。
    same('preflight 接受 cooled', preflightInstall(fakeCtx, { version: '0.2.12' }, 'dsh-pwsh-plugin@0.2.13', { cooled: '0.2.12' })?.outcome, 'cooling-down')
  }
} finally {
  await registry.close()
  cleanup()
}

console.log('\n' + '='.repeat(56))
console.log('TOTAL  pass=' + pass + '  fail=' + fail)
if (fail > 0) {
  console.log('\n失败项：')
  for (const problem of problems) console.log('  - ' + problem)
}
process.exit(fail === 0 ? 0 : 1)
