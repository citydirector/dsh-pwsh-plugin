// 这个文件是 `presets/shared/compaction-epoch.mjs` 的源：部署时复制进 DSH profile，
// 这里保留一份供 `wsl/custom-bash.mjs` import 与测试。**改这里，再同步到 profile。**
/**
 * compaction-epoch —— 感知压缩边界的「晋升」状态跟踪器（共享模块，不是插件行）
 *
 * 用途
 *   tool-bootstrap / instruction-hint / router-bootstrap 都需要回答同一个问题：
 *   「这个会话现在算不算已经晋升？」本模块给出唯一答案，三者共用，口径一致。
 *
 * 规则
 *   - 晋升信号 = 调用方指定的持久事件类型（`tool/call` 和/或 `assistant/message`）。
 *   - 压缩会把整段可见上下文重写成一条摘要，压缩后的第一次请求等同于「第二个首请求」，
 *     所以晋升按「纪元」计算：只有落在最近一次 `compaction/end` 之后的晋升信号才算数。
 *   - 从未压缩过时边界为 -1，行为与「一次性晋升」完全相同。
 *   - 子智能体（delegationDepth > 0）默认视为已晋升，首请求就能用工具；
 *     传 `includeSubagents: true` 可让子智能体也走锚定相位。
 *
 * 实现
 *   - 每个会话的状态按 session id 记忆；冷启动 / 恢复会话时扫描一次持久日志重建相位，
 *     之后靠 `observe()` 增量更新，O(1)。
 *   - 持久日志只能经 `session.snapshotEvents()` 读取。`Session` 上没有 `events`
 *     属性（0.1.3 起一直如此）；读不存在的属性曾让锚定相位悄悄失效（首请求带了 197 个工具）。
 */

/**
 * 创建一个跟踪器。
 * @param {string[]} promoteEvents 计为晋升信号的持久事件类型
 * @param {{ includeSubagents?: boolean }} [options]
 */
export function createEpochPromotion(promoteEvents, options = {}) {
  const includeSubagents = options.includeSubagents === true
  const promote = new Set(promoteEvents)
  /** session id -> { boundary, promoted } */
  const state = new Map()

  /** 从头扫描一次持久日志（冷启动 / 恢复会话）。 */
  const scan = (session) => {
    let boundary = -1
    let promoted = false
    const events = typeof session.snapshotEvents === 'function' ? session.snapshotEvents() : []
    for (const event of events) {
      // 没有 seq 的事件按「边界之后」处理。
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        boundary = seq
        promoted = false
        continue
      }
      if (promote.has(event.type) && seq > boundary) promoted = true
    }
    const entry = { boundary, promoted }
    state.set(session.id, entry)
    return entry
  }

  return {
    /**
     * 查询某个 agent 所在会话的当前相位。
     * @returns {{ boundary: number, promoted: boolean }}
     *   boundary：最近一次 compaction/end 的 seq（未压缩过为 -1）；
     *   promoted：边界之后是否已有晋升信号。
     *   没有 agent / session 时一律视为已晋升（宁可多给工具，也不卡死请求）。
     */
    status(agent) {
      if (agent === undefined) return { boundary: -1, promoted: true }
      const session = agent.session
      if (session === undefined) return { boundary: -1, promoted: true }
      if (!includeSubagents && (session.header?.delegationDepth ?? 0) > 0) return { boundary: -1, promoted: true }
      return state.get(session.id) ?? scan(session)
    },

    /** 增量喂入：在每个 `session/event` 上调用。尚未被查询过的会话直接忽略，等首次查询时再扫描。 */
    observe(session, event) {
      const entry = state.get(session.id)
      if (entry === undefined) return
      const seq = event.seq ?? 0
      if (event.type === 'compaction/end') {
        state.set(session.id, { boundary: seq, promoted: false })
        return
      }
      if (promote.has(event.type) && seq > entry.boundary && !entry.promoted) {
        state.set(session.id, { ...entry, promoted: true })
      }
    },
  }
}

/**
 * 读取 `user/message` 持久事件里的消息来源。
 * V4 会话格式把 source 放在 `event.data.source`；早期本地代码误读成
 * `event.data.message.source`，导致「是否已注入过」的去重永远判否。两种形状都兼容。
 */
export function eventSource(event) {
  return event?.data?.source ?? event?.data?.message?.source
}

/** 读取 `user/message` 持久事件里的消息 id（两种形状都兼容，理由同上）。 */
export function eventMessageId(event) {
  return event?.data?.id ?? event?.data?.message?.id
}

/**
 * 解析会话当前工作目录。
 * 上游已把工作目录交给 `workingDirectory` 服务管理（会话中途 cd 之后 header.cwd 不会更新），
 * 所以优先问服务；服务不存在（旧宿主）时退回 header.cwd，再退回进程 cwd。
 */
export async function resolveCwd(ctx, agent, signal) {
  try {
    const service = ctx.get('workingDirectory')
    if (service !== undefined && agent !== undefined) return await service.ensure(agent, signal)
  } catch {
    // 服务异常时退回旧路径，不让一次目录查询拖垮工具调用。
  }
  return agent?.session?.header?.cwd ?? process.cwd()
}
