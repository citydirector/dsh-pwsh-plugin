// 输出收集与解码：前台保留头 16KB + 尾 256KB；后台另外落一份本地 spool 供 ssh_read 分页。
import { closeSync, openSync, readSync, writeSync, unlinkSync, fstatSync } from 'node:fs'

export const HEAD_BYTES = 16 * 1024
export const TAIL_BYTES = 256 * 1024

export class OutputBuffer {
  constructor({ head = HEAD_BYTES, tail = TAIL_BYTES, spoolPath, spoolMaxBytes } = {}) {
    this.headLimit = head
    this.tailLimit = tail
    this.head = []
    this.headSize = 0
    this.tail = []
    this.tailSize = 0
    this.total = 0
    this.spoolPath = spoolPath
    this.spoolMaxBytes = spoolMaxBytes
    this.spoolBytes = 0
    this.spoolFull = false
    this.fd = spoolPath === undefined ? undefined : openSync(spoolPath, 'w+', 0o600)
  }

  write(chunk) {
    if (chunk.length === 0) return
    this.total += chunk.length
    let rest = chunk
    if (this.headSize < this.headLimit) {
      const take = Math.min(rest.length, this.headLimit - this.headSize)
      this.head.push(Buffer.from(rest.subarray(0, take)))
      this.headSize += take
      rest = rest.subarray(take)
    }
    if (rest.length > 0) {
      this.tail.push(Buffer.from(rest))
      this.tailSize += rest.length
      while (this.tailSize - this.tail[0].length >= this.tailLimit) this.tailSize -= this.tail.shift().length
    }
    if (this.fd !== undefined && !this.spoolFull) {
      const room = this.spoolMaxBytes === undefined ? chunk.length : Math.max(0, this.spoolMaxBytes - this.spoolBytes)
      const piece = chunk.subarray(0, Math.min(room, chunk.length))
      if (piece.length > 0) { writeSync(this.fd, piece); this.spoolBytes += piece.length }
      if (piece.length < chunk.length) this.spoolFull = true
    }
  }

  /** 头尾两段与被丢掉的字节区间。 */
  snapshot() {
    const head = Buffer.concat(this.head)
    let tail = Buffer.concat(this.tail)
    if (tail.length > this.tailLimit) tail = tail.subarray(tail.length - this.tailLimit)
    const dropped = this.total - head.length - tail.length
    return { head, tail, dropped, total: this.total, droppedFrom: head.length, droppedTo: head.length + dropped }
  }

  /** spool 里的一段原始字节。 */
  readSpool(offset, limit) {
    if (this.fd === undefined) return undefined
    const size = fstatSync(this.fd).size
    const start = Math.min(Math.max(0, offset), size)
    const length = Math.min(limit, size - start)
    const buffer = Buffer.alloc(length)
    if (length > 0) readSync(this.fd, buffer, 0, length, start)
    return { data: buffer, size }
  }

  dispose({ unlink = true } = {}) {
    if (this.fd !== undefined) {
      try { closeSync(this.fd) } catch {}
      this.fd = undefined
      if (unlink && this.spoolPath !== undefined) { try { unlinkSync(this.spoolPath) } catch {} }
    }
  }
}

// ESC [ ... final、OSC ... BEL/ST、单字符 ESC 序列。
const ANSI_RE = /\x1b\[[0-?]*[ -/]*[@-~]|\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)|\x1b[@-Z\\-_]/g

/** 折叠 `\r` 覆写：每行只留最后一次回车之后的内容（`\r\n` 当普通换行）。 */
export function foldCarriageReturns(text) {
  return text.replace(/\r\n/g, '\n').split('\n').map((line) => {
    const at = line.lastIndexOf('\r')
    return at < 0 ? line : line.slice(at + 1)
  }).join('\n')
}

/** 去掉末尾不完整的 UTF-8 序列（截断点落在字符中间时）。 */
export function trimPartialUtf8(buffer, { atStart = false } = {}) {
  let start = 0
  if (atStart) while (start < buffer.length && start < 3 && (buffer[start] & 0xc0) === 0x80) start++
  let end = buffer.length
  for (let i = 1; i <= Math.min(3, buffer.length - start); i++) {
    const byte = buffer[end - i]
    if ((byte & 0xc0) === 0x80) continue
    const need = byte >= 0xf0 ? 4 : byte >= 0xe0 ? 3 : byte >= 0xc0 ? 2 : 1
    if (need > i) end -= i
    break
  }
  return buffer.subarray(start, end)
}

/**
 * 字节 → 给模型看的文本。fatal 解码失败或含 NUL 时退回替换字符并给出提示。
 * @returns { text, warning? }
 */
export function decodeOutput(buffer, encoding = 'utf-8', { atStart = false } = {}) {
  const isUtf8 = encoding === 'utf-8' || encoding === 'utf8'
  const bytes = isUtf8 ? trimPartialUtf8(buffer, { atStart }) : buffer
  let text
  let warning
  try {
    text = new TextDecoder(encoding, { fatal: true }).decode(bytes)
  } catch {
    text = new TextDecoder(encoding).decode(bytes)
    warning = `output is not valid ${encoding}; redirect binary output to a file instead (e.g. cmd > out.bin) or set the host's encoding`
  }
  if (text.includes('\0')) {
    text = text.replaceAll('\0', '\\0')
    warning ??= 'output contains NUL bytes; it is probably binary — redirect it to a file instead'
  }
  return { text: foldCarriageReturns(text.replace(ANSI_RE, '')), warning }
}

/** 头尾快照 → 单段文本，中间写明丢弃区间。 */
export function renderSnapshot(snapshot, encoding) {
  if (snapshot.dropped === 0) {
    const whole = decodeOutput(Buffer.concat([snapshot.head, snapshot.tail]), encoding)
    return { text: whole.text, truncated: false, warning: whole.warning }
  }
  const head = decodeOutput(snapshot.head, encoding)
  const tail = decodeOutput(snapshot.tail, encoding, { atStart: snapshot.dropped > 0 })
  const gap = snapshot.dropped > 0
    ? `\n[... ${snapshot.dropped} bytes omitted (bytes ${snapshot.droppedFrom}-${snapshot.droppedTo}) ...]\n`
    : ''
  return {
    text: head.text + gap + tail.text,
    truncated: snapshot.dropped > 0,
    warning: head.warning ?? tail.warning,
  }
}
