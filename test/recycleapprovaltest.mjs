// 会话内回收授权：node test/recycleapprovaltest.mjs。不需要 DSH 运行时与 pwsh。
import assert from 'node:assert/strict'
import { readFileSync } from 'node:fs'
import { RecycleApprovals, SESSION_NOTICE } from '../plugin/recycle-approvals.mjs'

let pass = 0, fail = 0
const check = async (name, fn) => {
  try { await fn(); pass++; console.log('PASS ' + name) } catch (error) { fail++; console.log('FAIL ' + name + ': ' + (error?.stack ?? error)) }
}
const c = (session, cwd = '/w', identity = 'b1') => ({ key: JSON.stringify([session, cwd, 'workspace-write']), session, backendIdentity: identity })

await check('always-mode-never-records', () => {
  const a = new RecycleApprovals()
  a.sync('always', 0)
  assert.equal(a.grant(c('s1')), false)
  assert.equal(a.covers(c('s1')), false)
  assert.equal(a.size, 0)
})

await check('unknown-mode-is-always', () => {
  const a = new RecycleApprovals()
  a.sync('forever', 0)
  assert.equal(a.enabled(), false)
})

await check('session-mode-covers-same-boundary-only', () => {
  const a = new RecycleApprovals()
  a.sync('session', 0)
  assert.equal(a.grant(c('s1')), true)
  assert.equal(a.covers(c('s1')), true)
  assert.equal(a.covers(c('s1', '/other')), false, 'another working directory asks again')
  assert.equal(a.covers(c('s2')), false, 'another session (including a child session) asks again')
  assert.equal(a.covers(c('s1', '/w', 'b2')), false, 'a replaced sandbox backend asks again')
})

await check('turning-the-switch-off-drops-everything', () => {
  const a = new RecycleApprovals()
  a.sync('session', 0); a.grant(c('s1')); a.grant(c('s2'))
  assert.equal(a.sync('always', 0), 2)
  a.sync('session', 0)
  assert.equal(a.covers(c('s1')), false, 'turning it back on does not revive old approvals')
})

await check('epoch-change-clears', () => {
  const a = new RecycleApprovals()
  a.sync('session', 3); a.grant(c('s1'))
  assert.equal(a.sync('session', 3), 0, 'same epoch keeps the record')
  assert.equal(a.covers(c('s1')), true)
  assert.equal(a.sync('session', 4), 1)
  assert.equal(a.covers(c('s1')), false)
})

await check('revoke-session-keeps-others', () => {
  const a = new RecycleApprovals()
  a.sync('session', 0); a.grant(c('s1')); a.grant(c('s1', '/x')); a.grant(c('s2'))
  assert.equal(a.countSession('s1'), 2)
  assert.equal(a.revokeSession('s1'), 2)
  assert.equal(a.covers(c('s2')), true)
  assert.equal(a.clear(), 1)
})

await check('notice-is-written-by-the-plugin', () => {
  assert.match(SESSION_NOTICE.reason, /covers later recycling/)
  assert.match(SESSION_NOTICE.display, /会话内授权/)
})

// ---- file-tools 接线：会话结束丢记录、开关事件、/recycle-approval 命令 -----------------
await check('file-tools-wires-session-end-config-and-command', async () => {
  const { installFileTools } = await import('../plugin/file-tools.mjs')
  const listeners = new Map(), effects = [], commands = []
  const ctx = {
    effect: (fn) => { const d = fn(); effects.push(d); return d },
    on: (name, fn) => { listeners.set(name, fn); return () => listeners.delete(name) },
    inject: (_deps, fn) => fn({ commands: { register: (def) => { commands.push(def); return () => {} } } }),
    tools: { register: () => () => {}, guard: () => () => {} },
    get: () => undefined,
  }
  const config = { recycleApproval: 'session', recycleApprovalEpoch: 0 }
  installFileTools(ctx, config, () => ({ mode: 'workspace-write' }))
  assert(listeners.has('agent/disposed') && listeners.has('loader/volatile-update'))
  const command = commands.find((def) => def.name === 'recycle-approval')
  assert(command !== undefined, 'the /recycle-approval command is registered')
  const run = (rawInput, session = 's1') => command.handler({ rawInput, agent: { session: { id: session } } })
  assert.match((await run('status')).text, /本会话有 0 条/)
  assert.equal((await run('bogus')).kind, 'error')
  config.recycleApproval = 'always'
  listeners.get('loader/volatile-update')([['recycleApproval']])
  assert.match((await run('status')).text, /未开启/)
  for (const d of effects.reverse()) if (typeof d === 'function') d()
})

// ---- 设置页 ----------------------------------------------------------------------------
await check('settings-page-exposes-switch-and-clear', async () => {
  const registered = [], mutations = []
  const snapshot = { status: 'ready', value: { enforcePwshRun: false, enforceFileRemoval: false, recycleApproval: 'always', recycleApprovalEpoch: 2 }, base: {}, user: {}, writable: true, revision: 7 }
  const scope = { getSnapshot: () => snapshot, subscribe: () => () => {}, mutate: async (ops, revision) => { mutations.push({ ops, revision }); return true } }
  class FakeForm {
    constructor(_scope, specs) { this.specs = specs }
    bind(project) { return { getSnapshot: () => project(), subscribe: () => () => {} } }
    shell() { return { available: true, writable: true, dirty: false, invalid: false, saving: false, failed: false } }
    field(name) { const spec = this.specs.find((s) => s.field === name); return { text: spec.format(snapshot.value[name]), overridden: false, invalid: false } }
    actions() { return { edit: () => {}, resetField: () => {}, save: () => {}, discard: () => {} } }
    dispose() {}
  }
  const react = { createElement: (type, props, ...children) => ({ type, props: props ?? {}, children }), useState: (value) => [value, () => {}] }
  const primitives = { SettingsForm: 'SettingsForm', SettingsFormModel: FakeForm, Switch: 'Switch', Button: 'Button' }
  let loaded
  const window = { __ModuleLoader__: { load: (value) => { loaded = value } } }
  const document = { documentElement: { lang: 'zh-CN' } }
  new Function('window', 'document', 'navigator', 'MutationObserver', readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'))(window, document, { language: 'zh-CN' }, class { observe() {} disconnect() {} })
  const plugin = loaded.factory((id) => id === 'react' ? react : primitives)
  plugin.apply({
    configForms: { get: () => scope, whileServed: (_names, register) => register() },
    slots: { register: (entry, component) => { registered.push({ entry, component }); return () => {} }, inject: (_name, register) => register() },
    effect: (fn) => fn(),
    plugin: () => {},
  })
  const section = registered.find((item) => item.entry.name === 'settings.section' && item.entry.id === 'pwsh-run')
  const injected = section.entry.inject()
  const state = injected.hooks.pwshSettings.getSnapshot()
  assert.equal(state.recycleField.text, 'always')
  assert.equal(state.recycleAccepted, false)
  // 页面里有开关与清除按钮
  const find = (node, test) => node === null || typeof node !== 'object' ? undefined : test(node) ? node : (node.children ?? []).flat(Infinity).map((child) => find(child, test)).find(Boolean)
  const page = section.component({ view: 'page', usePwshSettings: (selector) => selector(state), ...injected })
  assert(find(page, (n) => n.type === 'Switch' && n.props['data-setting'] === 'recycleApproval'), 'the session approval switch renders')
  assert(find(page, (n) => n.type === 'Button' && n.props['data-action'] === 'clear-recycle-approvals'), 'the clear button renders')
  // 清除按钮：直接写 epoch+1，带上快照的 revision
  assert.equal(await injected.clearRecycleApprovals(), true)
  assert.deepEqual(mutations, [{ ops: [{ op: 'set', path: ['recycleApprovalEpoch'], value: 3 }], revision: 7 }])
})

console.log(`SUMMARY pass=${pass} fail=${fail}`)
if (fail > 0) process.exitCode = 1
