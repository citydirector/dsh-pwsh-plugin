#!/usr/bin/env node
/**
 * 更新检查的单元测试 —— 纯 node，不需要 DSH。
 *
 * 发布源用**本地 git 仓库**预演（DSH_PWSH_UPDATE_SOURCE 的 git+file:// 形态），
 * 所以这套测试既能在没有网络时跑，也能真正走一遍「读标签 → 比版本 → 下结论」。
 */

import { execFileSync } from 'node:child_process'
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
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
console.log('\n[7] packageVersion')
const version = packageVersion()
check('读到 0.1.0', version === '0.1.0', String(version))

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
