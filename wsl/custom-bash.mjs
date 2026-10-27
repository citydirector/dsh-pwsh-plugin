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
 *   bashPath        可执行文件：绝对路径，或 `bash`（经 PATH 解析）。默认 `bash`，
 *                   解不到时再试 win32 上的 C:\Windows\System32\bash.exe（同一个 WSL 垫片），
 *                   免得 PATH 少一项整个工具就废掉。显式给绝对路径则只认那一个。
 *   timeoutMs       单次命令超时，默认 120000。超时会终止进程并返回已收集的输出。
 *   maxOutputBytes  stdout / stderr 各自的收集上限，默认 64000。
 *   llrunPath       WSL 侧的 llrun 二进制（POSIX 路径）。默认按顺序探测 $LLRUN、
 *                   <DSH_HOME>/bin/llrun、/usr/local/bin/llrun、~/.local/bin/llrun，
 *                   最后才用包内自带的 wsl/llrun —— 显式安装的优先，包里那份只负责开箱可用。
 *                   取第一个可执行的；探测结果缓存，装好即生效，不必重启。
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
 * 几处容易踩反的细节
 *   - `timeoutMs` 必须真落成 timer：只解析不使用会让长命令无限挂住整个工具调用。
 *   - POSIX 路径的 `workdir` 不能当 Windows 进程 cwd（spawn 直接失败）；
 *     有围栏时交给 llrun 的 `-C`（在 landlock 之后 chdir），无围栏时退化为命令内 `cd`。
 *   - 默认工作目录取自 workingDirectory 服务而非 header.cwd：会话中途切目录后 header 不更新。
 */

import { fileURLToPath } from 'node:url'

import { resolveCwd } from './compaction-epoch.mjs'

/** 加载器诊断里显示的插件名。 */
export const name = 'custom-bash'

/** 注册前必须已有的服务。 */
export const inject = ['subprocess', 'tools']

/**
 * `bash` 解不出来时的后备可执行文件。
 * PATH 上缺 System32 是真实会发生的（进程环境块可能停在旧快照上），
 * 而 WSL 垫片的位置是固定的，写死它比让整个工具报 "not found on PATH" 划算。
 * 只在配置给的是裸名时启用；给了绝对路径就只认那一个。
 */
const WINDOWS_BASH_FALLBACKS = ['C:\\Windows\\System32\\bash.exe']

const DEFAULT_TIMEOUT_MS = 120000
const DEFAULT_MAX_OUTPUT_BYTES = 64000
const PROBE_TIMEOUT_MS = 8000

/**
 * 本文件同目录的 llrun，也就是随插件包一起发布的那份。
 * 从包加载时它是真的存在（bundle 把这一行指进 node_modules），
 * 所以「装完就能用」不依赖用户往系统目录里放东西。
 * 非 file: 协议加载（测试里的 data: URL 之类）时拿不到路径，返回 undefined。
 */
function packagedLlrunPath() {
  try {
    // 目录 URL 带尾分隔符，去掉再转，免得拼出双斜杠。
    return toWslPath(fileURLToPath(new URL('.', import.meta.url)).replace(/[\\/]$/, ''))
  } catch {
    return undefined
  }
}

/**
 * llrun 的候选位置。显式配置 llrunPath 时只用那一个；否则按顺序探测第一个可执行的。
 * 用户自己装的排在包内那份前面：系统级的 llrun 可能更新，包内的只保证可用。
 * /usr/local/bin 在多数发行版属于 root，普通用户装不进去，所以用户可写的位置也要列上。
 */
function defaultLlrunCandidates() {
  const candidates = []
  const fromEnv = process.env.LLRUN ?? process.env.DSH_LLRUN
  if (typeof fromEnv === 'string' && fromEnv.length > 0) candidates.push(fromEnv)
  // DSH_HOME 是 Windows 路径，转成 WSL 视角后才能 test -x。
  const posixHome = toWslPath(process.env.DSH_HOME)
  if (posixHome !== undefined) candidates.push(posixHome + '/bin/llrun')
  candidates.push('/usr/local/bin/llrun', '~/.local/bin/llrun')
  const packaged = packagedLlrunPath()
  if (packaged !== undefined) candidates.push(packaged + '/llrun')
  return [...new Set(candidates)]
}

/**
 * 构造探测脚本，经 stdin 送给 `bash -s`。
 * 不能走 `bash -c`：Windows 上的 WSL 垫片 bash.exe 会把 `-c` 的正文里
 * 单字母变量赋值 `x=abc` 整个吃掉（实测 `x=abc; echo "x=$x"` 输出 `x=`），
 * 探测会因此算出错误的候选序号。走 stdin 完全避开这层改写。
 * 结果只走退出码：0 = 一个都没有，N = 第 N 个候选可执行；不读 stdout，
 * 因为收集缓冲区只在 stdio 声明为 collect 时才存在，不该把可用性押在它上面。
 * 候选里的 ~ 在这里展开：用引号包起来的路径不会被 bash 做 tilde 展开。
 */
function llrunProbeScript(candidates) {
  const lines = ['index=0']
  for (const candidate of candidates) {
    // ~ 在生成时展开成 $HOME，留给 bash 自己解析，不写死探测时的家目录。
    const path = candidate.startsWith('~/') ? '$HOME/' + candidate.slice(2) : candidate
    lines.push('index=$((index + 1))')
    lines.push('if [ -x "' + path + '" ]; then exit "$index"; fi')
  }
  lines.push('exit 0')
  return lines.join('\n')
}

/**
 * 把命中路径变成可以安全跟在 `exec` 后面的词。
 * `~/` 开头的候选由 bash 自己的 $HOME 展开，所以这一支不能加单引号。
 */
function llrunExecWord(path) {
  if (path.startsWith('~/')) return '"$HOME/' + path.slice(2) + '"'
  return shellQuote(path)
}

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
  // 裸名才允许走后备：显式绝对路径是用户的明确选择，替他改路径反而掩盖配置错误。
  const bashCandidates = bashPath === 'bash' && process.platform === 'win32'
    ? ['bash', ...WINDOWS_BASH_FALLBACKS]
    : [bashPath]
  const timeoutMs = Number.isSafeInteger(config?.timeoutMs) && config.timeoutMs > 0 ? config.timeoutMs : DEFAULT_TIMEOUT_MS
  const maxOutputBytes = Number.isSafeInteger(config?.maxOutputBytes) && config.maxOutputBytes > 0 ? config.maxOutputBytes : DEFAULT_MAX_OUTPUT_BYTES
  // 显式配置时只认那一个；否则探测候选。解析结果跨调用缓存，失败不缓存。
  const configuredLlrun = typeof config?.llrunPath === 'string' && config.llrunPath.length > 0 ? config.llrunPath : undefined
  const llrunCandidates = configuredLlrun === undefined ? defaultLlrunCandidates() : [configuredLlrun]
  const fenceEnabled = config?.fence !== false

  /**
   * bash 解析：按 bashCandidates 顺序问 subprocess 服务，第一个解出来的胜出。
   * 缓存成功结果、不缓存失败 —— PATH 修好之后下一次调用立刻能用，不必重启 DSH。
   * 全都解不出来时把最后一个错误抛出去：它带的是 "was not found on PATH"，
   * 只有一次 resolve 时也就是原来的行为，文案不变。
   */
  let resolvedShell
  async function resolveShell(signal) {
    if (resolvedShell !== undefined) return resolvedShell
    let lastError
    for (const candidate of bashCandidates) {
      try {
        resolvedShell = await ctx.subprocess.resolveExecutable(candidate, undefined, signal)
        return resolvedShell
      } catch (error) {
        lastError = error
      }
    }
    throw lastError
  }

  /**
   * llrun 解析：返回真正可执行的那个路径，探测不到返回 undefined。
   * 成功结果跨调用缓存（同一进程里 llrun 不会凭空消失），失败不缓存，
   * 这样用户装好之后下一次调用就能直接用，不必重启 DSH。
   */
  let resolvedLlrun
  async function resolveLlrun(shell, cwd) {
    if (resolvedLlrun !== undefined) return resolvedLlrun
    const handle = ctx.subprocess.spawn({
      argv: [shell, '-s'],
      ...cwd !== undefined ? { cwd } : {},
      stdio: { stdin: { data: llrunProbeScript(llrunCandidates) }, stdout: { maxBytes: 4096 }, stderr: { maxBytes: 4096 } },
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
      graceMs: 3000,
    })
    const outcome = await handle.done.catch(() => undefined)
    const index = outcome?.exitCode
    if (!Number.isInteger(index) || index < 1 || index > llrunCandidates.length) return undefined
    resolvedLlrun = llrunCandidates[index - 1]
    return resolvedLlrun
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
      const shell = await resolveShell(exec?.signal)

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
        const llrunPath = await resolveLlrun(shell, baseCwd)
        if (llrunPath === undefined) {
          throw new Error(`bash fence is required in ${mode} mode but llrun was not found; looked for: ${llrunCandidates.join(', ')}`
            + ' — deploy wsl/llrun to one of them (see README), set the `llrunPath` config, or disable the fence'
            + ' explicitly with the `fence: false` config.')
        }
        const workspace = toWslPath(policy?.workspaceRoot) ?? toWslPath(baseCwd) ?? '-'
        const fenceArgs = []
        if (mode === 'read-only') fenceArgs.push('-r')
        if (posixDir !== undefined) fenceArgs.push('-C', shellQuote(posixDir))
        fenceArgs.push(shellQuote(workspace), '/bin/bash', '-s')
        argv = [shell, '-c', `exec ${llrunExecWord(llrunPath)} ${fenceArgs.join(' ')}`]
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
