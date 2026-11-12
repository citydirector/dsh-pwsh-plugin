/**
 * pwsh-run —— 常驻 PowerShell 会话工具（插件行）
 *
 * 为什么需要它
 *   把 PowerShell 再包进其它 shell 会增加一层变量与引号解析，
 *   复杂脚本因此容易在送到 PowerShell 之前改变含义。
 *   原生 pwsh 工具本身不吃 $，但受 Windows 命令行长度限制（实测 32700 字符即 ENAMETOOLONG），
 *   且每次都是全新进程，变量 / 当前目录 / 已导入模块不跨调用保留。
 *
 * 本工具把脚本正文直接经 stdin 喂给一个常驻 pwsh 进程：
 *   - 零转义：不经过任何 shell，$ / 引号 / here-string / 中文原样送达
 *   - 无长度限制：20 万字符的单次脚本实测跑通（原生工具在同一长度上必撞命令行上限）
 *   - 省启动：原生 pwsh 每次冷启动实测约 730ms，这边热态往返约 8ms
 *   - 状态保留：变量、当前目录、$env:、已导入模块跨调用保留
 *
 * 与原生 pwsh 工具的关系：并存，不替换。原生工具继续负责需要逐次沙箱、
 * 审批、后台 job 晋升的场景；本工具负责长脚本与需要状态的场景。
 *
 * 沙箱：常驻进程在**启动时**整体包进 ctx.sandbox.confine 返回的受限 argv，
 *   之后它的每一次读/写都受同一个 workspace 边界约束（ACL 受限令牌是进程级，
 *   不是逐命令级；因此每次复用前核对策略、工作区与后端，变化就重建）。
 *   read-only 模式下 pwsh 以 ConstrainedLanguage 运行，无法构造 runspace，
 *   因此常驻会话在该模式下不启动，直接报错让模型改用原生 pwsh 工具。
 *   ctx.sandboxPolicy 缺席时同样拒绝启动（fail-closed），除非显式 config.allowUnconfined: true。
 *
 * 已知边界（已写进工具描述，模型可见）
 *   - 脚本内 exit N 只结束当次调用，退出码不可观测（runspace 语义限制）。
 *   - 超时 / 取消会终止整个会话进程（连带回收子进程树）并自动重建，状态丢失。
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS, bootArgv, startSession, validateTimeout, abortable } from './session.mjs'

/** 加载器诊断里显示的插件名。 */
export const name = 'pwsh-run'

/** 注册前必须已有的服务。 */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_IDLE_MS = 30 * 60 * 1000
const DEFAULT_MAX_SESSIONS = 4
/** 服务端脚本：随插件分发，启动时经 -EncodedCommand 送入，不落地临时文件。 */
const SERVER_SOURCE = readFileSync(new URL('./session-server.ps1', import.meta.url), 'utf8')

const parameters = {
  type: 'object',
  properties: {
    script: {
      type: 'string',
      description: 'The PowerShell script body to run. Sent verbatim to a persistent pwsh session — do not escape $, do not wrap it in pwsh -c.',
    },
    workdir: {
      type: 'string',
      description: 'Optional Windows working directory to Set-Location into before running (e.g. D:\\proj). It persists for later calls in the same session; an invalid path fails the call before the script runs.',
    },
    timeoutMs: {
      type: 'integer',
      minimum: 1,
      maximum: MAX_TIMEOUT_MS,
      description: 'Timeout for this call in milliseconds; defaults to 120000. On timeout the session process is terminated and rebuilt.',
    },
  },
  required: ['script'],
  additionalProperties: false,
}

/**
 * 解析子进程的启动目录。
 * 与 wsl/custom-bash.mjs 同款：workingDirectory 服务优先（会话中途切目录后
 * header.cwd 不会更新），服务缺失时退回 header.cwd，再退回进程 cwd。
 */
async function resolveCwd(ctx, agent, signal) {
  const service = ctx.get('workingDirectory')
  if (service !== undefined && agent !== undefined) return await service.ensure(agent, signal)
  const header = agent?.session?.header
  if (typeof header?.cwd === 'string' && header.cwd.length > 0) return header.cwd
  return process.cwd()
}

/**
 * confine 失败时把原始 Win32 错误翻译成能照着做的说明。
 * 最常见的一种：工作区根的 DACL 没给 WRITE_DAC / WRITE_OWNER。沙箱要在目录上写 DACL 与
 * SACL（低完整性标签），缺任一条就会以 Win32 5（拒绝访问）失败，而原始错误只有一句
 * SetNamedSecurityInfoW failed，看不出该改哪个目录、该给什么权限。
 */
function describeConfineFailure(error, workspaceRoot) {
  const raw = String(error?.message ?? error)
  if (!/SetNamedSecurityInfoW/.test(raw)) return 'pwsh_run could not confine the session: ' + raw
  const root = typeof workspaceRoot === 'string' ? workspaceRoot : '(unknown)'
  return 'pwsh_run could not confine the session: ' + raw
    + '. The sandbox writes a DACL and an integrity label on the workspace root, which needs its DACL to'
    + ' grant the current user WRITE_DAC and WRITE_OWNER (full control satisfies both; Modify alone does not).'
    + ' Workspace root was ' + root + ' — grant yourself full control (icacls "' + root + '" /grant "%USERNAME%":(OI)(CI)F)'
    + ' or start the session from a directory under your user profile.'
}

/**
 * 捕获「子进程起不来」的报错，附上能照着做的说明。
 *
 * DSH 的 Windows 沙箱（workspace-write）给进程挂的是 Low 完整性 + WRITE_RESTRICTED 令牌，
 * 这种令牌建不了匿名管道，于是所有「捕获子进程 stdio」的起法一律失败——`& exe` 也在其中
 * （PowerShell 的调用运算符内部要建管道）。原始报错只有一句「拒绝访问」，
 * 看不出这是沙箱边界而不是命令写错了，模型很容易在这里反复换姿势盲试。
 */
export function describeExecDenial(text) {
  // 第一道门必须同时认内层文案：服务端交付的是剥到最内层的异常，`& exe` 到这里的原文是
  // "StandardOutputEncoding is only supported when standard output is redirected."，没有
  // "failed to run" 前缀。只按外层文案判定会让这条提示在真实路径上永不出现。
  if (!/failed to run|StandardOutputEncoding is only supported/.test(text)) return null
  if (!/拒绝访问|Access is denied|StandardOutputEncoding is only supported/.test(text)) return null
  return '[The sandbox is blocking that child process: this session runs under a restricted token (Low integrity +'
    + ' WRITE_RESTRICTED) that cannot create anonymous pipes, so any launch that captures a child\'s stdio fails —'
    + ' including `& exe`. Launches that do work: (1) [Diagnostics.Process]::Start on'
    + ' `cmd.exe /c "<exe> <args> > out.txt 2> err.txt"` with UseShellExecute=$false — .ExitCode is correct and'
    + ' both files carry the output; (2) Start-Process -NoNewWindow -PassThru -Wait -RedirectStandardOutput <file>'
    + ' -RedirectStandardError <file> — output is captured, but .ExitCode comes back empty. Two things NOT to do:'
    + ' do not pass CreateNoWindow=$true, and do not call Start-Process without -NoNewWindow — a fresh console'
    + ' cannot initialize under the restricted token, so the child dies with STATUS_DLL_INIT_FAILED (0xC0000142)'
    + ' and Windows raises a modal error dialog. Also do not let a child inherit this session\'s stdout: this tool'
    + ' detaches the child std handles, so session corruption is prevented — the lost output is not.]'
}

export function apply(ctx, config) {
  const pwshPath = typeof config?.pwshPath === 'string' && config.pwshPath.length > 0 ? config.pwshPath : 'pwsh'
  const defaultTimeoutMs = config?.timeoutMs === undefined ? DEFAULT_TIMEOUT_MS : validateTimeout(config.timeoutMs)
  const idleMs = Number.isSafeInteger(config?.idleMs) && config.idleMs > 0 ? config.idleMs : DEFAULT_IDLE_MS
  const maxSessions = Number.isSafeInteger(config?.maxSessions) && config.maxSessions > 0 ? config.maxSessions : DEFAULT_MAX_SESSIONS
  const maxOutputBytes = config?.maxOutputBytes ?? DEFAULT_MAX_OUTPUT_BYTES
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes < 1 || maxOutputBytes > 2147483647) {
    throw new Error('pwsh_run maxOutputBytes must be an integer between 1 and 2147483647')
  }
  // 明确放弃边界的唯一开关：策略服务缺席时默认拒绝启动，只有这里能改主意。
  const allowUnconfined = config?.allowUnconfined === true

  // 每次调用都重新取沙箱服务；apply 可能早于服务挂载，后端也可能热替换。
  // 而沙箱缺席时插件仍需能加载（启动会话时给出明确错误即可）。
  // 入参是 Agent（不是 ToolExecution）：sandboxPolicy.resolve 需要 session 才能读到
  // 会话的 sandbox/mode 覆盖与 header.cwd。传错形状会静默退回部署默认值
  // （mode=workspace-write + 配置的 workspaceRoot），边界就跑到 profile 目录去了。
  const resolvePolicy = (agent) => {
    const sandboxPolicy = ctx.get('sandboxPolicy')
    if (sandboxPolicy === undefined) return null
    const session = agent?.session
    return sandboxPolicy.resolve(session === undefined ? {} : { session })
  }

  // 槽位在第一次 await 前登记；同 ID 的创建、边界切换与执行共用队列。
  const sessions = new Map()
  let stopped = false
  const fingerprint = (value) => JSON.stringify(value, (_key, item) => {
    if (item && typeof item === 'object' && !Array.isArray(item)) {
      return Object.fromEntries(Object.keys(item).sort().map((key) => [key, item[key]]))
    }
    return item
  })

  const evict = async (slot, session, reason) => {
    if (slot.session === session) slot.session = null
    if (session) await session.dispose(reason)
  }

  const acquire = async (slot, workdir, agent, signal) => {
    if (signal?.aborted) throw new Error('pwsh_run cancelled before execution')
    const cwd = await resolveCwd(ctx, agent, signal)
    const policy = resolvePolicy(agent) ?? null
    if (signal?.aborted) throw new Error('pwsh_run cancelled before execution')
    if (stopped) throw new Error('pwsh_run plugin was stopped')
    const sandbox = ctx.get('sandbox')
    const identity = fingerprint({ policy, cwd })
    if (slot.session && (slot.identity !== identity || slot.sandbox !== sandbox || slot.session.dead)) {
      await evict(slot, slot.session, 'pwsh session boundary changed')
    }
    if (policy === null && !allowUnconfined) {
      throw new Error('pwsh_run: ctx.sandboxPolicy is absent, so the workspace boundary cannot be resolved. '
        + 'Mount @deepseek-ai/dsh-sandbox-policy, or set config.allowUnconfined: true to accept an unconfined session.')
    }
    if (policy?.mode === 'read-only') {
      throw new Error('pwsh_run does not support read-only mode: a persistent pwsh session needs FullLanguage. Use the native pwsh tool instead.')
    }
    if (policy !== null && !['workspace-write', 'danger-full-access'].includes(policy.mode)) {
      throw new Error('pwsh_run: unsupported sandbox mode ' + policy.mode)
    }
    if (slot.session) return slot.session

    const live = [...sessions.values()].filter((item) => item.session || item.starting)
    let retiring
    if (live.length >= maxSessions) {
      const victim = live.filter((item) => item !== slot && item.users === 0 && !item.starting)
        .sort((a, b) => a.session.lastUsed - b.session.lastUsed)[0]
      if (!victim) throw new Error('pwsh_run: all ' + maxSessions + ' sessions are busy; retry when a call finishes')
      retiring = evict(victim, victim.session, 'pwsh session evicted while idle')
      if (sessions.get(victim.key) === victim) sessions.delete(victim.key)
    }
    // 在等待旧进程退出前占住容量，另一 ID 不能同时认领最后一个位置。
    slot.starting = true
    slot.startup = new AbortController()
    const startupSignal = signal ? AbortSignal.any([signal, slot.startup.signal]) : slot.startup.signal
    try {
      await retiring
      if (stopped || startupSignal.aborted) throw new Error('pwsh_run session startup cancelled')
      const executable = await ctx.subprocess.resolveExecutable(pwshPath, undefined, startupSignal)
      let argv
      if (policy !== null && policy.mode !== 'danger-full-access') {
        if (!sandbox) throw new Error('pwsh_run: ctx.sandbox is absent, so a persistent session cannot be confined. Mount @deepseek-ai/dsh-sandbox-local, or use the native pwsh tool.')
        try {
          const confined = await sandbox.confine([executable, ...bootArgv(SERVER_SOURCE)], policy, startupSignal)
          argv = confined?.argv
          if (!Array.isArray(argv) || argv.length === 0 || argv.some((item) => typeof item !== 'string')) {
            throw new Error('sandbox.confine returned no valid confined argv')
          }
        }
        catch (error) { throw new Error(describeConfineFailure(error, policy.workspaceRoot)) }
      }
      const session = await startSession(ctx.subprocess, { executable, argv, cwd: workdir ?? cwd,
        serverSource: SERVER_SOURCE, label: slot.key, maxOutputBytes, signal: startupSignal })
      if (stopped || startupSignal.aborted) {
        await session.dispose('pwsh session startup cancelled')
        throw new Error('pwsh_run session startup cancelled')
      }
      slot.session = session
      slot.identity = identity
      slot.sandbox = sandbox
      return session
    } finally { slot.starting = false; slot.startup = null }
  }

  const reaper = setInterval(() => {
    const now = Date.now()
    for (const [key, slot] of sessions) {
      if (slot.users === 0 && !slot.starting && slot.session && now - slot.session.lastUsed > idleMs) {
        const retiring = evict(slot, slot.session, 'pwsh session expired while idle')
        if (sessions.get(key) === slot) sessions.delete(key)
        void retiring
      }
    }
  }, Math.min(idleMs, 60000))
  reaper.unref?.()

  ctx.effect(() => () => {
    stopped = true
    clearInterval(reaper)
    for (const slot of sessions.values()) {
      slot.startup?.abort()
      if (slot.session) void slot.session.dispose('pwsh_run plugin stopped')
    }
    sessions.clear()
  }, 'pwsh-run.sessions')

  const runScript = async (args, exec, slot) => {
    const requested = args.timeoutMs ?? defaultTimeoutMs
    const workdir = typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : undefined
    // 工作目录用 API 设置，避免在正文前拼语句破坏 using / param / #requires。
    let session
    try { session = await acquire(slot, workdir, exec?.agent, exec?.signal) }
    catch (error) {
      const message = String(error?.message ?? error)
      throw new Error(/^pwsh_run\b/.test(message) ? message : 'pwsh_run could not start a session: ' + message)
    }
    let response
    try { response = await session.run(args.script, requested, { signal: exec?.signal, workdir }) }
    catch (error) {
      await evict(slot, session, 'pwsh session execution failed')
      return { text: exec?.signal?.aborted
        ? '[cancelled; the session was terminated and is rebuilt on the next call]'
        : '[' + String(error) + '; a new session starts on the next call]' }
    }
    const notes = []
    if (response.truncated) notes.push('[output truncated at ' + maxOutputBytes + ' output bytes plus a separate 65536-byte error budget; redirect to a file if you need it all]')
    if (response.cancelled || response.noResponse || response.timedOut || session.dead) {
      await evict(slot, session)
      if (response.cancelled) notes.push('[cancelled; the session was terminated and is rebuilt on the next call]')
      else if (response.timedOut) notes.push('[timed out after ' + requested + 'ms; partial output above; the session was terminated and is rebuilt on the next call]')
      else notes.push('[no response from the pwsh session within ' + requested + 'ms; the session was terminated and is rebuilt on the next call]')
    }
    const body = [...response.out,
      ...response.warn.map((line) => 'WARNING: ' + line),
      ...response.verbose.map((line) => 'VERBOSE: ' + line),
      ...response.information.map((line) => 'INFORMATION: ' + line),
      ...response.debug.map((line) => 'DEBUG: ' + line)]
    if (response.sentinel === 'threw') body.push('[script threw]')
    const text = [...body, ...response.err, ...response.exceptions, ...response.fatal].join('\n')
    const denial = describeExecDenial(text)
    if (denial !== null) notes.push(denial)
    return { text: [text, ...notes].filter(Boolean).join('\n') || '(no output)' }
  }

  const enqueue = (args, exec) => {
    validateTimeout(args?.timeoutMs ?? defaultTimeoutMs)
    if (typeof args?.script !== 'string') throw new Error('pwsh_run script must be a string')
    if (exec?.signal?.aborted) throw new Error('pwsh_run cancelled before execution')
    const key = exec?.agent?.session?.id
    if (typeof key !== 'string' || !key) throw new Error('pwsh_run requires a session ID to isolate persistent state')
    let slot = sessions.get(key)
    if (!slot) {
      slot = { key, tail: Promise.resolve(), session: null, users: 0, starting: false }
      sessions.set(key, slot)
    }
    slot.users++
    let executing = false
    const operation = slot.tail.then(() => {
      executing = true
      if (exec?.signal?.aborted) throw new Error('pwsh_run cancelled before execution')
      if (stopped) throw new Error('pwsh_run plugin was stopped')
      return runScript(args, exec, slot)
    }).finally(() => {
      slot.users--
      if (slot.session) slot.session.lastUsed = Date.now()
      if (!slot.session && slot.users === 0 && sessions.get(key) === slot) sessions.delete(key)
    })
    slot.tail = operation.then(() => undefined, () => undefined)
    return abortable(operation, exec?.signal, () => !executing)
  }

  // 工具注册也要挂到 effect 上：live patchReload 会重新 apply 本模块，
  // 旧注册不撤的话 ctx.tools.register 会抛 "already registered"。
  ctx.effect(() => ctx.tools.register({
    name: 'pwsh_run',
    description: [
      'Run a PowerShell script in a **persistent** pwsh 7 session.',
      '* Send the script body verbatim: do NOT escape $, do NOT wrap it in pwsh -c, do NOT add shell quotes. There is no shell in between — the script goes straight to pwsh over stdin.',
      '* Prefer this over the pwsh tool when the script contains $variables, here-strings (@\'...\'@ / @"..."@), backticks, quotes, non-ASCII text, or is longer than a few thousand characters. The pwsh tool is capped by the Windows command line (~32K) and every call is a fresh process.',
      '* State persists while the session ID, sandbox policy and workspace stay the same: variables, current directory, $env: entries and imported modules. Do not assume a clean slate; reset explicitly when you need to.',
      '* Output uses PowerShell formatting; streams are labelled and grouped by type, so inter-stream ordering is not preserved.',
      '* Execution time excludes queue waiting. Each call times out after ' + String(Math.round(defaultTimeoutMs / 1000)) + 's by default (override with timeoutMs). On timeout the whole session process is terminated and rebuilt — persisted state is lost.',
      '* exit N inside the script only ends that call; its exit code is NOT observable. Use $LASTEXITCODE or Write-Output instead.',
      '* Sandbox: the persistent process is confined once at launch, and because the Windows ACL restricted token applies to the whole process, every later read/write in this session obeys the same workspace boundary as the native pwsh tool. In read-only mode this tool refuses to start (a persistent session needs FullLanguage) — use the native pwsh tool there.',
      '* Not for interactive programs or anything that needs a TTY.',
    ].join('\n'),
    parameters,
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: { text: { type: 'string' } },
        required: ['text'],
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      return await enqueue(args, exec)
    },
  }), 'pwsh-run.tool')
}