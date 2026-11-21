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
    else if (block.type === 'tool-result') {
      // output 可能是 { type, value } 对象而不是数组；对象不能 for...of。
      const inner = block.content ?? block.output
      const list = Array.isArray(inner) ? inner : Array.isArray(inner?.value) ? inner.value : inner !== undefined ? [inner] : []
      for (const item of list) {
        if (item?.type === 'text' && typeof item.text === 'string') parts.push(item.text)
        else if (item?.type === 'text' && typeof item.value === 'string') parts.push(item.value)
      }
    }
  }
  return parts.join('\n')
}

function parseJson(text) {
  try { const value = JSON.parse(text); return plainObject(value) ? value : undefined } catch { return undefined }
}

// 状态会被宿主 structuredClone 后写进持久化投影缓存（契约要求是纯 JSON）。
// undefined、NaN、Infinity 不是 JSON：值为 undefined 的键直接去掉（等于清空该字段），
// 不是有限数的数字也去掉。只收字符串、有限数、布尔、null。
function jsonFields(fields) {
  const out = {}
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue
    if (typeof value === 'number' && !Number.isFinite(value)) continue
    if (value !== null && typeof value === 'object') continue
    if (typeof value === 'function' || typeof value === 'symbol' || typeof value === 'bigint') continue
    out[key] = value
  }
  return out
}

function setRow(state, id, patch, at) {
  const prev = state.rows[id] ?? { sessionId: id }
  const rows = { ...state.rows, [id]: jsonFields({ ...prev, ...patch, updatedAt: at ?? prev.updatedAt }) }
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

// 宿主在快照、恢复、推送里同步调用 apply；这里抛错会拖垮整条会话的投影读取
// （会话打不开、列表里退化）。投影只是给标签页看的，宁可漏一条也不能抛。
export function applyEvent(state, event) {
  try { return applyEventUnsafe(state, event) } catch { return state }
}

function applyEventUnsafe(state, event) {
  const normalized = asSessionEvent(event)
  const at = typeof normalized.time === 'number' ? normalized.time : typeof normalized.at === 'number' ? normalized.at : undefined
  if (normalized.type === 'tool/call') {
    const { name, callId, arguments: args } = normalized.data ?? {}
    if (!TOOLS.has(name) || typeof callId !== 'string') return state
    const parsed = typeof args === 'string' ? parseJson(args) : plainObject(args) ? args : undefined
    let next = { ...state, calls: { ...state.calls, [callId]: jsonFields({ name, sessionId: typeof parsed?.sessionId === 'string' ? parsed.sessionId : undefined, background: parsed?.background === true }) } }
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
    // 2：折叠开始认代码模式的 ptc-dispatch 事件。按宿主契约，语义变了就要换版本，
    // 否则持久化缓存里 v1 的空检查点会被继续采用，老会话恢复出来仍是空表。
    stateVersion: 2,
    init: () => initState(),
    apply: (state, event) => applyEvent(state, event),
    wire: { viewSchema, view },
  }
}

// 注册结果留一份可查的记录：投影没挂上时标签页只会空着，没有别的症状。
export const registration = { attempted: false, registered: false, error: null }

export function registerProjection(ctx, { onError } = {}) {
  registration.attempted = true
  // register() 本身随 ctx 的生命周期撤销，热替换不会留下重复注册。
  // 它返回的是可 await 的 dispose（thenable），解析值是 ProjectionHandle。
  // 同步抛错也收进 Promise，免得在 inject 回调里直接炸掉。
  const pending = Promise.resolve().then(() => ctx.sessionProjections.register(projectionDefinition()))
  return pending.then((handle) => {
    registration.registered = true
    registration.error = null
    return handle
  }, (error) => {
    registration.registered = false
    registration.error = String(error?.message ?? error)
    if (typeof onError === 'function') return onError(error)
    try { ctx.logger?.warn?.('ssh projection registration failed; the sessions tab will stay empty: ' + registration.error) } catch {}
    return undefined
  })
}

/**
 * 给 ctx.inject 用的回调。必须解析成 undefined：cordis 把插件体（inject 回调就是一个插件体）
 * 的返回值当 effect 收集，Promise 解析出的值只能是函数或空值。把 ProjectionHandle 这个对象
 * 交回去会抛 TypeError('Invalid effect')，子 fiber 进入失败态并被卸载，注册随之释放：
 * 宿主快照与推送里就再也没有 sshSessions，标签页一直是「还没有 SSH 会话」。
 */
export async function mountProjection(child) {
  await registerProjection(child)
}
