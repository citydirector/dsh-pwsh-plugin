const MODE_RANK = new Map([
  ['read-only', 0], ['workspace-write', 1], ['danger-full-access', 2],
])

const DENIAL = 'Ordinary native pwsh calls are disabled by config.enforcePwshRun. '
  + 'Use pwsh_run instead: pass the PowerShell command as script, and keep workdir and timeoutMs when supplied. For a fresh one-shot process use mode=isolated; it preserves any existing persistent state. Turn off enforcePwshRun in pwsh settings to permit ordinary native calls. '
  + 'The native command was not executed.'

/** 守卫在宿主执行前策略之后检查；不用可被后续监听器改回 allow 的瀑布钩子。 */
export function installNativePwshGuard(ctx, enabled, resolvePolicy) {
  const live = enabled !== null && typeof enabled === 'object' && typeof enabled.get === 'function'
  const readEnabled = () => {
    const value = live ? enabled.get() : enabled
    if (value !== undefined && typeof value !== 'boolean') {
      throw new Error('pwsh_run enforcePwshRun must be a boolean')
    }
    return value === true
  }
  const initial = readEnabled()
  if (!live && !initial) return
  if (typeof ctx.tools.guard !== 'function') {
    throw new Error('pwsh_run enforcePwshRun requires a DSH host with tools.guard(); '
      + 'upgrade DSH to use this routing configuration. No routing guard was installed.')
  }

  ctx.effect(() => ctx.tools.guard((exec) => {
    // Loader 原地更新 volatile 引用；读取它不会销毁正在使用的常驻进程。
    if (exec.name !== 'pwsh' || !readEnabled()) return undefined
    // 后台 job 的句柄与逐次审批由原生工具持有，常驻会话不能代接。
    const args = exec.arguments
    if (args?.run_in_background === true) return undefined
    const mode = resolvePolicy(exec.agent)?.mode
    if (mode === 'read-only') return undefined
    const requestedRank = MODE_RANK.get(args?.sandbox_permissions)
    const currentRank = MODE_RANK.get(mode)
    if (requestedRank !== undefined && currentRank !== undefined && requestedRank > currentRank
      && typeof args?.justification === 'string' && args.justification.trim().length > 0) {
      // 只放行真实的提权请求；是否批准仍由原生工具的审批机制决定。
      return undefined
    }
    return DENIAL
  }), 'pwsh-run.native-guard')
}
