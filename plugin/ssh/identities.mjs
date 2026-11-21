// 「Too many authentication failures」的成因是服务端的 MaxAuthTries 先被用完：agent 里的钥匙
// 会按顺序一把把试，正确的那把还没轮到，连接就被断开。客户端唯一能做的是「少报几把」。
// 这里把 agent 里的公钥各写一份 .pub，连接时用 IdentitiesOnly 只报其中一把；私钥仍留在
// agent 里做签名，所以不需要把任何私钥落到磁盘上。逐把试到能进的那把，之后一直用它。
import { createHash } from 'node:crypto'
import { mkdirSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'

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

/** 把一条公钥写成 .pub 文件，文件名由内容摘要决定，同一把钥匙不会重复落两个文件。 */
export function writePublicKey(line, dir) {
  mkdirSync(dir, { recursive: true, mode: 0o700 })
  const name = createHash('sha1').update(line).digest('hex').slice(0, 16) + '.pub'
  const file = join(dir, name)
  writeFileSync(file, line + '\n', { mode: 0o600 })
  return file
}

/**
 * 逐把钥匙试一次握手，返回第一把能进的。argvFor 负责把 identityFile 与探活命令拼进命令行。
 * 一把都进不去时返回 undefined，由调用方决定如何报错。
 */
export async function findWorkingIdentity({ host, spawn, argvFor, keys, dir, timeoutMs = 15000, marker = '__DSH_KEY_OK__' }) {
  let tried = 0
  for (const line of keys ?? []) {
    const identityFile = writePublicKey(line, dir)
    const { command, args, env } = argvFor({ ...host, identityFile })
    tried += 1
    if (await probeOnce({ spawn, command, args, env, timeoutMs, marker })) return { identityFile, label: keyLabel(line), tried }
  }
  return undefined
}

function probeOnce({ spawn, command, args, env, timeoutMs, marker }) {
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
    child.stdout?.on('data', (chunk) => { out += String(chunk) })
    child.stderr?.on('data', (chunk) => { err += String(chunk) })
    child.stdin?.on('error', () => {})
  })
}