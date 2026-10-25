/**
 * 无感自动更新：由插件自己把新版本装上，并让它就地生效。
 *
 * 为什么不能直接调 installBundle
 *   插件的 apply 与它起的定时器都跑在 HMR 的事务上下文里（AsyncLocalStorage）。
 *   在那个上下文里调 installBundle，pnpm 会跑完、磁盘也会换成目标版本，但随后的
 *   热重组会被 runExclusive 的嵌套检查拒掉（HMR transactions cannot be nested），
 *   留下「磁盘新版、进程旧版」这种最难看清的状态（实测）。先 executing.run(undefined, …)
 *   把上下文清空再调，HMR 才会真的重组合，并顺手把本插件自己替换掉
 *   （实测：改完文件后 137ms 新代码就生效，无需重启）。
 *
 * 为什么没有 HMR 就完全不装
 *   没有 HMR 的宿主上，装完磁盘是新的、进程里仍是旧的，而 bundle 行给不出新的 module URL，
 *   重启之前一直是「装上了但没生效」。这种自动毫无意义，反而让 pwsh_run_update 报出一个
 *   与真正在跑的代码不符的版本。此时退回只提示，由人决定何时升级、何时重启。
 *
 * 为什么不自己下载覆盖文件
 *   见 update-apply.mjs 的头注释：本插件是 profile 的 bundle 依赖，版本钉在
 *   package.json 与 pnpm-lock.yaml 里，绕开包管理器改文件会立刻让 lockfile 与磁盘不一致。
 *
 * 为什么必须等到「安静」才装
 *   热替换会执行本插件的 effect 清理函数，那里要 dispose 掉所有常驻 pwsh 会话。
 *   若此刻正有一条调用在跑，它会连带被掐断——脚本跑到一半、半截输出、会话状态全丢，
 *   与直接断电没有区别。所以安装前要问宿主「现在安静吗」，忙就整个推迟，
 *   而不是装完再说「可惜刚才那条被打断了」。
 */

import { installRelease } from './update-apply.mjs'

/** 首次检查前的等待：让启动流程先跑完，别跟它抢 pnpm。 */
const FIRST_DELAY_MS = 90 * 1000
/** 一轮正常节奏：与 UpdateChecker 的定时一致，失败时按下面的退避重排。 */
const INTERVAL_MS = 12 * 60 * 60 * 1000
const RETRY_BASE_MS = 5 * 60 * 1000
const RETRY_MAX_MS = 2 * 60 * 60 * 1000
/** 查出有新版但有调用正跑着：过一会儿再看一眼，别等到下一轮 12 小时。 */
const BUSY_RETRY_MS = 3 * 60 * 1000

/**
 * 在 HMR 事务之外装一个发布。
 *
 * @param ctx - 插件上下文，用来取 pluginManager 与 hmr。
 * @param spec - 钉住 tag 的安装规格，例如 github:owner/repo#v1.2.3。
 * @param options - { requestId, log }。
 * @returns 与 installRelease 相同的结果对象，永不抛出。
 */
export async function installReleaseLive(ctx, spec, options = {}) {
  const manager = ctx?.get?.('pluginManager')
  const hmr = ctx?.get?.('hmr')
  if (hmr === undefined || typeof hmr?.executing?.run !== 'function') {
    return await installRelease(manager, spec, { ...options, live: false })
  }
  // 上下文清空后 installBundle 自己会拿 runExclusive；装完 HMR 重组合，
  // 本插件的模块被驱逐、新模块 import 进来重新 apply。
  return await hmr.executing.run(undefined, () => installRelease(manager, spec, { ...options, live: true }))
}

/**
 * 宿主能不能就地换掉已加载的模块。判断与 installReleaseLive 用同一组条件，
 * 两处必须一致，否则会出现「循环以为装得上、安装却退回非 live」的错配。
 *
 * @param ctx - 插件上下文。
 * @returns 有可用的 HMR 服务时为 true。
 */
function hmrIsLive(ctx) {
  const hmr = ctx?.get?.('hmr')
  return hmr !== undefined && typeof hmr?.executing?.run === 'function'
}

/**
 * 起一个自动更新循环：查到新版本就装上，失败按指数退避重试。
 *
 * @param ctx - 插件上下文。
 * @param checker - UpdateChecker 实例；它的 check() 重入安全，直接复用。
 * @param options - { log, firstDelayMs, intervalMs, retryBaseMs, retryMaxMs }。
 * @returns 停止函数；插件被卸载或热替换时由调用方停掉。
 */
export function startAutoUpdate(ctx, checker, options = {}) {
  const log = options.log ?? (() => undefined)
  const firstDelayMs = options.firstDelayMs ?? FIRST_DELAY_MS
  const intervalMs = options.intervalMs ?? INTERVAL_MS
  const retryBaseMs = options.retryBaseMs ?? RETRY_BASE_MS
  const retryMaxMs = options.retryMaxMs ?? RETRY_MAX_MS

  const installGate = options.installGate
  const busyRetryMs = options.busyRetryMs ?? BUSY_RETRY_MS

  /** 已经自动装过的版本：同一个版本装成功过就不再装第二次。 */
  const attempted = new Set()
  let timer
  let stopped = false
  let running = false
  let failures = 0
  /** 「忙，先不装」只记一次日志：每几分钟重复一行会把日志刷满。 */
  let busyNoted = false

  const schedule = (delayMs) => {
    if (stopped) return
    timer = setTimeout(tick, delayMs)
    if (typeof timer.unref === 'function') timer.unref()
  }

  const tick = async () => {
    if (stopped || running) return
    running = true
    let next = intervalMs
    try {
      const state = await checker.check()
      if (state.state === 'available' && hmrIsLive(ctx) !== true) {
        // 装上也换不掉正在跑的模块：留着提示那条路，别制造「装了但没生效」。
        log('auto update: ' + state.latest + ' is available, but this host runs no HMR — leaving it for a manual upgrade')
        failures = 0
      } else if (state.state === 'available' && !attempted.has(state.latest) && installGate?.tryAcquire() !== false) {
        try {
          const doc = checker.document()
          const spec = doc.spec
          if (typeof spec === 'string' && spec.length > 0) {
            busyNoted = false
            attempted.add(state.latest)
            log('auto update: installing ' + state.latest + ' from ' + spec)
            const outcome = await installReleaseLive(ctx, spec, { requestId: 'pwsh-run-auto-update', log })
            log('auto update: ' + outcome.outcome + ' — ' + outcome.text)
            if (outcome.ok !== true) {
              // 装失败要能重来：把记录撤掉，交给退避后的下一轮。
              attempted.delete(state.latest)
              failures += 1
              next = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1))
            } else {
              failures = 0
            }
          }
        } finally {
          // 安装可能把本插件本身驱逐掉，于是这个 release 落在旧实例的闭包上，
          // 只是把旧变量置回 false——新实例有它自己的闸门。
          installGate?.release()
        }
      } else if (state.state === 'available' && !attempted.has(state.latest)) {
        // 有新版，但此刻有调用在跑：热替换会掐断它。整轮推迟，几分钟后再看。
        if (!busyNoted) {
          busyNoted = true
          log('auto update: ' + state.latest + ' is available, but a call is running — postponing the install until the session is idle')
        }
        next = busyRetryMs
      } else if (state.state === 'failed') {
        failures += 1
        next = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1))
      } else {
        failures = 0
      }
    } catch (error) {
      // check() 本身不抛；这里兜的是 installReleaseLive 之外的意外。
      failures += 1
      next = Math.min(retryMaxMs, retryBaseMs * 2 ** (failures - 1))
      log('auto update: unexpected failure — ' + String(error?.message ?? error))
    } finally {
      running = false
      schedule(next)
    }
  }

  schedule(firstDelayMs)
  return () => {
    stopped = true
    clearTimeout(timer)
  }
}
