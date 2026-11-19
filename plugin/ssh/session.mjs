// 一条 SSH 会话：一个本地 ssh 子进程 + 远端一个长驻 shell。
// 状态机 connecting → probing → idle ⇄ running(fg|bg) → closing → dead(reason)，另有 draining 标记。
import { EventEmitter } from 'node:events'
import { SentinelSplitter, newNonce, probeScript, setupScript, commandScript, killDescendantsScript } from './framing.mjs'
import { OutputBuffer, renderSnapshot, decodeOutput } from './output.mjs'

export const DEAD_REASONS = Object.freeze(['network', 'remote-exit', 'killed', 'idle', 'hard-cap', 'host-removed', 'dsh-restart', 'probe-failed'])

export const realClock = Object.freeze({
  now: () => Date.now(),
  setTimeout: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t },
  clearTimeout: (t) => clearTimeout(t),
})

const PROBE_TIMEOUT_MS = 20000
const KILL_GRACE_MS = 3000
const EXIT_GRACE_MS = 3000
const BUSY_CLOSE_WAIT_MS = 2000

export class SessionError extends Error {
  constructor(code, message) { super(message); this.code = code }
}

export class SshSession extends EventEmitter {
  /**
   * @param o.id 会话 ID（s1、s2…）
   * @param o.host parseHost() 结果
   * @param o.transport { spawnMain(): child, runSide(script): Promise<{code}> }
   * @param o.clock 可注入的时钟
   */
  constructor({ id, host, transport, clock = realClock, env = {}, shell, name, spoolDir, spoolMaxBytes, defaultTimeoutMs }) {
    super()
    this.id = id
    this.host = host
    this.name = name
    this.transport = transport
    this.clock = clock
    this.env = env
    this.preferredShell = shell ?? host.shell
    this.spoolDir = spoolDir
    this.spoolMaxBytes = spoolMaxBytes
    this.defaultTimeoutMs = defaultTimeoutMs ?? 120000
    this.encoding = host.encoding ?? 'utf-8'
    this.state = 'connecting'
    this.draining = false
    this.deadReason = undefined
    this.openedAt = clock.now()
    this.lastActivity = this.openedAt
    this.cwd = undefined
    this.os = undefined
    this.shell = undefined
    this.pid = undefined
    this.job = undefined // 当前命令（前台或后台）
    this.jobs = new Map() // 已结束的后台任务，供 ssh_read
    this.nextJob = 1
    this.stderrText = []
    this.child = undefined
  }

  snapshot() {
    return {
      sessionId: this.id,
      host: this.host.name,
      name: this.name,
      state: this.state,
      mode: this.job === undefined ? undefined : this.job.background ? 'bg' : 'fg',
      draining: this.draining,
      cwd: this.cwd,
      shell: this.shell,
      os: this.os,
      openedAt: this.openedAt,
      lastActivity: this.lastActivity,
      deadReason: this.deadReason,
      jobId: this.job?.background ? this.job.jobId : undefined,
    }
  }

  setState(state) {
    if (this.state === state) return
    this.state = state
    this.emit('state', this.snapshot())
  }

  /** 握手：spawn → 探测 → 设置。失败时会话进入 dead(probe-failed) 并抛错。 */
  async open({ signal } = {}) {
    let child
    try {
      child = this.transport.spawnMain()
    } catch (error) {
      this.die('probe-failed')
      throw new SessionError('spawn-failed', `failed to start ssh: ${error.message}`)
    }
    this.child = child
    this.stdout = new SentinelSplitter((data) => this.sinkStdout(data))
    this.stderr = new SentinelSplitter((data) => this.sinkStderr(data))
    this.sinkStdout = () => {} // 探测哨兵之前的输出全丢弃
    this.sinkStderr = (data) => { if (this.state === 'connecting' || this.state === 'probing') this.stderrText.push(data) }
    child.stdout.on('data', (chunk) => this.stdout.push(chunk))
    child.stderr.on('data', (chunk) => this.stderr.push(chunk))
    child.stdin.on('error', () => {})
    child.on('error', (error) => { this.stderrText.push(Buffer.from(String(error.message))); this.onExit(null) })
    child.on('exit', (code) => this.onExit(code))
    this.exited = new Promise((resolve) => { this.resolveExited = resolve })

    const nonce = newNonce()
    const fail = (message) => {
      const detail = Buffer.concat(this.stderrText).toString('utf8').trim().split('\n').slice(-5).join('\n')
      this.terminate('probe-failed')
      return new SessionError('probe-failed', detail ? `${message}\n${detail}` : message)
    }
    const probe = this.stdout.expect(`__DSH_PROBE_${nonce} `)
    this.setState('probing')
    this.write(probeScript(nonce, { preferred: this.preferredShell, loadProfile: this.host.loadProfile }))
    const answer = await this.race(probe, PROBE_TIMEOUT_MS, signal)
    if (answer === undefined) throw fail(this.state === 'dead' ? 'ssh exited during the handshake' : 'remote shell did not answer the probe in time (only POSIX remotes are supported)')
    const [os, pid, shell] = answer.split(' ')
    if (!/^\d+$/.test(pid ?? '') || /windows|mingw|cygwin|msys/i.test(os ?? '')) throw fail('only POSIX remotes are supported')
    this.os = os
    this.pid = Number(pid)
    this.shell = shell

    const ready = this.stdout.expect(`__DSH_READY_${nonce} `)
    this.write(setupScript(nonce, { env: this.env }))
    const cwd = await this.race(ready, PROBE_TIMEOUT_MS, signal)
    if (cwd === undefined) throw fail('remote shell did not finish setup')
    this.cwd = cwd
    this.sinkStdout = (data) => this.job?.stdout.write(data)
    this.sinkStderr = (data) => this.job?.stderr.write(data)
    this.lastActivity = this.clock.now()
    this.setState('idle')
    return { sessionId: this.id, shell: this.shell, os: this.os, cwd: this.cwd, state: this.state }
  }

  /** 等 promise，超时/中止/会话死亡时返回 undefined。 */
  race(promise, ms, signal) {
    return new Promise((resolve) => {
      let done = false
      const finish = (value) => { if (done) return; done = true; this.clock.clearTimeout(timer); this.off('dead', onDead); signal?.removeEventListener?.('abort', onAbort); resolve(value) }
      const timer = this.clock.setTimeout(() => finish(undefined), ms)
      const onDead = () => finish(undefined)
      const onAbort = () => finish(undefined)
      this.on('dead', onDead)
      signal?.addEventListener?.('abort', onAbort, { once: true })
      promise.then(finish, () => finish(undefined))
    })
  }

  write(text) {
    if (this.child === undefined || this.state === 'dead') return
    try { this.child.stdin.write(text) } catch {}
  }

  busyError() {
    if (this.state === 'dead') return new SessionError('dead', `session ${this.id} has ended (${this.deadReason})`)
    if (this.state === 'closing') return new SessionError('closing', `session ${this.id} is closing`)
    if (this.state === 'connecting' || this.state === 'probing') return new SessionError('busy', `session ${this.id} is still connecting`)
    if (this.state === 'running') {
      const what = this.job.background ? `background job ${this.job.jobId}` : 'a command'
      return new SessionError('busy', `session ${this.id} is busy running ${what}; wait for it, use ssh_read, or open another session`)
    }
    if (this.draining) return new SessionError('draining', `session ${this.id} accepts no new commands (${this.drainReason ?? 'draining'})`)
    return undefined
  }

  /**
   * 执行一条命令。判断忙与置忙同步完成（中间没有 await），并发调用只有一个能进来。
   * 前台返回 { exitCode, stdout, stderr, cwd, truncated }；后台立即返回 { jobId, logPath }。
   */
  exec(command, { timeoutMs, background = false, signal } = {}) {
    const busy = this.busyError()
    if (busy !== undefined) return Promise.reject(busy)
    const nonce = newNonce()
    const jobId = background ? `j${this.nextJob++}` : undefined
    const spoolPath = background && this.spoolDir !== undefined ? `${this.spoolDir}/${this.id}-${jobId}-${nonce}.log` : undefined
    const job = {
      nonce,
      jobId,
      background,
      command,
      startedAt: this.clock.now(),
      stdout: new OutputBuffer(background ? { spoolPath, spoolMaxBytes: this.spoolMaxBytes } : {}),
      stderr: new OutputBuffer(),
      finished: false,
      exitCode: undefined,
    }
    // 后台任务的 stderr 合并进同一份 spool，读的时候只看一份。
    if (background) job.stderr = job.stdout
    this.job = job
    this.lastActivity = this.clock.now()
    this.setState('running')

    const outDone = this.stdout.expect(`__DSH_DONE_${nonce} `)
    const errDone = this.stderr.expect(`__DSH_DONE_${nonce}`)
    let script
    try { script = commandScript(nonce, command) } catch (error) {
      this.stdout.cancel(); this.stderr.cancel(); this.job = undefined; this.setState('idle')
      return Promise.reject(new SessionError('invalid', error.message))
    }
    this.write(script)
    job.done = Promise.all([outDone, errDone]).then(([line]) => {
      const space = line.indexOf(' ')
      const rc = Number(space < 0 ? line : line.slice(0, space))
      return { exitCode: Number.isInteger(rc) ? rc : undefined, cwd: space < 0 ? undefined : line.slice(space + 1) }
    })
    const settled = this.watch(job, background ? undefined : timeoutMs ?? this.defaultTimeoutMs, signal)
    if (background) {
      settled.then((result) => this.emit('job', { sessionId: this.id, ...result }))
      return Promise.resolve({ jobId, logPath: spoolPath })
    }
    return settled.then((result) => {
      if (result.timedOut) {
        const error = new SessionError('timeout', `command timed out after ${timeoutMs ?? this.defaultTimeoutMs}ms`)
        error.result = result
        if (this.state === 'dead') error.message += `; the session could not be recovered and is now dead (shell state lost)`
        throw error
      }
      if (result.cancelled) {
        const error = new SessionError('cancelled', 'command cancelled')
        error.result = result
        throw error
      }
      return result
    })
  }

  /** 等命令结束；超时/取消时走旁路 kill。返回给模型的结果对象。 */
  async watch(job, timeoutMs, signal) {
    let timedOut = false
    let cancelled = false
    let meta
    if (timeoutMs === undefined) {
      meta = await this.race(job.done, 2 ** 31 - 1, undefined)
    } else {
      meta = await this.race(job.done, timeoutMs, signal)
      if (meta === undefined && this.state !== 'dead') {
        if (signal?.aborted) cancelled = true; else timedOut = true
        meta = await this.interrupt(job)
      }
    }
    return this.finish(job, meta, { timedOut, cancelled })
  }

  /** 旁路 TERM → 3 秒 → KILL → 3 秒仍无哨兵则断连标 dead。 */
  async interrupt(job) {
    if (this.pid === undefined) return undefined
    for (const signal of ['TERM', 'KILL']) {
      try { await this.transport.runSide(killDescendantsScript(this.pid, signal)) } catch {}
      const meta = await this.race(job.done, KILL_GRACE_MS, undefined)
      if (meta !== undefined) return meta
      if (this.state === 'dead') return undefined
    }
    this.terminate('killed')
    return undefined
  }

  finish(job, meta, { timedOut = false, cancelled = false } = {}) {
    if (job.finished) {
      if (timedOut) job.result.timedOut = true
      if (cancelled) job.result.cancelled = true
      return job.result
    }
    job.finished = true
    job.finishedAt = this.clock.now()
    if (meta === undefined) { this.stdout?.cancel(); this.stderr?.cancel() }
    job.exitCode = meta?.exitCode ?? (this.state === 'dead' ? this.exitCode : undefined)
    if (meta?.cwd !== undefined) this.cwd = meta.cwd
    const out = renderSnapshot(job.stdout.snapshot(), this.encoding)
    const result = {
      exitCode: job.exitCode,
      cwd: this.cwd,
      truncated: out.truncated,
      durationMs: job.finishedAt - job.startedAt,
      bytes: job.stdout.total + (job.stderr === job.stdout ? 0 : job.stderr.total),
      timedOut,
      cancelled,
    }
    if (job.background) {
      result.jobId = job.jobId
      result.spoolFull = job.stdout.spoolFull
    } else {
      const err = renderSnapshot(job.stderr.snapshot(), this.encoding)
      result.stdout = out.text
      result.stderr = err.text
      result.truncated = out.truncated || err.truncated
      const warning = out.warning ?? err.warning
      if (warning !== undefined) result.warning = warning
      job.stdout.dispose(); job.stderr.dispose()
    }
    job.result = result
    if (job.background) this.jobs.set(job.jobId, job)
    if (this.job === job) {
      this.job = undefined
      this.lastActivity = this.clock.now()
      if (this.state === 'running') this.setState('idle')
    }
    return result
  }

  /** 读后台任务的 spool。jobId 省略时取当前或最近一个后台任务。 */
  read({ jobId, offset = 0, limit = 64 * 1024 } = {}) {
    let job = jobId === undefined ? undefined : (this.job?.jobId === jobId ? this.job : this.jobs.get(jobId))
    if (jobId === undefined) job = this.job?.background ? this.job : [...this.jobs.values()].at(-1)
    if (job === undefined) {
      const known = jobId !== undefined && /^j\d+$/.test(jobId) && Number(jobId.slice(1)) < this.nextJob
      throw new SessionError(known ? 'gone' : 'unknown', known ? `job ${jobId} output is no longer available` : `no background job ${jobId ?? ''} in session ${this.id}`.replace('  ', ' '))
    }
    const chunk = job.stdout.readSpool(offset, Math.min(limit, 1024 * 1024))
    if (chunk === undefined) throw new SessionError('gone', `job ${job.jobId} has no log`)
    const text = decodeOutput(chunk.data, this.encoding, { atStart: offset > 0 })
    const end = offset + chunk.data.length
    return {
      data: text.text,
      nextOffset: end,
      eof: end >= chunk.size,
      finished: job.finished,
      exitCode: job.finished ? job.exitCode : undefined,
      ...(job.stdout.spoolFull ? { warning: 'log reached its size limit; later output was discarded' } : {}),
      ...(text.warning ? { encodingWarning: text.warning } : {}),
    }
  }

  /** 优雅结束：空闲时 exit + EOF；忙时先杀进程组再 exit。3 秒后杀本地进程。 */
  async close(reason = 'killed') {
    if (this.state === 'dead') return
    if (this.state === 'closing') { await this.exited; return }
    const busyJob = this.job
    this.closeReason = reason
    this.setState('closing')
    if (busyJob !== undefined && this.pid !== undefined) {
      try { await this.transport.runSide(killDescendantsScript(this.pid, 'TERM')) } catch {}
      await this.race(busyJob.done, BUSY_CLOSE_WAIT_MS, undefined)
    }
    this.write('\nexit 0\n')
    try { this.child?.stdin.end() } catch {}
    const timer = this.clock.setTimeout(() => { try { this.child?.kill('SIGKILL') } catch {} ; this.onExit(null) }, EXIT_GRACE_MS)
    await this.exited
    this.clock.clearTimeout(timer)
  }

  /** 立刻断开（不等远端）。 */
  terminate(reason) {
    if (this.state === 'dead') return
    this.closeReason = reason
    try { this.child?.kill('SIGKILL') } catch {}
    this.onExit(null)
  }

  onExit(code) {
    if (this.state === 'dead') return
    this.exitCode = code ?? this.exitCode
    let reason = this.closeReason
    if (reason === undefined) reason = this.state === 'connecting' || this.state === 'probing' ? 'probe-failed' : code === 255 || code === null ? 'network' : 'remote-exit'
    this.die(reason)
  }

  die(reason) {
    if (this.state === 'dead') return
    this.deadReason = reason
    this.state = 'dead'
    this.diedAt = this.clock.now()
    const job = this.job
    if (job !== undefined && !job.finished) {
      const result = this.finish(job, undefined, {})
      if (job.background) this.emit('job', { sessionId: this.id, ...result, lost: true })
    }
    this.emit('dead', this.snapshot())
    this.emit('state', this.snapshot())
    this.resolveExited?.()
  }

  dispose() {
    this.terminate('dsh-restart')
    for (const job of this.jobs.values()) job.stdout.dispose()
    this.jobs.clear()
  }
}
