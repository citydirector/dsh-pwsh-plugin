// 真运行时（LocalSubprocessRuntime / LocalSandboxProvider）只在 DSH 自己的安装目录里，
// 位置随安装方式而异：便携版是 <root>/app/node_modules/@deepseek-ai，桌面端在 app.asar 里。
// 环境变量优先，缺省按便携版默认布局探测；都没有就 SKIP，让测试在没装 DSH 的机器上跑完而不报假失败。
import { existsSync } from 'node:fs'
import { pathToFileURL } from 'node:url'

// Windows 子进程在缺少 SystemDrive/WINDIR 时会把 `%SystemDrive%` 当字面量建目录，
// 后续失败看起来像插件 bug。测试入口在这里直接报错，说清楚缺的是什么。
export function assertWindowsEnvironment(env = process.env, platform = process.platform) {
  if (platform !== 'win32') return
  const missing = ['SystemDrive', 'WINDIR'].filter((name) => {
    const key = Object.keys(env).find((item) => item.toLowerCase() === name.toLowerCase())
    return key === undefined || typeof env[key] !== 'string' || env[key].length === 0
  })
  if (missing.length > 0) {
    throw new Error('incomplete Windows environment: ' + missing.join(', ') + ' not set. '
      + 'Run the tests from a normal shell (not a sanitized env), or set them, e.g. SystemDrive=C: WINDIR=C:\\Windows.')
  }
}
assertWindowsEnvironment()

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
