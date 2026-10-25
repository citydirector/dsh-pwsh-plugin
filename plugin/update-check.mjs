/**
 * pwsh-run 的更新检查 —— 只查不发，安装交给用户自己（sidepanel 或 `dsh plugin` CLI）。
 *
 * 为什么单独一个模块
 *   这个插件是纯宿主平面的工具插件，没有配置页面，也没有 client 入口。
 *   把「读发布标签 / 比版本 / 记状态」这几件事独立出来，就能在纯 node 里
 *   完整单测，不必起一个 DSH。
 *
 * 它做什么
 *   启动几秒后读一次发布源的 vX.Y.Z 标签，之后大约每 12 小时再读一次，
 *   与 package.json 里的版本比较。**从不自己安装**：发现新版本时只把
 *   版本号与 tag 钉住的安装规格（github:owner/repo#vX.Y.Z）记下来，
 *   由外部去装。一个 tag 一个规格，所以装新版本就是盖掉旧的，不需要额外逻辑。
 *   这里刻意不调 plugin_manager：组合里它默认关着，调不存在的东西会让提示变成谎话。
 *
 * 发布源可覆盖
 *   DSH_PWSH_UPDATE_SOURCE 可以是 owner/repo，也可以是任意 git URL
 *   （git+file:///…、git+https://…）。本地仓库预演发布就靠它。
 *   DSH_PWSH_UPDATE_API 覆盖 GitHub API 基址，DSH_PWSH_UPDATE_DELAY_MS
 *   覆盖首次检查的延迟（测试用）。
 */

import { execFile } from 'node:child_process'
import { readFileSync } from 'node:fs'

/** 发布在哪：这个仓库的 vX.Y.Z 标签就是发布。 */
export const UPDATE_REPOSITORY = 'citydirector/dsh-pwsh-plugin'

/** 启动后先让启动流程跑完，再查更新。 */
const UPDATE_DELAY_MS = 5000
const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000

/** 一个发布标签：v + 三段数字，后面不能再有东西（预发布版本永不推送）。 */
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/

/**
 * 读一个发布标签。
 *
 * @param tag - git 标签名。
 * @returns `[major, minor, patch]`；不是 vX.Y.Z 形态时返回 undefined。
 */
export function parseReleaseTag(tag) {
  const match = RELEASE_TAG.exec(String(tag ?? '').trim())
  return match === null ? undefined : [Number(match[1]), Number(match[2]), Number(match[3])]
}

/**
 * 比两个版本，写 X.Y.Z 或 vX.Y.Z 都行。
 *
 * @returns 像排序比较器那样返回负数、零或正数；解析不出来的版本排在所有能解析的之下。
 */
export function compareVersions(a, b) {
  const tag = (value) => (String(value ?? '').startsWith('v') ? String(value) : 'v' + String(value))
  const pa = parseReleaseTag(tag(a))
  const pb = parseReleaseTag(tag(b))
  if (pa === undefined || pb === undefined) return (pa === undefined ? 0 : 1) - (pb === undefined ? 0 : 1)
  for (let i = 0; i < 3; i += 1) if (pa[i] !== pb[i]) return pa[i] - pb[i]
  return 0
}

/**
 * 标签里的最新发布：只认 vX.Y.Z，按语义版本取最高（不是按日期或列表顺序）。
 *
 * @param tags - 标签名，顺序无所谓。
 * @returns 最新的发布标签；一个都没有时返回 undefined。
 */
export function latestRelease(tags) {
  let best
  for (const tag of tags ?? []) {
    if (parseReleaseTag(tag) === undefined) continue
    if (best === undefined || compareVersions(tag, best) > 0) best = tag
  }
  return best
}

/**
 * 发布从哪来。默认是 GitHub 仓库；DSH_PWSH_UPDATE_SOURCE 可以指向另一个
 * GitHub 仓库（owner/repo）或任意 git URL，发布正式上线前先在本地仓库预演就靠它。
 *
 * @param env - 要读的环境。
 * @returns `{ kind: 'github', repository, spec }` 或 `{ kind: 'git', url, spec }`；
 *   `spec` 是不带 #tag 的安装规格。
 */
export function updateSource(env = process.env) {
  const raw = String(env.DSH_PWSH_UPDATE_SOURCE ?? '').trim()
  if (/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(raw)) return { kind: 'github', repository: raw, spec: 'github:' + raw }
  if (/^git(\+[a-z]+)?:\/\//i.test(raw)) return { kind: 'git', url: raw.replace(/^git\+/i, ''), spec: raw }
  return { kind: 'github', repository: UPDATE_REPOSITORY, spec: 'github:' + UPDATE_REPOSITORY }
}

/** 一个发布的、钉住 tag 的安装规格：每个版本一个规格，DSH 会拿它盖掉旧的。 */
export function releaseSpec(source, tag) {
  return source.spec + '#' + tag
}

/**
 * 读发布源的全部标签。
 *
 * @param source - 由 updateSource() 给出。
 * @param options - `{ api, signal }`：GitHub API 基址、中止信号。
 * @returns 标签名（GitHub 侧是 API 列出的最新 100 个）。
 */
export async function fetchReleaseTags(source, { api = 'https://api.github.com', signal } = {}) {
  if (source.kind === 'git') {
    const output = await new Promise((resolve, reject) => {
      execFile('git', ['ls-remote', '--tags', '--', source.url], { timeout: 20000, signal, env: { ...process.env, GIT_TERMINAL_PROMPT: '0' } }, (error, stdout) => {
        if (error) reject(error)
        else resolve(stdout)
      })
    })
    return output.split('\n').map((line) => /refs\/tags\/([^\s^]+)$/.exec(line.trim())?.[1]).filter(Boolean)
  }
  const response = await fetch(api.replace(/\/+$/, '') + '/repos/' + source.repository + '/tags?per_page=100', {
    headers: { accept: 'application/vnd.github+json', 'user-agent': 'dsh-pwsh-plugin', 'x-github-api-version': '2022-11-28' },
    signal,
  })
  if (!response.ok) {
    const limited = response.status === 403 || response.status === 429
    throw new Error(limited ? 'GitHub rate limit (HTTP ' + response.status + ')' : 'GitHub answered HTTP ' + response.status)
  }
  const body = await response.json()
  if (!Array.isArray(body)) throw new Error('GitHub answered something other than a tag list')
  return body.map((item) => item?.name).filter((name) => typeof name === 'string')
}

/**
 * 拿标签表与正在跑的版本比一次。
 *
 * @param tags - 发布源的标签名。
 * @param current - 本包版本（X.Y.Z）。
 * @returns 有更新的发布时 `{ state: 'available', latest }`，否则 `{ state: 'current', latest? }`。
 */
export function updateVerdict(tags, current) {
  const latest = latestRelease(tags)
  if (latest !== undefined && compareVersions(latest, current) > 0) return { state: 'available', latest }
  return { state: 'current', ...(latest !== undefined ? { latest } : {}) }
}

/** 本包自己的版本，每次都现读：热替换之后读到的就是新版本。 */
export function packageVersion(fromUrl = import.meta.url) {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', fromUrl), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 一个更新检查器：定时读发布标签、记下判决、供工具层取用。
 *
 * 状态 `state`：off | pending | checking | current | available | failed。
 * 任何失败（断网、限流、没装 git）只记下来给调用方看，绝不抛出，也不提前重试：
 * 下一轮定时检查会再试。
 */
export class UpdateChecker {
  /**
   * @param options - `{ env, api, delayMs, intervalMs, log, source, version }`。
   *   `version` 缺省时读本包 package.json；`log` 是接受一行文本的日志函数。
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.api = options.api ?? this.env.DSH_PWSH_UPDATE_API ?? undefined
    this.delayMs = options.delayMs
    this.intervalMs = options.intervalMs ?? UPDATE_INTERVAL_MS
    this.log = options.log ?? (() => undefined)
    this.version = options.version ?? packageVersion()
    this.source = options.source ?? updateSource(this.env)
    this.state = { state: 'pending' }
    this.timer = undefined
    this.interval = undefined
    this.checking = undefined
    this.announced = undefined
    this.abort = new AbortController()
  }

  /** 已经报过的那次「有新版」：只在第一次把提示交给调用方，避免每次调用都刷一行。 */
  get announce() {
    if (this.state.state !== 'available') return undefined
    if (this.announced === this.state.latest) return undefined
    this.announced = this.state.latest
    return { latest: this.state.latest, spec: releaseSpec(this.source, this.state.latest) }
  }

  /** 开始定时检查。 */
  start() {
    if (this.timer !== undefined || this.interval !== undefined) return
    const delay = Number(this.env.DSH_PWSH_UPDATE_DELAY_MS ?? this.delayMs)
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.check()
      this.interval = setInterval(() => void this.check(), this.intervalMs)
      this.interval.unref?.()
    }, Number.isFinite(delay) && delay >= 0 ? delay : UPDATE_DELAY_MS)
    this.timer.unref?.()
  }

  /** 停掉定时检查并中止在途的那一次。 */
  stop() {
    clearTimeout(this.timer)
    clearInterval(this.interval)
    this.timer = undefined
    this.interval = undefined
    this.abort.abort()
  }

  /**
   * 立刻查一次（定时器与手动都走这里）。重入时返回同一次 Promise。
   *
   * @returns 查完之后的状态对象。
   */
  check() {
    if (this.checking !== undefined) return this.checking
    if (this.version === undefined) {
      this.state = { state: 'failed', error: 'own version unreadable', checkedAt: new Date().toISOString() }
      return Promise.resolve(this.state)
    }
    const previous = this.state
    this.state = { ...previous, state: 'checking' }
    const signal = AbortSignal.any([this.abort.signal, AbortSignal.timeout(20000)])
    this.checking = fetchReleaseTags(this.source, { api: this.api, signal })
      .then((tags) => {
        const verdict = updateVerdict(tags, this.version)
        this.state = { ...verdict, checkedAt: new Date().toISOString() }
        this.log('update check: ' + this.state.state + (this.state.latest === undefined ? '' : ' (newest ' + this.state.latest + ', running ' + this.version + ')'))
      }, (error) => {
        if (this.abort.signal.aborted) return
        const message = error?.name === 'TimeoutError' || error?.name === 'AbortError' ? 'timed out' : String(error?.message ?? error).split('\n')[0].slice(0, 200)
        // 早先查到过的发布不因一次瞬时失败而消失。
        this.state = {
          ...(previous.latest === undefined ? {} : { latest: previous.latest }),
          state: 'failed',
          error: message,
          checkedAt: new Date().toISOString(),
          ...(previous.state === 'available' ? { stale: 'available' } : {}),
        }
        this.log('update check failed: ' + message)
      })
      .finally(() => {
        this.checking = undefined
      })
    return this.checking.then(() => this.state)
  }

  /** 给调用方/测试看的一份纯净快照。 */
  document() {
    const doc = { ...this.state, source: this.source.spec }
    if (this.version !== undefined) doc.running = this.version
    if (doc.latest !== undefined) doc.spec = releaseSpec(this.source, doc.latest)
    return doc
  }
}
