import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { PwshSession, startSession, bootArgv } from '../plugin/session.mjs'
import { readFileSync } from 'node:fs'

const frame = (kind, text) => kind + ':' + Buffer.from(text).toString('base64') + '\n'
function fixture(limit = 4) {
  let sent, finish
  const request = new Promise((resolve) => { sent = resolve })
  const handle = { stdout: new EventEmitter(), stderr: new EventEmitter(), terminated: 0,
    done: new Promise((resolve) => { finish = resolve }),
    stdin: { write(line) { sent(line.split(' ')[0]) } },
    terminate() { this.terminated++; finish({ exitCode: 1 }) },
    waitForExit() { return this.done },
  }
  const session = new PwshSession(handle, 'protocol', limit)
  return { session, handle, request,
    emit: (text) => handle.stdout.emit('data', text),
    end: (id) => handle.stdout.emit('data', 'S:b2s=\n<<<T:' + id + ':0>>>\n<<<E:' + id + '>>>\n'),
  }
}
test('UTF8 cap clips at a whole code point and preserves later diagnostics', async () => {
  const f = fixture(); const pending = f.session.run('test', 1000); const id = await f.request
  try {
    f.emit('<<<B:' + id + '>>>\n' + frame('O', '中文中文') + frame('E', 'later error'))
    f.end(id)
    const r = await pending
    assert.deepEqual(r.out, ['中']); assert.equal(r.bytes, 3)
    assert.deepEqual(r.err, ['later error']); assert.equal(r.truncated, true)
  } finally { await f.session.dispose() }
})
test('empty output records also consume the bounded budget', async () => {
  const f = fixture(); const pending = f.session.run('test', 1000); const id = await f.request
  try {
    f.emit('<<<B:' + id + '>>>\n' + frame('O', '').repeat(100))
    f.end(id)
    const r = await pending
    assert.equal(r.out.length, 5); assert.equal(r.bytes, 4); assert.equal(r.truncated, true)
  } finally { await f.session.dispose() }
})
test('continued frames and arbitrarily split transport chunks retain one record', async () => {
  const f = fixture(100); const pending = f.session.run('test', 1000); const id = await f.request
  try {
    const wire = '<<<B:' + id + '>>>\n' + frame('O+', '中文') + frame('O', '🙂done')
    for (let i = 0; i < wire.length; i += 3) f.emit(wire.slice(i, i + 3))
    f.end(id)
    const r = await pending
    assert.deepEqual(r.out, ['中文🙂done']); assert.equal(r.truncated, false)
  } finally { await f.session.dispose() }
})
test('oversized protocol frame fails promptly instead of retaining unbounded data', async () => {
  const f = fixture(); const pending = f.session.run('test', 1000)
  const rejected = assert.rejects(pending, /protocol frame exceeded/)
  await f.request; f.emit('x'.repeat(32769)); await rejected
  await f.session.dispose(); assert.equal(f.handle.terminated, 1)
})
test('handshake timeout disposes the process and clears its watchdog', async () => {
  const f = fixture()
  await assert.rejects(startSession({ spawn: () => f.handle }, {
    executable: 'pwsh', serverSource: '', startupTimeoutMs: 15,
  }), /startup handshake timed out/)
  assert.equal(f.handle.terminated, 1)
})
test('compressed bootstrap has Windows command-line headroom and a hard bound', () => {
  const source = readFileSync(new URL('../plugin/session-server.ps1', import.meta.url), 'utf8')
  const args = bootArgv(source)
  assert.equal(args[2], '-EncodedCommand'); assert.ok(args[3].length < 30000)
  // Deliberately incompressible, bounded input checks the rejection path.
  let seed = 11
  const random = Array.from({ length: 50000 }, () => {
    seed = (Math.imul(seed, 1664525) + 1013904223) >>> 0
    return String.fromCharCode(33 + (seed % 90))
  }).join('')
  assert.throws(() => bootArgv(random), /command-line budget/)
})
