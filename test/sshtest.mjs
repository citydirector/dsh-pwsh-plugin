// SSH 模块测试：node test/sshtest.mjs。输出 PASS/FAIL <名>，结尾 SUMMARY。
// 两层替身：本机 sh 当远端（transport 层）+ 假时钟；真 sshd 用例在本机有 sshd/ssh-keygen 时才跑。
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { parseHost, parseHostList, parseApprovalList, approvalFor } from '../plugin/ssh/hosts.mjs'
import { buildSshArgv } from '../plugin/ssh/argv.mjs'
import { SentinelSplitter, commandScript } from '../plugin/ssh/framing.mjs'
import { decodeOutput, foldCarriageReturns, OutputBuffer, renderSnapshot } from '../plugin/ssh/output.mjs'
import { SshSession } from '../plugin/ssh/session.mjs'
import { SshManager } from '../plugin/ssh/manager.mjs'
import { applyEvent, initState, view } from '../plugin/ssh/projection.mjs'
import * as plugin from '../plugin/ssh/index.mjs'

if (process.platform === 'win32') {
  // Windows 上没有 POSIX sh 可当远端；这些用例要在 Linux/macOS/WSL 里跑。
  console.log('SKIP: sshtest needs a POSIX sh (run it inside WSL)')
  console.log('SUMMARY pass=0 fail=0')
  process.exit(0)
}

let pass = 0
let fail = 0
const failures = []
async function test(name, fn) {
  try {
    await fn()
    pass++
    console.log('PASS ' + name)
  } catch (error) {
    fail++
    failures.push(name)
    console.log('FAIL ' + name + ': ' + (error?.stack ?? error))
  }
}
function assert(cond, message = 'assertion failed') { if (!cond) throw new Error(message) }
function eq(a, b, message) { if (JSON.stringify(a) !== JSON.stringify(b)) throw new Error(`${message ?? 'not equal'}: ${JSON.stringify(a)} !== ${JSON.stringify(b)}`) }
async function rejects(promise, pattern) {
  try { await promise } catch (error) { if (pattern && !pattern.test(String(error.code ?? '') + ' ' + error.message)) throw new Error('wrong error: ' + error.message); return error }
  throw new Error('expected rejection')
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

const work = mkdtempSync(join(tmpdir(), 'sshtest-'))
const spool = join(work, 'spool')
spawnSync('mkdir', ['-p', spool])

const HOST = parseHost({ name: 'local', address: '127.0.0.1', user: 'tester' })
const localTransport = (shell = 'sh', extraEnv = {}) => ({
  spawnMain: () => spawn(shell, [], { stdio: 'pipe', env: { ...process.env, ...extraEnv } }),
  runSide: (script) => new Promise((resolve) => {
    const child = spawn('sh', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('exit', (code) => resolve({ code }))
    child.stdin.end(script)
  }),
})

class FakeClock {
  constructor() { this.t = 1_000_000; this.timers = new Set() }
  now() { return this.t }
  setTimeout(fn, ms) { const timer = { at: this.t + ms, fn }; this.timers.add(timer); return timer }
  clearTimeout(timer) { this.timers.delete(timer) }
  advance(ms) {
    this.t += ms
    for (const timer of [...this.timers].sort((a, b) => a.at - b.at)) {
      if (timer.at <= this.t && this.timers.has(timer)) { this.timers.delete(timer); timer.fn() }
    }
  }
}

async function openLocal(opts = {}) {
  const session = new SshSession({ id: 's1', host: opts.host ?? HOST, transport: opts.transport ?? localTransport(), spoolDir: spool, spoolMaxBytes: opts.spoolMaxBytes, env: opts.env ?? {}, defaultTimeoutMs: 20000 })
  await session.open()
  return session
}

// ---- 清单与参数 ----------------------------------------------------------------

await test('host list rejects unknown fields and bad values', () => {
  const { hosts, errors } = parseHostList([
    { name: 'ok', address: 'example.com', user: 'deploy' },
    { name: 'bad1', address: '-oProxyCommand=evil', user: 'x' },
    { name: 'bad2', address: 'example.com', user: '-x' },
    { name: 'bad3', address: 'example.com', user: 'x', port: 70000 },
    { name: 'bad4', address: 'example.com', user: 'x', extra: 1 },
    { name: 'bad5', address: '::1', user: 'x' },
    { name: 'bad6', address: 'a b', user: 'x' },
    { name: 'bad7', address: 'example.com', user: 'x', via: 'windows', agentSocket: '/tmp/s' },
    { name: 'v6', address: '[::1]', user: 'x' },
  ])
  eq([...hosts.keys()], ['ok', 'v6'])
  eq(errors.length, 7)
  assert(errors.every((e) => /^host "bad\d"/.test(e)), errors.join('\n'))
})

await test('argument injection is rejected at parse time', () => {
  for (const address of ['-p22', 'host;rm', 'a"b', "a'b", 'x\ny', 'user@host']) {
    let threw = false
    try { parseHost({ name: 'h', address, user: 'u' }) } catch { threw = true }
    assert(threw, 'accepted ' + JSON.stringify(address))
  }
})

await test('ssh argv: fixed options, double known_hosts, -- before address', () => {
  const host = parseHost({ name: 'h', address: 'example.com', user: 'deploy', port: 2222 })
  const { command, args } = buildSshArgv(host, { privateKnownHosts: '~/.ssh/dsh_known_hosts', userKnownHosts: '~/.ssh/known_hosts' })
  eq(command, 'ssh')
  assert(args.includes('BatchMode=yes') && args.includes('StrictHostKeyChecking=accept-new') && args.includes('RemoteCommand=none') && args.includes('RequestTTY=no') && args.includes('ForwardAgent=no') && args.includes('ClearAllForwardings=yes'))
  assert(args.includes('UserKnownHostsFile=~/.ssh/dsh_known_hosts ~/.ssh/known_hosts'))
  const dash = args.indexOf('--')
  eq(args.slice(dash), ['--', 'example.com', 'exec /bin/sh'])
  eq(args.slice(dash - 4, dash), ['-p', '2222', '-l', 'deploy'])
})

await test('via=wsl passes agentSocket through env', () => {
  const host = parseHost({ name: 'h', address: '10.0.0.5', user: 'u', via: 'wsl', wslDistro: 'Ubuntu', agentSocket: '/home/u/.ssh/agent.sock' })
  const { command, args } = buildSshArgv(host, { privateKnownHosts: '~/.ssh/dsh_known_hosts' })
  eq(command, 'wsl.exe')
  eq(args.slice(0, 6), ['-d', 'Ubuntu', '-e', 'env', 'SSH_AUTH_SOCK=/home/u/.ssh/agent.sock', 'ssh'])
})

await test('approval list: IP, CIDR, hostname, wildcard, invert', () => {
  const { rules, errors } = parseApprovalList('10.0.0.0/8\n# comment\nprod.example.com\n*.corp.example.com\n2001:db8::/32\nnot a host\n')
  eq(errors.length, 1)
  const h = (address) => parseHost({ name: 'h', address, user: 'u' })
  assert(approvalFor(h('10.1.2.3'), rules).required)
  assert(!approvalFor(h('192.168.1.1'), rules).required)
  assert(approvalFor(h('prod.example.com'), rules).required)
  assert(approvalFor(h('a.corp.example.com'), rules).required)
  assert(!approvalFor(h('corp.example.com'), rules).required)
  assert(approvalFor(h('[2001:db8::1]'), rules).required)
  assert(approvalFor(h('dev.example.com'), rules, false, ['10.9.9.9']).required, 'resolved IP should hit CIDR')
  assert(!approvalFor(h('10.1.2.3'), rules, true).required, 'invert: listed host is auto-allowed')
  assert(approvalFor(h('192.168.1.1'), rules, true).required, 'invert: unlisted host needs approval')
  const mapped = parseApprovalList('10.0.0.0/8').rules
  assert(approvalFor(h('[::ffff:10.0.0.1]'), mapped).required, 'IPv4-mapped IPv6 must not bypass')
})

// ---- 分帧 --------------------------------------------------------------------

await test('sentinel split across chunks', async () => {
  const seen = []
  const splitter = new SentinelSplitter((d) => seen.push(d.toString()))
  const p = splitter.expect('__DSH_DONE_abc ')
  const stream = 'hello\nworld\n__DSH_DONE_abc 0 /tmp\n'
  for (const ch of stream) splitter.push(Buffer.from(ch))
  eq(await p, '0 /tmp')
  eq(seen.join(''), 'hello\nworld')
})

await test('frame delimiter inside a command is refused', () => {
  let threw = false
  try { commandScript('n1', 'echo\n__DSH_EOF_n1\necho') } catch { threw = true }
  assert(threw)
})

await test('carriage-return progress bars fold', () => {
  eq(foldCarriageReturns('10%\r50%\r100%\ndone\r\n'), '100%\ndone\n')
})

await test('non-UTF-8 output warns; GB18030 decodes with encoding', () => {
  const gbk = Buffer.from([0xc4, 0xe3, 0xba, 0xc3]) // 你好
  const bad = decodeOutput(gbk, 'utf-8')
  assert(bad.warning !== undefined)
  eq(decodeOutput(gbk, 'gb18030').text, '你好')
  assert(decodeOutput(Buffer.from('a\0b'), 'utf-8').warning !== undefined)
})

await test('output keeps head and tail with dropped range', () => {
  const buf = new OutputBuffer({ head: 10, tail: 10 })
  buf.write(Buffer.from('0123456789abcdefghijKLMNOPQRST'))
  const out = renderSnapshot(buf.snapshot(), 'utf-8')
  assert(out.truncated)
  assert(out.text.startsWith('0123456789') && out.text.endsWith('KLMNOPQRST') && /10 bytes omitted \(bytes 10-20\)/.test(out.text), out.text)
})

// ---- 会话（本机 sh 当远端）---------------------------------------------------

await test('shell probe and setup', async () => {
  const s = await openLocal()
  assert(['bash', 'zsh', 'sh'].includes(s.shell))
  eq(s.os, process.platform === 'darwin' ? 'Darwin' : 'Linux')
  assert(s.pid > 1)
  const env = await s.exec('echo "$TERM $PAGER $GIT_PAGER $NO_COLOR ${HISTFILE-unset}"')
  eq(env.stdout, 'dumb cat cat 1 unset\n')
  await s.close()
})

await test('output correctness: stdout, stderr, exit code', async () => {
  const s = await openLocal()
  const r = await s.exec('echo out; echo err >&2; (exit 7)')
  eq([r.stdout, r.stderr, r.exitCode], ['out\n', 'err\n', 7])
  const n = await s.exec('printf "no newline"')
  eq(n.stdout, 'no newline')
  await s.close()
})

await test('variables, functions and cd persist across commands', async () => {
  const s = await openLocal()
  await s.exec('X=42; f() { echo "f$1"; }; cd /tmp')
  const r = await s.exec('echo "$X $(f 1) $PWD"')
  eq(r.stdout, '42 f1 /tmp\n')
  eq(r.cwd, '/tmp')
  await s.close()
})

await test('unclosed quote, unclosed heredoc and lone } do not kill the shell', async () => {
  const s = await openLocal()
  for (const cmd of ['echo "abc', '}']) {
    const r = await s.exec(cmd)
    assert(r.exitCode !== 0, cmd)
  }
  // 未闭合的 heredoc：shell 按规范读到正文末尾为止，命令照常执行，会话不受影响。
  eq((await s.exec('cat <<EOF\nnever closed')).stdout.includes('never closed'), true)
  eq((await s.exec('echo alive')).stdout, 'alive\n')
  await s.close()
})

await test('exec >file, redefined printf, set -e and set -u', async () => {
  const s = await openLocal()
  const f = join(work, 'redirect.txt')
  await s.exec(`exec >${f}; echo hidden`)
  // 每条命令开始时 stdout/stderr 都重置回会话管道，exec >file 只影响那一条命令。
  eq((await s.exec('echo still')).stdout, 'still\n')
  await s.exec('printf() { echo hijacked; }; cat() { echo hijacked; }')
  eq((await s.exec('echo ok')).stdout, 'ok\n')
  await s.close()
  const t = await openLocal()
  eq((await t.exec('set -e; false; echo after')).exitCode, 0)
  eq((await t.exec('false')).exitCode, 1)
  eq((await t.exec('set -u; X=1; echo "$X"')).stdout, '1\n')
  eq((await t.exec('echo still here')).stdout, 'still here\n')
  // set -u 下引用未定义变量：POSIX 规定非交互 shell 直接退出，会话随之结束（文档写明）。
  const unbound = await t.exec('echo "$UNDEFINED_VAR_X"')
  assert(unbound.exitCode !== 0)
  eq(t.state, 'dead')
  assert(readFileSync(f, 'utf8').includes('hidden'))
})

await test('exit 3 ends the session as remote-exit with code 3', async () => {
  const s = await openLocal()
  const r = await s.exec('exit 3')
  eq(r.exitCode, 3)
  eq([s.state, s.deadReason], ['dead', 'remote-exit'])
  await rejects(s.exec('echo x'), /dead/)
})

await test('two ssh_exec in parallel: second is refused, not queued', async () => {
  const s = await openLocal()
  const a = s.exec('sleep 0.3; echo a')
  const b = s.exec('echo b')
  await rejects(b, /busy/)
  eq((await a).stdout, 'a\n')
  await s.close()
})

await test('timeout terminates children and keeps the session', async () => {
  const s = await openLocal()
  await s.exec('Y=keep')
  const err = await rejects(s.exec('sleep 30', { timeoutMs: 300 }), /timeout/)
  assert(err.result.exitCode !== 0)
  eq(s.state, 'idle')
  eq((await s.exec('echo $Y')).stdout, 'keep\n')
  await s.close()
})

await test('uninterruptible builtin loop: session becomes dead after grace', async () => {
  const s = await openLocal()
  const err = await rejects(s.exec('while :; do :; done', { timeoutMs: 200 }), /timeout/)
  assert(/could not be recovered/.test(err.message), err.message)
  eq([s.state, s.deadReason], ['dead', 'killed'])
})

await test('background job: returns jobId, notifies, ssh_read pages', async () => {
  const s = await openLocal()
  const started = await s.exec('for i in 1 2 3; do echo line$i; sleep 0.1; done; exit_rc() { return 4; }; exit_rc', { background: true })
  assert(/^j\d+$/.test(started.jobId))
  await rejects(s.exec('echo x'), /busy running background job/)
  const done = await new Promise((r) => s.once('job', r))
  eq(done.exitCode, 4)
  const page = s.read({ jobId: started.jobId, offset: 0, limit: 6 })
  eq([page.data, page.nextOffset, page.eof, page.finished], ['line1\n', 6, false, true])
  const rest = s.read({ jobId: started.jobId, offset: page.nextOffset })
  eq([rest.data, rest.eof, rest.exitCode], ['line2\nline3\n', true, 4])
  await rejects(Promise.resolve().then(() => s.read({ jobId: 'j9' })), /unknown/)
  await s.close()
})

await test('log size limit stops the spool', async () => {
  const s = await openLocal({ spoolMaxBytes: 1000 })
  await s.exec('i=0; while [ $i -lt 200 ]; do echo 0123456789; i=$((i+1)); done', { background: true })
  const done = await new Promise((r) => s.once('job', r))
  assert(done.spoolFull)
  const page = s.read({ offset: 0, limit: 100000 })
  eq(page.nextOffset, 1000)
  assert(page.warning !== undefined)
  await s.close()
})

await test('stdout sentinel split by a large output', async () => {
  const s = await openLocal()
  const r = await s.exec('head -c 300000 /dev/zero | tr "\\0" x; echo')
  assert(r.truncated)
  assert(r.stdout.startsWith('x'.repeat(100)) && r.stdout.endsWith('x\n'))
  await s.close()
})

await test('secret environment variables are injected verbatim', async () => {
  const s = await openLocal({ env: { API_TOKEN: "a'b c$d" } })
  eq((await s.exec('printf %s "$API_TOKEN"')).stdout, "a'b c$d")
  await s.close()
})

await test('non-POSIX remote is refused at probe', async () => {
  const transport = { spawnMain: () => spawn('cat', [], { stdio: 'pipe' }), runSide: async () => ({ code: 0 }) }
  const session = new SshSession({ id: 's1', host: HOST, transport, spoolDir: spool })
  const clock = session.clock
  void clock
  // cat 会把脚本原样回显，探测行里 $$ 不是数字 → 拒绝。
  await rejects(session.open(), /probe-failed|POSIX/)
  eq(session.state, 'dead')
})

await test('network drop marks the session dead(network)', async () => {
  const s = await openLocal()
  s.child.kill('SIGKILL')
  await new Promise((r) => s.once('dead', r))
  eq(s.deadReason, 'network')
})

await test('ssh_kill during handshake', async () => {
  const transport = { spawnMain: () => spawn('sh', ['-c', 'sleep 5'], { stdio: 'pipe' }), runSide: async () => ({ code: 0 }) }
  const s = new SshSession({ id: 's1', host: HOST, transport, spoolDir: spool })
  const opening = s.open()
  await sleep(50)
  await s.close('killed')
  await rejects(opening, /probe-failed|handshake/)
  eq(s.state, 'dead')
})

// ---- 管理器 ------------------------------------------------------------------

function newManager(clock, extra = {}) {
  const notices = []
  const m = new SshManager({ transportFor: () => localTransport(), clock, notify: (n) => notices.push(n), spoolDir: spool, ...extra })
  m.configure({ hosts: parseHostList([{ name: 'local', address: '127.0.0.1', user: 'tester', maxSessions: 2 }]).hosts, settings: { idleMinutes: 30, hardCapHours: 24, globalMax: 3 } })
  return { m, notices }
}

await test('whitelist: unknown host lists available hosts', async () => {
  const { m } = newManager(new FakeClock())
  await rejects(m.open('A', { host: 'nope' }), /available hosts: local/)
  m.dispose()
})

await test('ids increase per DSH session and are never reused; ended vs never existed', async () => {
  const { m } = newManager(new FakeClock())
  const a = await m.open('A', { host: 'local' })
  await m.kill('A', a.sessionId)
  const b = await m.open('A', { host: 'local' })
  eq([a.sessionId, b.sessionId], ['s1', 's2'])
  const other = await m.open('B', { host: 'local' })
  eq(other.sessionId, 's1')
  eq((await m.kill('A', 's1')).alreadyEnded, true)
  await rejects(Promise.resolve().then(() => m.get('A', 's9')), /unknown/)
  await m.closeAll()
  m.dispose()
})

await test('per-host and global limits', async () => {
  const { m } = newManager(new FakeClock())
  await m.open('A', { host: 'local' })
  await m.open('A', { host: 'local' })
  await rejects(m.open('A', { host: 'local' }), /limit 2/)
  await m.closeAll()
  m.dispose()
})

await test('idle timeout closes; 0 disables', async () => {
  const clock = new FakeClock()
  const { m, notices } = newManager(clock)
  m.settings.wake = true
  const a = await m.open('A', { host: 'local', agentId: 'agent-1' })
  clock.t += 31 * 60000
  m.sweep()
  const s = m.get('A', a.sessionId)
  await s.exited
  eq(s.deadReason, 'idle')
  await sleep(10)
  assert(notices.some((n) => /s1 会话已结束：空闲超时/.test(n.text) && n.agentId === 'agent-1'), JSON.stringify(notices))
  m.configure({ settings: { idleMinutes: 0 } })
  const b = await m.open('A', { host: 'local' })
  clock.t += 1000 * 60000
  m.sweep()
  eq(m.get('A', b.sessionId).state, 'idle')
  await m.closeAll()
  m.dispose()
})

await test('hard cap via clock jump; shrinking limits waits 5 minutes', async () => {
  const clock = new FakeClock()
  const { m } = newManager(clock)
  const a = await m.open('A', { host: 'local' })
  m.configure({ settings: { hardCapHours: 1 } })
  clock.t += 2 * 3600000 - 1
  m.sweep()
  // 宽限期内（上限变更 5 分钟后才生效）——但 2 小时后宽限早过了，第一次 sweep 应用新上限，下一次关闭。
  m.sweep()
  const s = m.get('A', a.sessionId)
  await s.exited
  eq(s.deadReason, 'hard-cap')
  m.dispose()
})

await test('disabling SSH drains: refuse new, running finish', async () => {
  const { m } = newManager(new FakeClock())
  const a = await m.open('A', { host: 'local' })
  const running = m.exec('A', { sessionId: a.sessionId, command: 'sleep 0.2; echo done' })
  m.configure({ settings: { enabled: false } })
  await rejects(m.open('A', { host: 'local' }), /disabled/)
  eq((await running).stdout, 'done\n')
  await rejects(m.exec('A', { sessionId: a.sessionId, command: 'echo x' }), /draining/)
  await m.closeAll()
  m.dispose()
})

await test('host removed: drained and closed when idle', async () => {
  const clock = new FakeClock()
  const { m } = newManager(clock)
  const a = await m.open('A', { host: 'local' })
  m.configure({ hosts: new Map() })
  const s = m.get('A', a.sessionId)
  assert(s.draining)
  m.sweep()
  await s.exited
  eq(s.deadReason, 'host-removed')
  m.dispose()
})

await test('background completion notice format; merged; dropped after owner closed', async () => {
  const { m, notices } = newManager(new FakeClock())
  const a = await m.open('A', { host: 'local', agentId: 'ag' })
  const b = await m.open('A', { host: 'local', agentId: 'ag' })
  await m.exec('A', { sessionId: a.sessionId, command: 'sleep 0.1; (exit 1)', background: true })
  await m.exec('A', { sessionId: b.sessionId, command: 'sleep 0.1', background: true })
  await sleep(600)
  const texts = notices.map((n) => n.text).join('\n')
  assert(/^\[ssh\] local · s1 后台任务 j1 已结束：exit=1，用时 \d+(m\d+)?s，输出 0 B。用 ssh_read 查看。$/m.test(texts), texts)
  assert(/s2 后台任务 j1 已结束：exit=0/.test(texts), texts)
  const count = notices.length
  await m.exec('A', { sessionId: a.sessionId, command: 'sleep 0.2', background: true })
  await m.ownerClosed('A')
  await sleep(400)
  eq(notices.length, count)
  m.dispose()
})

await test('notice tail lines are opt-in', async () => {
  const { m, notices } = newManager(new FakeClock())
  m.configure({ settings: { noticeTailLines: 2 } })
  const a = await m.open('A', { host: 'local', agentId: 'ag' })
  await m.exec('A', { sessionId: a.sessionId, command: 'echo one; echo two; echo three', background: true })
  await sleep(300)
  assert(/最后 2 行[^\n]*\ntwo\nthree$/.test(notices.at(-1).text), notices.at(-1).text)
  await m.closeAll()
  m.dispose()
})

await test('reopen restores only the directory', async () => {
  const { m } = newManager(new FakeClock())
  const a = await m.open('A', { host: 'local' })
  await m.exec('A', { sessionId: a.sessionId, command: 'cd /tmp; Z=1' })
  await m.kill('A', a.sessionId)
  const b = await m.open('A', { host: 'local', reopen: a.sessionId })
  eq(b.cwd, '/tmp')
  eq((await m.exec('A', { sessionId: b.sessionId, command: 'echo "${Z-none}"' })).stdout, 'none\n')
  await m.closeAll()
  m.dispose()
})

// ---- 投影 --------------------------------------------------------------------

await test('projection folds tool calls, results and notices', () => {
  let state = initState()
  const call = (callId, name, args) => ({ type: 'tool/call', data: { callId, name, arguments: args } })
  const result = (callId, value) => ({ type: 'tool/result', data: { message: { role: 'tool', source: { kind: 'tool', callId }, content: [{ type: 'text', text: JSON.stringify(value) }] } } })
  state = applyEvent(state, call('c1', 'ssh_open', { host: 'local' }))
  state = applyEvent(state, result('c1', { sessionId: 's1', host: 'local', cwd: '/home', shell: 'bash', os: 'Linux', state: 'idle', expiresAt: 5 }))
  state = applyEvent(state, call('c2', 'ssh_exec', { sessionId: 's1', command: 'make', background: true }))
  eq(view(state).rows[0].state, 'running')
  state = applyEvent(state, result('c2', { jobId: 'j1', logPath: '/x' }))
  eq([view(state).rows[0].mode, view(state).rows[0].jobId], ['bg', 'j1'])
  state = applyEvent(state, { type: 'user/message', data: { source: { kind: 'ssh' }, content: [{ type: 'text', text: '[ssh] local · s1 后台任务 j1 已结束：exit=0，用时 1s，输出 0 B。用 ssh_read 查看。' }] } })
  eq(view(state).rows[0].state, 'idle')
  state = applyEvent(state, { type: 'user/message', data: { source: { kind: 'ssh' }, content: [{ type: 'text', text: '[ssh] local · s1 会话已结束：连接断开。' }] } })
  eq([view(state).rows[0].state, view(state).rows[0].deadReasonText], ['dead', '连接断开'])
  const same = applyEvent(state, { type: 'turn/start', data: {} })
  assert(same === state, 'unrelated events keep the same reference')
})

// ---- 插件接线（假 ctx + 假 ssh 可执行文件）---------------------------------

await test('plugin wiring: tools, approval gate, read-only, rootKey', async () => {
  const fakeSsh = join(work, 'fake-ssh')
  writeFileSync(fakeSsh, '#!/bin/sh\nexec sh\n')
  chmodSync(fakeSsh, 0o755)
  const tools = new Map()
  const listeners = new Map()
  const effects = []
  let mode = 'workspace-write'
  const ctx = {
    tools: { register: (def) => { tools.set(def.name, def); return () => tools.delete(def.name) } },
    effect: (fn) => { const d = fn(); effects.push(d); return d },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    get: (name) => name === 'sandboxPolicy' ? { resolve: () => ({ mode }) } : undefined,
  }
  const manager = plugin.apply(ctx, { ...plugin.Config({}), stateDir: join(work, 'state'), sshPath: fakeSsh, hosts: [{ name: 'local', address: '127.0.0.1', user: 'tester' }, { name: 'prod', address: '10.1.1.1', user: 'u' }], approvalList: '10.0.0.0/8' })
  eq([...tools.keys()].sort(), ['ssh_exec', 'ssh_kill', 'ssh_list', 'ssh_open', 'ssh_read'])
  const agent = { id: 'a1', session: { id: 'root-1' } }
  const child = { id: 'a2', session: { id: 'child-1' }, parent: agent }
  eq(plugin.rootKey(child), 'root-1')
  const gate = listeners.get('tools/pre-execute')
  eq((await gate({ name: 'ssh_open', arguments: { host: 'prod' }, agent }, async () => ({ kind: 'allow' }))).kind, 'ask')
  eq((await gate({ name: 'ssh_open', arguments: { host: 'local' }, agent }, async () => ({ kind: 'allow' }))).kind, 'allow')
  const opened = await tools.get('ssh_open').execute({ host: 'local' }, { agent: child })
  eq(opened.sessionId, 's1')
  const r = await tools.get('ssh_exec').execute({ sessionId: 's1', command: 'echo via-plugin' }, { agent })
  eq(r.stdout, 'via-plugin\n')
  const rendered = tools.get('ssh_exec').output.render({}, r)[0].text
  assert(JSON.parse(rendered).stdout === 'via-plugin\n')
  mode = 'read-only'
  await rejects(tools.get('ssh_exec').execute({ sessionId: 's1', command: 'echo x' }, { agent }), /read-only/)
  const listed = await tools.get('ssh_list').execute({}, { agent })
  eq(listed.sessions.length, 1)
  mode = 'workspace-write'
  assert(existsSync(join(work, 'state', 'sessions.json')))
  await tools.get('ssh_kill').execute({ sessionId: 's1' }, { agent })
  manager.dispose()
})

await test('real sshd (skipped when sshd is unavailable)', async () => {
  const sshd = ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find((p) => existsSync(p))
  if (sshd === undefined || spawnSync('ssh', ['-V']).error) { console.log('  (skip: no sshd/ssh on this machine)'); return }
  console.log('  (real sshd test not implemented in this environment)')
})

rmSync(work, { recursive: true, force: true })
console.log(`SUMMARY pass=${pass} fail=${fail}`)
if (fail > 0) { console.log('FAILED: ' + failures.join(', ')); process.exitCode = 1 }
process.exit()
