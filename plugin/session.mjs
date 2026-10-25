/**
 * pwsh-run 会话客户端 —— 常驻 pwsh 进程的生命周期与协议编解码
 *
 * 本模块**不依赖 DSH**，只要求调用方给一个最小的 subprocess 接口：
 *   interface SubprocessLike {
 *     spawn(spec): { stdin, stdout, stderr, done, terminate(), waitForExit(signal?) }
 *   }
 * 这样既能挂在 ctx.subprocess 上，也能在纯 node 里做集成测试。
 */

const DEFAULT_GRACE_MS = 3000

/**
 * 单次调用的输出收集上限（每个流各自计）。
 * 常驻会话没有原生工具那种 collect 尾巴截断，几个 MB 的输出也照单全收——不设上限的话
 * 一段死循环打印就能把宿主进程的内存吃光。超限只丢弃后续内容并打标记，不打断脚本。
 */
export const DEFAULT_MAX_OUTPUT_BYTES = 8 * 1024 * 1024

/** 把脚本正文编码成协议负载。 */
export const encodeScript = (text) => Buffer.from(text, 'utf8').toString('base64')

/** 由 UTF-16LE 的 base64 生成 pwsh 启动参数（-EncodedCommand，避开 32K 命令行里的转义问题）。 */
export function bootArgv(serverSource) {
  return ['-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(serverSource, 'utf16le').toString('base64')]
}

/**
 * 一个常驻 pwsh 会话。
 *
 * 线程模型：服务端是单 runspace，调用必须串行；run() 内部用 Promise 链排队。
 * 生命周期：进程退出 / stdout 出错 / 服务端发 BYE 都算「会话死亡」，
 *          在途调用立刻失败，下一次 acquire 会重建。
 */
export class PwshSession {
  constructor(handle, label, maxOutputBytes) {
    this.handle = handle
    this.label = label
    this.maxOutputBytes = maxOutputBytes === undefined ? DEFAULT_MAX_OUTPUT_BYTES : maxOutputBytes
    this.buffer = ''
    this.pending = new Map()
    this.activeId = null
    this.sequence = 0
    this.dead = false
    this.deathReason = null
    this.queue = Promise.resolve()
    this.lastUsed = Date.now()
    this.stderrTail = ''

    const stdout = handle.stdout
    if (stdout !== undefined && stdout !== null) {
      if (typeof stdout.setEncoding === 'function') stdout.setEncoding('utf8')
      stdout.on('data', (chunk) => this.#onData(chunk))
      stdout.on('error', (error) => this.#fail('stdout error: ' + String(error)))
    }
    const stderr = handle.stderr
    if (stderr !== undefined && stderr !== null) {
      if (typeof stderr.setEncoding === 'function') stderr.setEncoding('utf8')
      stderr.on('data', (chunk) => { this.stderrTail = (this.stderrTail + chunk).slice(-2000) })
    }
    if (handle.done !== undefined) {
      handle.done.then(
        (outcome) => this.#fail('session died code=' + String(outcome === undefined ? 'null' : outcome.exitCode)),
        (error) => this.#fail('session died: ' + String(error)),
      )
    }
  }

  /** 追加收到的字节，按行切出协议消息。 */
  #onData(chunk) {
    this.buffer += chunk
    for (;;) {
      const index = this.buffer.indexOf('\n')
      if (index < 0) return
      const line = this.buffer.slice(0, index).replace(/\r$/, '')
      this.buffer = this.buffer.slice(index + 1)
      this.#onLine(line)
    }
  }

  #onLine(line) {
    if (line.length === 0) return
    if (line === '<<<BYE>>>') {
      this.#fail('session said BYE')
      return
    }
    const marker = line.match(/^<<<([BTE]):([^>:]+)(?::([01]))?>>>$/)
    if (marker !== null) {
      const kind = marker[1]
      const id = marker[2]
      if (kind === 'B') {
        this.activeId = id
        return
      }
      const entry = this.pending.get(id)
      if (entry === undefined) return
      if (kind === 'T') {
        if (marker[3] === '1') entry.response.timedOut = true
        return
      }
      // E：本次响应收齐
      this.activeId = null
      this.pending.delete(id)
      entry.resolve(entry.response)
      return
    }
    const part = line.match(/^([OEWVXFS]):(.*)$/)
    if (part === null) return
    const entry = this.activeId === null ? undefined : this.pending.get(this.activeId)
    if (entry === undefined) return
    const text = Buffer.from(part[2], 'base64').toString('utf8')
    // 哨兵必须无条件收：它决定「跑完 / 抛异常 / 被中断」，丢了会让上层误判。
    if (part[1] === 'S') {
      entry.response.sentinel = text
      return
    }
    if (entry.response.truncated) return
    entry.response.bytes += text.length
    if (entry.response.bytes > this.maxOutputBytes) {
      // 只标记一次；后续数据行直接丢弃，脚本本身不受影响。
      entry.response.truncated = true
      return
    }
    switch (part[1]) {
      case 'O': entry.response.out.push(text); break
      case 'E': entry.response.err.push(text); break
      case 'W': entry.response.warn.push(text); break
      case 'V': entry.response.verbose.push(text); break
      case 'X': entry.response.exceptions.push(text); break
      case 'F': entry.response.fatal.push(text); break
      default: break
    }
  }

  /** 会话不可再用：在途调用立刻失败。 */
  #fail(reason) {
    if (this.dead) return
    this.dead = true
    this.deathReason = reason
    for (const entry of this.pending.values()) entry.reject(new Error(reason))
    this.pending.clear()
    this.activeId = null
  }

  /** 杀掉进程并等待托管范围清空（Windows 上 Job Object 会连带回收子进程树）。 */
  async dispose() {
    this.dead = true
    try {
      this.handle.terminate()
    } catch {
      // terminate 幂等：进程已退出时忽略。
    }
    if (typeof this.handle.waitForExit === 'function') {
      try {
        await this.handle.waitForExit(AbortSignal.timeout(3000))
      } catch {
        // 托管范围无法观察时不再等待。
      }
    }
  }

  /** 跑一段脚本；同一会话内串行。 */
  run(script, timeoutMs) {
    const execute = () => this.#send(script, timeoutMs)
    const result = this.queue.then(execute, execute)
    this.queue = result.then(() => undefined, () => undefined)
    return result
  }

  #send(script, timeoutMs) {
    if (this.dead) return Promise.reject(new Error(this.deathReason === null ? 'session is dead' : this.deathReason))
    const stdin = this.handle.stdin
    if (stdin === undefined || stdin === null) return Promise.reject(new Error('session has no stdin pipe'))
    const id = 'c' + String(++this.sequence)
    this.lastUsed = Date.now()
    const response = { out: [], err: [], warn: [], verbose: [], exceptions: [], fatal: [], sentinel: null, timedOut: false, bytes: 0, truncated: false }
    const seconds = Math.max(1, Math.ceil(timeoutMs / 1000))
    return new Promise((resolve, reject) => {
      this.pending.set(id, { response, resolve, reject })
      stdin.write(id + ' ' + String(seconds) + ' ' + encodeScript(script) + '\n', (error) => {
        if (error) {
          this.pending.delete(id)
          reject(new Error('write to pwsh session failed: ' + String(error)))
        }
      })
    })
  }
}

/**
 * 启动一个会话并完成握手（跑一句 $PSVersionTable 确认真的活着）。
 * 服务端启动要解析脚本 + 打开 runspace，实测约 1s，所以握手超时给到 20s。
 */
export async function startSession(subprocess, options) {
  // argv：调用方已经算好的完整命令行。沙箱给出的是一条完整受限命令（node runner.js … -- pwsh.exe …），
  // 拆成前缀再接会更脆，所以整条用；没有沙箱时由调用方给出裸 pwsh 命令行。
  const argv = Array.isArray(options.argv) ? options.argv : [options.executable].concat(bootArgv(options.serverSource))
  const handle = subprocess.spawn({
    argv,
    cwd: options.cwd,
    stdio: {
      stdin: 'pipe',
      // 必须自己解协议：collect 模式只保留尾部，会把前面的响应截掉。
      stdout: 'pipe',
      // 同理用 pipe 而非 collect：collect 模式下 handle.stderr 是 undefined，
      // 启动失败的诊断尾巴会永远读不到（实测踩过）。这里自己收 2000 字符尾巴。
      stderr: 'pipe',
    },
    graceMs: DEFAULT_GRACE_MS,
  })
  const session = new PwshSession(handle, options.label === undefined ? 'pwsh' : options.label, options.maxOutputBytes)
  const probe = await Promise.race([
    session.run('$PSVersionTable.PSVersion.Major', 15000),
    new Promise((resolve) => setTimeout(() => resolve(null), 20000)),
  ])
  if (probe === null || probe.sentinel !== 'ok') {
    const tail = session.stderrTail.trim()
    await session.dispose()
    throw new Error('pwsh session failed to start' + (tail.length > 0 ? ': ' + tail : ''))
  }
  session.version = (probe.out ?? []).join('\n').trim()
  return session
}