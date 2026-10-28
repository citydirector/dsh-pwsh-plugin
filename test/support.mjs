// 真运行时（LocalSubprocessRuntime / LocalSandboxProvider）只在 DSH 自己的安装目录里，
// 位置随安装方式而异：便携版是 <root>/app/node_modules/@deepseek-ai，桌面端在 app.asar 里。
// 环境变量优先，缺省按便携版默认布局探测；都没有就 SKIP，让测试在没装 DSH 的机器上跑完而不报假失败。
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

const PORTABLE_DEFAULT = 'app/node_modules/@deepseek-ai'
const DESKTOP_DEFAULT = 'resources/app.asar/dsh/node_modules/@deepseek-ai'

const clean = (value) => {
  if (typeof value !== 'string' || value.length === 0) return undefined
  return value.replace(/[\\/]+$/, '')
}

function defaultRoots() {
  const roots = []
  // DSH_HOME 是数据根，安装根通常是它的上一级（便携版布局）。
  const home = clean(process.env.DSH_HOME)
  if (home !== undefined) roots.push(home.replace(/[\\/]data$/, '') + '/' + PORTABLE_DEFAULT)
  const cwd = clean(process.cwd())
  if (cwd !== undefined) {
    // 从工作区逐级往上找，最多十层。
    let dir = cwd
    for (let i = 0; i < 10 && dir.length > 3; i += 1) {
      roots.push(dir + '/' + PORTABLE_DEFAULT, dir + '/' + DESKTOP_DEFAULT)
      const next = dir.replace(/[\\/][^\\/]+$/, '')
      if (next === dir) break
      dir = next
    }
  }
  return roots.filter((root) => existsSync(root))
}

export const moduleRoots = [
  clean(process.env.DSH_MODULES_ASAR),
  clean(process.env.DSH_MODULES),
  ...defaultRoots(),
].filter((root) => root !== undefined)

/** 逐个候选根目录尝试 import，第一个成功的胜出；全失败返回 undefined。 */
export async function importFromDsh(rel) {
  for (const root of moduleRoots) {
    try {
      return await import(pathToFileURL(root + '/' + rel).href)
    } catch {
      // 换下一个候选根目录。
    }
  }
  return undefined
}

export const SKIP_HINT =
  'SKIP: no DSH runtime found. Set DSH_MODULES to <dsh install>/node_modules/@deepseek-ai,'
  + ' or DSH_MODULES_ASAR to <asar>/dsh/node_modules/@deepseek-ai.'

/** Windows 盘符路径对应的 WSL 路径：D:\\ws 变成 /mnt/d/ws。 */
export function toWslPath(winPath) {
  const match = /^([A-Za-z]):[\\/]?(.*)$/.exec(winPath)
  if (match === null) return undefined
  return '/mnt/' + match[1].toLowerCase() + '/' + match[2].replaceAll('\\', '/')
}
/**
 * 一个只服务一个包的假 npm registry。
 *
 * 更新检查现在读的是 registry 的 abbreviated metadata（`application/vnd.npm.install-v1+json`），
 * 这一层用真 HTTP 起，才能把「accept 头对不对、404 与网络故障要不要分开、dist-tags 缺了怎么办」
 * 一起测到 —— 用一个假 fetch 返回对象的话，这些全都测不出来。
 *
 * @param packages - 包名 → 摘要文档；值写 null 表示这个包在 registry 上不存在（回 404）。
 * @param options - `{ ttl }`：文档变更后是否要让客户端重新取（这里不做缓存，保留参数位）。
 * @returns `{ url, requests, set, close }`；`set` 可以在运行中换掉某个包的文档。
 */
export async function startRegistry(packages, options = {}) {
  const { createServer } = await import('node:http')
  const state = new Map(Object.entries(packages))
  const requests = []
  const server = createServer((request, response) => {
    const name = decodeURIComponent(String(request.url ?? '/').replace(/^\/+/, ''))
    requests.push({ name, accept: String(request.headers.accept ?? '') })
    const doc = state.get(name)
    // 每个响应都关掉连接：undici 会为 keep-alive 的空闲连接留一个解析器超时计时器，
    // 而有的测试会临时压缩全局 setTimeout（用它记录退避间隔），那个计时器就会被提前触发并抛错。
    // 这与被测代码毫无关系，让连接短命是最省事的解法。
    response.setHeader('connection', 'close')
    if (doc === undefined || doc === null) {
      response.writeHead(404, { 'content-type': 'application/json' })
      response.end(JSON.stringify({ error: 'Not found' }))
      return
    }
    response.writeHead(200, { 'content-type': 'application/json' })
    response.end(JSON.stringify(doc))
  })
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const address = server.address()
  const url = 'http://127.0.0.1:' + String(address.port)
  return {
    url,
    requests,
    set(name, doc) {
      state.set(name, doc)
    },
    async close() {
      await new Promise((resolve) => server.close(resolve))
    },
    // 断开现有 keep-alive 连接：客户端（undici）那边的解析器超时计时器随之清掉，
    // 于是「压缩全局 setTimeout」这类测试手法不会再误伤它。
    closeConnections() {
      server.closeAllConnections?.()
    },
    // 让调用方知道服务确实在监听：有些平台要在 listen 之后才真正可连。
    ready: options.ready ?? true,
  }
}

/**
 * 造一份 registry 摘要文档（abbreviated metadata）。
 *
 * @param tags - dist-tags，例如 `{ latest: '0.2.13' }`。
 * @param versions - 版本号 → `{ deprecated? }`。
 */
export function packageDocument(tags, versions) {
  const doc = { name: 'dsh-pwsh-plugin', 'dist-tags': tags, versions: {} }
  for (const [version, extra] of Object.entries(versions)) doc.versions[version] = { version, ...extra }
  return doc
}