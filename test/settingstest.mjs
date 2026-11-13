// 使用宿主的 Schema、SettingsForms 和表单模型验证保存与运行态路由。
import assert from 'node:assert/strict'
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { createRequire, registerHooks } from 'node:module'
import { pathToFileURL } from 'node:url'
import vm from 'node:vm'
import { Config, apply } from '../plugin/index.mjs'
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
root.provide('configEditor', {
  documentPath: resolve(dir, 'profile.json'),
  entries: () => [entry],
  configuration: () => [{ entry, inherited: base, override }],
  async edit(target, change) {
    assert.equal(target, entry)
    const next = await change(override, base)
    const resolved = Config({ ...base, ...next })
    writeFileSync(this.documentPath, JSON.stringify(next))
    override = next
    entry.options.config = { ...base, ...next }
    cosmos.updateVolatile(config.enforcePwshRun, resolved.enforcePwshRun)
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
const { SettingsFormModel } = modelModule
vm.runInNewContext(readFileSync(new URL('../client/index.js', import.meta.url), 'utf8'), {
  window: { __ModuleLoader__: { load({ factory }) { client = factory(name => name === 'react' ? React : { SettingsFormModel, SettingsForm() {}, Switch() {}, Button() {} }) } } },
  document: { documentElement: { lang: 'zh-CN' } }, navigator: { language: 'zh-CN' },
  MutationObserver: class { constructor(fn) { observerCallback = fn } observe() {} disconnect() { watchStopped = true } },
})
const uiEffects = []
client.apply({
  configForms: { get(ns) { assert.equal(ns, 'pwsh-run'); return scope }, whileServed(names, register) { assert.deepEqual(Array.from(names), ['pwsh-run']); return register(new Set(names)) } },
  slots: { inject(_slot, fn) { return fn() }, register(options, Component) { const slot = { options, Component }; slots.push(slot); return () => { slots = slots.filter(row => row !== slot) } } },
  effect(fn) { const d = fn(); uiEffects.push(d); return d },
})
const section = () => slots.find(row => row.options.name === 'settings.section')
const props = section().options.inject()
const state = () => props.hooks.pwshSettings.getSnapshot()
const native = { name: 'pwsh', agent: { session: { id: 'settings-live' } }, arguments: { command: 'fixture' } }
const exec = { agent: { session: { id: 'settings-live', header: { cwd: process.cwd() } } } }
const run = script => definitions.get('pwsh_run').execute({ script }, exec)
const waitSaved = async () => { for (let i = 0; i < 100 && state().saving; i++) await new Promise(r => setTimeout(r, 10)); assert(!state().saving) }
try {
  check('schema-default-is-live-false', () => assert.equal(config.enforcePwshRun.get(), false))
  check('form-projects-only-routing', () => assert(JSON.stringify(descriptor().schema).includes('enforcePwshRun') && !JSON.stringify(descriptor().schema).includes('timeoutMs')))
  check('automatic-page-disabled', () => assert.equal(descriptor().autoGenerate, false))
  check('sidebar-and-plugin-row-registered', () => assert.equal(slots.length, 2))
  check('sidebar-localized-title', () => assert.equal(section().options.label, 'pwsh 设置'))
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
