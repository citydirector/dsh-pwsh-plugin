import { StringDecoder } from 'node:string_decoder'

export const FILE_SCAN_DEFAULTS = Object.freeze({
  fileScanMaxEntries: 250000,
  fileScanMaxBytes: 64 * 1024 * 1024,
  fileScanTimeoutMs: 120000,
  fileOperationTimeoutMs: 300000,
})
export const PLAN_TTL = 120000
export const PAGE_BYTES = 256 * 1024
export const MAX_FRAME_BYTES = 256 * 1024

export function fileScanLimits(config = {}) {
  const maxima = { fileScanMaxEntries: 2000000, fileScanMaxBytes: 512 * 1024 * 1024, fileScanTimeoutMs: 1800000, fileOperationTimeoutMs: 1800000 }
  return Object.fromEntries(Object.entries(FILE_SCAN_DEFAULTS).map(([name, fallback]) => {
    const value = config[name] ?? fallback
    if (!Number.isSafeInteger(value) || value < 1 || value > maxima[name]) throw Error(name + ' must be an integer between 1 and ' + maxima[name])
    return [name, value]
  }))
}

// 明细按完整帧接收；协议丢失或超预算不能变成一个貌似完整的计划。
export function inventoryStream({ onEntry = () => {}, onProgress = () => {} } = {}) {
  const decoder = new StringDecoder('utf8')
  let buffer = '', final, failure
  const line = text => {
    if (!text.trim()) return
    if (Buffer.byteLength(text) > MAX_FRAME_BYTES) throw Error('File worker frame exceeded its byte budget.')
    if (final) throw Error('Unexpected output after the file worker result.')
    const value = JSON.parse(text)
    if (value.type === 'entry') onEntry(value.entry, Buffer.byteLength(JSON.stringify(value.entry)))
    else if (value.type === 'progress') onProgress(value)
    else if (typeof value.ok === 'boolean') final = value
    else throw Error('Unknown file worker frame.')
  }
  const push = chunk => {
    if (failure) return
    try {
      buffer += typeof chunk === 'string' ? chunk : decoder.write(chunk)
      let end
      while ((end = buffer.indexOf('\n')) >= 0) {
        line(buffer.slice(0, end).replace(/\r$/, ''))
        buffer = buffer.slice(end + 1)
      }
      if (Buffer.byteLength(buffer) > MAX_FRAME_BYTES) throw Error('File worker frame exceeded its byte budget.')
    } catch (error) { failure = error; throw error }
  }
  return {
    push,
    finish() {
      if (failure) throw failure
      buffer += decoder.end()
      if (buffer.trim()) line(buffer)
      if (!final) throw Error('File worker output ended before a complete result; no executable plan was created.')
      return final
    },
  }
}

export function inventoryPage(entries, offset = 0, limit = 128) {
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > entries.length) throw Error('Inventory offset is outside the completed plan.')
  if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) throw Error('Inventory limit must be between 1 and 256.')
  const page = []
  let bytes = 1024
  for (let i = offset; i < entries.length && page.length < limit; i++) {
    const formatted = JSON.stringify(entries[i], null, 2)
    const size = Buffer.byteLength(formatted) + 4 * formatted.split(String.fromCharCode(10)).length + 8
    if (bytes + size > PAGE_BYTES) break
    page.push(entries[i]); bytes += size
  }
  if (!page.length && offset < entries.length) throw Error('One inventory entry exceeds the page byte budget.')
  const nextOffset = offset + page.length
  return { entries: page, offset, nextOffset: nextOffset < entries.length ? nextOffset : null, totalEntries: entries.length }
}

// 操作状态独立于一次工具返回；取消只中止当前工作进程，不假装回滚已完成的回收。
export class FileOperations {
  constructor() { this.jobs = new Map() }
  prune() {
    for (const [id, job] of this.jobs) if (job.status !== 'running' && job.expires <= Date.now()) this.jobs.delete(id)
  }
  start(id, owner, action, task) {
    this.prune()
    if ([...this.jobs.values()].filter(j => j.status === 'running').length >= 4) throw Error('Four file operations are already running; wait or cancel one.')
    if (this.jobs.size >= 256) throw Error('Too many retained file operations; wait for completed statuses to expire.')
    const controller = new AbortController()
    const job = { id, owner, action, controller, status: 'running', started: Date.now(), progress: { phase: 'starting', entries: 0, removed: [] } }
    this.jobs.set(id, job)
    job.done = Promise.resolve().then(() => task(job)).then(result => { job.result = result; job.status = 'completed' }, error => {
      job.error = error
      job.status = controller.signal.aborted ? 'cancelled' : 'failed'
    }).finally(() => { job.finished = Date.now(); job.expires = job.finished + 300000 })
    return job
  }
  async wait(job, waitMs = 10000) {
    if (!Number.isSafeInteger(waitMs) || waitMs < 0 || waitMs > 10000) throw Error('waitMs must be between 0 and 10000.')
    if (!waitMs || job.status !== 'running') return
    let timer
    try { await Promise.race([job.done, new Promise(resolve => { timer = setTimeout(resolve, waitMs) })]) }
    finally { clearTimeout(timer) }
  }
  view(job) {
    return { operationId: job.id, action: job.action, status: job.status, elapsedMs: (job.finished ?? Date.now()) - job.started, progress: { ...job.progress }, ...(job.result ? { result: job.result } : {}), ...(job.error ? { error: job.error.message, removed: job.error.removed ?? job.progress.removed ?? [], diagnostic: job.error.diagnostic, inspectRemaining: true } : {}) }
  }
  dispose() { for (const job of this.jobs.values()) if (job.status === 'running') job.controller.abort(Error('File tools unloaded.')) }
}
