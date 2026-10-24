/**
 * custom-bash —— Windows 上的 `bash` 工具（插件行，可在多个 agent 预设里各挂一份）
 *
 * 为什么需要它
 *   官方 persistent bash 依赖 PTY，而 DSH 的 PTY 后端只支持 linux/darwin，
 *   在 win32 上会直接报 "terminal inspection is unsupported"。本工具注册同名 `bash`、
 *   使用与 Minimal 相近的描述，但通过跨平台的 `ctx.subprocess.spawn` 起进程，
 *   从而在 Windows 上保留「首请求只有 bash」这一锚定 schema（issue #11）。
 *
 * Windows 适配
 *   Windows 上没有 Git Bash 时，PATH 上的 `bash` 通常是 WSL 垫片；
 *   组合里因此把 `bashPath` 指向 `C:\Windows\System32\bash.exe`，描述写明「WSL Debian」。
 *
 * 配置
 *   bashPath        可执行文件：绝对路径，或 `bash`（经 PATH 解析）。默认 `bash`。
 *   timeoutMs       单次命令超时，默认 120000。超时会终止进程并返回已收集的输出。
 *   maxOutputBytes  stdout / stderr 各自的收集上限，默认 64000。
 *   llrunPath       WSL 侧的 llrun 二进制（POSIX 路径）。默认 /usr/local/bin/llrun。
 *   fence           是否按 sandbox 权限档挂围栏，默认 true。
 *
 * 沙箱（2026-10-23）
 *   workspace-write / read-only 下经 `wsl/llrun` 起 bash：userns socket 掩蔽（docker 等）
 *   + landlock ABI 7 + /var/tmp 封印；read-only 走 `-r` 严格只读档（写入全拒、读取全留）。
 *   danger-full-access 走裸 bash —— 这是 DSH 既定语义（该档 bypasses confinement），不是缺口。
 *   llrun 缺失时 fail-closed 抛错，不会静默降级成无围栏。
 *
 * 语义
 *   每次调用都是全新进程，状态不跨调用保留。命令经 **stdin 送入 `bash -s`**，
 *   不再拼进 `bash -c` 字符串 —— 避开 Windows bash.exe 的 argv 引号怪癖（事故根因之一）。
 *   非零退出码不抛异常，而是在输出末尾注明退出码（与官方 bash 工具一致）；
 *   只有进程根本起不来时才抛错。
 *
 * 修复记录（2026-10-17）
 *   - `timeoutMs` 以前被解析后从未使用，长命令会无限挂起；现在真正生效。
 *   - 头注释说「非零退出码不抛」，代码却 throw；现以注释为准，改为返回。
 *   - `workdir` 传 WSL 路径（/mnt/d/...）时，以前直接当 Windows cwd 交给 spawn 会失败；
 *     现在 POSIX 路径改为在命令前 `cd`（有围栏时用 llrun 的 `-C`），Windows 路径仍作为进程 cwd。
 *   - 默认工作目录改为从 workingDirectory 服务读取（会话中途切目录后 header.cwd 不更新）。
 */

import { resolveCwd } from './compaction-epoch.mjs'

/** 加载器诊断里显示的插件名。 */
export const name = 'custom-bash'

/** 注册前必须已有的服务。 */
export const inject = ['subprocess', 'tools']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000
const DEFAULT_LLRUN_PATH = '/usr/local/bin/llrun'
const PROBE_TIMEOUT_MS = 8000

/** 面向模型的参数 schema。 */
const commandSchema = {
  type: 'object',
  properties: {
    command: {
      type: 'string',
      description: 'The bash command to execute (`bash` script domain, fed through stdin — no argument quoting involved).',
    },
    workdir: {
      type: 'string',
      description: 'Optional working directory (Windows path or WSL path such as /mnt/d/...); defaults to the session working directory.',
    },
  },
  required: ['command'],
  additionalProperties: false,
}

/** 单引号转义，用于把 POSIX 路径安全拼进 shell 片段。 */
const shellQuote = (value) => `'${String(value).replaceAll("'", "'\\''")}'`

/** 合并调用方的取消信号与本工具的超时信号。 */
function withTimeout(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal === undefined ? timeout : AbortSignal.any([signal, timeout])
}

/** Windows 绝对路径 → WSL 视角的 /mnt/<drive>/...；无法映射时返回 undefined。 */
function toWslPath(path) {
  if (typeof path !== 'string') return undefined
  const matched = /^([A-Za-z]):[\\/](.*)$/.exec(path)
  if (matched === null) return undefined
  return `/mnt/${matched[1].toLowerCase()}/${matched[2].replaceAll('\\', '/')}`
}

export function apply(ctx, config) {
  const bashPath = typeof config?.bashPath === 'string' && config.bashPath.length > 0 ? config.bashPath : 'bash'
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(config?.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES
  const llrunPath = typeof config?.llrunPath === 'string' && config.llrunPath.length > 0 ? config.llrunPath : DEFAULT_LLRUN_PATH
  const fenceEnabled = config?.fence !== false

  /** llrun 可执行性探测。成功结果跨调用缓存；失败不缓存，下次调用重新探测。 */
  let llrunReady = false
  async function probeLlrun(shell, cwd) {
    if (llrunReady) return true
    const handle = ctx.subprocess.spawn({
      argv: [shell, '-c', `test -x ${shellQuote(llrunPath)}`],
      ...cwd !== undefined ? { cwd } : {},
      stdio: { stdin: 'ignore', stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      graceMs: 3000,
    })
    const outcome = await handle.done.catch(() => undefined)
    llrunReady = outcome?.exitCode === 0
    return llrunReady
  }

  ctx.tools.register({
    name: 'bash',
    description: [
      'Run commands in a bash shell (WSL Debian on Windows)',
      '* When invoking this tool, the contents of the "command" parameter does NOT need to be XML-escaped.',
      '* Network access depends on the task environment. Prefer configured mirrors/proxies when they are available.',
      '* State does NOT persist across command calls: each call runs in a fresh shell.',
      "* To inspect a particular line range of a file, e.g. lines 10-25, try 'sed -n 10,25p /path/to/the/file'.",
      '* Please avoid commands that may produce a very large amount of output.',
      `* Each call times out after ${Math.round(timeoutMs / 1000)}s; detach long-lived processes (e.g. 'nohup cmd >log 2>&1 &').`,
      '* OS sandbox: in workspace-write and read-only sessions this shell runs under llrun (landlock + unix-socket masking + /var/tmp sealed; read-only additionally refuses every write). Writes outside the session workspace are denied in those modes. In danger-full-access no fence is applied.',
      '* Do not operate on Windows files from here — that is a workaround, not the intended path. Use `write` / `edit` / `pwsh_run` for anything on the Windows side.',
      '* Deleting files: send them to the Recycle Bin instead of a permanent delete. WSL-internal paths (/home/...) use `gio trash <path>`; /mnt/c and /mnt/d Windows files must go through `pwsh_run` with Microsoft.VisualBasic.FileIO.FileSystem SendToRecycleBin — gio trash there only creates a freedesktop dot-Trash-1000 folder per drive, which the Windows Explorer Recycle Bin cannot see or restore. Never `rm -rf` a path you have not verified.',
    ].join('\n'),
    parameters: commandSchema,
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
      const signal = withTimeout(exec?.signal, timeoutMs)
      const shell = await ctx.subprocess.resolveExecutable(bashPath, undefined, exec?.signal)

      // POSIX 路径（WSL 视角）不能作为 Windows 进程 cwd；
      // 有围栏时交给 llrun 的 `-C`（在 landlock 之后 chdir），无围栏时退化为命令内 cd。
      const requested = typeof args.workdir === 'string' && args.workdir.length > 0 ? args.workdir : undefined
      const posixDir = requested !== undefined && requested.startsWith('/') ? requested : undefined
      const baseCwd = requested !== undefined && posixDir === undefined
        ? requested
        : await resolveCwd(ctx, exec?.agent, exec?.signal)

      // 权限档。resolve 必须带 session —— 缺了它会静默退回部署默认值（workspaceRoot 指向 profile 目录）。
      const session = exec?.agent?.session
      const policy = ctx.get('sandboxPolicy')?.resolve(session === undefined ? {} : { session })
      if (fenceEnabled && policy === undefined) {
        throw new Error('bash fence requested but ctx.sandboxPolicy is absent — refusing to run unsandboxed;'
          + ' set the `fence: false` config to accept an unbounded shell.')
      }
      const mode = typeof policy?.mode === 'string' ? policy.mode : undefined
      const needFence = fenceEnabled && mode !== 'danger-full-access'

      let argv
      let script = args.command
      if (needFence) {
        if (!await probeLlrun(shell, baseCwd)) {
          throw new Error(`bash fence is required in ${mode} mode but llrun is not executable at ${llrunPath}`
            + ' — deploy wsl/llrun there (see README), or disable the fence explicitly with the `fence: false` config.')
        }
        const workspace = toWslPath(policy?.workspaceRoot) ?? toWslPath(baseCwd) ?? '-'
        const fenceArgs = []
        if (mode === 'read-only') fenceArgs.push('-r')
        if (posixDir !== undefined) fenceArgs.push('-C', shellQuote(posixDir))
        fenceArgs.push(shellQuote(workspace), '/bin/bash', '-s')
        argv = [shell, '-c', `exec ${shellQuote(llrunPath)} ${fenceArgs.join(' ')}`]
      } else {
        if (posixDir !== undefined) script = `cd ${shellQuote(posixDir)} && ${args.command}`
        argv = [shell, '-s']
      }

      const handle = ctx.subprocess.spawn({
        argv,
        cwd: baseCwd,
        stdio: {
          stdin: { data: script },
          stdout: { maxBytes: maxOutputBytes },
          stderr: { maxBytes: maxOutputBytes },
        },
        signal,
        graceMs: 3000,
      })

      let outcome
      try {
        outcome = await handle.done
      } catch (error) {
        if (signal.aborted && exec?.signal?.aborted !== true) {
          outcome = { exitCode: null, timedOut: true }
        } else {
          throw new Error(`bash spawn failed: ${String(error)}`)
        }
      }

      let stdout = ''
      let stderr = ''
      try {
        stdout = handle.collected.stdout.readFrom(0).text
        stderr = handle.collected.stderr.readFrom(0).text
      } catch {
        // 收集缓冲区读取失败时按「无输出」处理。
      }
      const body = [stdout, stderr].filter((part) => part.length > 0).join('\n')
      const notes = []
      if (outcome?.timedOut === true || (signal.aborted && exec?.signal?.aborted !== true)) {
        notes.push(`[timed out after ${Math.round(timeoutMs / 1000)}s]`)
      }
      if (outcome?.exitCode !== undefined && outcome.exitCode !== 0) notes.push(`exit code: ${outcome.exitCode}`)
      const text = [body, ...notes].filter((part) => part.length > 0).join('\n')
      return { text: text.length > 0 ? text : 'exit code: 0 (no output)' }
    },
  })
}
