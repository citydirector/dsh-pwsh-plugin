/**
 * pwsh-run 的更新检查 —— 只查不装。装这一步由 update-apply.mjs 走 DSH 自己的 pluginManager。
 *
 * 为什么单独一个模块
 *   这个插件是纯宿主平面的工具插件，没有配置页面，也没有 client 入口。
 *   把「读发布源 / 比版本 / 记状态」这几件事独立出来，就能在纯 node 里
 *   完整单测，不必起一个 DSH。
 *
 * 发布源是 npm registry，不是 git 标签
 *   早期版本读 GitHub 的 vX.Y.Z 标签，安装规格是 github:owner/repo#vX.Y.Z。
 *   改到 registry 之后同一份发布既是 npm 包、也是 profile 里能被 pnpm 解析的依赖，
 *   「装到的是哪个版本」由 pnpm 说了算，插件不必自己拼 git 规格。
 *   更要紧的一条：pnpm 有供应链冷却期（minimumReleaseAge，默认 1440 分钟），
 *   当天发布的版本当天可能解析不到 —— 于是「最新版」与「实际装到的版本」不是一回事。
 *   检查阶段只认 registry 的 dist-tags，安装之后必须回读磁盘上的版本，
 *   拿这里的判决去宣称装好了就是在说一句没人验证过的话。
 *
 * 它做什么
 *   启动几秒后读一次 registry 的 dist-tags.latest，之后大约每 12 小时再读一次，
 *   与 package.json 里的版本比较。**从不自己安装**：发现新版本时只把版本号与
 *   安装规格（<package>@X.Y.Z）记下来。一个版本一个规格，所以装新版本就是盖掉旧的。
 *
 * 发布源可覆盖
 *   DSH_PWSH_UPDATE_REGISTRY 覆盖 registry 基址（测试与自建镜像靠它）。
 *   DSH_PWSH_UPDATE_DELAY_MS 覆盖首次检查的延迟（测试用）。
 */

import { readFileSync } from 'node:fs'

/** 发布在哪：这个包名在 npm registry 上的 dist-tags 就是发布。 */
export const UPDATE_PACKAGE = 'dsh-pwsh-plugin'

/** 默认 registry。 */
export const UPDATE_REGISTRY = 'https://registry.npmjs.org'

/** 启动后先让启动流程跑完，再查更新。 */
const UPDATE_DELAY_MS = 5000
const UPDATE_INTERVAL_MS = 12 * 60 * 60 * 1000

/** 三段数字，可选预发布尾巴；npm 的版本号允许的形态。 */
const RELEASE_VERSION = /^(?:v)?(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-([0-9A-Za-z.-]+))?$/

/**
 * 读一个版本号。
 *
 * @param value - 版本号，可带 v 前缀与预发布尾巴（1.2.3 / v1.2.3 / 1.2.3-rc.1）。
 * @returns `{ parts: [major, minor, patch], prerelease }`；不是版本形态时返回 undefined。
 */
export function parseVersion(value) {
  const match = RELEASE_VERSION.exec(String(value ?? '').trim())
  if (match === null) return undefined
  const prerelease = match[4] === undefined ? undefined : match[4]
  return { parts: [Number(match[1]), Number(match[2]), Number(match[3])], prerelease }
}

/**
 * 比两个版本，写 X.Y.Z 或 vX.Y.Z 都行。
 *
 * 预发布（1.2.3-rc.1）按 semver 的规矩排在对应的正式版**之下**：
 * 否则一个 rc 会被当成「比 1.2.3 还新」，自动更新就会把用户推到预发布上。
 *
 * @returns 像排序比较器那样返回负数、零或正数；解析不出来的版本排在所有能解析的之下。
 */
export function compareVersions(a, b) {
  const pa = parseVersion(a)
  const pb = parseVersion(b)
  if (pa === undefined || pb === undefined) return (pa === undefined ? 0 : 1) - (pb === undefined ? 0 : 1)
  for (let i = 0; i < 3; i += 1) if (pa.parts[i] !== pb.parts[i]) return pa.parts[i] - pb.parts[i]
  if (pa.prerelease === pb.prerelease) return 0
  // 都没有预发布尾巴 → 相等（上面已处理）；一个有一个没有 → 有尾巴的那个更旧。
  if (pa.prerelease === undefined) return 1
  if (pb.prerelease === undefined) return -1
  return pa.prerelease < pb.prerelease ? -1 : pa.prerelease > pb.prerelease ? 1 : 0
}

/**
 * 发布从哪来。默认是 npm 公共 registry；DSH_PWSH_UPDATE_REGISTRY 可以指向自建镜像
 * 或测试用的本地服务器 —— 发布正式上线前先在本地预演就靠它。
 *
 * @param env - 要读的环境。
 * @returns `{ kind: 'registry', registry, name, spec }`；`spec` 是不带版本的安装规格。
 */
export function updateSource(env = process.env) {
  const raw = String(env.DSH_PWSH_UPDATE_REGISTRY ?? '').trim()
  const registry = raw.length === 0 ? UPDATE_REGISTRY : raw.replace(/\/+$/, '')
  return { kind: 'registry', registry, name: UPDATE_PACKAGE, spec: UPDATE_PACKAGE }
}

/** 一个发布的、钉住版本号的安装规格：每个版本一个规格，DSH 会拿它盖掉旧的。 */
export function releaseSpec(source, version) {
  return source.name + '@' + String(version).replace(/^v/, '')
}

/**
 * 读 registry 上的包摘要（abbreviated metadata）。
 *
 * 用 abbreviated 而不是完整文档：完整文档带每个版本的全部 package.json，动辄几百 KB，
 * 而这里只需要 dist-tags 与版本清单。
 *
 * @param source - 由 updateSource() 给出。
 * @param options - `{ fetch, signal }`：可替换的 fetch（测试用）与中止信号。
 * @returns `{ latest, versions, deprecated }`：dist-tags.latest、版本清单、被废弃的版本集合。
 */
export async function fetchRegistry(source, { fetch: fetchImpl = globalThis.fetch, signal } = {}) {
  const url = source.registry + '/' + encodeURIComponent(source.name)
  const response = await fetchImpl(url, {
    headers: { accept: 'application/vnd.npm.install-v1+json', 'user-agent': 'dsh-pwsh-plugin' },
    signal,
  })
  if (!response.ok) {
    // 404 是「这个包还不存在」，与「网络不通」必须分开说：前者重试一万次也不会好。
    const reason = response.status === 404 ? 'not published on ' + source.registry : 'registry answered HTTP ' + response.status
    throw new Error(reason)
  }
  const body = await response.json()
  if (body === null || typeof body !== 'object') throw new Error('registry answered something other than a package document')
  const versions = Object.keys(body.versions ?? {})
  const deprecated = new Set(versions.filter((version) => typeof body.versions[version]?.deprecated === 'string'))
  const tagged = body['dist-tags']?.latest
  return {
    ...(typeof tagged === 'string' ? { latest: tagged } : {}),
    versions,
    deprecated,
  }
}

/**
 * 拿 registry 的摘要与正在跑的版本比一次。
 *
 * dist-tags.latest 缺失时从版本清单里挑：只认正式版（预发布不自动推），取语义最高。
 *
 * @param document - fetchRegistry() 的返回。
 * @param current - 本包版本（X.Y.Z）。
 * @returns 有更新的发布时 `{ state: 'available', latest }`，否则 `{ state: 'current', latest? }`。
 */
export function updateVerdict(document, current) {
  const versions = Array.isArray(document?.versions) ? document.versions : []
  const deprecated = document?.deprecated instanceof Set ? document.deprecated : new Set()
  let latest = typeof document?.latest === 'string' ? document.latest : undefined
  if (latest === undefined) {
    for (const version of versions) {
      const parsed = parseVersion(version)
      if (parsed === undefined || parsed.prerelease !== undefined || deprecated.has(version)) continue
      if (latest === undefined || compareVersions(version, latest) > 0) latest = version
    }
  }
  // 被标为 deprecated 的「最新版」不可信：那是发布者自己说的「别用这个」。
  if (latest !== undefined && deprecated.has(latest)) return { state: 'current', deprecated: latest }
  if (latest !== undefined && compareVersions(latest, current) > 0) return { state: 'available', latest }
  return { state: 'current', ...(latest !== undefined ? { latest } : {}) }
}

/**
 * 本包自己的版本。每次**调用**都现读 package.json —— 注意 UpdateChecker 只在构造时调一次，
 * 所以实例上的版本是构造那一刻的磁盘值。热替换会重新 apply、重建实例，两者因此仍然对齐。
 */
export function packageVersion(fromUrl = import.meta.url) {
  try {
    const pkg = JSON.parse(readFileSync(new URL('../package.json', fromUrl), 'utf8'))
    return typeof pkg.version === 'string' ? pkg.version : undefined
  } catch {
    return undefined
  }
}

/**
 * 一个更新检查器：定时读 registry、记下判决、供工具层取用。
 *
 * 状态 `state`：off | pending | checking | current | available | failed。
 * 任何失败（断网、镜像挂掉、包还没发布）只记下来给调用方看，绝不抛出，也不提前重试：
 * 下一轮定时检查会再试。
 */
export class UpdateChecker {
  /**
   * @param options - `{ env, fetch, delayMs, intervalMs, log, source, version }`。
   *   `version` 缺省时在**构造这一刻**读一次本包 package.json，之后固定在实例上；
   *   `log` 是接受一行文本的日志函数。
   */
  constructor(options = {}) {
    this.env = options.env ?? process.env
    this.fetch = options.fetch
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
    this.checking = fetchRegistry(this.source, { ...(this.fetch === undefined ? {} : { fetch: this.fetch }), signal })
      .then((document) => {
        const verdict = updateVerdict(document, this.version)
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
