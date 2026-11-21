// SSH 模块测试：node test/sshtest.mjs。输出 PASS/FAIL <名>，结尾 SUMMARY。
// 两层替身：本机 sh 当远端（transport 层）+ 假时钟；真 sshd 用例在本机有 sshd/ssh 客户端时才跑。
import { spawn, spawnSync } from 'node:child_process'
import { mkdtempSync, writeFileSync, chmodSync, rmSync, existsSync, readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import net from 'node:net'
import { join, resolve } from 'node:path'
import { parseHost, parseHostList, parseApprovalList, approvalFor } from '../plugin/ssh/hosts.mjs'
import { buildSshArgv, describeCredentials } from '../plugin/ssh/argv.mjs'
import { SentinelSplitter, commandScript } from '../plugin/ssh/framing.mjs'
import { decodeOutput, foldCarriageReturns, OutputBuffer, renderSnapshot } from '../plugin/ssh/output.mjs'
import { SshSession } from '../plugin/ssh/session.mjs'
import { SshManager } from '../plugin/ssh/manager.mjs'
import { applyEvent, initState, view, registerProjection } from '../plugin/ssh/projection.mjs'
import * as plugin from '../plugin/ssh/index.mjs'

if (process.platform === 'win32') {
  // Windows 上没有 POSIX sh 可当远端；这些用例要在 Linux/macOS/WSL 里跑。
  console.log('SKIP: sshtest needs a POSIX sh (run it inside WSL)')
  console.log('SUMMARY pass=0 fail=0 skip=1')
  // 设了门闩就不许整份被平台跳过：CI 在 Windows 上跑 pnpm test 时这条会拦住假绿。
  if (process.env.DSH_REQUIRE_REAL_SSHD === '1') { console.log('REQUIRED: the whole suite was skipped on win32'); process.exitCode = 1 }
  process.exit()
}

let pass = 0
let fail = 0
let skip = 0
const failures = []
// 环境缺失（没有 sshd 等）单独计数：它既不是通过，也不该让整份测试变红。
function skipTest(name, reason) { skip++; console.log('SKIP ' + name + ': ' + reason) }
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

await test('host list accepts user@host, bare host and alias maps', () => {
  const { hosts, errors } = parseHostList({
    plain: 'example.com',
    withUser: 'deploy@example.com',
    object: { host: '10.0.0.5', user: 'u', port: 2222 },
  })
  eq(errors, [])
  eq([...hosts.keys()], ['plain', 'withUser', 'object'])
  eq(hosts.get('withUser').user, 'deploy')
  eq(hosts.get('withUser').address, 'example.com')
  eq(hosts.get('object').address, '10.0.0.5')
  eq(hosts.get('object').port, 2222)
  assert(/^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/.test(hosts.get('plain').user), hosts.get('plain').user)
  eq([hosts.get('plain').userDefaulted, hosts.get('withUser').userDefaulted, hosts.get('object').userDefaulted], [true, false, false])
  eq(parseHostList({}).errors, ['host list must not be empty'])
  eq(parseHostList({ ok: 42 }).errors, ['host "ok": value must be "user@host", "host" or an object'])
  eq(parseHostList([{ name: 'x', address: 'u@example.com', user: 'v' }]).errors, ['host "x": user is set both in the address and as a field'])
})

await test('argument injection is rejected at parse time', () => {
  for (const address of ['-p22', 'host;rm', 'a"b', "a'b", 'x\ny']) {
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

await test('credentials stay on the via side: identityFile, identityAgent, pipe through env', () => {
  const known = { privateKnownHosts: '~/.ssh/dsh_known_hosts' }
  const wsl = parseHost({ name: 'w', address: 'root@192.0.2.5', via: 'wsl', identityFile: '~/.ssh/qq_bot', identityAgent: 'none' })
  const w = buildSshArgv(wsl, known)
  eq(w.env, undefined)
  assert(!w.args.some((arg) => String(arg).startsWith('SSH_AUTH_SOCK=')), 'no agent socket when identityAgent is none')
  const wi = w.args.indexOf('IdentityFile=~/.ssh/qq_bot')
  assert(wi > 0 && w.args[wi - 1] === '-o' && w.args[wi + 2] === 'IdentitiesOnly=yes', 'IdentityFile comes with IdentitiesOnly')
  assert(w.args.includes('IdentityAgent=none'))
  assert(w.args.indexOf('IdentityAgent=none') < w.args.indexOf('--'), 'options come before the host')
  const win = parseHost({ name: 'x', address: 'root@192.0.2.5', identityFile: 'C:/Users/you/.ssh/qq_bot', identityAgent: '\\\\.\\pipe\\openssh-ssh-agent' })
  const x = buildSshArgv(win, known)
  eq(x.command, 'ssh')
  eq(x.env, { SSH_AUTH_SOCK: '\\\\.\\pipe\\openssh-ssh-agent' })
  assert(!x.args.some((arg) => String(arg).includes('\\')), 'no backslash reaches the ssh argv')
  assert(x.args.includes('IdentityFile=C:/Users/you/.ssh/qq_bot'))
  // 旧字段 agentSocket 仍然生效，并且与 identityAgent 等价
  const legacy = parseHost({ name: 'l', address: 'u@192.0.2.5', via: 'wsl', agentSocket: '/home/u/a.sock' })
  eq([legacy.identityAgent, legacy.agentSocket], ['/home/u/a.sock', '/home/u/a.sock'])
  for (const [entry, pattern] of [
    [{ name: 'b1', address: 'u@h', identityAgent: '/tmp/a.sock' }, /pipe/],
    [{ name: 'b2', address: 'u@h', identityAgent: '\\\\.\\pipe\\a b' }, /pipe/],
    [{ name: 'b3', address: 'u@h', identityFile: 'C:\\Users\\u\\.ssh\\k' }, /plain path/],
    [{ name: 'b4', address: 'u@h', identityFile: '-oProxyCommand=x' }, /plain path/],
    [{ name: 'b5', address: 'u@h', via: 'wsl', agentSocket: '/a', identityAgent: '/b' }, /disagree/],
    [{ name: 'b6', address: 'u@h', identityAgent: 7 }, /string/],
  ]) {
    let error
    try { parseHost(entry) } catch (caught) { error = caught }
    assert(error !== undefined && pattern.test(error.message), entry.name + ': ' + error?.message)
  }
  const line = describeCredentials(wsl)
  assert(line.includes('via wsl') && line.includes('agent none') && line.includes('key ~/.ssh/qq_bot only') && line.includes('root@192.0.2.5:22'), line)
  assert(describeCredentials(parseHost({ name: 'd', address: 'u@h' })).includes('agent default'))
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

await test('auth failure names the side, agent and key that were used', async () => {
  const host = parseHost({ name: 'w', address: 'root@192.0.2.5', via: 'wsl', identityAgent: '/home/u/.ssh/agent.sock' })
  const transport = { spawnMain: () => spawn('sh', ['-c', 'echo "root@192.0.2.5: Permission denied (publickey)." >&2; exit 255'], { stdio: 'pipe' }), runSide: async () => ({ code: 0 }) }
  const s = new SshSession({ id: 's1', host, transport, spoolDir: spool })
  let error
  try { await s.open() } catch (caught) { error = caught }
  assert(error !== undefined, 'open should fail')
  assert(/Permission denied/.test(error.message) && error.message.includes('via wsl · root@192.0.2.5:22 · agent /home/u/.ssh/agent.sock'), error.message)
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

await test('whitelist: an empty host list says where to add hosts', async () => {
  const { m } = newManager(new FakeClock())
  m.configure({ hosts: new Map() })
  await rejects(m.open('A', { host: 'local' }), /no hosts are configured; add them under Settings/)
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

await test('projection view reuses the reference the host compares', () => {
  let state = initState()
  const first = view(state)
  assert(view(state) === first, 'the same state must give the same view object')
  state = applyEvent(state, { type: 'tool/call', data: { callId: 'c1', name: 'ssh_open', arguments: { host: 'local' } } })
  const second = view(state)
  assert(second !== first, 'a new state must give a new view')
  assert(view(state) === second, 'the cache follows the new state')
})

await test('projection registration matches the host contract', async () => {
  let definition
  const handle = { stateOf: () => undefined, readerFor: () => undefined, dispose: () => {} }
  const ctx = { sessionProjections: { register: (value) => { definition = value; return Promise.resolve(handle) } } }
  const pending = registerProjection(ctx)
  assert(typeof pending?.then === 'function', 'registerProjection hands back a promise a caller may await')
  assert(await pending === handle, 'the registration handle is passed through')
  eq([definition.key, definition.stateVersion], ['sshSessions', 1])
  // 宿主运行时只调 .parse：状态与视图都要过得了这两个 schema
  const state = definition.stateSchema.parse(definition.init())
  const next = definition.apply(state, { type: 'tool/call', data: { callId: 'c1', name: 'ssh_open', arguments: { host: 'local' } } })
  definition.wire.viewSchema.parse(definition.wire.view(next))
  // plugin/index.mjs 不 await 这个 Promise：拒绝必须被收在这里，不能变成未处理的拒绝
  eq(await registerProjection({ sessionProjections: { register: () => Promise.reject(new Error('boom')) } }), undefined)
})

// ---- 浏览器半侧：SSH 设置分组 -------------------------------------------------
const hostsSpecFor = (FakeForm) => FakeForm.lastSpecs.find((spec) => spec.field === 'hosts')
await test('client registers the ssh settings section and row config page', async () => {
  // 宿主不会按 Config 自动出表单，设置页由 client/index.js 自己登记；这里用最小桩检查形状。
  const registered = []
  const disposers = []
  // Node 21 起 globalThis.navigator 是只读 getter，直接赋值会抛；按描述符打桩再原样还原。
  const saved = Object.fromEntries(['window','document','navigator','MutationObserver'].map((key) => [key, Object.getOwnPropertyDescriptor(globalThis, key)]))
  const stub = (key, value) => Object.defineProperty(globalThis, key, { value, configurable: true, writable: true })
  class FakeForm {
    constructor(scope, specs) { this.scope = scope; this.specs = specs; if (specs.some((spec) => spec.field === 'hosts')) FakeForm.lastSpecs = specs }
    bind(project) { this.project = project; return { getSnapshot: () => project(), subscribe: () => () => {} } }
    shell() { return { available: true, writable: true, dirty: true, invalid: false, saving: false, failed: false } }
    field(name) { return { text: name === 'enabled' ? 'true' : '12', overridden: false, invalid: false } }
    actions() { return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} } }
    dispose() {}
  }
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (value) => [value, () => {}], useEffect: () => {} }
  const primitives = { SettingsForm: 'SettingsForm', SettingsFormModel: FakeForm, Switch: 'Switch', Button: 'Button', settingsNumberField: (field) => ({ field }), settingsTextField: (field) => ({ field }) }
  const scope = { getSnapshot: () => ({ status: 'ready', value: { enabled: true, hosts: [], approvalList: '' }, base: {}, user: {}, writable: true, revision: 3 }), subscribe: () => () => {}, mutate: async () => true }
  const ctx = {
    configForms: { get: () => scope, whileServed: (namespaces, register) => register() },
    slots: { register: (entry, component) => { registered.push({ entry, component }); return () => {} }, inject: (name, register) => register() },
    effect: (fn) => { const dispose = fn(); disposers.push(dispose); return dispose },
    plugin: () => {},
  }
  let loaded
  try {
    stub('window', { __ModuleLoader__: { load: (value) => { loaded = value } } })
    stub('document', { documentElement: { lang: 'zh-CN' } })
    stub('navigator', { language: 'zh-CN' })
    stub('MutationObserver', class { observe() {} disconnect() {} })
    new Function(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'))()
    assert(loaded?.factory !== undefined, 'the client module should call the module loader')
    const plugin = loaded.factory((id) => id === 'react' ? react : primitives)
    plugin.apply(ctx)
    // 组件在 render 时读 document.documentElement.lang，所以断言要在撤桩之前跑完
    const section = registered.find((item) => item.entry.name === 'settings.section')
    const row = registered.find((item) => item.entry.name === 'plugins.row.config')
    assert(section !== undefined && row !== undefined, 'both slots are registered')
    eq([section.entry.id, typeof section.entry.label], ['ssh', 'string'])
    eq(row.entry.key, 'dsh-pwsh-plugin' + '#' + 'ssh')
    const injected = section.entry.inject()
    const state = injected.hooks.sshSettings.getSnapshot()
    eq([state.writable, Object.keys(state.fields).sort()], [true, ['approvalList', 'approvalListInvert', 'enabled', 'globalMax', 'hardCapHours', 'hosts', 'idleMinutes']])
    const page = section.component({ view: 'page', useSshSettings: (selector) => selector(state), ...injected })
    assert(page !== null && page.type === 'div', 'the page renders a container')
    const findSetting = (node, setting) => {
      if (node === null || node === undefined) return undefined
      if (Array.isArray(node)) { for (const child of node) { const hit = findSetting(child, setting); if (hit !== undefined) return hit } return undefined }
      if (typeof node !== 'object') return undefined
      if (node.props?.['data-setting'] === setting) return node
      return findSetting(node.children, setting)
    }
    const invert = findSetting(page, 'approvalListInvert')
    assert(invert !== undefined, 'the approval invert switch is rendered')
    eq(invert.type, 'Switch')
    eq(invert.props.checked, false)
    assert(String(invert.props.label).includes('反转'), invert.props.label)
    // 说明文案跟着开关走：默认关闭时只描述「名单内要审批」，打开后只描述「名单内免审批」
    const texts = (node, out = []) => {
      if (typeof node === 'string') out.push(node)
      else if (Array.isArray(node)) node.forEach((child) => texts(child, out))
      else if (node !== null && typeof node === 'object') texts(node.children, out)
      return out
    }
    const find = (node, test) => {
      if (Array.isArray(node)) { for (const child of node) { const hit = find(child, test); if (hit !== undefined) return hit } return undefined }
      if (node === null || typeof node !== 'object') return undefined
      if (test(node)) return node
      return find(node.children, test)
    }
    const offText = texts(page).join('\n')
    assert(offText.includes('关闭：名单是「要审批」的主机') && offText.includes('名单内的主机在 ssh_open 与每条 ssh_exec 时都要人工批准，名单外自动放行'), 'off copy describes the gate')
    assert(!offText.includes('名单内的主机自动放行') && !offText.includes('关闭时相反'), 'off copy does not describe the inverted mode')
    const onState = { ...state, fields: { ...state.fields, approvalListInvert: { text: 'true', overridden: true, invalid: false } } }
    const onPage = section.component({ view: 'page', useSshSettings: (selector) => selector(onState), ...injected })
    const onText = texts(onPage).join('\n')
    eq(findSetting(onPage, 'approvalListInvert').props.checked, true)
    assert(onText.includes('开启：名单是「免审批」的主机') && onText.includes('名单内的主机自动放行，名单外的主机'), 'on copy describes the allow list')
    assert(!offText.includes('disabled: true'), 'the scope note no longer says the row ships disabled')
    // 主机清单示例：能被表单解析，也能被服务端整条接受；只在清单为空时可一键填入
    const example = find(page, (node) => node.props?.['data-ssh-hosts-example'] !== undefined)
    assert(example !== undefined && example.type === 'details', 'the hosts example is rendered')
    const [full, short] = texts(example).filter((text) => /^[[{]/.test(text.trim()))
    const parsedExample = hostsSpecFor(FakeForm).parse(full)
    eq([parsedExample.kind, parsedExample.value.map((entry) => entry.name)], ['set', ['web', 'db', 'lab']])
    const served = parseHostList(full)
    eq([served.hosts.size, served.errors], [3, []], 'the server accepts every example host')
    eq(hostsSpecFor(FakeForm).parse(short).value.map((entry) => entry.name), ['web', 'db'])
    assert(!/\b(?!192\.0\.2\.)\d+\.\d+\.\d+\.\d+\b/.test(full) && !/@(?![\w.]*example\.com|192\.0\.2\.)/.test(full), 'the example only uses reserved addresses')
    const fill = find(example, (node) => node.props?.['data-action'] === 'fill-ssh-hosts-example')
    eq(fill.props.disabled, true, 'a non-empty host list is not overwritten')
    const emptyState = { ...state, fields: { ...state.fields, hosts: { text: '[ ]', overridden: false, invalid: false } } }
    const edits = []
    const emptyPage = section.component({ view: 'page', useSshSettings: (selector) => selector(emptyState), ...injected, edit: (name, value) => edits.push([name, value]) })
    const emptyFill = find(emptyPage, (node) => node.props?.['data-action'] === 'fill-ssh-hosts-example')
    eq(emptyFill.props.disabled, false)
    emptyFill.props.onClick()
    eq(edits, [['hosts', full]])
    const hostsSpec = hostsSpecFor(FakeForm)
    assert(hostsSpec !== undefined, 'the hosts spec exists')
    for (const invalid of ['{}', 'x', '[1]', '{"bad alias":"example.com"}', '{"ok":""}', '{"ok":"a b"}', '[{"name":"ok","address":"example.com","port":70000}]', '[{"name":"ok","address":"example.com","adress":"typo"}]', '{"ok":{"host":"example.com","via":"linux"}}', '{"ok":{"host":"example.com","loadProfile":"yes"}}']) {
      eq(hostsSpec.parse(invalid), undefined, invalid)
    }
    const parsed = hostsSpec.parse('{"ok":"user@example.com"}')
    eq(parsed.kind, 'set')
    eq(parsed.value.length, 1)
    eq([parsed.value[0].name, parsed.value[0].address, parsed.value[0].user], ['ok', 'example.com', 'user'])
    eq(hostsSpec.parse('[]').kind, 'clear', 'an empty array clears the list')
    eq(hostsSpec.parse('[{"name":"k","address":"u@h","via":"wsl","identityFile":"~/.ssh/k","identityAgent":"none"}]').value[0].identityFile, '~/.ssh/k')
    eq(hostsSpec.parse('[{"name":"k","address":"u@h","identityAgent":"\\\\\\\\.\\\\pipe\\\\openssh-ssh-agent"}]').kind, 'set')
    for (const invalid of ['[{"name":"k","address":"u@h","identityFile":"C:\\\\Users\\\\k"}]', '[{"name":"k","address":"u@h","identityAgent":"/tmp/a"}]', '[{"name":"k","address":"u@h","agentSocket":"/tmp/a"}]']) eq(hostsSpec.parse(invalid), undefined, invalid)
    const bare = hostsSpec.parse('{"ok":"example.com"}')
    eq(bare.kind, 'set')
    eq(bare.value[0].user, undefined)
    assert(section.component({ view: 'summary' }).length > 0, 'the summary is a non-empty line')
  } finally {
    for (const [name, descriptor] of Object.entries(saved)) { if (descriptor === undefined) delete globalThis[name]; else Object.defineProperty(globalThis, name, descriptor) }
    for (const dispose of disposers) if (typeof dispose === 'function') dispose()
  }
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
  eq(listed.hosts.find((h) => h.name === 'local'), { name: 'local', via: 'windows', user: 'tester' })
  mode = 'workspace-write'
  assert(existsSync(join(work, 'state', 'sessions.json')))
  await tools.get('ssh_kill').execute({ sessionId: 's1' }, { agent })
  manager.dispose()
})

// ---- 真 sshd ------------------------------------------------------------------
// 起一个临时 sshd：只绑 127.0.0.1，端口由内核挑（绝不用 22，也绝不绑 0.0.0.0），
// 主机钥匙/用户钥匙/authorized_keys 全在临时目录里；结束一律 kill 并删目录。
// 缺 sshd 或 ssh 客户端时只 SKIP，并打印缺的是哪个。
function commandPath(name) {
  const found = spawnSync('sh', ['-c', 'command -v ' + name], { encoding: 'utf8' })
  return found.status === 0 ? found.stdout.trim() : undefined
}

// 内核挑一个空闲高位端口后立刻释放——sshd 必须自己 bind 同一个端口，
// 我们不能把 socket 一直握着（那样 sshd 反而绑不上，SO_REUSEPORT 也不可移植）。
// 释放到 sshd 绑定之间仍有被别的进程抢走的窗口，所以 startRealSshd 用 withFreshPorts
// 在启动失败时换端口重试；这里只负责每次给一个新的候选端口。
async function freeHighPort() {
  const server = net.createServer()
  await new Promise((done, failed) => { server.once('error', failed); server.listen(0, '127.0.0.1', done) })
  const { port } = server.address()
  await new Promise((done) => server.close(done))
  return port
}

// 端口竞争是外部进程造成的，重试比断言“一定不会发生”可靠。每次失败都重新取端口，
// 最多 attempts 次；最后一次的错误原样带出来，方便区分端口冲突和 sshd 配置错误。
async function withFreshPorts(attempt, { attempts = 3, pickPort = freeHighPort } = {}) {
  const tried = []
  let last
  for (let i = 0; i < attempts; i++) {
    const port = await pickPort()
    tried.push(port)
    try { return await attempt(port) } catch (error) { last = error }
  }
  const reason = last instanceof Error ? last.message : String(last)
  throw new Error('gave up after ' + tried.length + ' port attempts (' + tried.join(', ') + '): ' + reason)
}

await test('sshd startup retries with a fresh port', async () => {
  const ports = []
  const result = await withFreshPorts(async (port) => {
    if (ports.length < 3) throw new Error('port ' + port + ' was taken')
    return port
  }, { pickPort: async () => { const port = 41000 + ports.length; ports.push(port); return port } })
  eq(result, 41002)
  eq(ports, [41000, 41001, 41002])
  let attempts = 0
  const error = await rejects(withFreshPorts(async () => { attempts++; throw new Error('busy') }, { pickPort: async () => 43000 + attempts }), /gave up after 3 port attempts/)
  eq(attempts, 3)
  assert(error.message.includes('43000, 43001, 43002'), error.message)
})

async function waitPort(port, ms) {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    const open = await new Promise((done) => {
      const socket = net.connect(port, '127.0.0.1')
      socket.once('connect', () => { socket.destroy(); done(true) })
      socket.once('error', () => done(false))
    })
    if (open) return true
    await sleep(100)
  }
  return false
}

async function startRealSshd() {
  const sshdPath = commandPath('sshd') ?? ['/usr/sbin/sshd', '/usr/local/sbin/sshd'].find((candidate) => existsSync(candidate))
  const bins = {
    sshd: sshdPath,
    ssh: commandPath('ssh'),
    'ssh-keygen': commandPath('ssh-keygen'),
    'ssh-agent': commandPath('ssh-agent'),
    'ssh-add': commandPath('ssh-add'),
  }
  const missing = Object.keys(bins).filter((name) => bins[name] === undefined)
  if (missing.length > 0) return { skip: 'no ' + missing.join('/') + ' on this machine' }
  const user = process.env.USER ?? process.env.LOGNAME
  if (user === undefined) return { skip: 'no $USER/$LOGNAME to log in as' }

  const dir = mkdtempSync(join(tmpdir(), 'sshtest-sshd-'))
  const hostKey = join(dir, 'host_key')
  const userKey = join(dir, 'user_key')
  const authorizedKeys = join(dir, 'authorized_keys')
  const knownHosts = join(dir, 'known_hosts')
  const configPath = join(dir, 'sshd_config')
  const agentSocket = join(dir, 'agent.sock')
  const log = []
  let agentStarted = false
  let sshd
  let previousAgent = process.env.SSH_AUTH_SOCK

  const cleanup = async () => {
    if (agentStarted) spawnSync(bins['ssh-agent'], ['-k'], { env: { ...process.env, SSH_AUTH_SOCK: agentSocket } })
    if (sshd !== undefined && sshd.exitCode === null && sshd.signalCode === null) {
      sshd.kill('SIGTERM')
      await new Promise((done) => { const timer = setTimeout(done, 3000); sshd.once('exit', () => { clearTimeout(timer); done() }) })
      if (sshd.exitCode === null && sshd.signalCode === null) sshd.kill('SIGKILL')
    }
    rmSync(dir, { recursive: true, force: true })
  }

  try {
    for (const key of [hostKey, userKey]) {
      const made = spawnSync(bins['ssh-keygen'], ['-q', '-t', 'ed25519', '-N', '', '-f', key], { encoding: 'utf8' })
      if (made.status !== 0) throw new Error('ssh-keygen failed: ' + String(made.stderr).trim())
    }
    // 临时公钥直接写进 authorized_keys；StrictModes 关掉，否则临时目录的属主/权限会被 sshd 拒绝
    writeFileSync(authorizedKeys, readFileSync(userKey + '.pub'))
    for (const file of [authorizedKeys, hostKey, userKey]) chmodSync(file, 0o600)
    writeFileSync(knownHosts, '')
    const writeConfig = (port) => {
      writeFileSync(configPath, [
        'Port ' + port,                        // 内核挑的空闲高位端口，不是 22
        'ListenAddress 127.0.0.1',             // 只监听回环
        'HostKey ' + hostKey,
        'AuthorizedKeysFile ' + authorizedKeys, // 必须是绝对路径
        'StrictModes no',
        'PidFile ' + join(dir, 'sshd.pid'),
        'UsePAM no',
        'PasswordAuthentication no',
        'KbdInteractiveAuthentication no',
        'PermitRootLogin no',
        'AllowUsers ' + user,                  // 显式放行当前用户：系统配置里的 AllowUsers 不含他时会 publickey 被拒
        'MaxStartups 5',
        'LogLevel VERBOSE',
      ].join('\n') + '\n')
      chmodSync(configPath, 0o600)
    }
    // sshd 不接受相对路径（会直接退出 255：sshd requires execution with an absolute path）
    const sshdBinary = sshdPath.startsWith('/') ? sshdPath : resolve(sshdPath)
    const stopChild = async (child) => {
      if (child.exitCode !== null || child.signalCode !== null) return
      child.kill('SIGTERM')
      await new Promise((done) => { const timer = setTimeout(done, 2000); child.once('exit', () => { clearTimeout(timer); done() }) })
      if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
    }
    const started = await withFreshPorts(async (port) => {
      writeConfig(port)
      log.length = 0
      const child = spawn(sshdBinary, ['-D', '-e', '-f', configPath], { stdio: ['ignore', 'pipe', 'pipe'] })
      child.stdout.on('data', (chunk) => log.push(String(chunk)))
      child.stderr.on('data', (chunk) => log.push(String(chunk)))
      if (!await waitPort(port, 5000)) {
        const tail = log.join('').split('\n').map((line) => line.trim()).filter(Boolean).slice(-3).join(' / ')
        await stopChild(child)
        throw new Error('sshd did not listen on 127.0.0.1:' + port + (tail === '' ? '' : ': ' + tail))
      }
      return { child, port }
    })
    sshd = started.child
    const port = started.port

    const agent = spawnSync(bins['ssh-agent'], ['-a', agentSocket], { encoding: 'utf8' })
    if (agent.status !== 0) throw new Error('ssh-agent failed: ' + String(agent.stderr).trim())
    agentStarted = true
    const added = spawnSync(bins['ssh-add'], [userKey], { encoding: 'utf8', env: { ...process.env, SSH_AUTH_SOCK: agentSocket } })
    if (added.status !== 0) throw new Error('ssh-add failed: ' + String(added.stderr).trim())

    // 插件拼的 argv 不带 -i，公钥认证只能靠 agent：临时 socket 交给 ssh 子进程继承
    process.env.SSH_AUTH_SOCK = agentSocket
    const host = parseHost({ name: 'real-sshd', address: '127.0.0.1', user, port })
    // 走插件的 transportFor，而不是在测试里另拼一份 argv：这样 via / sshPath 覆盖
    // 与 runSide 的错误分支都真的被覆盖到。userKnownHosts 留空以保持 argv 与断言一致。
    const transport = plugin.transportFor({ sshPath: 'ssh', wslPath: 'wsl.exe', knownHosts, userKnownHosts: undefined })(host)
    let stopped = false
    const stop = async () => {
      if (stopped) return
      stopped = true
      if (previousAgent === undefined) delete process.env.SSH_AUTH_SOCK
      else process.env.SSH_AUTH_SOCK = previousAgent
      await cleanup()
    }
    console.log('  (real sshd listening on 127.0.0.1:' + port + ' as ' + user + ')')
    return { host, transport, knownHosts, stop }
  } catch (error) {
    await cleanup()
    return { fail: 'could not start a real sshd: ' + error.message }
  }
}

// 五个用例共用同一个临时 sshd；缺环境时逐个 SKIP，但每个都打印具体原因。
const REAL_SSHD_TESTS = [
  'real sshd: opens a session',
  'real sshd: command output',
  'real sshd: variables and cwd survive across commands',
  'real sshd: exit code and stderr are separated',
  'real sshd: host key pinned and close ends the session',
]
const realSshd = await startRealSshd()
if (realSshd.skip !== undefined) {
  for (const name of REAL_SSHD_TESTS) skipTest(name, realSshd.skip)
} else if (realSshd.fail !== undefined) {
  // 环境齐备却启动不了：用例逐条失败，别让它伪装成跳过。
  for (const name of REAL_SSHD_TESTS) await test(name, () => { throw new Error(realSshd.fail) })
} else {
  const session = new SshSession({ id: 'real1', host: realSshd.host, transport: realSshd.transport, spoolDir: spool, defaultTimeoutMs: 20000 })
  let opened
  try {
    await test(REAL_SSHD_TESTS[0], async () => {
      opened = await session.open()
      eq([opened.state, opened.sessionId], ['idle', 'real1'])
      assert(typeof opened.shell === 'string' && opened.shell.length > 0, 'shell: ' + opened.shell)
      assert(opened.os === 'Linux' || opened.os === 'Darwin', 'os: ' + opened.os)
      assert(opened.cwd.startsWith('/'), 'cwd: ' + opened.cwd)
    })
    await test(REAL_SSHD_TESTS[1], async () => {
      if (opened === undefined) throw new Error('the session never opened')
      const result = await session.exec('echo hello-from-real-sshd')
      eq([result.exitCode, result.stdout, result.stderr], [0, 'hello-from-real-sshd\n', ''])
    })
    await test(REAL_SSHD_TESTS[2], async () => {
      if (opened === undefined) throw new Error('the session never opened')
      await session.exec('GREETING=ssh-real; cd /tmp')
      eq((await session.exec('echo "$GREETING ${PWD##*/}"')).stdout, 'ssh-real tmp\n')
    })
    await test(REAL_SSHD_TESTS[3], async () => {
      if (opened === undefined) throw new Error('the session never opened')
      const result = await session.exec('echo to-stdout; echo to-stderr >&2; (exit 7)')
      eq([result.exitCode, result.stdout, result.stderr], [7, 'to-stdout\n', 'to-stderr\n'])
    })
    await test(REAL_SSHD_TESTS[4], async () => {
      if (opened === undefined) throw new Error('the session never opened')
      // 首连 accept-new 应把真主机钥匙钉进临时 known_hosts —— 这就是「连的是真 sshd」的证据。
      // Debian 默认 HashKnownHosts yes，主机名是哈希过的（|1| 开头），不能指望明文 127.0.0.1。
      const pinned = readFileSync(realSshd.knownHosts, 'utf8').trim()
      assert(pinned !== '' && /^(127\.0\.0\.1|\|1\|)/.test(pinned), 'known_hosts should hold the host key, got: ' + JSON.stringify(pinned.slice(0, 24)))
      await session.close()
      eq([session.state, session.deadReason], ['dead', 'killed'])
    })
  } finally {
    await session.close().catch(() => {})
    await realSshd.stop()
  }
}

rmSync(work, { recursive: true, force: true })
console.log(`SUMMARY pass=${pass} fail=${fail} skip=${skip}`)
if (fail > 0) { console.log('FAILED: ' + failures.join(', ')); process.exitCode = 1 }
// CI 里设上它，缺 sshd 的机器就不会被当成通过。
if (skip > 0 && process.env.DSH_REQUIRE_REAL_SSHD === '1') { console.log('REQUIRED: ' + skip + ' case(s) were skipped'); process.exitCode = 1 }
process.exit()
