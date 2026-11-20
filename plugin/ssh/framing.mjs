// 分帧协议：no-PTY 管道上的命令边界全靠哨兵行。
// 每条命令一个新 nonce；stdout 走 fd9、stderr 走 fd8，两路哨兵都收到才算完成。
import { randomBytes } from 'node:crypto'

export const newNonce = () => randomBytes(9).toString('hex')

/** 单引号转义：把任意字符串变成 POSIX shell 字面量。 */
export const shQuote = (text) => "'" + String(text).replaceAll("'", "'\\''") + "'"

const ENV_NAME_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/** 第一段：在远端 /bin/sh 里挑 shell 并 exec。之后的字节要等探测哨兵回来再发，免得 sh 预读吞掉。 */
export function probeScript(nonce, { preferred, loadProfile = false } = {}) {
  const order = [preferred, 'bash', 'zsh', 'sh'].filter((item, i, list) => item && list.indexOf(item) === i)
  const flags = loadProfile
    ? "case $__dsh_s in bash|zsh|sh) __dsh_f=-l;; esac"
    : "case $__dsh_s in bash) __dsh_f='--noprofile --norc';; zsh) __dsh_f=-f;; esac"
  return [
    '__dsh_s=; __dsh_f=',
    `for __dsh_c in ${order.join(' ')}; do if command -v "$__dsh_c" >/dev/null 2>&1; then __dsh_s=$__dsh_c; break; fi; done`,
    '[ -n "$__dsh_s" ] || __dsh_s=sh',
    flags,
    `printf '\\n__DSH_PROBE_${nonce} %s %s %s\\n' "$(uname -s 2>/dev/null || echo unknown)" "$$" "$__dsh_s"`,
    'exec "$__dsh_s" $__dsh_f',
    '',
  ].join('\n')
}

/** 第二段：已经在目标 shell 里。保存 fd、清理交互环境、注入秘密变量，回 READY 哨兵。 */
export function setupScript(nonce, { env = {} } = {}) {
  const lines = [
    'exec 9>&1 8>&2',
    'unset HISTFILE',
    'export TERM=dumb PAGER=cat GIT_PAGER=cat SYSTEMD_PAGER= DEBIAN_FRONTEND=noninteractive NO_COLOR=1',
    '[ -n "${LANG-}" ] || export LANG=C.UTF-8',
  ]
  for (const [name, value] of Object.entries(env)) {
    if (!ENV_NAME_RE.test(name)) throw new Error(`invalid environment variable name "${name}"`)
    lines.push(`export ${name}=${shQuote(value)}`)
  }
  lines.push(`command printf '\\n__DSH_READY_${nonce} %s\\n' "$PWD" >&9`)
  lines.push('')
  return lines.join('\n')
}

/** 一条命令。正文放 quoted heredoc 里，任何字符都不经展开；用 `command eval` 让语法错误不至于打死 shell。 */
export function commandScript(nonce, command) {
  const body = String(command)
  const eof = `__DSH_EOF_${nonce}`
  if (body.split('\n').includes(eof)) throw new Error('command contains the frame delimiter')
  return [
    `__dsh_c=$(command cat <<'${eof}'`,
    body,
    eof,
    ')',
    `{ command eval "$__dsh_c"; } </dev/null >&9 2>&8 9>&- 8>&- && __dsh_rc=0 || __dsh_rc=$?`,
    `command printf '\\n__DSH_DONE_${nonce} %s %s\\n' "$__dsh_rc" "$PWD" >&9`,
    `command printf '\\n__DSH_DONE_${nonce}\\n' >&8`,
    '',
  ].join('\n')
}

/** 旁路连接里执行：TERM/KILL 掉某个 shell 的全部后代（不动 shell 本身）。 */
export function killDescendantsScript(pid, signal) {
  if (!Number.isSafeInteger(pid) || pid <= 1) throw new Error('invalid pid')
  if (!/^(TERM|KILL|INT|HUP)$/.test(signal)) throw new Error('invalid signal')
  return [
    '__dsh_kids() { ps -eo pid=,ppid= 2>/dev/null | while read -r p pp; do [ "$pp" = "$1" ] && echo "$p"; done; }',
    `__dsh_walk() { for c in $(__dsh_kids "$1"); do __dsh_walk "$c"; kill -${signal} "$c" 2>/dev/null; done; }`,
    `__dsh_walk ${pid}`,
    'exit 0',
    '',
  ].join('\n')
}

/**
 * 字节流里找 `\n<marker>...\n` 哨兵行。哨兵可以跨任意 chunk 边界；
 * 哨兵之前的字节原样交给 onData，可能是哨兵前缀的尾巴先扣住。
 */
export class SentinelSplitter {
  constructor(onData) {
    this.onData = onData
    this.carry = Buffer.alloc(0)
    this.marker = undefined
    this.resolve = undefined
  }

  /** 等下一条哨兵。返回 Promise<string>（哨兵行 marker 之后的剩余文本，去掉开头空格）。 */
  expect(marker) {
    this.marker = Buffer.from('\n' + marker)
    return new Promise((resolve) => {
      this.resolve = resolve
      this.push(Buffer.alloc(0))
    })
  }

  /** 不再等哨兵：扣住的字节全部放行（例如连接已断）。 */
  cancel() {
    this.marker = undefined
    this.resolve = undefined
    if (this.carry.length > 0) { const rest = this.carry; this.carry = Buffer.alloc(0); this.onData(rest) }
  }

  push(chunk) {
    this.carry = this.carry.length === 0 ? chunk : Buffer.concat([this.carry, chunk])
    if (this.marker === undefined) {
      if (this.carry.length > 0) { const all = this.carry; this.carry = Buffer.alloc(0); this.onData(all) }
      return
    }
    const at = this.carry.indexOf(this.marker)
    if (at < 0) {
      const keep = Math.min(this.carry.length, this.marker.length - 1)
      const commit = this.carry.length - keep
      // 只扣住真的可能是哨兵前缀的尾巴。
      let hold = keep
      while (hold > 0 && !this.marker.subarray(0, hold).equals(this.carry.subarray(this.carry.length - hold))) hold--
      const cut = this.carry.length - hold
      if (cut > 0 || commit > 0) {
        const head = this.carry.subarray(0, cut)
        this.carry = Buffer.from(this.carry.subarray(cut))
        if (head.length > 0) this.onData(head)
      }
      return
    }
    const end = this.carry.indexOf(0x0a, at + this.marker.length)
    if (at > 0) { this.onData(this.carry.subarray(0, at)); this.carry = Buffer.from(this.carry.subarray(at)) }
    if (end < 0) return
    const lineEnd = end - at
    const rest = this.carry.subarray(this.marker.length, lineEnd).toString('utf8').replace(/^ /, '')
    this.carry = Buffer.from(this.carry.subarray(lineEnd + 1))
    const resolve = this.resolve
    this.marker = undefined
    this.resolve = undefined
    // 哨兵之后的字节（理论上没有）按普通输出放行。
    if (this.carry.length > 0) { const tail = this.carry; this.carry = Buffer.alloc(0); this.onData(tail) }
    resolve(rest)
  }
}
