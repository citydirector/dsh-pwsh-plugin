// 主机清单与审批名单：只在这里把用户配置变成可信结构，后面的代码不再校验。
// 参数注入在解析时拦截——地址、用户名、socket 路径一律不允许以 `-` 开头或含空白/引号/控制字符。
import { isIP } from 'node:net'
import { userInfo } from 'node:os'

export const HOST_DEFAULTS = Object.freeze({
  port: 22,
  via: 'windows',
  maxSessions: 4,
  loadProfile: false,
})

const NAME_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/
const SHELLS = new Set(['bash', 'zsh', 'sh'])
const ENCODING_RE = /^[A-Za-z0-9_-]{1,32}$/
const FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}=?$/
const IDENTITY_FINGERPRINT_RE = /^SHA256:[A-Za-z0-9+/]{43}$/
const DISTRO_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
const UNSAFE_PATH_RE = /[\s"'`\\\x00-\x1f\x7f]/
// Windows 侧的 agent 是命名管道。走 SSH_AUTH_SOCK 环境变量传给 ssh.exe，不进 -o（ssh 的选项解析会吃掉反斜杠）。
const WINDOWS_PIPE_RE = /^\\\\\.\\pipe\\[A-Za-z0-9._-]{1,128}$/

function localUser() {
  const candidates = []
  try { candidates.push(userInfo().username) } catch {}
  candidates.push(process.env.USER, process.env.LOGNAME, process.env.USERNAME)
  for (const candidate of candidates) {
    if (typeof candidate === 'string' && USER_RE.test(candidate)) return candidate
  }
  throw new Error('user is required when the address has no "user@host", and the local login name is not a valid user')
}

/** `user@host` 或 `host`。地址里最多一个 `@`，用户名与主机都不许为空。 */
function splitUserHost(raw) {
  const at = raw.lastIndexOf('@')
  if (at < 0) return { host: raw }
  if (raw.indexOf('@') !== at) throw new Error('address must contain at most one "@"')
  const user = raw.slice(0, at)
  const host = raw.slice(at + 1)
  if (user === '') throw new Error('user before "@" is empty')
  if (host === '') throw new Error('host after "@" is empty')
  return { user, host }
}

function isPlainObject(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return false
  const proto = Object.getPrototypeOf(value)
  return proto === Object.prototype || proto === null
}

/** 地址：IPv4、`[IPv6]` 或主机名。返回给 ssh 用的形式（IPv6 去掉方括号）。 */
export function parseAddress(raw) {
  if (typeof raw !== 'string' || raw.length === 0) throw new Error('address is required')
  if (raw.startsWith('-')) throw new Error('address must not start with "-"')
  if (/[\s"'`\\\x00-\x1f\x7f@]/.test(raw)) throw new Error('address must not contain whitespace, quotes, "@" or control characters')
  const bracket = /^\[([0-9A-Fa-f:.]+)\]$/.exec(raw)
  if (bracket !== null) {
    if (isIP(bracket[1]) !== 6) throw new Error('address in brackets must be an IPv6 literal')
    return { host: bracket[1], kind: 'ip6' }
  }
  if (isIP(raw) === 4) return { host: raw, kind: 'ip4' }
  if (isIP(raw) === 6) throw new Error('write IPv6 addresses in brackets, e.g. [::1]')
  if (!HOSTNAME_RE.test(raw)) throw new Error('address is not a valid hostname or IP')
  return { host: raw.replace(/\.$/, '').toLowerCase(), kind: 'name' }
}

function integer(value, name, min, max, fallback) {
  if (value === undefined || value === null) return fallback
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new Error(`${name} must be an integer between ${min} and ${max}`)
  return value
}

function optionalPath(value, name) {
  if (value === undefined || value === null || value === '') return undefined
  if (typeof value !== 'string' || value.startsWith('-') || UNSAFE_PATH_RE.test(value)) {
    throw new Error(`${name} must be a plain path without whitespace, quotes or a leading "-"`)
  }
  return value
}

const KNOWN_KEYS = new Set(['name', 'address', 'host', 'port', 'user', 'via', 'wslDistro', 'agentSocket', 'identityAgent', 'identityFile', 'shell', 'encoding', 'maxSessions', 'hostKeyFingerprint', 'identityFingerprint', 'loadProfile'])

/** 一台主机的条目。错误信息带上主机名，方便用户在设置页定位。 */
export function parseHost(entry, index = 0) {
  if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`hosts[${index}] must be an object`)
  const label = typeof entry.name === 'string' ? entry.name : `hosts[${index}]`
  try {
    for (const key of Object.keys(entry)) {
      if (!KNOWN_KEYS.has(key)) throw new Error(`unknown field "${key}"`)
    }
    if (typeof entry.name !== 'string' || !NAME_RE.test(entry.name)) throw new Error('name must be 1-64 characters of letters, digits, ".", "_" or "-"')
    if (entry.address !== undefined && entry.host !== undefined) throw new Error('use either address or host, not both')
    const rawAddress = entry.address ?? entry.host
    if (typeof rawAddress !== 'string' || rawAddress.length === 0) throw new Error('address is required')
    const split = splitUserHost(rawAddress)
    const address = parseAddress(split.host)
    let user = entry.user
    if (split.user !== undefined) {
      if (user !== undefined && user !== split.user) throw new Error('user is set both in the address and as a field')
      user = split.user
    }
    const userDefaulted = user === undefined
    if (userDefaulted) user = localUser()
    if (typeof user !== 'string' || !USER_RE.test(user)) throw new Error('user must be a plain login name')
    const via = entry.via ?? HOST_DEFAULTS.via
    if (via !== 'windows' && via !== 'wsl') throw new Error('via must be "windows" or "wsl"')
    let wslDistro
    if (entry.wslDistro !== undefined) {
      if (via !== 'wsl') throw new Error('wslDistro only applies to via: wsl')
      if (typeof entry.wslDistro !== 'string' || !DISTRO_RE.test(entry.wslDistro)) throw new Error('wslDistro is not a valid distribution name')
      wslDistro = entry.wslDistro
    }
    // 凭据只在 via 这一侧找：identityFile 是那一侧的私钥路径，identityAgent 是那一侧的 agent。
    // agentSocket 是 identityAgent 的旧名（只用于 wsl），两者同给时必须一致。
    const agentSocket = optionalPath(entry.agentSocket, 'agentSocket')
    if (agentSocket !== undefined && via !== 'wsl') throw new Error('agentSocket only applies to via: wsl; use identityAgent for a Windows pipe')
    let identityAgent
    if (entry.identityAgent !== undefined && entry.identityAgent !== null && entry.identityAgent !== '') {
      if (typeof entry.identityAgent !== 'string') throw new Error('identityAgent must be a string')
      if (entry.identityAgent === 'none') identityAgent = 'none'
      else if (via === 'windows') {
        if (!WINDOWS_PIPE_RE.test(entry.identityAgent)) throw new Error('identityAgent for via: windows must be "none" or a pipe like \\\\.\\pipe\\openssh-ssh-agent')
        identityAgent = entry.identityAgent
      } else identityAgent = optionalPath(entry.identityAgent, 'identityAgent')
      if (agentSocket !== undefined && agentSocket !== identityAgent) throw new Error('agentSocket and identityAgent disagree; keep only identityAgent')
    } else identityAgent = agentSocket
    const identityFile = optionalPath(entry.identityFile, 'identityFile')
    // 登录钥匙的指纹（ssh-keygen -lf 的写法），从 agent 里只挑这一把；和 hostKeyFingerprint（服务端主机公钥）不是一回事。
    let identityFingerprint
    if (entry.identityFingerprint !== undefined && entry.identityFingerprint !== null && entry.identityFingerprint !== '') {
      if (typeof entry.identityFingerprint !== 'string' || !IDENTITY_FINGERPRINT_RE.test(entry.identityFingerprint)) throw new Error('identityFingerprint must look like SHA256:<43 base64 characters>, as ssh-keygen -lf prints it')
      if (identityFile !== undefined) throw new Error('identityFile and identityFingerprint both pick the key; keep one')
      if (identityAgent === 'none') throw new Error('identityFingerprint picks a key from the agent; it cannot be used with identityAgent: "none"')
      identityFingerprint = entry.identityFingerprint
    }
    let shell
    if (entry.shell !== undefined) {
      if (!SHELLS.has(entry.shell)) throw new Error('shell must be bash, zsh or sh')
      shell = entry.shell
    }
    let encoding
    if (entry.encoding !== undefined) {
      if (typeof entry.encoding !== 'string' || !ENCODING_RE.test(entry.encoding)) throw new Error('encoding is not a valid label')
      try { new TextDecoder(entry.encoding) } catch { throw new Error(`encoding "${entry.encoding}" is not supported`) }
      encoding = entry.encoding.toLowerCase()
    }
    let hostKeyFingerprint
    if (entry.hostKeyFingerprint !== undefined) {
      if (typeof entry.hostKeyFingerprint !== 'string' || !FINGERPRINT_RE.test(entry.hostKeyFingerprint)) throw new Error('hostKeyFingerprint must look like SHA256:<base64>')
      hostKeyFingerprint = entry.hostKeyFingerprint
    }
    if (entry.loadProfile !== undefined && typeof entry.loadProfile !== 'boolean') throw new Error('loadProfile must be true or false')
    return Object.freeze({
      name: entry.name,
      address: split.host,
      sshHost: address.host,
      addressKind: address.kind,
      port: integer(entry.port, 'port', 1, 65535, HOST_DEFAULTS.port),
      user,
      // 省略 user 时取本机登录名；ssh_list 会标出来，免得远端登录名不同却不知道用的是谁。
      userDefaulted,
      via,
      wslDistro,
      identityAgent,
      // 旧字段名保留在结构上，免得外部代码读 agentSocket 时拿到 undefined
      agentSocket: identityAgent === 'none' || via !== 'wsl' ? undefined : identityAgent,
      identityFile,
      identityFingerprint,
      shell,
      encoding,
      maxSessions: integer(entry.maxSessions, 'maxSessions', 1, 64, HOST_DEFAULTS.maxSessions),
      hostKeyFingerprint,
      loadProfile: entry.loadProfile ?? HOST_DEFAULTS.loadProfile,
    })
  } catch (error) {
    throw new Error(`host "${label}": ${error.message}`)
  }
}

/**
 * 整份清单。接受数组或 JSON 文本；返回 { hosts: Map, errors: string[] }。
 * 有错的条目被丢弃而不是让整份清单失效——其余主机照常可用，错误在设置页和 ssh_open 里报告。
 */
export function parseHostList(value) {
  const hosts = new Map()
  const errors = []
  let list = value
  if (typeof value === 'string') {
    if (value.trim() === '') return { hosts, errors }
    try { list = JSON.parse(value) } catch (error) {
      return { hosts, errors: [`host list is not valid JSON: ${error.message}`] }
    }
  }
  if (list === undefined || list === null) return { hosts, errors }
  // 设置页还支持紧凑的别名映射：{ "alias": "user@host" | "host" | { address, user?, ... } }。
  // 键即别名，对象值里的 name 会被忽略，避免同一台主机出现两个名字。
  if (isPlainObject(list)) {
    const names = Object.keys(list)
    if (names.length === 0) return { hosts, errors: ['host list must not be empty'] }
    const entries = []
    for (const name of names) {
      const target = list[name]
      if (typeof target === 'string') {
        entries.push({ name, address: target })
      } else if (isPlainObject(target)) {
        entries.push({ ...target, name })
      } else {
        errors.push(`host "${name}": value must be "user@host", "host" or an object`)
      }
    }
    list = entries
  }
  if (!Array.isArray(list)) return { hosts, errors: ['host list must be an array or an alias map'] }
  list.forEach((entry, index) => {
    try {
      const host = parseHost(entry, index)
      if (hosts.has(host.name)) throw new Error(`host "${host.name}": duplicate name`)
      hosts.set(host.name, host)
    } catch (error) {
      errors.push(error.message)
    }
  })
  return { hosts, errors }
}

// ---- 审批名单 ----------------------------------------------------------------

function ipv4ToBigInt(text) {
  return text.split('.').reduce((acc, part) => (acc << 8n) | BigInt(Number(part)), 0n)
}

function ipv6ToBigInt(text) {
  let value = text.toLowerCase()
  // 末尾内嵌 IPv4（::ffff:1.2.3.4）。
  const v4 = /(\d+\.\d+\.\d+\.\d+)$/.exec(value)
  if (v4 !== null) {
    const n = ipv4ToBigInt(v4[1])
    value = value.slice(0, -v4[1].length) + ((n >> 16n) & 0xffffn).toString(16) + ':' + (n & 0xffffn).toString(16)
  }
  const [head, tail] = value.includes('::') ? value.split('::') : [value, undefined]
  const headParts = head === '' ? [] : head.split(':')
  const tailParts = tail === undefined || tail === '' ? [] : tail.split(':')
  const fill = tail === undefined ? 0 : 8 - headParts.length - tailParts.length
  const parts = [...headParts, ...Array(fill).fill('0'), ...tailParts]
  return parts.reduce((acc, part) => (acc << 16n) | BigInt(parseInt(part || '0', 16)), 0n)
}

function ipKey(ip) {
  const family = isIP(ip)
  if (family === 4) return { family, value: ipv4ToBigInt(ip), bits: 32 }
  if (family === 6) {
    const value = ipv6ToBigInt(ip)
    // IPv4 映射地址按 IPv4 比较，避免 ::ffff:10.0.0.1 绕过 10.0.0.0/8。
    if ((value >> 32n) === 0xffffn) return { family: 4, value: value & 0xffffffffn, bits: 32 }
    return { family, value, bits: 128 }
  }
  return undefined
}

/** 名单一行：IP、CIDR、主机名或 `*.example.com`。返回匹配器，非法行抛错。 */
export function parseApprovalRule(line) {
  const text = line.trim()
  const slash = text.indexOf('/')
  if (slash >= 0) {
    const base = text.slice(0, slash).replace(/^\[|\]$/g, '')
    const prefix = Number(text.slice(slash + 1))
    const key = ipKey(base)
    if (key === undefined || !Number.isInteger(prefix) || prefix < 0 || prefix > key.bits) throw new Error(`"${text}" is not a valid CIDR`)
    const shift = BigInt(key.bits - prefix)
    return { kind: 'cidr', text, family: key.family, net: key.value >> shift, shift }
  }
  const bare = text.replace(/^\[|\]$/g, '')
  const ip = ipKey(bare)
  if (ip !== undefined) return { kind: 'cidr', text, family: ip.family, net: ip.value, shift: 0n }
  if (text.startsWith('*.')) {
    const suffix = text.slice(2).toLowerCase().replace(/\.$/, '')
    if (!HOSTNAME_RE.test(suffix)) throw new Error(`"${text}" is not a valid domain pattern`)
    return { kind: 'suffix', text, suffix }
  }
  if (!HOSTNAME_RE.test(text)) throw new Error(`"${text}" is not an IP, CIDR or hostname`)
  return { kind: 'name', text, name: text.toLowerCase().replace(/\.$/, '') }
}

/** 多行文本 → { rules, errors }。空行与 `#` 注释忽略。 */
export function parseApprovalList(text) {
  const rules = []
  const errors = []
  if (typeof text !== 'string') return { rules, errors }
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.replace(/#.*$/, '').trim()
    if (line === '') continue
    try { rules.push(parseApprovalRule(line)) } catch (error) { errors.push(error.message) }
  }
  return { rules, errors }
}

function ruleMatches(rule, names, ips) {
  if (rule.kind === 'name') return names.includes(rule.name)
  if (rule.kind === 'suffix') return names.some((name) => name.endsWith('.' + rule.suffix))
  return ips.some((ip) => {
    const key = ipKey(ip)
    return key !== undefined && key.family === rule.family && (key.value >> rule.shift) === rule.net
  })
}

/**
 * 某台主机是否要手动审批。
 * @param host 解析后的主机
 * @param resolvedIps 连接前解析出的 IP（主机名才有；CIDR 规则也拿它们比）
 * @param invert 反转：名单内放行、名单外审批
 * @returns { required, rule } rule 是命中的那一行（未命中为 undefined）
 */
export function approvalFor(host, rules, invert = false, resolvedIps = []) {
  const names = host.addressKind === 'name' ? [host.sshHost] : []
  const ips = host.addressKind === 'name' ? resolvedIps : [host.sshHost, ...resolvedIps]
  const hit = rules.find((rule) => ruleMatches(rule, names, ips))
  return { required: invert ? hit === undefined : hit !== undefined, rule: hit?.text }
}
