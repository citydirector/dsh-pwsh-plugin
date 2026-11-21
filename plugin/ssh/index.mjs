// dsh-pwsh-plugin 的 SSH 模块：独立的 cordis 插件条目（id ssh），不碰 pwsh-run 的逻辑。
// 工具：ssh_open / ssh_exec / ssh_read / ssh_kill / ssh_list。
import Schema from '@deepseek-ai/schemastery'
import { spawn } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { mkdirSync, appendFileSync, readdirSync, statSync, unlinkSync, writeFileSync, readFileSync } from 'node:fs'
import { lookup } from 'node:dns/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { parseHostList, parseApprovalList } from './hosts.mjs'
import { buildSshArgv } from './argv.mjs'
import { SshManager, MANAGER_DEFAULTS } from './manager.mjs'
import { SessionError } from './session.mjs'
import { mountProjection, PROJECTION_KEY, registration as projectionRegistration } from './projection.mjs'

export const name = 'ssh'
export const inject = ['tools']

// 基本都可热改：宿主只保留带 volatile 的字段，没有 volatile 的条目连表单都不会生成。
// 例外（改了要重挂插件，不就地改）：stateDir 决定会话登记与审计日志落在哪；sshPath / wslPath
// 决定要启动的可执行文件，换它应当是一次显式的重载，而不是某次配置写入顺手生效。
export const Config = Schema.object({
  enabled: Schema.boolean().default(true).volatile(),
  hosts: Schema.union([Schema.array(Schema.any()), Schema.dict(Schema.any()), Schema.string()]).default([]).volatile(),
  approvalList: Schema.string().default('').volatile(),
  approvalListInvert: Schema.boolean().default(false).volatile(),
  idleMinutes: Schema.natural().default(MANAGER_DEFAULTS.idleMinutes).volatile(),
  hardCapHours: Schema.number().min(1).max(168).default(MANAGER_DEFAULTS.hardCapHours).volatile(),
  globalMax: Schema.number().min(1).max(64).step(1).default(MANAGER_DEFAULTS.globalMax).volatile(),
  logMaxMB: Schema.number().min(1).max(4096).step(1).default(MANAGER_DEFAULTS.logMaxMB).volatile(),
  noticeTailLines: Schema.natural().max(200).default(MANAGER_DEFAULTS.noticeTailLines).volatile(),
  wakeOnNotice: Schema.boolean().default(true).volatile(),
  audit: Schema.boolean().default(true).volatile(),
  env: Schema.dict(Schema.string()).default({}).volatile(),
  sshPath: Schema.string().default('ssh'),
  wslPath: Schema.string().default('wsl.exe'),
  knownHosts: Schema.string().default('~/.ssh/dsh_known_hosts').volatile(),
  userKnownHosts: Schema.string().default('~/.ssh/known_hosts').volatile(),
  defaultTimeoutMs: Schema.number().min(1000).max(3600000).step(1).default(120000).volatile(),
  stateDir: Schema.string(),
})

const DESCRIPTION = {
  open: [
    'Open a persistent SSH shell session to a host from the configured host list. Returns a sessionId (s1, s2, …) for ssh_exec.',
    '* Only hosts in the list can be reached; an unknown host fails with the list of available names.',
    '* Each session is an independent connection with its own shell, directory and variables. Open more than one to run things in parallel.',
    '* Sessions end after a period of inactivity and after a hard time limit; ssh_list shows both. Use reopen: "<old id>" to start a fresh session in the old directory (state such as variables is not restored).',
    '* Only POSIX remotes (Linux, macOS, BSD) are supported. There is no TTY: interactive programs (top, vim, password prompts) will not work; use batch flags (top -b -n 1, apt-get -y).',
  ].join('\n'),
  exec: [
    'Run a shell command in an SSH session. Variables, cd and functions persist across calls in the same session.',
    '* One command at a time per session: a busy session refuses new commands instead of queueing. Open another session for parallel work.',
    '* background: true returns a jobId at once; the session stays busy until the job ends and you are notified in-session. Read its output with ssh_read. Do not poll.',
    '* Foreground output keeps the first 16 KB and the last 256 KB. Redirect large or binary output to a file on the remote and inspect it with head/tail.',
    '* Default timeout is ' + String(Math.round((MANAGER_DEFAULTS.defaultTimeoutMs ?? 120000) / 1000)) + 's. On timeout the command\'s child processes are terminated; a shell builtin that cannot be interrupted ends the whole session.',
    '* Remote hosts are NOT covered by the local sandbox, llrun or the deletion guard. Be careful with destructive commands.',
  ].join('\n'),
  read: 'Read the output log of a background job in an SSH session, by byte offset. Use nextOffset for the next page.',
  kill: 'End an SSH session. An idle shell exits cleanly; a running command is terminated first.',
  list: 'List this conversation\'s SSH sessions with their state, directory, and time limits, plus the hosts that can be opened.',
}

const textOutput = {
  schema: { type: 'object', additionalProperties: true, properties: {} },
  render: (_args, value) => [{ type: 'text', text: JSON.stringify(value, null, 1) }],
}

/** DSH 会话树的根：子 Agent 打开的 SSH 会话归根会话所有。 */
export function rootKey(agent) {
  let current = agent
  for (let i = 0; i < 32 && current?.parent?.session !== undefined; i++) current = current.parent
  const session = current?.session
  return session?.header?.rootSessionId ?? session?.id ?? 'default'
}

// volatile 字段在解析后的 config 上是带 get() 的引用，不是值；每次使用时解包才拿到最新的。
const live = (field) => (field !== null && typeof field === 'object' && typeof field.get === 'function' ? field.get() : field)

// OpenSSH 的 Windows 移植层在 init_prog_paths() 里找不到 ProgramData 就直接 cleanup_exit(255)，
// 而且这条 fatal 路径连 stderr 都不写。父进程的环境块万一不完整，ssh 会静默死掉，
// 报错里只剩一个 255 —— 所以这里补一个默认值，不让它因为一个缺失变量就整进程退出。
function childEnv(override) {
  const base = { ...process.env }
  if (!base.ProgramData) base.ProgramData = (base.SystemDrive ?? 'C:') + '\\ProgramData'
  return override === undefined ? base : { ...base, ...override }
}

// 导出给真机用例复用：测试要走生产那条 spawn 路径，别再自己拼一份。
export function transportFor(config) {
  const run = (host) => buildSshArgv(host, { privateKnownHosts: live(config.knownHosts), userKnownHosts: live(config.userKnownHosts) }, { sshPath: live(config.sshPath), wslPath: live(config.wslPath) })
  return (host) => ({
    // 连接失败时把真正跑的那条命令行出来：agent 走环境变量、argv 里看不到，排障时要看的是这一条。
    describe() {
      const { command, args } = run(host)
      return command + ' ' + args.join(' ')
    },
    spawnMain() {
      const { command, args, env } = run(host)
      return spawn(command, args, { stdio: 'pipe', windowsHide: true, env: childEnv(env) })
    },
    runSide(script) {
      return new Promise((resolve) => {
        const { command, args, env } = run(host)
        let child
        try { child = spawn(command, args, { stdio: ['pipe', 'ignore', 'ignore'], windowsHide: true, env: childEnv(env) }) } catch { resolve({ code: null }); return }
        const timer = setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 15000)
        child.on('error', () => {})
        child.on('exit', (code) => { clearTimeout(timer); resolve({ code }) })
        child.stdin.on('error', () => {})
        child.stdin.end(script)
      })
    },
  })
}

function userMessage(text, sessions) {
  return Object.freeze({
    id: randomUUID(),
    role: 'user',
    content: Object.freeze([Object.freeze({ type: 'text', text })]),
    source: Object.freeze({ kind: 'ssh', form: 'notice', summary: text.split('\n')[0].slice(0, 200), sessions }),
  })
}

export function apply(ctx, config) {
  const stateDir = config.stateDir ?? join(process.env.DSH_HOME ?? join(homedir(), '.dsh'), 'ssh')
  const spoolDir = join(stateDir, 'spool')
  try { mkdirSync(spoolDir, { recursive: true, mode: 0o700 }) } catch {}
  const auditDir = join(stateDir, 'audit')
  const leftoverFile = join(stateDir, 'sessions.json')

  // 上次遗留：读出上一个进程登记的会话，然后清空登记。远端进程不自动杀。
  let leftovers = []
  try { leftovers = JSON.parse(readFileSync(leftoverFile, 'utf8')) } catch {}
  for (const name of safeList(spoolDir)) { try { unlinkSync(join(spoolDir, name)) } catch {} }

  const persistRegistry = () => {
    const rows = manager.liveSessions().map((s) => ({ owner: s.owner, sessionId: s.id, host: s.host.name, pid: s.pid, openedAt: s.openedAt }))
    try { writeFileSync(leftoverFile, JSON.stringify([...leftovers, ...rows]), { mode: 0o600 }) } catch {}
  }

  const audit = (record) => {
    try {
      mkdirSync(auditDir, { recursive: true, mode: 0o700 })
      appendFileSync(join(auditDir, record.at.slice(0, 10) + '.jsonl'), JSON.stringify(record) + '\n', { mode: 0o600 })
    } catch {}
  }
  pruneAudit(auditDir, 7)

  const deliver = ({ agentId, text, wake, sessions }) => {
    const agent = agentId === undefined ? undefined : ctx.get('agents')?.get(agentId)
    if (agent === undefined) return
    const message = userMessage(text, sessions)
    if (wake && agent.status === 'idle') agent.followup(message)
    else agent.inject(message)
  }

  const manager = new SshManager({ transportFor: transportFor(config), notify: deliver, audit, spoolDir, onChange: () => persistRegistry() })

  // 这些字段是 volatile：宿主改完只就地更新引用、不重挂插件（cordis-plugin-loader 的
  // _commitVolatile 会 emit loader/volatile-update），所以要在事件里重读一次，
  // 否则开关、主机表与限额只会在下次重挂时生效。
  const applyConfig = () => {
    const hostList = parseHostList(live(config.hosts))
    const approval = parseApprovalList(live(config.approvalList))
    manager.configure({
      hosts: hostList.hosts,
      rules: approval.rules,
      invert: live(config.approvalListInvert),
      settings: {
        enabled: live(config.enabled),
        idleMinutes: live(config.idleMinutes),
        hardCapHours: live(config.hardCapHours),
        globalMax: live(config.globalMax),
        logMaxMB: live(config.logMaxMB),
        noticeTailLines: live(config.noticeTailLines),
        wake: live(config.wakeOnNotice),
        audit: live(config.audit),
        env: live(config.env),
        defaultTimeoutMs: live(config.defaultTimeoutMs),
      },
    })
    manager.configErrors = [...hostList.errors, ...approval.errors]
  }
  applyConfig()
  ctx.on('loader/volatile-update', () => applyConfig())
  manager.leftovers = leftovers
  manager.start()
  ctx.effect(() => () => manager.dispose(), 'ssh.manager')
  // 页面由 client/index.js 自己登记；不让 settings 服务再自动生成一张重复的表单。
  ctx.inject?.(['settings'], (child) => {
    child.effect(() => child.settings.configure({ auto: false }, ctx.fiber), 'ssh.settings-page')
  })

  const readOnly = (agent) => {
    const policy = ctx.get('sandboxPolicy')?.resolve(agent?.session === undefined ? {} : { session: agent.session })
    return policy?.mode === 'read-only'
  }

  const fail = (error) => {
    if (error instanceof SessionError) {
      const out = new Error(`[${error.code}] ${error.message}`)
      out.result = error.result
      return out
    }
    return error
  }

  // 审批：命中名单（或反转后未命中）的主机，ssh_open 与每条 ssh_exec 都交宿主审批。
  ctx.effect(() => ctx.on('tools/pre-execute', async (exec, next) => {
    if (exec.name !== 'ssh_open' && exec.name !== 'ssh_exec') return await next()
    let hostName = exec.arguments?.host
    if (exec.name === 'ssh_exec') {
      try { hostName = manager.get(rootKey(exec.agent), exec.arguments?.sessionId).host.name } catch { return await next() }
    }
    const host = manager.hosts.get(hostName)
    if (host === undefined) return await next()
    let ips = []
    if (host.addressKind === 'name' && manager.rules.some((rule) => rule.kind === 'cidr')) {
      try { ips = (await lookup(host.sshHost, { all: true })).map((item) => item.address) } catch {}
    }
    const verdict = manager.approvalFor(hostName, ips)
    if (!verdict.required) return await next()
    const command = exec.name === 'ssh_exec' ? String(exec.arguments?.command ?? '').slice(0, 2000) : undefined
    const en = exec.name === 'ssh_open' ? `Open an SSH session to ${host.name} (${host.user}@${host.address})` : `Run on ${host.name}: ${command}`
    const zh = exec.name === 'ssh_open' ? `打开到 ${host.name}（${host.user}@${host.address}）的 SSH 会话` : `在 ${host.name} 上执行：${command}`
    return { kind: 'ask', reason: `ssh approval list${verdict.rule ? ` (${verdict.rule})` : ''}`, displayReason: { en, 'zh-CN': zh } }
  }, { prepend: true }), 'ssh.approval')

  const tool = (definition) => ctx.effect(() => ctx.tools.register({ output: textOutput, ...definition }), `ssh.tool.${definition.name}`)

  tool({
    name: 'ssh_open',
    description: DESCRIPTION.open,
    parameters: {
      host: { type: 'string', required: true, description: 'Host name from the SSH host list.' },
      shell: { type: 'string', enum: ['bash', 'zsh', 'sh'], description: 'Preferred remote shell; falls back to bash, zsh, sh.' },
      name: { type: 'string', description: 'Optional label shown in the session list.' },
      reopen: { type: 'string', description: 'Id of an ended session whose directory the new session starts in.' },
    },
    async execute(args, exec) {
      if (readOnly(exec.agent)) throw new Error('[read-only] SSH sessions cannot be opened in read-only mode; only ssh_list is available')
      const owner = rootKey(exec.agent)
      try {
        const result = await manager.open(owner, { ...args, agentId: exec.agent?.id, signal: exec.signal })
        const session = manager.get(owner, result.sessionId)
        session.owner = owner
        persistRegistry()
        return { ...result, host: session.host.name }
      } catch (error) { throw fail(error) }
    },
  })

  tool({
    name: 'ssh_exec',
    description: DESCRIPTION.exec,
    parameters: {
      sessionId: { type: 'string', required: true, description: 'Session id from ssh_open.' },
      command: { type: 'string', required: true, description: 'Shell command(s), sent verbatim.' },
      timeoutMs: { type: 'number', description: 'Foreground timeout in milliseconds (default 120000).' },
      background: { type: 'boolean', description: 'Run in the background and return a jobId immediately.' },
    },
    async execute(args, exec) {
      if (readOnly(exec.agent)) throw new Error('[read-only] ssh_exec is not available in read-only mode')
      try { return await manager.exec(rootKey(exec.agent), { ...args, signal: exec.signal }) } catch (error) { throw fail(error) }
    },
  })

  tool({
    name: 'ssh_read',
    description: DESCRIPTION.read,
    parameters: {
      sessionId: { type: 'string', required: true },
      jobId: { type: 'string', description: 'Background job id; defaults to the current or latest job.' },
      offset: { type: 'number', description: 'Byte offset (default 0).' },
      limit: { type: 'number', description: 'Max bytes (default 65536, max 1048576).' },
    },
    async execute(args, exec) {
      if (readOnly(exec.agent)) throw new Error('[read-only] ssh_read is not available in read-only mode')
      try { return manager.read(rootKey(exec.agent), args) } catch (error) { throw fail(error) }
    },
  })

  tool({
    name: 'ssh_kill',
    description: DESCRIPTION.kill,
    parameters: { sessionId: { type: 'string', required: true } },
    async execute(args, exec) {
      try { return await manager.kill(rootKey(exec.agent), args.sessionId) } catch (error) { throw fail(error) }
    },
  })

  tool({
    name: 'ssh_list',
    description: DESCRIPTION.list,
    parameters: {},
    async execute(_args, exec) {
      return {
        sessions: manager.list(rootKey(exec.agent)),
        hosts: [...manager.hosts.values()].map((h) => ({ name: h.name, via: h.via, user: h.user, ...(h.userDefaulted ? { userFrom: 'local-login' } : {}) })),
        enabled: manager.settings.enabled,
        projection: { key: PROJECTION_KEY, registered: projectionRegistration.registered, ...(projectionRegistration.error === null ? {} : { error: projectionRegistration.error }) },
        ...(manager.configErrors.length > 0 ? { configErrors: manager.configErrors } : {}),
      }
    },
  })

  // DSH 会话关闭 → 其下 SSH 会话结束。
  ctx.effect(() => ctx.on('agent/disposed', ({ agent }) => {
    if (agent?.parent !== undefined) return
    void manager.ownerClosed(rootKey(agent))
  }), 'ssh.owner-closed')

  ctx.inject?.(['sessionProjections'], (child) => mountProjection(child))

  // /ssh 命令：标签页与设置页的按钮走这里（宿主 remote.commands 通道，不注册 HTTP 路由）。
  ctx.inject?.(['commands'], (child) => {
    child.commands.register({
      name: 'ssh',
      description: 'List or end SSH sessions: /ssh list | kill <id> | kill-all | kill-everywhere | leftovers | clear-leftovers',
      handler: async (invocation) => {
        const owner = rootKey(invocation.agent)
        const [action = 'list', arg] = String(invocation.rawInput ?? '').trim().split(/\s+/u)
        try {
          switch (action) {
            case 'list': {
              const rows = manager.list(owner)
              return { kind: 'success', text: rows.length === 0 ? '本会话没有 SSH 会话。' : rows.map((r) => `${r.sessionId} ${r.host} ${r.state}${r.mode ? '(' + r.mode + ')' : ''} ${r.cwd ?? ''}${r.deadReason ? ' · ' + r.deadReason : ''}`).join('\n') }
            }
            case 'kill': {
              if (arg === undefined) return { kind: 'error', text: '用法：/ssh kill <sessionId>' }
              const r = await manager.kill(owner, arg, { by: 'user' })
              return { kind: 'success', text: r.alreadyEnded ? `${arg} 早已结束（${r.reason}）。` : `${arg} 已结束。` }
            }
            case 'kill-all':
              await manager.closeOwner(owner, 'killed', { by: 'user' })
              return { kind: 'success', text: '本会话的 SSH 会话已全部结束。' }
            case 'kill-everywhere':
              if (arg !== 'confirm') return { kind: 'error', text: '会结束所有 DSH 会话里的 SSH 会话。确认请用：/ssh kill-everywhere confirm' }
              await manager.closeAll('killed', { by: 'user' })
              return { kind: 'success', text: '所有 SSH 会话已结束。' }
            case 'leftovers':
              return { kind: 'success', text: manager.leftovers.length === 0 ? '没有上次遗留的会话。' : manager.leftovers.map((l) => `${l.host} ${l.sessionId} pid=${l.pid ?? '?'} 打开于 ${new Date(l.openedAt).toISOString()}`).join('\n') + '\n远端进程不会被自动结束；需要的话请手动登录清理。' }
            case 'clear-leftovers':
              manager.leftovers = []
              persistRegistry()
              return { kind: 'success', text: '已清除「上次遗留」记录。' }
            default:
              return { kind: 'error', text: '用法：/ssh list | kill <id> | kill-all | kill-everywhere confirm | leftovers | clear-leftovers' }
          }
        } catch (error) {
          return { kind: 'error', text: error.message }
        }
      },
    })
  })

  return manager
}

function safeList(dir) { try { return readdirSync(dir) } catch { return [] } }

function pruneAudit(dir, days) {
  const cutoff = Date.now() - days * 86400000
  for (const name of safeList(dir)) {
    try { if (statSync(join(dir, name)).mtimeMs < cutoff) unlinkSync(join(dir, name)) } catch {}
  }
}

export { PROJECTION_KEY }
