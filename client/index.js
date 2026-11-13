window.__ModuleLoader__.load({
  id: 'dsh-pwsh-plugin',
  factory: (require) => {
    const React = require('react')
    const { SettingsForm, SettingsFormModel, Switch, Button } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'pwsh-run'
    const FIELD = 'enforcePwshRun'
    const REMOVE = 'enforceFileRemoval'
    const COPY = {
      zh: {
        title: 'pwsh 设置', group: '工具路由', label: '强制使用 pwsh_run',
        removal: '删除确认', removalLabel: '删除前先确认范围',
        removalHint: '识别到常见的 PowerShell 或 bash 删除命令时，先拦下原脚本，引导模型通过 file_remove 查看固定清单后再确认回收。',
        removalLimit: '这是脚本入口检查，无法覆盖任意子程序。工具登记的临时目录可通过 file_temp 清理；已有异常目录不会自动改权限。回收站需要额外权限时，仍由宿主审批。',
        summary: '管理 PowerShell 路由与删除确认。',
        intro: '统一管理当前 profile 的 PowerShell 调用与文件删除确认。',
        hint: '开启后，普通 pwsh 调用会在执行前被拒绝。短命令可用 pwsh_run 的 mode=isolated，每次独立运行，超时也不会清空已有常驻状态。关闭此开关可恢复普通原生调用。',
        scope: '对当前 profile 的所有预设和会话生效。保存后立即应用，正在运行的 pwsh_run 任务和常驻状态会保留。',
        exceptions: '只读会话、明确的后台任务和需要宿主审批的有效提权请求，仍可使用原生 pwsh。',
        on: '已开启', off: '已关闭', pending: '有尚未保存的修改', inherited: '恢复配置默认值',
        form: { unavailable: '配置暂不可用，请确认插件已在当前主机加载。', readOnly: '当前部署的配置只读，无法保存修改。', saveFailed: '保存失败，请刷新配置后重试。', save: '保存', saving: '保存中…' },
      },
      en: {
        title: 'pwsh settings', group: 'Tool routing', label: 'Require pwsh_run',
        removal: 'Deletion confirmation', removalLabel: 'Review targets before deletion',
        removalHint: 'Block common PowerShell and bash deletion commands and direct the model to review a fixed file_remove plan before recycling.',
        removalLimit: 'An entry check cannot inspect arbitrary child programs. Registered scratch directories can use file_temp cleanup; existing ACLs are never repaired automatically. Recycling that needs wider access still requires Host approval.',
        summary: 'Manage PowerShell routing and deletion confirmation.',
        intro: 'Manage PowerShell routing and file removal for the current profile.',
        hint: 'When enabled, ordinary pwsh calls are blocked. Short commands can use pwsh_run with mode=isolated: each runs independently and a timeout preserves existing persistent state. Disable this switch to restore ordinary native calls.',
        scope: 'Applies to every preset and session in this profile. Saving takes effect immediately and preserves running pwsh_run tasks and session state.',
        exceptions: 'Read-only sessions, explicit background jobs, and valid elevation requests that require Host approval retain native pwsh.',
        on: 'Enabled', off: 'Disabled', pending: 'Unsaved changes', inherited: 'Restore configuration default',
        form: { unavailable: 'Configuration unavailable. Check that the plugin is loaded on this Host.', readOnly: 'Configuration is read-only in this deployment.', saveFailed: 'Not saved. Refresh the configuration and try again.', save: 'Save', saving: 'Saving…' },
      },
    }
    const copy = () => (document.documentElement.lang || navigator.language || 'en').toLowerCase().startsWith('zh') ? COPY.zh : COPY.en
    const style = {
      page: { display: 'grid', gap: 24, width: '100%', maxWidth: 680, padding: '8px 0' },
      title: { margin: 0, fontSize: 21, fontWeight: 600, lineHeight: 1.4 },
      intro: { margin: '8px 0 0', fontSize: 13, opacity: 0.65, lineHeight: 1.65 },
      section: { display: 'grid', gap: 16 },
      group: { margin: 0, fontSize: 12, fontWeight: 600, opacity: 0.65 },
      row: { display: 'flex', alignItems: 'flex-start', justifyContent: 'space-between', gap: 24 },
      field: { display: 'grid', gap: 6 },
      label: { fontSize: 14, fontWeight: 500 },
      note: { margin: 0, fontSize: 13, lineHeight: 1.7, opacity: 0.65 },
      status: { display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 12, fontSize: 12, opacity: 0.65 },
      reset: { marginLeft: 'auto' },
    }
    function SettingsPage(props) {
      const t = copy()
      if (props.view === 'summary') return t.summary
      const state = props.usePwshSettings((value) => value)
      const disabled = !state.writable || state.saving
      return h('div', { style: style.page, 'data-pwsh-settings': '' },
        h('header', null, h('h2', { style: style.title }, t.title), h('p', { style: style.intro }, t.intro)),
        h(SettingsForm, { labels: t.form, state, onSave: props.save, onDiscard: props.discard },
          h('section', { style: style.section },
            h('h3', { style: style.group }, t.group),
            h('div', { style: style.row },
              h('div', { style: style.field }, h('span', { style: style.label }, t.label), h('p', { style: style.note }, t.hint)),
              h(Switch, { label: t.label, checked: state.field.text === 'true', disabled, onChange: (value) => props.edit(FIELD, value ? 'true' : 'false') })),
            h('div', { style: style.status, role: 'status' },
              h('span', null, state.accepted ? t.on : t.off),
              state.dirty ? h('span', null, t.pending) : null,
              state.field.overridden ? h(Button, { style: style.reset, variant: 'ghost', size: 'sm', disabled, onClick: () => props.resetField(FIELD) }, t.inherited) : null),
            h('p', { style: style.note }, t.scope),
            h('p', { style: style.note }, t.exceptions),
            h('h3', { style: style.group }, t.removal),
            h('div', { style: style.row },
              h('div', { style: style.field }, h('span', { style: style.label }, t.removalLabel), h('p', { style: style.note }, t.removalHint)),
              h(Switch, { label: t.removalLabel, checked: state.removalField.text === 'true', disabled, onChange: (value) => props.edit(REMOVE, value ? 'true' : 'false') })),
            h('div', { style: style.status, role: 'status' },
              h('span', null, state.removalAccepted ? t.on : t.off),
              state.removalField.overridden ? h(Button, { style: style.reset, variant: 'ghost', size: 'sm', disabled, onClick: () => props.resetField(REMOVE) }, t.inherited) : null),
            h('p', { style: style.note }, t.removalLimit))))
    }
    function apply(ctx) {
      const scope = ctx.configForms.get(NS)
      const form = new SettingsFormModel(scope, [FIELD, REMOVE].map(field => ({
        field,
        format: (value) => value === true ? 'true' : 'false',
        parse: (text) => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
      })))
      const store = form.bind(() => ({ ...form.shell(), field: form.field(FIELD), accepted: scope.getSnapshot().value?.[FIELD] === true, removalField: form.field(REMOVE), removalAccepted: scope.getSnapshot().value?.[REMOVE] === true }))
      const inject = () => ({ hooks: { pwshSettings: store }, ...form.actions() })
      ctx.effect(() => () => form.dispose(), 'pwsh-run.form')
      ctx.effect(() => {
        let dispose = () => {}
        const register = () => {
          dispose()
          dispose = ctx.configForms.whileServed([NS], () => {
            const section = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'pwsh-run', order: 43, label: copy().title, inject }, SettingsPage))
            const row = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: 'dsh-pwsh-plugin#pwsh-run', inject }, SettingsPage))
            return () => { row(); section() }
          })
        }
        register()
        // 导航文字由注册项持有，语言改变时重新登记，让宿主刷新入口标题。
        const observer = new MutationObserver(register)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        return () => { observer.disconnect(); dispose() }
      }, 'pwsh-run.settings-page')
    }
    return { name: 'pwsh-run-settings', inject: ['slots', 'configForms'], apply }
  },
})
