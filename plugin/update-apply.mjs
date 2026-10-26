/**
 * 把「查到新版本」变成「装上新版本」——走 DSH 自己的 pluginManager，不自己下载覆盖文件。
 *
 * 为什么不学 our-free-model 自带下载器
 *   那个插件是独立包，安装目录里就是自己那几十个文件，所以它能做「清单签名 + 逐文件 sha256 +
 *   备份 + 原地替换 + 热重载回滚」这一整套事务。本插件是 profile 里的一个 bundle 依赖：
 *   文件躺在 node_modules/dsh-pwsh-plugin，版本钉在 profile 的 package.json 与 pnpm-lock.yaml 里。
 *   绕开包管理器去改这些文件，会立刻让 lockfile 与磁盘不一致，下一次 dsh plugin add/remove 就会
 *   踩到脏状态。所以安装这一步交给 dsh-plugin-manager（Plugins 页面用的同一个服务），
 *   它自己跑 pnpm、自己回滚 package.json / lockfile。
 *
 * 能不能不重启
 *   bundle 行的 name 是包名，拿不到 URL 上的缓存破坏参数，ESM 按 URL 缓存模块 —— 光重新 apply
 *   只是再 import 同一个 URL。但 installBundle 走 HMR 的 runExclusive，重组合会比对文件指纹
 *   （inode:size:mtime），把变了的模块驱逐、重新 import，所以**在 HMR 在场的宿主上是真换掉了**，
 *   实测 137ms 生效。前提是调用点在 HMR 事务之外，否则嵌套会被拒（见 auto-update.mjs）。
 *   没有 HMR 的宿主上 application 才是 'restart-required'，这里照实转述。
 */

import { readFileSync } from 'node:fs'
import { join } from 'node:path'

import { packageVersion } from './update-check.mjs'

/** 本包的包名：profile 的 dependencies 用它记录安装规格。 */
const OWN_NAME = (() => {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8'))
    return typeof pkg.name === 'string' && pkg.name.length > 0 ? pkg.name : 'dsh-pwsh-plugin'
  } catch {
    return 'dsh-pwsh-plugin'
  }
})()

/** `v1.2.3` 与 `1.2.3` 是同一个版本；不是这个形态时返回 undefined。 */
function bareVersion(value) {
  const text = String(value ?? '').trim().replace(/^v/i, '')
  return /^\d+\.\d+\.\d+$/.test(text) ? text : undefined
}

/**
 * profile 里为本包记录的那条依赖值。
 *
 * @param profileDir - profile 目录，取自 ctx.get('profileContext').dir。
 * @param packageName - 要查的包名，默认本包。
 * @returns 记不下时（没有 package.json、没这条依赖、值不是字符串）返回 undefined。
 */
export function readInstalledSpec(profileDir, packageName = OWN_NAME) {
  if (typeof profileDir !== 'string' || profileDir.length === 0) return undefined
  try {
    const manifest = JSON.parse(readFileSync(join(profileDir, 'package.json'), 'utf8'))
    const value = manifest?.dependencies?.[packageName]
    return typeof value === 'string' && value.length > 0 ? value.trim() : undefined
  } catch {
    return undefined
  }
}

/**
 * 装之前的预检：这次安装有没有意义。
 *
 * 为什么要有它
 *   dsh-plugin-manager 在 HMR 在场的宿主上，对「规格与 profile 里已记录的完全相同」的安装会在
 *   pnpm 之前直接抛 already-installed。有两种情形会撞上，而它们都不该真去装一次：
 *     1. 别人（终端 dsh plugin add、Plugins 页面）已经装好了，只是进程还没重启；
 *     2. 发版时打了 tag 却忘了改 package.json 的 version —— 装的永远是同一个包内版本，
 *        于是每一轮都「有新版、装不进去」，静默循环到天荒地老。
 *   两种都能用手里已有的事实判掉：profile 记的规格、磁盘上的包版本、进程里在跑的版本。
 *   判掉之后要能说清是哪一种 —— 一个要重启，另一个是发布本身有毛病。
 *
 * @param options - `{ spec, latest, disk, running, installed }`。
 *   `disk` 缺省时现读本包 package.json；`running` 缺省时不比对运行版本。
 * @returns 该装时返回 null；否则返回 `{ ok, outcome, text }`——三种情形成因不同，都不该重试。
 */
export function checkInstallNeed(options = {}) {
  const latest = bareVersion(options.latest)
  if (latest === undefined) return null
  // 「没传 disk」和「传了但读不到」必须分开：前者现读本包，后者说明本包的版本号有问题，
  // 那时不该拿它去判别人的发布坏了。
  const disk = bareVersion(Object.hasOwn(options, 'disk') ? options.disk : packageVersion())
  const running = bareVersion(options.running)
  const spec = typeof options.spec === 'string' ? options.spec.trim() : undefined
  const installed = typeof options.installed === 'string' ? options.installed.trim() : undefined

  if (disk === latest) {
    // 磁盘上已经是这个版本了，再装一次要么被拒，要么装个同样的东西。
    if (running === latest) {
      return {
        ok: true,
        outcome: 'already-current',
        text: 'v' + latest + ' is already installed and already running in this process — nothing to do.',
      }
    }
    return {
      ok: true,
      outcome: 'restart-required',
      text: 'v' + latest + ' is already on disk, but this process still runs '
        + (running === undefined ? 'the previous version' : 'v' + running)
        + '. Restart DSH to load it; installing again would only be refused as already-installed.',
    }
  }

  // 读不到包内版本时不做这个判断：那是「本插件自己的 package.json 有问题」，不是发布的问题，
  // 按未知处理比按坏发布处理安全。
  if (disk !== undefined && spec !== undefined && spec.length > 0 && installed === spec) {
    // profile 已经指向这个 tag，而磁盘上的包仍报别的版本：tag 与 package.json 对不上。
    return {
      ok: false,
      outcome: 'broken-release',
      text: 'The release tagged v' + latest + ' still declares version ' + disk
        + ' in its package.json, and the profile already points at that tag. Every install attempt would be '
        + 'refused as already-installed and could never change anything. This release is broken: the tag '
        + 'exists but package.json was not bumped.',
    }
  }

  return null
}

/** 安装规格末尾钉的 tag：`github:owner/repo#v1.2.3` → `v1.2.3`。 */
export function specTag(spec) {
  const text = typeof spec === 'string' ? spec.trim() : ''
  const hash = text.lastIndexOf('#')
  return hash === -1 ? undefined : text.slice(hash + 1)
}

/**
 * 从插件上下文里凑齐预检要的事实。
 *
 * @param ctx - 插件上下文；profileContext 缺席时读不到已装规格（预检只剩版本比对）。
 * @param checker - UpdateChecker 实例，用来取进程里在跑的版本。
 * @param spec - 要装的规格，末尾钉着 tag。
 * @returns checkInstallNeed 的结果：null 表示该装。
 */
export function preflightInstall(ctx, checker, spec) {
  const profileDir = ctx?.get?.('profileContext')?.dir
  return checkInstallNeed({
    spec,
    latest: specTag(spec),
    running: checker?.version,
    installed: readInstalledSpec(profileDir),
  })
}

/** 安装后要把 application 这个枚举翻译成一句能照做的话。 */
export function describeInstallOutcome(result, options = {}) {
  const application = typeof result?.application === 'string' ? result.application : 'unknown'
  const error = result?.error
  if (application === 'failed' || application === 'cancelled') {
    const code = typeof error?.code === 'string' ? error.code : 'operation-error'
    // 预检（checkInstallNeed）已经拦掉正常的 already-installed，走到这里说明 profile 目录读不到、
    // 或者中途被别处抢先装了。这不是故障，说清楚「已经在了」比报一串 operation-error 有用。
    if (code === 'already-installed') {
      return {
        ok: true,
        text: 'This release is already installed in the profile, so there was nothing to install. '
          + 'If the running process still shows an older version, restart DSH to load what is already on disk.',
      }
    }
    const diagnostic = typeof error?.diagnostic === 'string' && error.diagnostic.length > 0 ? ': ' + error.diagnostic : ''
    return {
      ok: false,
      text: 'pwsh_run could not install the release (' + code + diagnostic + '). '
        + 'Nothing was changed in the profile if pnpm failed before the swap; '
        + 'run the same command from a terminal to see the full output: ',
    }
  }
  // HMR 在场且安装是在它的事务之外发起时，application 仍是 'applied'，但这次是**真的**换掉了：
  // HMR 重组合会驱逐本插件的模块、重新 import 并重新 apply（实测改文件后 137ms 生效）。
  if (options?.live === true && application === 'applied') {
    return {
      ok: true,
      text: 'The release is installed and the new code is already running (application: applied, '
        + 'HMR replaced the plugin in place — no restart needed).',
    }
  }
  // 没有 HMR，或安装是在 HMR 事务里发起的：磁盘是新版，进程里仍是旧模块。bundle 行给不出
  // 新的 module URL，ESM 按 URL 缓存，重新 apply 也只是再 import 同一个 URL（实测过）。
  return {
    ok: true,
    text: 'The release is installed on disk (application: ' + application + '). Restart DSH to load it: a bundle row '
      + 'names the package, so the module URL does not change and the running process keeps the old code until a restart.',
  }
}

/**
 * 装一个钉住 tag 的规格。
 *
 * @param manager - ctx.get('pluginManager')；缺席时传 null。
 * @param spec - 例如 `github:owner/repo#v1.2.3`。
 * @param options - `{ requestId, signal, log }`。
 * @returns `{ ok, outcome, text, error }`，永不抛出：安装失败是正常结果，不是程序缺陷。
 */
export async function installRelease(manager, spec, options = {}) {
  if (manager === null || manager === undefined) {
    return {
      ok: false,
      outcome: 'no-manager',
      text: 'This profile does not expose ctx.pluginManager, so pwsh_run cannot install the release itself.',
    }
  }
  if (typeof manager.installBundle !== 'function') {
    return { ok: false, outcome: 'no-manager', text: 'ctx.pluginManager does not offer installBundle in this DSH build.' }
  }
  try {
    const result = await manager.installBundle(spec, options.requestId === undefined ? {} : { requestId: options.requestId })
    const described = describeInstallOutcome(result, { live: options.live === true })
    return {
      ok: described.ok,
      outcome: typeof result?.application === 'string' ? result.application : 'unknown',
      text: described.text,
      ...(result?.error === undefined ? {} : { error: result.error }),
    }
  } catch (error) {
    // change() 只在拿不到 profile 锁或服务正在销毁时 reject；两种都值得原样带出去。
    return { ok: false, outcome: 'threw', text: 'pwsh_run could not install the release: ' + String(error?.message ?? error) }
  }
}
