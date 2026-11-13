// 用真实 ToolsService / 原生与 PTC 调度器确认拒绝发生在工具正文之前。
import assert from 'node:assert/strict'
import { apply } from '../plugin/index.mjs'
import { importFromDsh, SKIP_HINT } from './support.mjs'

let pass = 0
function check(name, fn) {
  fn()
  console.log('PASS ' + name)
  pass++
}
function mount(config, nativeTools = {}) {
  const effects = []
  const definitions = new Map()
  const ctx = {
    subprocess: {},
    tools: { register(def) { definitions.set(def.name, def); return () => definitions.delete(def.name) }, ...nativeTools },
    get() { return undefined },
    effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
  }
  try { apply(ctx, config) }
  catch (error) { for (const dispose of effects.reverse()) dispose?.(); throw error }
  return { definitions, stop() { for (const dispose of effects.reverse()) dispose?.() } }
}

for (const [label, config] of [['default', {}], ['disabled', { enforcePwshRun: false }]]) {
  const plugin = mount(config)
  check(label + '-supports-host-without-guards', () => assert(plugin.definitions.has('pwsh_run')))
  plugin.stop()
}
check('enabled-refuses-old-host', () => assert.throws(() => mount({ enforcePwshRun: true }), /requires a DSH host with tools.guard/))
check('rejects-string-boolean', () => assert.throws(() => mount({ enforcePwshRun: 'true' }), /must be a boolean/))
check('rejects-null-boolean', () => assert.throws(() => mount({ enforcePwshRun: null }), /must be a boolean/))

const [cordis, toolsModule, nativeModule, ptcModule] = await Promise.all([
  importFromDsh('cordis/lib/index.js'), importFromDsh('dsh-tools/lib/index.js'),
  importFromDsh('dsh-tool-executor-native/lib/index.js'), importFromDsh('dsh-tool-executor-ptc/lib/index.js'),
])
if ([cordis, toolsModule, nativeModule, ptcModule].some((value) => value === undefined)) {
  console.log(SKIP_HINT)
} else {
  const { Context } = cordis
  const { ToolsService, defineTool } = toolsModule
  const { NativeToolExecutor } = nativeModule
  const { PtcExecutor } = ptcModule
  const ctx = new Context()
  ctx.provide('systemPrompt', { tools() { return () => {} }, getSectionOrder() { return 0 } })
  new ToolsService(ctx)
  ctx.provide('workingDirectory', { async ensure() { return process.cwd() } })
  const modes = new Map([['write', 'workspace-write'], ['read', 'read-only'], ['full', 'danger-full-access']])
  const policySessions = []
  ctx.provide('sandboxPolicy', { resolve({ session }) {
    policySessions.push(session?.id)
    return { mode: modes.get(session?.id) ?? 'workspace-write', workspaceRoot: process.cwd() }
  } })
  const sessionLogs = []
  const agents = Object.fromEntries([...modes.keys()].map((id) => [id, { ctx, session: { id, header: { cwd: process.cwd() }, append(event, value) { sessionLogs.push({ event, value }) } } }]))
  const nativeCalls = []
  const removeNative = ctx.tools.register(defineTool({
    name: 'pwsh', description: 'Native entry fixture; no shell is started.',
    parameters: Object.fromEntries(['command', 'workdir', 'timeoutMs', 'run_in_background', 'sandbox_permissions', 'justification'].map((key) => [key, { type: 'json' }])),
    output: { schema: { type: 'object', additionalProperties: false, properties: { text: { type: 'string', required: true } } }, render: (_args, value) => [{ type: 'text', text: value.text }] },
    execute(args, exec) { nativeCalls.push({ args, session: exec.agent?.session?.id }); return { text: 'native-entry' } },
  }))
  const removeOther = ctx.tools.register(defineTool({
    name: 'other_tool', description: 'Unrelated entry fixture.', parameters: {},
    output: { schema: { type: 'string' }, render: (_args, value) => [{ type: 'text', text: value }] },
    execute() { return 'other-entry' },
  }))
  const native = new NativeToolExecutor(ctx)
  let sequence = 0
  const call = async (name = 'pwsh', args = {}, agent = agents.write, executor = native) => {
    const result = await executor.execute({
      calls: [{ type: 'tool-call', id: 'route-' + (++sequence), name, arguments: JSON.stringify(args) }],
      signal: new AbortController().signal, agent,
    })
    return result.results[0].result
  }
  const text = (result) => result.content.filter((item) => item.type === 'text').map((item) => item.text).join('\n')
  let plugin
  const start = (enabled) => {
    const effects = []
    apply({
      tools: ctx.tools, subprocess: {}, get: (name) => ctx.get(name),
      effect(fn) { const dispose = fn(); effects.push(dispose); return dispose },
    }, { enforcePwshRun: enabled })
    return () => { for (const dispose of effects.reverse()) dispose?.() }
  }
  try {
    plugin = start(false)
    let result = await call('pwsh', { command: 'unexecuted fixture' })
    check('disabled-keeps-native-entry', () => assert(!result.isError && nativeCalls.length === 1))
    plugin(); plugin = start(true)
    const before = nativeCalls.length
    result = await call('pwsh', { command: 'must never run', workdir: process.cwd(), timeoutMs: 1234 })
    check('enabled-blocks-native-before-body', () => assert(result.isError && nativeCalls.length === before))
    check('denial-explains-argument-mapping', () => assert(/script/.test(text(result)) && /workdir/.test(text(result)) && /timeoutMs/.test(text(result))))
    check('denial-offers-isolated-mode-and-settings-exit', () => assert(/mode=isolated/.test(text(result)) && /settings/.test(text(result))))
    result = await call('pwsh', {}, agents.full)
    check('full-access-still-routes-ordinary-calls', () => assert(result.isError && nativeCalls.length === before))
    result = await call('other_tool')
    check('other-tools-unaffected', () => assert(!result.isError && text(result) === 'other-entry'))

    const removeAllow = ctx.on('tools/pre-execute', () => ({ kind: 'allow' }))
    result = await call()
    check('pre-execute-allow-cannot-override-guard', () => assert(result.isError && nativeCalls.length === before))
    removeAllow()

    result = await call('pwsh', {}, agents.read)
    check('read-only-keeps-native-entry', () => assert(!result.isError && nativeCalls.at(-1).session === 'read'))
    check('policy-resolves-the-calling-session', () => assert(policySessions.includes('read') && policySessions.includes('write') && policySessions.includes('full')))
    modes.set('write', 'read-only')
    result = await call()
    check('same-session-downgrade-takes-effect', () => assert(!result.isError))
    modes.set('write', 'workspace-write')
    result = await call()
    check('same-session-upgrade-restores-routing', () => assert(result.isError))

    result = await call('pwsh', { command: 'job', run_in_background: true })
    check('explicit-background-retains-native-job-semantics', () => assert(!result.isError && nativeCalls.at(-1).args.run_in_background === true))
    result = await call('pwsh', { run_in_background: 'true' })
    check('string-background-flag-does-not-bypass', () => assert(result.isError))
    result = await call('pwsh', { sandbox_permissions: 'danger-full-access', justification: 'Test requires the native approval entry.' })
    check('wider-request-reaches-native-approval-entry', () => assert(!result.isError && nativeCalls.at(-1).args.sandbox_permissions === 'danger-full-access'))
    result = await call('pwsh', { sandbox_permissions: 'danger-full-access', justification: ' ' })
    check('empty-justification-does-not-bypass', () => assert(result.isError))
    result = await call('pwsh', { sandbox_permissions: 'danger-full-access' })
    check('missing-justification-does-not-bypass', () => assert(result.isError))
    result = await call('pwsh', { sandbox_permissions: 'workspace-write', justification: 'Same mode is not escalation.' })
    check('same-mode-flag-does-not-bypass', () => assert(result.isError))
    result = await call('pwsh', { sandbox_permissions: 'danger-full-access', justification: 'Already full.' }, agents.full)
    check('full-mode-flag-does-not-bypass-at-full-mode', () => assert(result.isError))

    const priorDenied = nativeCalls.length
    const removeDeny = ctx.on('tools/pre-execute', () => ({ kind: 'deny', reason: 'Host denied this request.' }))
    result = await call('pwsh', { sandbox_permissions: 'danger-full-access', justification: 'Still requires host permission.' })
    check('native-exception-does-not-override-host-denial', () => assert(result.isError && nativeCalls.length === priorDenied && /Host denied/.test(text(result))))
    removeDeny()

    // 只替换程序求值器；SDK 绑定、子调用调度和守卫全部由真实 PTC executor 提供。
    const AsyncFunction = Object.getPrototypeOf(async function () {}).constructor
    ctx.provide('ptcRuntime', {
      language: 'typescript', programFormat: 'function-body', retainsState: false,
      resolve(request) { return { ...request, timeoutMs: 5000 } },
      async run(spec) {
        try { return { logs: [], value: await new AsyncFunction('tools', spec.program)(spec.bindings[0].functions) } }
        catch (error) { return { logs: [], error: { kind: 'exception', message: String(error.message) } } }
      },
      async release() {},
    })
    const ptc = new PtcExecutor(ctx)
    const ptcBefore = nativeCalls.length
    result = await call('run_code', { code: 'try { await tools.pwsh({command:"must not run"}); return "unexpected" } catch (e) { return e.message }', description: 'Exercise guarded nested native call' }, agents.write, ptc)
    check('ptc-sdk-call-is-blocked-before-native-body', () => assert(!result.isError && /enforcePwshRun/.test(text(result)) && nativeCalls.length === ptcBefore, JSON.stringify(result)))
    result = await call('run_code', { code: 'return await tools.pwsh({run_in_background:true})', description: 'Exercise native background entry' }, agents.write, ptc)
    check('ptc-background-exception-reaches-native-entry', () => assert(!result.isError && /native-entry/.test(text(result)) && nativeCalls.length === ptcBefore + 1))
    result = await call('run_code', { code: 'return await tools.pwsh({})', description: 'Exercise native read only entry' }, agents.read, ptc)
    check('ptc-read-only-exception-reaches-native-entry', () => assert(!result.isError && /native-entry/.test(text(result))))
    result = await call('run_code', { code: 'return await tools.other_tool({})', description: 'Exercise unrelated nested entry' }, agents.write, ptc)
    check('ptc-other-tools-unaffected', () => assert(!result.isError && /other-entry/.test(text(result))))

    plugin(); plugin = undefined
    result = await call()
    check('unload-removes-guard', () => assert(!result.isError))
    plugin = start(true)
    result = await call()
    check('reload-reinstalls-guard-without-duplicate-registration', () => assert(result.isError))
    plugin(); plugin = start(false)
    result = await call()
    check('reload-with-off-restores-native-entry', () => assert(!result.isError))
  } finally {
    plugin?.()
    removeOther()
    removeNative()
  }
}
console.log('SUMMARY pass=' + pass + ' fail=0')
