// 插件页的显示元数据：locale 本地化、icon、以及详情文档的选择规则。
// 纯静态校验 —— 宿主那套 readPluginMeta / readPackageDocument 的规则在这里复刻一遍，
// 任何一条不满足，插件页上就会静默退化成「英文标题 + 英文 README」，构建期没信号。
import { readFileSync, statSync } from 'node:fs'
import { dirname, extname, join, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const manifestPath = join(ROOT, 'package.json')
const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'))

const results = []
const check = (label, pass, detail) => results.push((pass ? 'PASS ' : 'FAIL ') + label + (detail ? '  ::  ' + detail : ''))

/** 宿主的 icon 约束：svg/png/jpg/jpeg/webp，相对 manifest、不越界、≤256 KiB。 */
const ICON_MEDIA_TYPES = new Map([
  ['.svg', 'image/svg+xml'], ['.png', 'image/png'], ['.jpg', 'image/jpeg'],
  ['.jpeg', 'image/jpeg'], ['.webp', 'image/webp'],
])
const MAX_ICON_BYTES = 256 * 1024

/** 宿主的 locale 文件名约束。 */
const LANGUAGE_ID = /^[A-Za-z]{2,8}(?:-[A-Za-z0-9]{1,8})*$/u

/** 宿主的 README 选取规则：只有这五个名字参与竞争，按列表顺序排名，再按名字字典序。 */
const README_NAMES = ['README.md', 'readme.md', 'Readme.md', 'README.markdown', 'README']
const README_PATTERN = /^readme(?:\.md|\.markdown)?$/iu

/** 宿主的语言链：语言本身、逐段缩短、最后强制英文。 */
function languageChain(language) {
  const id = language.toLowerCase()
  if (!LANGUAGE_ID.test(id)) throw new Error('Not a language id: ' + language)
  const parts = id.split('-')
  const chain = parts.map((_part, index) => parts.slice(0, parts.length - index).join('-'))
  return [...new Set([...chain, 'en'])]
}

/** 宿主的 meta.detail 校验：包内相对的 Markdown 路径。 */
function detailPath(value) {
  if (typeof value !== 'string' || value.trim() === '') return undefined
  if (value.includes('\\') || /^[A-Za-z][A-Za-z\d+.-]*:/u.test(value)) return undefined
  if (value.split('/').some((segment) => segment === '' || segment === '.' || segment === '..')) return undefined
  return /\.(?:md|markdown)$/iu.test(value) ? value : undefined
}

/** 宿主挑详情文档：先按语言链找声明了 meta.detail 的 locale，否则回落到 README。 */
function pickDocument(language) {
  for (const candidate of languageChain(language)) {
    const names = [...new Set([candidate, candidate.replace(/^([a-z]{2,3})-([a-z]{2})$/u, (_m, base, region) => base + '-' + region.toUpperCase())])]
    for (const name of names) {
      let parsed
      try {
        parsed = JSON.parse(readFileSync(join(ROOT, 'locale', name + '.json'), 'utf8'))
      } catch {
        continue
      }
      const detail = detailPath(parsed?.meta?.detail)
      if (detail !== undefined) return { origin: 'locale', path: detail, file: name + '.json' }
      break
    }
  }
  const rank = (name) => {
    const index = README_NAMES.indexOf(name)
    return index === -1 ? README_NAMES.length : index
  }
  const names = readFileNames(ROOT)
  const name = names.filter((entry) => README_PATTERN.test(entry)).sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))[0]
  return name === undefined ? undefined : { origin: 'readme', path: name }
}

function readFileNames(directory) {
  try {
    return readdirSyncSorted(directory)
  } catch {
    return []
  }
}

import { readdirSync } from 'node:fs'
const readdirSyncSorted = (directory) => readdirSync(directory, { withFileTypes: true })
  .filter((entry) => entry.isFile() || entry.isSymbolicLink())
  .map((entry) => entry.name)

// 1. icon 字段与文件
const icon = manifest.icon
check('icon-declared', typeof icon === 'string' && icon.length > 0, JSON.stringify(icon ?? null))
{
  const relativeOk = typeof icon === 'string'
    && !icon.startsWith('/') && !/^[A-Za-z]:/u.test(icon) && !icon.includes('\\')
  const mediaType = relativeOk ? ICON_MEDIA_TYPES.get(extname(icon).toLowerCase()) : undefined
  check('icon-type', mediaType !== undefined, String(mediaType ?? 'unsupported extension'))
  if (relativeOk && mediaType !== undefined) {
    const file = resolve(dirname(manifestPath), icon)
    const local = relative(dirname(manifestPath), file)
    const inside = local !== '..' && !local.startsWith('..' + (process.platform === 'win32' ? '\\' : '/'))
    const size = statSync(file).size
    check('icon-inside-package', inside, local)
    check('icon-size', size <= MAX_ICON_BYTES, size + ' bytes')
    const text = readFileSync(file, 'utf8')
    check('icon-svg-shape', mediaType !== 'image/svg+xml' || (text.trimStart().startsWith('<svg') && text.trimEnd().endsWith('</svg>')), 'viewBox=' + String(/viewBox="([^"]+)"/u.exec(text)?.[1]))
  }
}

// 2. 资源必须可被宿主的 ESM 解析器解析到 —— 靠 exports 放行
{
  const exported = manifest.exports ?? {}
  check('locale-exported', Object.keys(exported).some((key) => /^\.\/locale\//u.test(key)), Object.keys(exported).join(' '))
  check('icon-exported', Object.hasOwn(exported, './icon') || Object.hasOwn(exported, './icon.svg'), Object.keys(exported).join(' '))
  check('packed-locale', (manifest.files ?? []).includes('locale'), JSON.stringify(manifest.files ?? []))
  check('packed-icon', (manifest.files ?? []).some((entry) => entry === 'icon.svg' || entry === icon), JSON.stringify(manifest.files ?? []))
}

// 3. 两份 locale 都要有标题与简介，英文是必填的回退
{
  const locales = readFileNames(join(ROOT, 'locale')).filter((name) => name.endsWith('.json'))
  check('locale-english-present', locales.includes('en.json'), locales.join(' '))
  for (const name of locales) {
    const language = name.slice(0, -5)
    check('locale-name-' + language, LANGUAGE_ID.test(language), name)
    const meta = JSON.parse(readFileSync(join(ROOT, 'locale', name), 'utf8'))?.meta
    for (const field of ['title', 'description']) {
      const value = meta?.[field]
      check('locale-' + language + '-' + field, typeof value === 'string' && value.trim() !== '', String(value ?? '').slice(0, 48))
    }
  }
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))?.meta
  check('locale-zh-title-localized', typeof zh?.title === 'string' && /[\u4e00-\u9fff]/u.test(zh.title), String(zh?.title ?? ''))
}

// 4. 中文详情文档
{
  const zh = JSON.parse(readFileSync(join(ROOT, 'locale', 'zh.json'), 'utf8'))?.meta
  const declared = detailPath(zh?.detail)
  check('detail-path-shape', declared === 'README.zh-CN.md', JSON.stringify(zh?.detail ?? null))
  check('detail-exists', declared !== undefined && statSafe(join(ROOT, declared)) > 0, String(statSafe(join(ROOT, declared ?? ''))))
}

// 5. 语言链上的真实选择
for (const [language, origin, path] of [['zh-CN', 'locale', 'README.zh-CN.md'], ['en-US', 'readme', 'README.md'], ['ja', 'readme', 'README.md']]) {
  const picked = pickDocument(language)
  check('pick-' + language, picked?.origin === origin && picked?.path === path, JSON.stringify(picked ?? null))
}
check('readme-zh-not-a-readme', !README_PATTERN.test('README.zh-CN.md'), 'README.zh-CN.md 只能靠 meta.detail 触达')

function statSafe(file) {
  try {
    return statSync(file).size
  } catch {
    return -1
  }
}

console.log(results.join('\n'))
const fails = results.filter((line) => line.startsWith('FAIL')).length
console.log('\nSUMMARY pass=' + (results.length - fails) + ' fail=' + fails)
process.exit(fails === 0 ? 0 : 1)
