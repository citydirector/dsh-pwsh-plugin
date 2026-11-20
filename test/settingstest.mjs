// 使用宿主的 Schema、SettingsForms 和表单模型验证保存与运行态路由。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { Config, apply } from '../plugin/index.mjs'
import { Config as SshConfig } from '../plugin/ssh/index.mjs'
import { importFromDsh, SKIP_HINT } from './support.mjs'

const localRequire = createRequire(import.meta.url)
const React = localRequire('react')
// 分发运行时不带 UI 的开发依赖；测试从本项目解析这些 peer。
const peers = new Map(['immer', 'clsx', 'react', 'react/jsx-runtime', 'react-dom/client', 'zustand', 'zustand/vanilla', 'zustand/middleware', 'zustand/shallow', 'zustand/traditional'].map(name => [name, pathToFileURL(localRequire.resolve(name)).href]))
const resolver = registerHooks({ resolve(specifier, context, next) {
  return next(peers.get(specifier) ?? specifier, context)
} })
const [cordis, settingsModule, cosmos, local, modelModule] = await Promise.all([
  importFromDsh('cordis/lib/index.js'), importFromDsh('dsh-settings/lib/index.js'),
  importFromDsh('cosmokit/lib/index.js'), importFromDsh('dsh-subprocess-local/lib/index.js'),
  importFromDsh('dsh-client-ui-primitives/lib/types/settings-form/form-model.js').then(async value => { if (value) return value; if (process.env.DSH_MODULES) return import(pathToFileURL(process.env.DSH_MODULES + '/dsh-client-ui-primitives/lib/types/settings-form/form-model.js').href); return value }),
])
if ([cordis, settingsModule, cosmos, local, modelModule].some(v => v === undefined)) {
  console.log(SKIP_HINT); console.log('Unavailable: ' + ['cordis', 'settings', 'cosmokit', 'subprocess', 'form-model'].filter((_, i) => [cordis, settingsModule, cosmos, local, modelModule][i] === undefined).join(', ')); process.exit(1)
}
let pass = 0
const check = (label, fn) => { fn(); pass++; console.log('PASS ' + label) }
const root = new cordis.Context()
root.provide('loader', { async await() {} })
const dir = resolve('_skadi_temp/settings-test')
mkdirSync(dir, { recursive: true })
root.provide('profileContext', { home: dir, name: 'isolated-settings-test' })
const base = { allowUnconfined: true, timeoutMs: 15000, enforcePwshRun: false }
let override = { maxSessions: 5 }
const config = Config({ ...base, ...override })
const fiber = { uid: 101, state: 2, runtime: { Config }, effectiveConfig: config, ctx: root }
const entry = { id: 101, options: { id: 'pwsh-run', config: { ...base, ...override } }, fiber }
// SSH 是独立条目；设置页是否出现取决于宿主 describe 是否服务它的命名空间。
const sshConfig = SshConfig({})
const sshFiber = { uid: 102, state: 2, runtime: { Config: SshConfig }, effectiveConfig: sshConfig, ctx: root }
const sshEntry = { id: 102, options: { id: 'ssh', config: {} }, fiber: sshFiber }
root.provide('configEditor', {
  documentPath: resolve(dir, 'profile.json'),
  entries: () => [entry],
  configuration: () => [{ entry, inherited: base, override }, { entry: sshEntry, inherited: {}, override: {} }],
  entries: () => [entry, sshEntry],
  async edit(target, change) {
    if (target === sshEntry) {
      const next = await change(sshEntry.options.config, {})
      const resolved = SshConfig(next)
      sshEntry.options.config = next
      for (const [field, value] of Object.entries(next)) cosmos.updateVolatile(sshConfig[field], resolved[field])
      return
    }
    assert.equal(target, entry)
    const next = await change(override, base)
    const resolved = Config({ ...base, ...next })
    writeFileSync(this.documentPath, JSON.stringify(next))
    override = next
    entry.options.config = { ...base, ...next }
    for (const field of ['enforcePwshRun', 'enforceFileRemoval']) cosmos.updateVolatile(config[field], resolved[field])
  },
})
const settings = new settingsModule.SettingsForms(root)
const subprocess = new local.LocalSubprocessRuntime(root)
const effects = [], guards = [], definitions = new Map()
apply({
  fiber: { ctx: root }, subprocess,
  tools: {
    register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name) },
    guard(fn) { guards.push(fn); return () => guards.splice(guards.indexOf(fn), 1) },
  },
  get: name => name === 'workingDirectory' ? { async ensure() { return process.cwd() } } : root.get(name),
  effect(fn) { const d = fn(); effects.push(d); return d },
  inject(names, callback) { assert.deepEqual(names, ['settings']); callback({ settings, effect(fn) { const d = fn(); effects.push(d); return d } }) },
}, config)
const descriptor = () => settings.describe().find(row => row.ns === 'pwsh-run')
const listeners = new Set()
let writable = true, served = true
const scope = {
  getSnapshot() { return { ...descriptor(), status: served ? 'ready' : 'unavailable', writable } },
  subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) },
  async mutate(ops, revision) {
    try { await settings.mutate('pwsh-run', ops, revision); for (const fn of listeners) fn(); return true }
    catch { return false }
  },
}
let client, slots = [], observerCallback, watchStopped = false
const { SettingsFormModel, settingsNumberField, settingsTextField } = modelModule
const Switch = () => {}
vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory(name => name === 'react' ? React : { SettingsFormModel, SettingsForm() {}, Switch, Button() {}, settingsNumberField, settingsTextField }) } } },
  document: { documentElement: { lang: 'zh-CN' } }, navigator: { language: 'zh-CN' },
  MutationObserver: class { constructor(fn) { observerCallback = fn } observe() {} disconnect() { watchStopped = true } },
})
const uiEffects = []
// SSH 设置分组也挂在同一个 client 上，但它有自己的命名空间；这里只给它一个只读桩。
// 真快照：命名空间没被宿主服务时这里是 undefined，页面就不会登记——正是要钉住的行为。
const sshRow = () => settings.describe().find(row => row.ns === 'ssh')
const sshScope = {
  getSnapshot() { const row = sshRow(); return { ...(row ?? {}), status: row === undefined ? 'unavailable' : 'ready', writable: true } },
  subscribe() { return () => {} },
  async mutate(ops, revision) {
    try { await settings.mutate('ssh', ops, revision); return true } catch { return false }
  },
}
client.apply({
  configForms: {
    get(ns) { return ns === 'pwsh-run' ? scope : ns === 'ssh' ? sshScope : assert.fail('unexpected namespace ' + ns) },
    whileServed(names, register) {
      const served = new Set(settings.describe().map(row => row.ns))
      const live = names.filter((name) => served.has(name))
      return live.length === 0 ? () => {} : register(new Set(live))
    },
  },
  slots: { inject(_slot, fn) { return fn() }, register(options, Component) { const slot = { options, Component }; slots.push(slot); return () => { slots = slots.filter(row => row !== slot) } } },
  effect(fn) { const d = fn(); uiEffects.push(d); return d },
})
const section = (id = 'pwsh-run') => slots.find(row => row.options.name === 'settings.section' && row.options.id === id)
const pwshSlots = () => slots.filter(row => row.options.name === 'settings.section' ? row.options.id === 'pwsh-run' : row.options.key === 'dsh-pwsh-plugin' + '#' + 'pwsh-run')
const props = section().options.inject()
const state = () => props.hooks.pwshSettings.getSnapshot()
const native = { name: 'pwsh', agent: { session: { id: 'settings-live' } }, arguments: { command: 'fixture' } }
const exec = { agent: { session: { id: 'settings-live', header: { cwd: process.cwd() } } } }
const run = script => definitions.get('pwsh_run').execute({ script }, exec)
const waitSaved = async () => { for (let i = 0; i < 100 && state().saving; i++) await new Promise(r => setTimeout(r, 10)); assert(!state().saving) }
try {
  check('schema-default-is-live-false', () => assert.equal(config.enforcePwshRun.get(), false))
  check('form-projects-both-live-switches', () => assert(['enforcePwshRun','enforceFileRemoval'].every(field=>JSON.stringify(descriptor().schema).includes(field)) && !JSON.stringify(descriptor().schema).includes('timeoutMs')))
  check('automatic-page-disabled', () => assert.equal(descriptor().autoGenerate, false))
  check('sidebar-and-plugin-row-registered', () => assert.equal(pwshSlots().length, 2))
  check('sidebar-localized-title', () => assert.equal(section().options.label, 'pwsh 设置'))
  check('ssh-group-registered', () => assert.equal(section('ssh').options.label, 'SSH 会话'))
  check('ssh-row-page-keyed-by-package-and-row', () => assert(slots.some(row => row.options.name === 'plugins.row.config' && row.options.key === 'dsh-pwsh-plugin' + '#' + 'ssh')))
  check('ssh-namespace-is-served', () => assert(sshRow() !== undefined))
  check('ssh-form-exposes-live-fields-only', () => {
    // value 是已解包、按表单字段投影后的普通值，正好用来判断哪些字段可编辑。
    const fields = Object.keys(sshRow().value ?? {})
    assert(fields.includes('enabled') && fields.includes('hosts') && fields.includes('idleMinutes'))
    assert(!fields.includes('stateDir'))
  })
  check('ssh-every-field-but-state-dir-is-volatile', () => {
    // 只抽查几个字段会漏掉「新加的字段忘了 .volatile()」，直接遍历 schema 才钉得住。
    const fields = Object.entries(SshConfig.dict)
    const plain = fields.filter(([name, schema]) => name !== 'stateDir' && schema.meta?.volatile !== true).map(([name]) => name)
    assert.deepEqual(plain, [], 'fields missing .volatile(): ' + plain.join(', '))
    assert.equal(fields.find(([name]) => name === 'stateDir')[1].meta?.volatile, undefined)
    assert.equal(Object.keys(sshRow().value ?? {}).length, fields.length - 1)
  })
  await settings.mutate('ssh', [{ op: 'set', path: ['idleMinutes'], value: 45 }], sshRow().revision)
  check('ssh-edit-lands-in-live-config', () => assert.equal(sshConfig.idleMinutes.get(), 45))
  await assert.rejects(() => settings.mutate('ssh', [{ op: 'set', path: ['stateDir'], value: 'probe' }]), /not volatile/)
  check('native-initially-allowed', () => assert.equal(guards[0](native), undefined))
  const formOnly = process.env.DSH_SETTINGS_FORM_ONLY === '1'
  if (formOnly) console.log('SKIP: real pwsh process check requires an unrestricted test process')
  const first = formOnly ? null : await run('$global:settingsProbe = 42; Write-Output $PID')
  props.edit('enforcePwshRun', 'true')
  check('edit-is-staged-without-persistence', () => assert(state().dirty && !config.enforcePwshRun.get()))
  props.save(); await waitSaved()
  check('save-is-durable', () => assert.equal(JSON.parse(readFileSync(root.configEditor.documentPath)).enforcePwshRun, true))
  check('save-preserves-other-config', () => assert.equal(override.maxSessions, 5))
  check('accepted-value-comes-from-host', () => assert(state().accepted && !state().dirty && !state().failed))
  check('saved-switch-changes-routing-live', () => assert(guards[0](native)))
  if (!formOnly) {
    const second = await run('Write-Output $PID; Write-Output $global:settingsProbe')
    check('save-preserves-process-and-state', () => assert.equal(second.text, first.text + '\n42'))
  }
  const deletion = { name: 'pwsh_run', arguments: { script: 'Remove-Item fixture' } }
  check('removal-default-off', () => assert(!config.enforceFileRemoval.get() && !state().removalAccepted))
  props.edit('enforceFileRemoval', 'true')
  check('removal-draft-does-not-block', () => assert(!guards[1](deletion) && state().dirty))
  props.save(); await waitSaved()
  check('removal-save-is-durable-and-live', () => assert(JSON.parse(readFileSync(root.configEditor.documentPath)).enforceFileRemoval && state().removalAccepted && guards[1](deletion)))
  const afterRemoval = formOnly ? null : await run('Write-Output $PID; Write-Output $global:settingsProbe')
  if (!formOnly) check('removal-save-keeps-pwsh-session', () => assert.equal(afterRemoval.text, first.text+'\n42'))
  props.resetField('enforceFileRemoval'); props.save(); await waitSaved()
  check('removal-reset-unsets-override', () => assert(!config.enforceFileRemoval.get() && !Object.hasOwn(override,'enforceFileRemoval') && !guards[1](deletion)))
  props.edit('enforcePwshRun', 'false'); props.discard()
  check('discard-keeps-saved-state', () => assert(!state().dirty && config.enforcePwshRun.get()))
  props.resetField('enforcePwshRun'); props.save(); await waitSaved()
  check('reset-uses-inherited-default', () => assert.equal(config.enforcePwshRun.get(), false))
  check('reset-restores-native-route', () => assert.equal(guards[0](native), undefined))
  const stale = descriptor().revision
  await settings.mutate('pwsh-run', [{ op: 'set', path: ['enforcePwshRun'], value: true }], stale)
  await assert.rejects(() => settings.mutate('pwsh-run', [{ op: 'set', path: ['enforcePwshRun'], value: false }], stale), /revision|conflict/i)
  check('stale-write-does-not-overwrite', () => assert(config.enforcePwshRun.get()))
  await assert.rejects(() => settings.mutate('pwsh-run', [{ op: 'set', path: ['timeoutMs'], value: 12 }]), /not volatile/)
  check('process-settings-not-editable-through-form', () => assert.equal(config.timeoutMs, 15000))
  const sshProps = section('ssh').options.inject()
  const sshState = () => sshProps.hooks.sshSettings.getSnapshot()
  const waitSshSaved = async () => { for (let i = 0; i < 100 && sshState().saving; i++) await new Promise(r => setTimeout(r, 10)); assert(!sshState().saving) }
  const findSwitch = (node) => {
    if (node === null || node === undefined) return undefined
    if (Array.isArray(node)) { for (const child of node) { const hit = findSwitch(child); if (hit !== undefined) return hit } return undefined }
    if (typeof node !== 'object') return undefined
    if (node.type === Switch && node.props?.['data-setting'] === 'approvalListInvert') return node
    return findSwitch(node.props?.children ?? node.children)
  }
  check('ssh-form-exposes-approval-invert-switch', () => {
    assert(Object.hasOwn(sshState().fields, 'approvalListInvert'))
    const page = section('ssh').Component({ view: 'page', useSshSettings: selector => selector(sshState()), ...sshProps })
    const node = findSwitch(page)
    assert(node !== undefined, 'approvalListInvert Switch is rendered')
    assert.equal(node.props.checked, false)
    assert.match(node.props.label, /反转/)
  })
  sshProps.edit('approvalListInvert', 'true')
  check('ssh-invert-edit-is-staged', () => assert(sshState().dirty && sshConfig.approvalListInvert.get() === false))
  sshProps.save(); await waitSshSaved()
  check('ssh-invert-save-lands-in-live-config', () => assert.equal(sshConfig.approvalListInvert.get(), true))
  writable = false; for (const fn of listeners) fn()
  props.edit('enforcePwshRun', 'false'); props.save(); await waitSaved()
  check('read-only-form-does-not-save', () => assert(config.enforcePwshRun.get()))
  props.discard()
  for (const d of uiEffects.reverse()) d?.()
  check('unload-removes-pages-and-subscriptions', () => assert(slots.length === 0 && listeners.size === 0 && watchStopped))
} finally {
  for (const d of effects.reverse()) d?.()
  resolver.deregister()
}
console.log('SUMMARY pass=' + pass + ' fail=0')
