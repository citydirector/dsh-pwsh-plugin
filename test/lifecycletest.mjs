import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import { test } from 'node:test'
import { setTimeout as sleep } from 'node:timers/promises'
import { apply } from '../plugin/index.mjs'
import { PwshSession, startSession, MAX_TIMEOUT_MS, validateTimeout } from '../plugin/session.mjs'

function runtime(options = {}) {
  const handles = []
  const requests = []
  const waiting = []
  const api = {
    handles, requests,
    async resolveExecutable(command) { return command },
    request(script) {
      const prior = requests.find((item) => item.script === script)
      if (prior) return Promise.resolve(prior)
      return new Promise((resolve) => waiting.push({ script, resolve }))
    },
    spawn() {
      let finish
      const handle = {
        stdout: new EventEmitter(), stderr: new EventEmitter(), terminated: 0, count: 0,
        done: new Promise((resolve) => { finish = resolve }),
        terminate() { this.terminated++; finish({ exitCode: 1 }) },
        waitForExit() { return this.done },
        reply(id, lines = []) {
          this.stdout.emit('data', '<<<B:' + id + '>>>\n' + lines.join('\n') + '\nS:b2s=\n<<<T:' + id + ':0>>>\n<<<E:' + id + '>>>\n')
        },
      }
      handle.stdin = { write(line, callback) {
        callback?.()
        const [id, timeout, payload] = line.trim().split(' ')
        const { script, workdir } = JSON.parse(Buffer.from(payload, 'base64').toString())
        const entry = { script, workdir, timeout: Number(timeout), handle, id }
        requests.push(entry)
        for (const item of waiting.filter((item) => item.script === script)) item.resolve(entry)
        if (script === '$PSVersionTable.PSVersion.Major') {
          if (options.holdStartup) return
          if (options.startFailure) {
            handle.stderr.emit('data', 'runner refused the sandbox temp root')
            finish({ exitCode: 127 })
          } else handle.reply(id, ['O:Nw==', ...(options.warning ? ['W:' + Buffer.from(options.warning).toString('base64')] : [])])
        } else if (script !== 'hold') {
          const text = script === 'increment' ? String(++handle.count) : script
          handle.reply(id, ['O:' + Buffer.from(text).toString('base64')])
        }
      } }
      handles.push(handle)
      return handle
    },
  }
  return api
}

function harness(config = {}, options = {}) {
  const subprocess = runtime(options)
  const effects = []
  let registration
  const h = {
    subprocess, policy: { mode: 'danger-full-access', workspaceRoot: process.cwd() }, cwd: process.cwd(),
    resolutions: 0, confined: 0, ensure: undefined,
    sandbox: { async confine(argv) { h.confined++; return { argv } } },
    close: async () => {
      for (const dispose of effects.reverse()) dispose?.()
      await Promise.all(subprocess.handles.map((handle) => handle.done))
    },
    run: (script, id = 'A', extra = {}, signal) => registration.execute({ script, ...extra }, {
      agent: { session: { id, header: { cwd: h.cwd } } }, signal,
    }),
  }
  const ctx = {
    subprocess,
    get(name) {
      if (name === 'workingDirectory') return { ensure: () => h.ensure ? h.ensure() : h.cwd }
      if (name === 'sandbox') return h.sandbox
      if (name === 'sandboxPolicy' && h.policy) return { resolve() { h.resolutions++; return h.policy } }
    },
    tools: { register(value) { registration = value; return () => {} } },
    effect(fn) { effects.push(fn()) },
  }
  apply(ctx, config)
  return h
}

const opts = { timeout: 10000 }
test('same ID rechecks read-only and removes the old process', opts, async (t) => {
  const h = harness(); t.after(h.close)
  await h.run('first')
  h.policy.mode = 'read-only'
  await assert.rejects(h.run('must-not-run'), /read-only/)
  assert.equal(h.subprocess.handles[0].terminated, 1)
  assert.equal(h.subprocess.requests.some((r) => r.script === 'must-not-run'), false)
  assert.equal(h.resolutions, 2)
})
test('workspace, cwd, backend and effective policy changes rebuild', opts, async (t) => {
  const h = harness(); t.after(h.close)
  await h.run('first')
  h.policy = { mode: 'workspace-write', workspaceRoot: h.cwd }
  await h.run('fenced')
  assert.equal(h.confined, 1)
  h.policy.workspaceRoot += '/other'
  await h.run('new-root')
  h.cwd += '/changed'
  await h.run('new-cwd')
  h.sandbox = { async confine(argv) { return { argv } } }
  await h.run('new-backend')
  assert.equal(h.subprocess.handles.length, 5)
  assert.equal(h.subprocess.handles.slice(0, -1).every((x) => x.terminated === 1), true)
})
test('missing policy never reuses an old unconfined session', opts, async (t) => {
  const h = harness(); t.after(h.close)
  await h.run('first'); h.policy = null
  await assert.rejects(h.run('must-not-run'), /sandboxPolicy is absent/)
  assert.equal(h.subprocess.handles[0].terminated, 1)
})
test('malformed confinement result is refused before an unconfined spawn', opts, async (t) => {
  const h = harness(); t.after(h.close)
  h.policy.mode = 'workspace-write'
  h.sandbox = { async confine() { return {} } }
  await assert.rejects(h.run('must-not-run'), /no valid confined argv/)
  assert.equal(h.subprocess.handles.length, 0)
})
test('working-directory failure is surfaced without stale fallback', opts, async (t) => {
  const h = harness(); t.after(h.close)
  h.ensure = () => { throw new Error('cwd unavailable') }
  await assert.rejects(h.run('must-not-run'), /cwd unavailable/)
  assert.equal(h.subprocess.handles.length, 0)
})
test('first concurrent calls share one process and one state', opts, async (t) => {
  const h = harness(); t.after(h.close)
  h.ensure = async () => { await sleep(5); return h.cwd }
  const results = await Promise.all([h.run('increment'), h.run('increment'), h.run('increment')])
  assert.deepEqual(results.map((r) => r.text), ['1', '2', '3'])
  assert.equal(h.subprocess.handles.length, 1)
})
test('full pool refuses newcomer while four sessions run', opts, async (t) => {
  const h = harness(); t.after(h.close)
  await Promise.all(['A', 'B', 'C', 'D'].map((id) => h.run('warm', id)))
  const runs = ['A', 'B', 'C', 'D'].map((id) => h.run('hold', id))
  await sleep(10)
  await assert.rejects(h.run('new', 'E'), /sessions are busy/)
  assert.equal(h.subprocess.handles.every((x) => x.terminated === 0), true)
  for (const entry of h.subprocess.requests.filter((x) => x.script === 'hold')) entry.handle.reply(entry.id, ['O:ZG9uZQ=='])
  assert.deepEqual((await Promise.all(runs)).map((x) => x.text), ['done', 'done', 'done', 'done'])
  await h.run('new', 'E')
  assert.equal(h.subprocess.handles.length, 5)
  assert.equal(h.subprocess.handles.slice(0, 4).filter((x) => x.terminated).length, 1)
})
test('idle timer starts after completion and never reaps a busy call', opts, async (t) => {
  const h = harness({ idleMs: 15 }); t.after(h.close)
  const run = h.run('hold')
  const entry = await h.subprocess.request('hold')
  await sleep(50)
  assert.equal(entry.handle.terminated, 0)
  entry.handle.reply(entry.id, ['O:ZG9uZQ==']); await run
  await sleep(50)
  assert.equal(entry.handle.terminated, 1)
})
test('queued short timeout cannot interrupt the preceding long call', { timeout: 10000 }, async (t) => {
  const h = harness(); t.after(h.close)
  const first = h.run('hold', 'A', { timeoutMs: 9000 })
  const entry = await h.subprocess.request('hold')
  const second = h.run('short', 'A', { timeoutMs: 1 })
  await sleep(5150)
  assert.equal(entry.handle.terminated, 0)
  assert.equal(h.subprocess.requests.some((x) => x.script === 'short'), false)
  entry.handle.reply(entry.id, ['O:ZG9uZQ=='])
  assert.equal((await first).text, 'done'); assert.equal((await second).text, 'short')
})
test('pre-cancelled and queued cancelled requests never reach PowerShell', opts, async (t) => {
  const h = harness(); t.after(h.close)
  const pre = new AbortController(); pre.abort()
  await assert.rejects(async () => h.run('pre', 'A', {}, pre.signal), /cancelled/)
  assert.equal(h.subprocess.handles.length, 0)
  const first = h.run('hold'); const entry = await h.subprocess.request('hold')
  const controller = new AbortController()
  const queued = h.run('queued', 'A', {}, controller.signal)
  const rejected = assert.rejects(queued, /cancelled/); controller.abort(); await rejected
  assert.equal(entry.handle.terminated, 0)
  entry.handle.reply(entry.id, ['O:ZG9uZQ==']); await first
  await h.run('next')
  assert.equal(h.subprocess.requests.some((x) => x.script === 'queued'), false)
})
test('active cancellation settles promptly and the next call rebuilds', opts, async (t) => {
  const h = harness(); t.after(h.close)
  const controller = new AbortController()
  const run = h.run('hold', 'A', {}, controller.signal)
  const entry = await h.subprocess.request('hold')
  controller.abort()
  assert.match((await run).text, /cancelled/)
  assert.equal(entry.handle.terminated, 1)
  await h.run('rebuilt')
  assert.equal(h.subprocess.handles.length, 2)
})
test('dispose rejects pending requests immediately and is idempotent', opts, async () => {
  const rt = runtime(); const handle = rt.spawn()
  const session = new PwshSession(handle, 'test')
  const pending = session.run('hold', 9000)
  const rejected = assert.rejects(pending, /explicit disposal/)
  await rt.request('hold')
  await Promise.all([session.dispose('explicit disposal'), session.dispose('again')])
  await rejected
  assert.equal(handle.terminated, 1)
})
test('startup warnings reach the first user response once', opts, async () => {
  const rt = runtime({ warning: 'STARTUP-WARNING' })
  const session = await startSession(rt, { executable: 'pwsh', serverSource: '' })
  try {
    assert.deepEqual((await session.run('one', 1000)).warn, ['STARTUP-WARNING'])
    assert.deepEqual((await session.run('two', 1000)).warn, [])
  } finally { await session.dispose() }
})
test('failed handshake includes stderr, disposes, and does not cache failure', opts, async () => {
  const rt = runtime({ startFailure: true })
  await assert.rejects(startSession(rt, { executable: 'pwsh', serverSource: '' }), /runner refused the sandbox temp root/)
  assert.equal(rt.handles[0].terminated, 1)
})
test('plugin shutdown cancels a process still in its startup handshake', opts, async () => {
  const h = harness({}, { holdStartup: true })
  const call = h.run('must-not-run')
  const rejected = assert.rejects(call, /cancelled|startup/)
  await h.subprocess.request('$PSVersionTable.PSVersion.Major')
  await h.close(); await rejected
  assert.equal(h.subprocess.handles[0].terminated, 1)
  assert.equal(h.subprocess.requests.some((x) => x.script === 'must-not-run'), false)
})
test('missing session ID and invalid timeout are rejected before spawn', opts, async (t) => {
  const h = harness(); t.after(h.close)
  for (const value of [0, -1, 0.5, NaN, Infinity, 4294967295, MAX_TIMEOUT_MS + 1]) {
    await assert.rejects(async () => h.run('invalid', 'A', { timeoutMs: value }), /timeoutMs must be an integer/)
  }
  assert.equal(validateTimeout(1), 1); assert.equal(validateTimeout(MAX_TIMEOUT_MS), MAX_TIMEOUT_MS)
  await assert.rejects(async () => h.run('anonymous', null), /session ID/)
  assert.equal(h.subprocess.handles.length, 0)
})
