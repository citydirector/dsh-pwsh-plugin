// 「Too many authentication failures」的成因是服务端的 MaxAuthTries 先被用完：agent 里的钥匙
// 会按顺序一把把试，正确的那把还没轮到，连接就被断开。客户端唯一能做的是「少报几把」。
// 连接时用 IdentityFile=<那把钥匙的 .pub> 配 IdentitiesOnly 只报一把；ssh 拿 .pub 去 agent
// 里挑对应的私钥签名，私钥从不离开 agent（ssh-add -L 本来也只给公钥）。
// 选哪把：主机清单的 identityFingerprint（手配）> 上次试通、记在 stateDir 的指纹（学到）
// > 撞上 MaxAuthTries 时逐把试，一次最多 PROBE_LIMIT 把。试过不行的指纹只在内存里按主机记着，
// 试通就放掉；全部失败时把「已排除 / 还没试」两组一起报给模型，让它请用户挑。
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'

/** 一次撞墙之后最多试几把；每把都是一次独立的握手，服务端那边会各记一次失败。 */
export const PROBE_LIMIT = 3

// ssh-add -L 的一行：'ssh-ed25519 AAAAC3... comment'，注释可省略。
const KEY_LINE = /^(ssh-(?:rsa|ed25519|dss)|ecdsa-sha2-[a-z0-9-]+|sk-(?:ssh-ed25519|ecdsa-sha2-[a-z0-9-]+)@openssh\.com) [A-Za-z0-9+/]+={0,2}(?: .*)?$/

/** 从 ssh-add -L 的输出里挑出公钥行；错误文案一类的行不算。 */
export function parseAgentKeys(text) {
  return String(text ?? '').split('\n').map((line) => line.trim()).filter((line) => KEY_LINE.test(line))
}

/** 公钥的注释；没有注释时退回钥匙类型。 */
export function keyLabel(line) {
  const rest = line.split(' ').slice(2).join(' ').trim()
  return rest === '' ? line.split(' ')[0] : rest
}

/** 和 ssh-keygen -lf 同样写法的指纹：SHA256:<base64，去掉末尾的 =>。 */
export function keyFingerprint(line) {
  const blob = Buffer.from(String(line).split(' ')[1] ?? '', 'base64')
  return 'SHA256:' + createHash('sha256').update(blob).digest('base64').replace(/=+$/u, '')
}

/** ssh-add -L 的输出 → [{ line, fingerprint, label }]，同一把钥匙只留一次。 */
export function agentKeyList(text) {
  const seen = new Set()
  const out = []
  for (const line of parseAgentKeys(text)) {
    const fingerprint = keyFingerprint(line)
    if (seen.has(fingerprint)) continue
    seen.add(fingerprint)
    out.push({ line, fingerprint, label: keyLabel(line) })
  }
  return out
}

/** 同一台主机：别名、登录名、地址、端口、走哪一侧、用哪个 agent 都一样才算。地址一改，学到的指纹就作废。 */
export function identityKey(host) {
  return [host.name, `${host.user}@${host.sshHost ?? host.address}:${host.port}`, host.via + (host.wslDistro === undefined ? '' : ':' + host.wslDistro), host.identityAgent ?? ''].join('|')
}

/**
 * 学到的指纹，存在 stateDir 里自己的文件中，不写 cordis.patch.yml。
 * 文件只放公钥指纹与注释，没有任何私钥材料。
 */
export class IdentityStore {
  constructor(file) {
    this.file = file
    this.rows = {}
    try {
      const data = JSON.parse(readFileSync(file, 'utf8'))
      if (data?.version === 1 && data.hosts !== null && typeof data.hosts === 'object') this.rows = data.hosts
    } catch {}
  }

  get(host) {
    const row = this.rows[identityKey(host)]
    return typeof row?.fingerprint === 'string' ? row : undefined
  }

  set(host, { fingerprint, label }, at = Date.now()) {
    this.rows = { ...this.rows, [identityKey(host)]: { host: host.name, fingerprint, label, learnedAt: new Date(at).toISOString() } }
    this.save()
  }

  /** 按别名删；不给别名就全删。返回删掉几条。 */
  forget(name) {
    const keep = {}
    let removed = 0
    for (const [key, row] of Object.entries(this.rows)) {
      if (name === undefined || row.host === name) removed += 1
      else keep[key] = row
    }
    this.rows = keep
    if (removed > 0) this.save()
    return removed
  }

  delete(host) {
    const key = identityKey(host)
    if (this.rows[key] === undefined) return
    const { [key]: _gone, ...rest } = this.rows
    this.rows = rest
    this.save()
  }

  list() { return Object.values(this.rows) }

  save() {
    try {
      mkdirSync(dirname(this.file), { recursive: true, mode: 0o700 })
      const temp = this.file + '.tmp'
      writeFileSync(temp, JSON.stringify({ version: 1, hosts: this.rows }, null, 2), { mode: 0o600 })
      renameSync(temp, this.file)
    } catch {}
  }
}

/** 把一条公钥写成 .pub 文件，文件名由内容摘要决定，同一把钥匙不会重复落两个文件。 */
export function writePublicKey(line, dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = createHash('sha1').update(line).digest('hex').slice(0, 16) + '.pub'
  const file = join(dir, name)
  writeFileSync(file, line + '\n', { mode: 0o600 })
  return file
}

export function probeOnce({ spawn, command, args, env, timeoutMs, marker }) {
  return new Promise((resolve) => {
    let child
    try { child = spawn(command, args, { stdio: 'pipe', windowsHide: true, env }) } catch { resolve(false); return }
    let out = ''
    let settled = false
    const done = (ok) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      resolve(ok)
    }
    const timer = setTimeout(() => done(false), timeoutMs)
    child.on('error', () => done(false))
    child.on('exit', (code) => done(code === 0 && out.includes(marker)))
    // 按流解码：逐块 String(chunk) 会把跨块的多字节字符（中文注释）切成乱码。
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.on('data', () => {})
    child.stdin?.on('error', () => {})
  })
}

/** 读 agent 里的公钥。Windows 侧是命名管道，经 SSH_AUTH_SOCK 传给 ssh-add。 */
export async function listAgentKeys({ spawn, command, args = ['-L'], env, timeoutMs = 10000 }) {
  return await new Promise((resolve) => {
    let child
    try { child = spawn(command, args, { stdio: 'pipe', windowsHide: true, env }) } catch { resolve({ keys: [], error: 'ssh-add could not be started' }); return }
    let out = ''
    let err = ''
    let settled = false
    const done = (value) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      try { child.kill('SIGKILL') } catch {}
      resolve(value)
    }
    const timer = setTimeout(() => done({ keys: [], error: 'ssh-add timed out' }), timeoutMs)
    child.on('error', (error) => done({ keys: [], error: String(error?.message ?? error) }))
    child.on('exit', () => {
      const keys = parseAgentKeys(out)
      done(keys.length === 0 ? { keys: [], error: err.trim() || 'the agent holds no keys' } : { keys })
    })
    // 按流解码：逐块 String(chunk) 会把跨块的多字节字符（中文注释）切成乱码。
    child.stdout?.setEncoding?.('utf8')
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.setEncoding?.('utf8')
    child.stderr?.on('data', (chunk) => { err += String(chunk) })
    child.stdin?.on('error', () => {})
  })
}