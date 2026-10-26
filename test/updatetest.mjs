#!/usr/bin/env node
/**
 * 更新检查的单元测试 —— 纯 node，不需要 DSH。
 *
 * 发布源用**本地 git 仓库**预演（DSH_PWSH_UPDATE_SOURCE 的 git+file:// 形态），
 * 所以这套测试既能在没有网络时跑，也能真正走一遍「读标签 → 比版本 → 下结论」。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  UpdateChecker,
  compareVersions,
  fetchReleaseTags,
  latestRelease,
  packageVersion,
  parseReleaseTag,
  releaseSpec,
  updateSource,
  updateVerdict,
} from '../plugin/update-check.mjs'
import { checkInstallNeed, installRelease, preflightInstall, readInstalledSpec, specTag } from '../plugin/update-apply.mjs'

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

// ── 1. 标签解析 ────────────────────────────────────────────────────────────
console.log('\n[1] parseReleaseTag')
deep('v1.2.3', parseReleaseTag('v1.2.3'), [1, 2, 3])
deep('v0.0.0', parseReleaseTag('v0.0.0'), [0, 0, 0])
deep('v10.20.30', parseReleaseTag('v10.20.30'), [10, 20, 30])
same('前后空白容忍', JSON.stringify(parseReleaseTag('  v2.0.1  ')), '[2,0,1]')
same('无 v 前缀拒绝', parseReleaseTag('1.2.3'), undefined)
same('两段拒绝', parseReleaseTag('v1.2'), undefined)
same('四段拒绝', parseReleaseTag('v1.2.3.4'), undefined)
same('预发布拒绝', parseReleaseTag('v1.2.3-rc.1'), undefined)
same('前导零拒绝', parseReleaseTag('v01.2.3'), undefined)
same('非字符串', parseReleaseTag(null), undefined)

// ── 2. 版本比较 ────────────────────────────────────────────────────────────
console.log('\n[2] compareVersions')
check('v1.2.3 < v1.2.4', compareVersions('v1.2.3', 'v1.2.4') < 0)
check('v1.2.3 == 1.2.3（带不带 v 都行）', compareVersions('v1.2.3', '1.2.3') === 0)
check('v1.10.0 > v1.9.0（按数字不按字面）', compareVersions('v1.10.0', 'v1.9.0') > 0)
check('v2.0.0 > v1.99.99', compareVersions('v2.0.0', 'v1.99.99') > 0)
check('解析不出的排在下面', compareVersions('bogus', 'v0.0.1') < 0)
check('两个解析不出视为相等', compareVersions('bogus', 'nonsense') === 0)

// ── 3. 取最新 ──────────────────────────────────────────────────────────────
console.log('\n[3] latestRelease')
same('乱序取最高', latestRelease(['v1.0.0', 'v1.10.2', 'v1.9.9']), 'v1.10.2')
same('忽略非发布标签', latestRelease(['v1.0.0', 'nightly', 'v1.0.1-rc.1']), 'v1.0.0')
same('空表', latestRelease([]), undefined)
same('undefined 表', latestRelease(undefined), undefined)

// ── 4. 发布源 ──────────────────────────────────────────────────────────────
console.log('\n[4] updateSource')
deep('默认 GitHub 仓库', updateSource({}), { kind: 'github', repository: 'citydirector/dsh-pwsh-plugin', spec: 'github:citydirector/dsh-pwsh-plugin' })
deep('环境变量改成另一个仓库', updateSource({ DSH_PWSH_UPDATE_SOURCE: 'me/other' }), { kind: 'github', repository: 'me/other', spec: 'github:me/other' })
deep('git+file URL', updateSource({ DSH_PWSH_UPDATE_SOURCE: 'git+file:///D:/repo' }), { kind: 'git', url: 'file:///D:/repo', spec: 'git+file:///D:/repo' })
deep('git+https URL', updateSource({ DSH_PWSH_UPDATE_SOURCE: 'git+https://host/x.git' }), { kind: 'git', url: 'https://host/x.git', spec: 'git+https://host/x.git' })
deep('空串退回默认', updateSource({ DSH_PWSH_UPDATE_SOURCE: '   ' }), { kind: 'github', repository: 'citydirector/dsh-pwsh-plugin', spec: 'github:citydirector/dsh-pwsh-plugin' })

// ── 5. 安装规格 ────────────────────────────────────────────────────────────
console.log('\n[5] releaseSpec')
same('GitHub 规格钉 tag', releaseSpec({ spec: 'github:me/x' }, 'v1.2.3'), 'github:me/x#v1.2.3')
same('git 规格钉 tag', releaseSpec({ spec: 'git+file:///R' }, 'v0.1.0'), 'git+file:///R#v0.1.0')

// ── 6. 判决 ────────────────────────────────────────────────────────────────
console.log('\n[6] updateVerdict')
deep('有更新的', updateVerdict(['v0.1.0', 'v0.2.0'], '0.1.0'), { state: 'available', latest: 'v0.2.0' })
deep('已是最新', updateVerdict(['v0.1.0'], '0.1.0'), { state: 'current', latest: 'v0.1.0' })
deep('一个标签都没有', updateVerdict([], '0.1.0'), { state: 'current' })
deep('标签比本地还旧', updateVerdict(['v0.0.9'], '0.1.0'), { state: 'current', latest: 'v0.0.9' })

// ── 7. 本包版本 ────────────────────────────────────────────────────────────
// 只断言"读得到"与"读对了"：发版必然改版本号，把数字写死在断言里等于每次发版都要改测试。
console.log('\n[7] packageVersion')
const declared = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
const version = packageVersion()
check('读到 package.json 声明的版本', version === declared, String(version) + ' vs ' + String(declared))
check('是三段版本号', typeof version === 'string' && /^\d+\.\d+\.\d+$/.test(version), String(version))

// ── 8. 本地仓库预演：真读标签 ──────────────────────────────────────────────
console.log('\n[8] fetchReleaseTags（本地 git 仓库）')
const sandbox = mkdtempSync(join(tmpdir(), 'pwsh-update-'))
const repo = join(sandbox, 'release-repo')
const cleanup = () => {
  try {
    rmSync(sandbox, { recursive: true, force: true })
  } catch {
    /* 测试自己的临时目录，删不掉也不影响结论 */
  }
}

try {
  mkdirSync(repo, { recursive: true })
  const git = (...args) => execFileSync('git', ['-C', repo, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } })
  git('init', '-q', '-b', 'main')
  git('config', 'user.email', 'test@local')
  git('config', 'user.name', 'test')
  writeFileSync(join(repo, 'payload.txt'), 'x\n')
  git('add', '.')
  git('commit', '-q', '-m', 'release')
  git('tag', 'v0.1.0')
  git('tag', 'v0.1.1')
  git('tag', 'v0.2.0')
  git('tag', 'not-a-release')

  const source = { kind: 'git', url: repo, spec: 'git+file://' + repo }
  const tags = await fetchReleaseTags(source)
  check('读到两个以上标签', tags.length >= 3, String(tags.length))
  check('含 v0.2.0', tags.includes('v0.2.0'), JSON.stringify(tags))
  same('最新是 v0.2.0', latestRelease(tags), 'v0.2.0')

  // ── 9. UpdateChecker 端到端 ──────────────────────────────────────────────
  console.log('\n[9] UpdateChecker（本地仓库，跑 0.1.0）')
  const lines = []
  const checker = new UpdateChecker({ env: {}, source, version: '0.1.0', log: (line) => lines.push(line) })
  const after = await checker.check()
  same('判决 available', after.state, 'available')
  same('最新 v0.2.0', after.latest, 'v0.2.0')
  const doc = checker.document()
  same('doc 带安装规格', doc.spec, 'git+file://' + repo + '#v0.2.0')
  same('doc 带运行版本', doc.running, '0.1.0')
  check('写了一条日志', lines.some((line) => line.includes('available')), JSON.stringify(lines))

  const first = checker.announce
  check('第一次 announce 有内容', first !== undefined && first.latest === 'v0.2.0', JSON.stringify(first))
  same('第二次 announce 不再重复', checker.announce, undefined)

  // 装上新版之后（版本变 0.2.0），同一次检查应判 current。
  const newer = new UpdateChecker({ env: {}, source, version: '0.2.0' })
  const afterNewer = await newer.check()
  same('升到 0.2.0 后判 current', afterNewer.state, 'current')

  // 发布源指错时不抛，只记 failed。
  console.log('\n[10] 失败不抛')
  const broken = new UpdateChecker({ env: {}, source: { kind: 'git', url: join(sandbox, 'no-such-repo'), spec: 'git+file://' + join(sandbox, 'no-such-repo') }, version: '0.1.0' })
  const failed = await broken.check()
  same('state=failed', failed.state, 'failed')
  check('带错误信息', typeof failed.error === 'string' && failed.error.length > 0, String(failed.error))
  same('失败时不 announce', broken.announce, undefined)

  // 版本读不出时不联网瞎猜。
  console.log('\n[11] 自身版本读不出')
  const noVersion = new UpdateChecker({ env: {}, source, version: undefined })
  // 构造时 version 会去读本包 package.json，所以显式置空来模拟读不到。
  noVersion.version = undefined
  const unreadable = await noVersion.check()
  same('state=failed', unreadable.state, 'failed')
  same('错误文案', unreadable.error, 'own version unreadable')

  // start/stop 能重复调用且不留定时器。
  console.log('\n[12] start / stop')
  const timed = new UpdateChecker({ env: {}, source, version: '0.1.0', delayMs: 60_000, intervalMs: 60_000 })
  timed.start()
  timed.start()
  check('重复 start 不叠定时器', timed.timer !== undefined && timed.interval === undefined)
  timed.stop()
  timed.stop()
  same('stop 之后没有定时器', timed.timer, undefined)
  same('stop 之后没有间隔器', timed.interval, undefined)

  // ---------------------------------------------------------------- 安装
  console.log('\n[13] 安装：交给 pluginManager')
  {
    const none = await installRelease(undefined, 'github:owner/repo#v1.0.0')
    same('服务缺席时 outcome=no-manager', none.outcome, 'no-manager')
    check('服务缺席时 ok=false', none.ok === false)

    const shell = await installRelease({}, 'github:owner/repo#v1.0.0')
    same('没有 installBundle 时也是 no-manager', shell.outcome, 'no-manager')

    const calls = []
    const fake = {
      async installBundle(spec, options) {
        calls.push([spec, options])
        return { application: 'restart-required', changed: true, target: 'dsh-pwsh-plugin' }
      },
    }
    const restarted = await installRelease(fake, 'github:owner/repo#v1.0.1', { requestId: 'req-1' })
    check('装成功时 ok=true', restarted.ok === true)
    same('outcome 透传 application', restarted.outcome, 'restart-required')
    same('spec 原样传给安装器', calls[0][0], 'github:owner/repo#v1.0.1')
    same('requestId 原样传给安装器', calls[0][1].requestId, 'req-1')
    check('提示要重启', restarted.text.includes('Restart DSH'), restarted.text)

    // bundle 行给不出新的 module URL，所以 'applied' 也不该宣称「已经换过来了」。
    const applied = await installRelease({
      async installBundle() { return { application: 'applied', changed: true } },
    }, 'github:owner/repo#v1.0.1')
    check('applied 仍然要求重启', applied.text.includes('Restart DSH'), applied.text)

    const failed = await installRelease({
      async installBundle() {
        return { application: 'failed', changed: false, error: { code: 'operation-error', diagnostic: 'pnpm exited 1' } }
      },
    }, 'github:owner/repo#v1.0.1')
    check('失败时 ok=false', failed.ok === false)
    check('失败文案带错误码与诊断', failed.text.includes('operation-error') && failed.text.includes('pnpm exited 1'), failed.text)

    const cancelled = await installRelease({
      async installBundle() { return { application: 'cancelled', changed: false } },
    }, 'github:owner/repo#v1.0.1')
    check('取消也按失败处理', cancelled.ok === false)

    const threw = await installRelease({
      async installBundle() { throw new Error('profile is locked') },
    }, 'github:owner/repo#v1.0.1')
    same('抛错时 outcome=threw', threw.outcome, 'threw')
    check('抛错文案带上原始原因', threw.text.includes('profile is locked'), threw.text)

    // HMR 在场且安装跑在它的事务之外：代码是真换过来了，这时再要求重启就是误报。
    const inPlace = await installRelease({
      async installBundle() { return { application: 'applied', changed: true } },
    }, 'github:owner/repo#v1.0.1', { live: true })
    check('live 装成功时 ok=true', inPlace.ok === true)
    check('live 不再要求重启', !inPlace.text.includes('Restart DSH'), inPlace.text)
    check('live 明确说已在跑', inPlace.text.includes('already running'), inPlace.text)

    // 预检拦下来的 already-installed 也要按「已装好」表述，而不是一串 operation-error。
    const refused = await installRelease({
      async installBundle() { return { application: 'failed', changed: false, error: { code: 'already-installed' } } },
    }, 'github:owner/repo#v1.0.1', { live: true })
    check('already-installed 不再当成失败', refused.ok === true, JSON.stringify(refused))
    check('already-installed 说的是已经装好了', refused.text.includes('already installed'), refused.text)
    check('already-installed 不再印错误码', !refused.text.includes('could not install'), refused.text)
  }

  // ── 14. 装之前的预检 ────────────────────────────────────────────────────
  // 这一节钉的是两种「装了也白装」：别人已经装好等重启、以及发版忘了升版本号。
  console.log('\n[14] checkInstallNeed（装之前先问值不值得装）')
  {
    same('tag 解析：钉了 tag', specTag('github:owner/repo#v1.2.3'), 'v1.2.3')
    same('tag 解析：没钉 tag', specTag('github:owner/repo'), undefined)
    same('tag 解析：非字符串', specTag(null), undefined)

    // 磁盘比最新旧：该装。
    same('版本旧 → 该装', checkInstallNeed({ latest: 'v1.3.0', disk: '1.2.0', running: '1.2.0', spec: 'github:o/r#v1.3.0', installed: 'github:o/r#v1.2.0' }), null)
    // 最新标签解析不出来：不判，交给下游。
    same('latest 非法 → 不判', checkInstallNeed({ latest: 'nightly', disk: '1.2.0' }), null)
    // 磁盘与运行都是最新：什么都不用做。
    const current = checkInstallNeed({ latest: 'v1.3.0', disk: '1.3.0', running: '1.3.0' })
    same('都最新 → already-current', current?.outcome, 'already-current')
    check('都最新时 ok=true', current?.ok === true, JSON.stringify(current))
    // 磁盘新、进程旧：别人装好了没重启。
    const restart = checkInstallNeed({ latest: 'v1.3.0', disk: '1.3.0', running: '1.2.0' })
    same('磁盘新进程旧 → restart-required', restart?.outcome, 'restart-required')
    check('点出进程里还在跑哪个版本', restart?.text.includes('1.2.0'), String(restart?.text))
    check('说清要重启', /restart/i.test(String(restart?.text)), String(restart?.text))
    check('这时 ok 仍是 true（没坏，只是要重启）', restart?.ok === true, JSON.stringify(restart))
    same('运行版本未知也能判', checkInstallNeed({ latest: 'v1.3.0', disk: '1.3.0' })?.outcome, 'restart-required')
    // profile 已指向该 tag，而包内版本没变：发布本身坏了。
    const broken = checkInstallNeed({ latest: 'v1.3.0', disk: '1.2.0', running: '1.2.0', spec: 'github:o/r#v1.3.0', installed: 'github:o/r#v1.3.0' })
    same('tag 与版本号对不上 → broken-release', broken?.outcome, 'broken-release')
    check('broken-release 时 ok=false', broken?.ok === false, JSON.stringify(broken))
    check('指出是发了 tag 但没升版本', /not bumped|package\.json/.test(String(broken?.text)), String(broken?.text))
    // profile 记录的规格与要装的不同：说明还没装过，照装不误。
    same('profile 记录别的规格 → 该装', checkInstallNeed({ latest: 'v1.3.0', disk: '1.2.0', spec: 'github:o/r#v1.3.0', installed: 'github:o/r#v1.2.0' }), null)
    // 读不到包内版本时不做「发布坏了」的判断：那是本插件的问题，不是发布的问题。
    same('包内版本读不到 → 不判坏发布', checkInstallNeed({ latest: 'v1.3.0', disk: undefined, spec: 'github:o/r#v1.3.0', installed: 'github:o/r#v1.3.0' }), null)

    // 真读一份 profile：依赖表里拿得到、读不到时安静返回 undefined。
    const profileDir = join(sandbox, 'profile')
    mkdirSync(profileDir, { recursive: true })
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'other-plugin': '^1.0.0', 'dsh-pwsh-plugin': 'github:o/r#v1.4.0' } }))
    same('读到 profile 记的规格', readInstalledSpec(profileDir, 'dsh-pwsh-plugin'), 'github:o/r#v1.4.0')
    same('没这条依赖时返回 undefined', readInstalledSpec(profileDir, 'absent-plugin'), undefined)
    same('profile 目录不存在时返回 undefined', readInstalledSpec(join(sandbox, 'no-such-profile'), 'dsh-pwsh-plugin'), undefined)
    same('profile 目录缺席时返回 undefined', readInstalledSpec(undefined, 'dsh-pwsh-plugin'), undefined)
    writeFileSync(join(profileDir, 'package.json'), 'not json')
    same('package.json 坏了也不抛', readInstalledSpec(profileDir, 'dsh-pwsh-plugin'), undefined)

    // preflightInstall 把 ctx 与 checker 接起来：profile 指向该 tag 且版本没变 → 拦下来。
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pwsh-plugin': 'github:o/r#v1.3.0' } }))
    const fakeCtx = { get: (name) => (name === 'profileContext' ? { dir: profileDir } : undefined) }
    const fakeChecker = { version: '1.2.0' }
    // 本包磁盘版本是测试自己的版本，与 v1.3.0 无关，所以这里撞的是 broken-release 分支。
    same('preflight 接上 ctx 与 checker', preflightInstall(fakeCtx, fakeChecker, 'github:o/r#v1.3.0')?.outcome, 'broken-release')
    // profile 指向别的 tag 时放行。
    writeFileSync(join(profileDir, 'package.json'), JSON.stringify({ dependencies: { 'dsh-pwsh-plugin': 'github:o/r#v1.0.0' } }))
    same('profile 指向别的 tag → 放行', preflightInstall(fakeCtx, fakeChecker, 'github:o/r#v1.3.0'), null)
  }
} finally {
  cleanup()
}

console.log('\n' + '='.repeat(56))
console.log('TOTAL  pass=' + pass + '  fail=' + fail)
if (fail > 0) {
  console.log('\n失败项：')
  for (const problem of problems) console.log('  - ' + problem)
}
process.exit(fail === 0 ? 0 : 1)
