/** 常驻 pwsh 的协议、串行调用及有界输出收集。 */
import { gzipSync } from 'node:zlib'
import { StringDecoder } from 'node:string_decoder'

export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024
export const DIAGNOSTIC_BYTES = 64 * 1024
export const RESPONSE_GRACE_MS = 5000
// Node 定时器采用有符号 32 位毫秒，执行预算还需给收尾留下余量。
export const MAX_TIMEOUT_MS = 2147483647 - RESPONSE_GRACE_MS
const MAX_FRAME_CHARS = 32768
export const encodeScript = (text) => Buffer.from(text, 'utf8').toString('base64')

export function validateTimeout(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_TIMEOUT_MS) {
    throw new Error('pwsh_run timeoutMs must be an integer between 1 and ' + MAX_TIMEOUT_MS)
  }
  return value
}

export function bootArgv(serverSource) {
  // 压缩启动源码：服务端功能增长不能再撞 Windows 的 32K 命令行上限。
  const payload = gzipSync(Buffer.from(serverSource, 'utf8')).toString('base64')
  const boot = "$m=[IO.MemoryStream]::new([Convert]::FromBase64String('" + payload + "'));"
    + "$g=[IO.Compression.GZipStream]::new($m,[IO.Compression.CompressionMode]::Decompress);"
    + "$r=[IO.StreamReader]::new($g,[Text.Encoding]::UTF8);"
    + "try { & ([ScriptBlock]::Create($r.ReadToEnd())) } finally { $r.Dispose(); $m.Dispose() }"
  const encoded = Buffer.from(boot, 'utf16le').toString('base64')
  if (encoded.length > 30000) throw new Error('pwsh_run compressed bootstrap exceeds the Windows command-line budget')
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', encoded]
}

const cancelled = () => new Error('pwsh_run cancelled before execution')
export function abortable(promise, signal, shouldAbort = () => true) {
  if (signal === undefined) return promise
  if (signal.aborted) return Promise.reject(cancelled())
  return new Promise((resolve, reject) => {
    const abort = () => { if (shouldAbort()) reject(cancelled()) }
    signal.addEventListener('abort', abort, { once: true })
    promise.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort))
  })
}

function clipUtf8(text, limit) {
  const bytes = Buffer.from(text, 'utf8')
  if (bytes.length <= limit) return text
  return new StringDecoder('utf8').write(bytes.subarray(0, Math.max(0, limit)))
}

export class PwshSession {
  constructor(handle, label, maxOutputBytes = DEFAULT_MAX_OUTPUT_BYTES) {
    this.handle = handle
    this.label = label
    this.maxOutputBytes = maxOutputBytes
    this.buffer = ''
    this.pending = new Map()
    this.activeId = null
    this.sequence = 0
    this.dead = false
    this.deathReason = null
    this.queue = Promise.resolve()
    this.lastUsed = Date.now()
    this.stderrTail = ''
    this.startupWarnings = []
    handle.stdin?.on?.('error', (error) => this.#fail('stdin error: ' + String(error)))
    handle.stdout?.setEncoding?.('utf8')
    handle.stdout?.on('data', (chunk) => this.#onData(chunk))
    handle.stdout?.on('error', (error) => this.#fail('stdout error: ' + String(error)))
    handle.stderr?.setEncoding?.('utf8')
    handle.stderr?.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000) })
    handle.stderr?.on('error', (error) => { this.stderrTail = (this.stderrTail + String(error)).slice(-2000) })
    handle.done?.then(
      (outcome) => this.#fail('session died code=' + String(outcome?.exitCode ?? 'null')),
      (error) => this.#fail('session died: ' + String(error)),
    )
  }

  #onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) {
        if (this.buffer.length > MAX_FRAME_CHARS) {
          this.#fail('pwsh protocol frame exceeded its size limit')
          void this.dispose()
        }
        return
      }
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      if (line.length > MAX_FRAME_CHARS) {
        this.#fail('pwsh protocol frame exceeded its size limit')
        void this.dispose()
        return
      }
      this.#onLine(line)
    }
  }

  #onLine(line) {
    if (line === '<<<BYE>>>') { this.#fail('session said BYE'); return }
    const marker = line.match(/^<<<([BTE]):([^>:]+)(?::([01]))?>>>$/)
    if (marker !== null) {
      const [, kind, id] = marker
      if (kind === 'B') { this.activeId = id; return }
      const entry = this.pending.get(id)
      if (entry === undefined) return
      if (kind === 'T') { entry.response.timedOut = marker[3] === '1'; return }
      this.activeId = null
      this.pending.delete(id)
      entry.resolve(entry.response)
      return
    }
    const entry = this.pending.get(this.activeId)
    if (entry === undefined) return
    if (line === 'L:') { entry.response.truncated = true; return }
    const part = line.match(/^([OEWVXFSID])(\+?):(.*)$/)
    if (part === null) return
    let text = Buffer.from(part[3], 'base64').toString('utf8')
    const kind = part[1]
    if (kind === 'S') { entry.response.sentinel = text; return }
    const diagnostic = 'EXF'.includes(kind)
    const counter = diagnostic ? 'diagnosticBytes' : 'bytes'
    const records = diagnostic ? 'diagnosticRecords' : 'records'
    const newRecord = entry.continuing !== kind
    const separator = newRecord && entry.response[records] > 0 ? 1 : 0
    const remaining = (diagnostic ? DIAGNOSTIC_BYTES : this.maxOutputBytes) - entry.response[counter] - separator
    if (remaining < 0) { entry.response.truncated = true; return }
    const kept = clipUtf8(text, remaining)
    if (kept !== text) entry.response.truncated = true
    text = kept
    if (text.length > 0 || part[3].length === 0) {
      entry.response[counter] += Buffer.byteLength(text, 'utf8') + separator
      if (newRecord) entry.response[records]++
    }
    const field = { O: 'out', E: 'err', W: 'warn', V: 'verbose', X: 'exceptions', F: 'fatal', I: 'information', D: 'debug' }[kind]
    const items = entry.response[field]
    if (text.length > 0 || part[3].length === 0) {
      if (entry.continuing === kind && items.length > 0) items[items.length - 1] += text
      else items.push(text)
    }
    entry.continuing = part[2] === '+' ? kind : null
  }

  #fail(reason) {
    if (!this.dead) { this.dead = true; this.deathReason = reason }
    for (const entry of this.pending.values()) entry.reject(new Error(this.deathReason ?? reason))
    this.pending.clear()
    this.activeId = null
  }

  dispose(reason = 'pwsh session disposed') {
    this.#fail(reason)
    this.disposal ??= (async () => {
      try { this.handle.terminate() } catch { /* 已退出的进程不需要再次终止。 */ }
      const abort = new AbortController()
      const timer = setTimeout(() => abort.abort(), 3000)
      try { await this.handle.waitForExit?.(abort.signal) } catch { /* 等待范围已终止或不可观察。 */ }
      finally { clearTimeout(timer) }
    })()
    return this.disposal
  }

  run(script, timeoutMs, options = {}) {
    validateTimeout(timeoutMs)
    if (options.signal?.aborted) return Promise.reject(cancelled())
    let started = false
    const execute = () => { started = true; return this.#send(script, timeoutMs, options) }
    const result = this.queue.then(execute, execute)
    this.queue = result.then(() => undefined, () => undefined)
    return abortable(result, options.signal, () => !started)
  }

  #send(script, timeoutMs, options) {
    if (options.signal?.aborted) return Promise.reject(cancelled())
    if (this.dead) return Promise.reject(new Error(this.deathReason ?? 'session is dead'))
    if (!this.handle.stdin) return Promise.reject(new Error('session has no stdin pipe'))
    const id = 'c' + String(++this.sequence)
    this.lastUsed = Date.now()
    const response = { out: [], err: [], warn: this.startupWarnings.splice(0), verbose: [], information: [], debug: [], exceptions: [], fatal: [], sentinel: null, timedOut: false, bytes: 0, diagnosticBytes: 0, records: 0, diagnosticRecords: 0, truncated: false }
    return new Promise((resolve, reject) => {
      let timer
      const finish = (fn, value) => {
        clearTimeout(timer)
        options.signal?.removeEventListener('abort', onAbort)
        this.lastUsed = Date.now()
        fn(value)
      }
      const stop = (isCancellation) => {
        this.pending.delete(id)
        response.cancelled = isCancellation
        response.noResponse = !isCancellation
        finish(resolve, response)
        void this.dispose(isCancellation ? 'pwsh session cancelled' : 'pwsh session response timed out')
      }
      const onAbort = () => stop(true)
      this.pending.set(id, { response, resolve: (v) => finish(resolve, v), reject: (e) => finish(reject, e), continuing: null })
      // 只有实际发送后才开始计执行时间；排队取消不会杀前一条调用。
      timer = setTimeout(() => stop(false), timeoutMs + RESPONSE_GRACE_MS)
      options.signal?.addEventListener('abort', onAbort, { once: true })
      this.handle.stdin.write(id + ' ' + timeoutMs + ' ' + encodeScript(JSON.stringify({ script, workdir: options.workdir })) + ' ' + this.maxOutputBytes + '\n', (error) => {
        if (error) {
          const entry = this.pending.get(id)
          this.pending.delete(id)
          entry?.reject(new Error('write to pwsh session failed: ' + error))
        }
      })
    })
  }
}

export async function startSession(subprocess, options) {
  if (options.signal?.aborted) throw cancelled()
  const argv = options.argv ?? [options.executable, ...bootArgv(options.serverSource)]
  const handle = subprocess.spawn({ argv, cwd: options.cwd, stdio: { stdin: 'pipe', stdout: 'pipe', stderr: 'pipe' }, graceMs: 3000 })
  const session = new PwshSession(handle, options.label ?? 'pwsh', options.maxOutputBytes)
  let timer
  try {
    const probe = await Promise.race([
      abortable(session.run('$PSVersionTable.PSVersion.Major', 15000), options.signal),
      new Promise((_, reject) => { timer = setTimeout(() => reject(new Error('startup handshake timed out')), options.startupTimeoutMs ?? 20000) }),
    ])
    if (probe.sentinel !== 'ok' || session.dead) throw new Error('startup handshake failed: ' + [...probe.exceptions, ...probe.fatal].join('\n'))
    session.version = probe.out.join('\n').trim()
    session.startupWarnings.push(...probe.warn)
    return session
  } catch (error) {
    await session.dispose('pwsh session startup failed')
    const tail = session.stderrTail.trim()
    throw new Error('pwsh session failed to start: ' + (error?.message ?? error) + (tail ? '\n' + tail : ''))
  } finally { clearTimeout(timer) }
}