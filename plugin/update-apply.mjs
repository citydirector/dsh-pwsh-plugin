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

/** 安装后要把 application 这个枚举翻译成一句能照做的话。 */
export function describeInstallOutcome(result, options = {}) {
  const application = typeof result?.application === 'string' ? result.application : 'unknown'
  const error = result?.error
  if (application === 'failed' || application === 'cancelled') {
    const code = typeof error?.code === 'string' ? error.code : 'operation-error'
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
