#!/usr/bin/env node
/**
 * 发版前复核：tag、提交、package.json 的 version 三者必须指向同一个版本。
 *
 * 为什么需要它
 *   版本号是 package.json 里唯一写死的东西，而更新检查是拿它跟发布标签比的。
 *   手工 `git tag v0.2.6` 却忘了改 version，后果不是「装不上」，而是**永远报有新版**：
 *   装完 v0.2.6，磁盘上读到的仍是 0.2.5，下一轮判决照样是 available，
 *   于是每轮都去装同一个版本、被 already-installed 拒掉、退避翻倍到上限，永远如此。
 *   实测过这条路径，不是猜测。
 *
 * 怎么用
 *   npm version patch -m 'chore(release): %s'   # 改 version + 提交 + 打 annotated tag
 *   node scripts/release-check.mjs              # 复核三者对齐
 *   git push origin main <tag>
 *
 * 退出码 0 = 可以发；1 = 有问题，原因打在 stderr 上。
 */

import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'

const fail = (message) => {
  console.error('release-check: ' + message)
  process.exit(1)
}

/** 跑一条 git 命令，失败时返回 undefined 而不是抛出 —— 大多数检查要容忍「没有 tag」。 */
const git = (...args) => {
  try {
    return execFileSync('git', args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim()
  } catch {
    return undefined
  }
}

const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
const version = pkg.version
if (typeof version !== 'string' || !/^\d+\.\d+\.\d+$/.test(version)) {
  fail('package.json 的 version 必须是三段版本号，当前是 ' + String(version))
}

const dirty = git('status', '--porcelain')
if (dirty === undefined) fail('当前目录不是 git 仓库')
if (dirty.length > 0) {
  fail('工作区不干净，先提交或 stash：\n' + dirty)
}

// --exact-match 只在 HEAD 正好落在某个 tag 上时给结果；否则是非零退出码，git() 返回 undefined。
const exact = git('describe', '--tags', '--exact-match')
const expected = 'v' + version

if (exact === undefined) {
  // expected 这个 tag 已经用掉了，而 HEAD 又在它之后：说明 tag 之后还有未发版的提交。
  // 这时候重打同名 tag 会把已发布的版本移到新提交上，下游拿到的「v0.2.5」就换了内容。
  if (git('rev-parse', '--verify', '--quiet', 'refs/tags/' + expected) !== undefined) {
    fail('tag ' + expected + ' 已经指向别的提交，而 HEAD 在它之后还有改动。'
      + '先升版本：npm version patch -m "chore(release): %s"')
  }
  // 还没有这个 tag：这正是「该打 tag 了」的状态，把该打的名字说出来。
  console.log('release-check: HEAD 还没有 tag —— 该打的是 ' + expected + '（package.json 是 ' + version + '）')
  console.log('release-check: git tag -a ' + expected + ' -m "' + expected + '"')
  process.exit(0)
}

if (exact !== expected) {
  fail('HEAD 上的 tag 是 ' + exact + '，但 package.json 的 version 对应 ' + expected
    + '。两者必须一致，否则更新检查会永远报有新版。')
}

const tagVersion = git('show', exact + ':package.json')
if (tagVersion === undefined) {
  fail('读不出 ' + exact + ' 那个提交里的 package.json')
}
const declared = JSON.parse(tagVersion).version
if (declared !== version) {
  fail(exact + ' 指向的提交里 version 是 ' + declared + '，与当前 ' + version + ' 不一致')
}

console.log('release-check: OK —— ' + exact + ' / 提交 ' + (git('rev-parse', '--short', 'HEAD') ?? '?')
  + ' / version ' + version + ' 三者对齐')
