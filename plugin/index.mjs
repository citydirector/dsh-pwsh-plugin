/**
 * pwsh-run —— 常驻 PowerShell 会话工具（插件行）
 *
 * 为什么需要它
 *   DSH 的 bash 工具把命令包成 /bin/bash -c "<cmd>" 再交给 shell，
 *   所以任何经过 bash 的 PowerShell 命令，$变量 会先被外层双引号展开、
 *   heredoc 也会在那一层失效（实测：pwsh -Command "Write-Output \"var=$abc\"" 输出 var=）。
 *   原生 pwsh 工具本身不吃 $，但受 Windows 命令行长度限制（实测 32700 字符即 ENAMETOOLONG），
 *   且每次都是全新进程，变量 / 当前目录 / 已导入模块不跨调用保留。
 *
 * 本工具把脚本正文直接经 stdin 喂给一个常驻 pwsh 进程：
 *   - 零转义：不经过任何 shell，$ / 引号 / here-string / 中文原样送达
 *   - 无长度限制：单次脚本实测 67813 字符正常，20 万字符变量正常
 *   - 省启动：省掉每次约 300-500ms 的 pwsh 冷启动，往返实测 1-2ms
 *   - 状态保留：变量、当前目录、$env:、已导入模块跨调用保留
 *
 * 与原生 pwsh 工具的关系：并存，不替换。原生工具继续负责需要逐次沙箱、
 * 审批、后台 job 晋升的场景；本工具负责长脚本与需要状态的场景。
 *
 * 沙箱：常驻进程在**启动时**整体包进 ctx.sandbox.confine 返回的受限 argv，
 *   之后它的每一次读/写都受同一个 workspace 边界约束（ACL 受限令牌是进程级，
 *   不是逐命令级——这一点与原生工具等价，实测 workspace 外写入全部被拒）。
 *   read-only 模式下 pwsh 以 ConstrainedLanguage 运行，无法构造 runspace，
 *   因此常驻会话在该模式下不启动，直接报错让模型改用原生 pwsh 工具。
 *   ctx.sandboxPolicy 缺席时同样拒绝启动（fail-closed），除非显式 config.allowUnconfined: true。
 *
 * 已知边界（已写进工具描述，模型可见）
 *   - 脚本内 exit N 只结束当次调用，退出码不可观测（runspace 语义限制）。
 *   - 超时 / 取消会终止整个会话进程（连带回收子进程树）并自动重建，状态丢失。
 */

import { readFileSync } from 'node:fs'
import { DEFAULT_MAX_OUTPUT_BYTES, bootArgv, startSession } from './session.mjs'
import { UpdateChecker } from './update-check.mjs'

/** 加载器诊断里显示的插件名。 */
export const name = 'pwsh-run'

/** 注册前必须已有的服务。 */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_IDLE_MS = 30 * 60 * 1000
const DEFAULT_MAX_SESSIONS = 4
/** 调用方超时之外多给的余量：服务端被打断后还要把尾部输出吐完、写结束标记。 */
const RESPONSE_GRACE_MS = 5000

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
      type: 'number',
      description: 'Timeout for this call in milliseconds; defaults to 120000. On timeout the session process is terminated and rebuilt.',
    },
  },
  required: ['script'],
  additionalProperties: false,
}

/**
 * 解析子进程的启动目录。
 * 与 presets/shared/custom-bash.mjs 同款：workingDirectory 服务优先（会话中途切目录后
 * header.cwd 不会更新），服务缺失时退回 header.cwd，再退回进程 cwd。
 */
async function resolveCwd(ctx, agent, signal) {
  try {
    const service = ctx.get('workingDirectory')
    if (service !== undefined && agent !== undefined) return await service.ensure(agent, signal)
  } catch {
    // 服务异常时退回旧路径，不让一次目录查询拖垮工具调用。
  }
  const header = agent?.session?.header
  if (typeof header?.cwd === 'string' && header.cwd.length > 0) return header.cwd
  return process.cwd()
}

/**
 * 把一个字符串安全地拼进 PowerShell 源码。
 * 必须用单引号字面量：JSON 的双引号写法会被 PowerShell 当成可展开字符串，
 * 路径里一旦出现 $ 或反引号（如 D:\$Recycle.Bin）就会被解析掉，
 * 而且 JSON 会把反斜杠加倍成 \\，与 PowerShell 的转义规则并不一致。
 * PowerShell 单引号里唯一需要转义的字符是单引号本身（写成两个）。
 */
function psLiteral(value) {
  return "'" + String(value).replaceAll("'", "''") + "'"
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

/** 合并调用方取消信号与本地超时信号。 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

export function apply(ctx, config) {
  const pwshPath = typeof config?.pwshPath === 'string' && config.pwshPath.length > 0 ? config.pwshPath : 'pwsh'
  const defaultTimeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const idleMs = Number.isSafeInteger(config?.idleMs) && config.idleMs > 0 ? config.idleMs : DEFAULT_IDLE_MS
  const maxSessions = Number.isSafeInteger(config?.maxSessions) && config.maxSessions > 0 ? config.maxSessions : DEFAULT_MAX_SESSIONS
  const maxOutputBytes = Number.isSafeInteger(config?.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES
  // 唯一一条「 knowingly 放弃边界」的开关：沙箱策略服务缺席时默认拒绝启动。
  const allowUnconfined = config?.allowUnconfined === true
  // 更新检查：只查不发。查到新版本时在工具描述里挂一句，安装仍交给 DSH 的 plugin_manager。
  const updateCheck = config?.updateCheck !== false

  // 沙箱服务每次启动会话时再取：插件 apply 可能早于沙箱服务挂载，
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

  /** sessionId -> Promise<PwshSession>。用 Promise 占位，避免并发首调用各起一个进程。 */
  const sessions = new Map()

  const sessionKey = (exec) => {
    const id = exec?.agent?.session?.id
    return typeof id === 'string' && id.length > 0 ? id : 'default'
  }

  const evict = async (key, session) => {
    sessions.delete(key)
    if (session !== undefined && session !== null) await session.dispose()
  }

  /** 取一个活着的会话，必要时新建；超出上限淘汰最久未用的。 */
  const acquire = async (key, workdir, agent, signal) => {
    const existing = sessions.get(key)
    if (existing !== undefined) {
      let session = null
      try {
        session = await existing
      } catch {
        sessions.delete(key)
      }
      if (session !== null && !session.dead) {
        session.lastUsed = Date.now()
        return session
      }
      if (session !== null) await session.dispose()
      sessions.delete(key)
    }

    const cwd = workdir ?? await resolveCwd(ctx, agent, signal)
    const pending = (async () => {
      const executable = await ctx.subprocess.resolveExecutable(pwshPath, undefined, signal)
      // 常驻进程只在启动时能 confine 一次——但 ACL 受限令牌是**进程级**的，
      // 之后该进程所有读写都受同一 workspace 边界约束，与原生 pwsh 工具等价（实测）。
      const policy = resolvePolicy(agent)
      const boot = bootArgv(SERVER_SOURCE)
      const plain = [executable].concat(boot)
      // fail-closed：解析不出边界就拒绝启动，而不是悄悄跑一个不受约束的会话。
      if (policy === null && allowUnconfined !== true) {
        throw new Error('pwsh_run: ctx.sandboxPolicy is absent, so the workspace boundary cannot be resolved. ' +
          'Mount @deepseek-ai/dsh-sandbox-policy, or set config.allowUnconfined: true to accept an unconfined session ' +
          '(file writes would then NOT be restricted to the workspace).')
      }
      if (policy === null || policy.mode === 'danger-full-access') {
        return await startSession(ctx.subprocess, { executable, cwd, serverSource: SERVER_SOURCE, label: key, maxOutputBytes })
      }
      // read-only 下 pwsh 是 ConstrainedLanguage，连 runspace 都建不起来（实测
      // [Text.UTF8Encoding]::new 即报 "Cannot create type"），常驻会话没法启动。
      if (policy.mode === 'read-only') {
        throw new Error('pwsh_run does not support read-only mode: a persistent pwsh session needs FullLanguage ' +
          '(a read-only sandbox runs pwsh in ConstrainedLanguage, where creating a runspace fails). Use the native pwsh tool instead.')
      }
      const sandbox = ctx.get('sandbox')
      if (sandbox === undefined) throw new Error('pwsh_run: ctx.sandbox is absent, so a persistent session cannot be confined. Mount @deepseek-ai/dsh-sandbox-local, or use the native pwsh tool.')
      let confined
      try {
        confined = await sandbox.confine(plain, policy, signal)
      } catch (error) {
        throw new Error(describeConfineFailure(error, policy.workspaceRoot))
      }
      return await startSession(ctx.subprocess, { executable, argv: confined.argv, cwd, serverSource: SERVER_SOURCE, label: key, maxOutputBytes })
    })()
    pending.catch(() => sessions.delete(key))
    sessions.set(key, pending)

    if (sessions.size > maxSessions) {
      const others = [...sessions.entries()].filter(([victim]) => victim !== key)
      const ages = []
      for (const entry of others) {
        let lastUsed = 0
        try {
          lastUsed = (await entry[1]).lastUsed
        } catch {
          lastUsed = 0
        }
        ages.push([entry[0], entry[1], lastUsed])
      }
      ages.sort((a, b) => a[2] - b[2])
      for (const [victimKey, victim] of ages.slice(0, Math.max(0, sessions.size - maxSessions))) {
        sessions.delete(victimKey)
        Promise.resolve(victim).then((session) => session.dispose(), () => undefined)
      }
    }
    return await pending
  }

  // 空闲会话回收，避免常驻进程无限累积。
  const reaper = setInterval(() => {
    const now = Date.now()
    for (const [key, pending] of [...sessions.entries()]) {
      Promise.resolve(pending).then(async (session) => {
        if (now - session.lastUsed > idleMs) await evict(key, session)
      }, () => sessions.delete(key))
    }
  }, Math.min(idleMs, 60000))
  if (typeof reaper.unref === 'function') reaper.unref()

  /** 插件卸载 / 热重载时清干净：停回收器 + 杀掉所有会话。 */
  ctx.effect(() => () => {
    clearInterval(reaper)
    for (const pending of sessions.values()) Promise.resolve(pending).then((session) => session.dispose(), () => undefined)
    sessions.clear()
  }, 'pwsh-run.sessions')

  // 更新检查：只读发布标签、只记判决，从不自己安装。
  // 发现新版本时不改工具描述（描述在注册时就固定了），而是把提示挂在每次调用的
  // 输出末尾一次——够模型看见，也不至于每次刷。
  const checker = updateCheck
    ? new UpdateChecker({
        log: (line) => {
          try {
            ctx.logger?.info?.('pwsh-run: %s', line)
          } catch {
            // 日志服务缺席时不影响工具本身。
          }
        },
      })
    : undefined
  ctx.effect(() => {
    checker?.start()
    return () => checker?.stop()
  }, 'pwsh-run.update')

  // 工具注册也要挂到 effect 上：live patchReload 会重新 apply 本模块，
  // 旧注册不撤的话 ctx.tools.register 会抛 "already registered"。
  ctx.effect(() => ctx.tools.register({
    name: 'pwsh_run',
    description: [
      'Run a PowerShell script in a **persistent** pwsh 7 session.',
      '* Send the script body verbatim: do NOT escape $, do NOT wrap it in pwsh -c, do NOT add shell quotes. There is no shell in between — the script goes straight to pwsh over stdin.',
      '* Prefer this over the pwsh tool when the script contains $variables, here-strings (@\'...\'@ / @"..."@), backticks, quotes, non-ASCII text, or is longer than a few thousand characters. The pwsh tool is capped by the Windows command line (~32K) and every call is a fresh process.',
      '* State persists across calls in the same session: variables, current directory, $env: entries and imported modules. Do not assume a clean slate; reset explicitly when you need to.',
      '* Output ordering is preserved and streams are labelled (stdout / error / warning / verbose).',
      '* Each call times out after ' + String(Math.round(defaultTimeoutMs / 1000)) + 's by default (override with timeoutMs). On timeout the whole session process is terminated and rebuilt — persisted state is lost.',
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
      const requested = Number.isFinite(args?.timeoutMs) && args.timeoutMs > 0 ? Math.trunc(args.timeoutMs) : defaultTimeoutMs
      const key = sessionKey(exec)
      const workdir = typeof args?.workdir === 'string' && args.workdir.length > 0 ? args.workdir : undefined

      // workdir 通过 Set-Location 生效（会话有状态，所以下一次调用会继承）。
      const script = workdir === undefined
        ? args.script
        : 'Set-Location -LiteralPath ' + psLiteral(workdir) + " -ErrorAction Stop\n" + args.script

      let session
      try {
        session = await acquire(key, workdir, exec?.agent, exec?.signal)
      } catch (error) {
        // acquire 里已经写好人话的错误（沙箱缺席、read-only、confine 失败）不再套第二层前缀。
        // 用 \b 而不是 'pwsh_run '：几条自带文案是 'pwsh_run: ...' 冒号收尾，带空格的匹配会漏掉它们。
        const message = String(error?.message ?? error)
        throw new Error(/^pwsh_run\b/.test(message) ? message : 'pwsh_run could not start a session: ' + message)
      }

      const local = withTimeout(exec?.signal, requested + RESPONSE_GRACE_MS)
      let expired = false
      const onAbort = () => { expired = true }
      local.addEventListener('abort', onAbort, { once: true })

      let response = null
      try {
        response = await Promise.race([
          session.run(script, requested),
          new Promise((resolve) => {
            local.addEventListener('abort', () => resolve(null), { once: true })
          }),
        ])
      } catch (error) {
        // 会话中途死亡：清掉，下一次调用自动重建。
        await evict(key, session)
        const message = String(error)
        const note = session.dead ? '[' + message + '; a new session starts on the next call]' : '[' + message + ']'
        return { text: note }
      } finally {
        local.removeEventListener('abort', onAbort)
      }

      const notes = []
      if (response?.truncated === true) notes.push('[output truncated at ' + String(maxOutputBytes) + ' bytes; redirect to a file if you need it all]')
      if (response === null || expired) {
        // 服务端没能在预算内回话：整个进程杀掉重建，不让一条调用拖垮后续。
        await evict(key, session)
        notes.push(exec?.signal?.aborted === true
          ? '[cancelled; the session was terminated and is rebuilt on the next call]'
          : '[no response from the pwsh session within ' + String(Math.round(requested / 1000)) + 's; the session was terminated and is rebuilt on the next call]')
      } else if (session.dead) {
        await evict(key, session)
        notes.push('[' + String(session.deathReason) + '; a new session starts on the next call]')
      } else if (response.timedOut) {
        // 服务端 Stop() 能打断脚本，但脚本内 Start-Process 起的子进程不会随之回收
        // （实测子进程仍存活）。杀掉整个会话才能靠 Job Object 连带清干净。
        await evict(key, session)
        notes.push('[timed out after ' + String(Math.round(requested / 1000)) + 's; partial output above; the session was terminated and is rebuilt on the next call]')
      }

      const body = []
      for (const line of response?.out ?? []) body.push(line)
      for (const line of response?.warn ?? []) body.push('WARNING: ' + line)
      for (const line of response?.verbose ?? []) body.push('VERBOSE: ' + line)
      if (response?.sentinel === 'threw') body.push('[script threw]')
      // 更新提示只在第一次查到新版本时挂一行，之后不再刷。
      const fresh = checker?.announce
      if (fresh !== undefined) {
        notes.push('[a newer pwsh-run release exists: ' + fresh.latest + ' (running ' + String(checker?.version ?? '?') +
          '). Install it with dsh plugin --profile <name> add "' + fresh.spec + '" or the plugin_manager tool. ' +
          'Nothing is installed automatically.]')
      }
      const text = [body.join('\n')]
        .concat(response?.err ?? [])
        .concat(response?.exceptions ?? [])
        .concat(response?.fatal ?? [])
        .concat(notes)
        .filter((part) => part.length > 0)
        .join('\n')
      return { text: text.length > 0 ? text : '(no output)' }
    },
  }), 'pwsh-run.tool')
}