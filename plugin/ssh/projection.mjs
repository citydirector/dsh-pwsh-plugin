// SSH 标签页的会话投影：完全由会话事件折叠出来（宿主投影没有直接推送接口）。
// 来源：ssh_* 的 tool/call 与 tool/result、代码模式下等价的 ptc-dispatch 事件（见 asSessionEvent），
// 以及本模块注入的 [ssh] 通知（user/message, source.kind = ssh）。
// 倒计时不进状态，客户端按 expiresAt / idleDeadline 自己算，免得每秒产生事件。

export const PROJECTION_KEY = 'sshSessions'
const TOOLS = new Set(['ssh_open', 'ssh_exec', 'ssh_read', 'ssh_kill', 'ssh_list'])
const MAX_ROWS = 64

// 宿主只要求有 parse()；不引入 zod。
const plainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
export const stateSchema = { parse(value) { if (!plainObject(value) || !plainObject(value.calls) || !plainObject(value.rows)) throw new Error('invalid ssh projection state'); return value } }
export const viewSchema = { parse(value) { if (!plainObject(value) || !Array.isArray(value.rows)) throw new Error('invalid ssh projection view'); return value } }

export const initState = () => ({ calls: {}, rows: {} })

function resultCallId(message) {
  if (message?.source?.kind === 'tool' && typeof message.source.callId === 'string') return message.source.callId
  return message?.content?.find?.((block) => block.type === 'tool-result' && typeof block.toolCallId === 'string')?.toolCallId
}

function resultText(message) {
  const blocks = message?.content ?? []
  const parts = []
  for (const block of blocks) {
    if (block.type === 'text') parts.push(block.text)
    else if (block.type === 'tool-result') for (const inner of block.content ?? block.output ?? []) if (inner?.type === 'text') parts.push(inner.text)
  }
  return parts.join('\n')
}

function parseJson(text) {
  try { const value = JSON.parse(text); return plainObject(value) ? value : undefined } catch { return undefined }
}

function setRow(state, id, patch, at) {
  const prev = state.rows[id] ?? { sessionId: id }
  const rows = { ...state.rows, [id]: { ...prev, ...patch, updatedAt: at ?? prev.updatedAt } }
  const ids = Object.keys(rows)
  if (ids.length > MAX_ROWS) {
    const dead = ids.filter((key) => rows[key].state === 'dead').slice(0, ids.length - MAX_ROWS)
    for (const key of dead) delete rows[key]
  }
  return { ...state, rows }
}

/** 纯函数：一条事件折进状态。不关心的事件原样返回同一引用。 */
/**
 * 代码模式（PTC）把 `run_code` 里的子调用记成另一对事件：`tool/ptc-dispatch-start`
 * 与 `tool/ptc-dispatch`。只认 `tool/call` / `tool/result` 的话，脚本里调的 ssh_*
 * 一条也进不来 —— 标签页会一直停在「本会话还没有 SSH 会话」。
 * 这里把两条事件改写成已有形状，折叠逻辑不必知道消息有两个来源。
 */
function asSessionEvent(event) {
  if (event.type === 'tool/ptc-dispatch-start') {
    const data = event.data ?? {}
    return { ...event, type: 'tool/call', data: { name: data.name, callId: data.subCallId, arguments: data.arguments } }
  }
  if (event.type === 'tool/ptc-dispatch') {
    const data = event.data ?? {}
    if (typeof data.subCallId !== 'string') return event
    const content = Array.isArray(data.content) ? data.content : []
    return { ...event, type: 'tool/result', data: { message: { source: { kind: 'tool', callId: data.subCallId }, isError: data.isError === true, content } } }
  }
  return event
}

export function applyEvent(state, event) {
  const normalized = asSessionEvent(event)
  const at = typeof normalized.time === 'number' ? normalized.time : typeof normalized.at === 'number' ? normalized.at : undefined
  if (normalized.type === 'tool/call') {
    const { name, callId, arguments: args } = normalized.data ?? {}
    if (!TOOLS.has(name) || typeof callId !== 'string') return state
    const parsed = typeof args === 'string' ? parseJson(args) : plainObject(args) ? args : undefined
    let next = { ...state, calls: { ...state.calls, [callId]: { name, sessionId: parsed?.sessionId, background: parsed?.background === true } } }
    if (name === 'ssh_exec' && typeof parsed?.sessionId === 'string' && next.rows[parsed.sessionId] !== undefined && next.rows[parsed.sessionId].state !== 'dead') {
      next = setRow(next, parsed.sessionId, { state: 'running', mode: parsed.background === true ? 'bg' : 'fg', lastActivity: at }, at)
    }
    return next
  }
  if (normalized.type === 'tool/result') {
    const message = normalized.data?.message
    const callId = resultCallId(message)
    const call = callId === undefined ? undefined : state.calls[callId]
    if (call === undefined) return state
    const calls = { ...state.calls }
    delete calls[callId]
    let next = { ...state, calls }
    const value = parseJson(resultText(message))
    const failed = message?.isError === true || value === undefined
    if (call.name === 'ssh_open' && !failed && typeof value.sessionId === 'string') {
      next = setRow(next, value.sessionId, { host: value.host, state: 'idle', cwd: value.cwd, shell: value.shell, os: value.os, expiresAt: value.expiresAt, idleMinutes: value.idleMinutes, openedAt: at, lastActivity: at, deadReason: undefined, mode: undefined }, at)
    } else if (call.name === 'ssh_exec' && typeof call.sessionId === 'string' && next.rows[call.sessionId] !== undefined) {
      const row = next.rows[call.sessionId]
      if (row.state !== 'dead') {
        if (!failed && typeof value.jobId === 'string' && value.exitCode === undefined) next = setRow(next, call.sessionId, { state: 'running', mode: 'bg', jobId: value.jobId, lastActivity: at }, at)
        else next = setRow(next, call.sessionId, { state: 'idle', mode: undefined, cwd: value?.cwd ?? row.cwd, lastActivity: at }, at)
      }
      if (failed && /session could not be recovered|has ended/.test(resultText(message))) next = setRow(next, call.sessionId, { state: 'dead', deadReason: 'killed' }, at)
    } else if (call.name === 'ssh_kill' && typeof call.sessionId === 'string' && !failed) {
      next = setRow(next, call.sessionId, { state: 'dead', deadReason: value.reason ?? 'killed', mode: undefined }, at)
    } else if (call.name === 'ssh_list' && !failed && Array.isArray(value.sessions)) {
      for (const s of value.sessions) {
        if (typeof s?.sessionId !== 'string') continue
        next = setRow(next, s.sessionId, { host: s.host, state: s.state, mode: s.mode, cwd: s.cwd, deadReason: s.deadReason, expiresAt: s.expiresAt, lastActivity: s.lastActivity }, at)
      }
    }
    return next
  }
  if (normalized.type === 'user/message' && normalized.data?.source?.kind === 'ssh') {
    const text = (normalized.data.content ?? []).filter((b) => b.type === 'text').map((b) => b.text).join('\n')
    let next = state
    for (const line of text.split('\n')) {
      const m = /^\[ssh\] (\S+) · (s\d+) (后台任务 (j\d+) 已结束|会话已结束：([^，。]+))/.exec(line)
      if (m === null || next.rows[m[2]] === undefined) continue
      if (m[4] !== undefined) next = setRow(next, m[2], { state: 'idle', mode: undefined, jobId: undefined, lastActivity: at }, at)
      else next = setRow(next, m[2], { state: 'dead', mode: undefined, deadReasonText: m[5] }, at)
    }
    return next
  }
  return state
}

// 宿主用 Object.is 比较前后两次 view 的返回值，相同就不发布；所以同一个 state 必须给出同一个对象。
// 缓存按 state 引用失效：applyEvent 只在不命中时复用引用，状态一变就是新对象，键自然换掉。
const viewCache = new WeakMap()
export function view(state) {
  const cached = viewCache.get(state)
  if (cached !== undefined) return cached
  const rows = Object.values(state.rows).sort((a, b) => Number(a.sessionId.slice(1)) - Number(b.sessionId.slice(1)))
  const value = { rows }
  viewCache.set(state, value)
  return value
}

export function projectionDefinition() {
  return {
    key: PROJECTION_KEY,
    stateSchema,
    stateVersion: 1,
    init: () => initState(),
    apply: (state, event) => applyEvent(state, event),
    wire: { viewSchema, view },
  }
}

// 注册是否成功必须可查：投影没挂上时标签页只会空着，没有别的症状可追。
export const registration = { attempted: false, registered: false, error: null, at: 0 }

export function registerProjection(ctx, { onError } = {}) {
  registration.attempted = true
  registration.at = Date.now()
  // 用 Promise.resolve().then 包一层：服务缺席时的同步抛错也会变成一次可记录的拒绝，
  // 而不是在 inject 回调里直接炸掉、连尝试记录都留不下。
  const pending = Promise.resolve().then(() => {
    if (ctx.sessionProjections === undefined) throw new Error('sessionProjections service is absent on the injected context')
    return ctx.sessionProjections.register(projectionDefinition())
  })
  return pending.then((handle) => {
    registration.registered = true
    registration.error = null
    return handle
  }, (error) => {
    registration.registered = false
    registration.error = String(error?.message ?? error)
    if (typeof onError === 'function') return onError(error)
    // 注册失败不会抛给调用方（见上），所以这里必须留下能查的痕迹：Tab 会一直空着。
    try { ctx.logger?.warn?.('ssh projection registration failed; the sessions tab will stay empty: ' + registration.error) } catch {}
    return undefined
  })
}
