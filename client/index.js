window.__ModuleLoader__.load({
  id: 'dsh-pwsh-plugin',
  factory: (require) => {
    const React = require('react')
    const { SettingsForm, SettingsFormModel, Switch, Button, settingsNumberField, settingsTextField } = require('@deepseek-ai/dsh-client-ui-primitives')
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

    // ---- SSH 会话标签页（对话上方，和 轨迹 / 上下文 / 费用 并列）----
    // 数据来自服务端 sshSessions 投影（由会话事件折叠，宿主推送，不轮询）；
    // 倒计时用本地 1 秒时钟按 expiresAt / idleDeadline 计算；「结束」走 /ssh 命令。
    const SSH_COPY = {
      zh: { tab: 'SSH', empty: '本会话还没有 SSH 会话。', host: '主机', id: 'ID', state: '状态', cwd: '目录', active: '最后活动', left: '剩余', end: '结束', endAll: '全部结束', reason: '原因',
        states: { connecting: '连接中', probing: '握手中', idle: '空闲', running: '运行中', closing: '结束中', dead: '已结束' }, bg: '后台', fg: '前台' },
      en: { tab: 'SSH', empty: 'No SSH sessions in this conversation yet.', host: 'Host', id: 'ID', state: 'State', cwd: 'Directory', active: 'Last active', left: 'Left', end: 'End', endAll: 'End all', reason: 'Reason',
        states: { connecting: 'connecting', probing: 'handshake', idle: 'idle', running: 'running', closing: 'closing', dead: 'ended' }, bg: 'bg', fg: 'fg' },
    }
    const sshCopy = () => (document.documentElement.lang || '').toLowerCase().startsWith('zh') ? SSH_COPY.zh : SSH_COPY.en
    const clockText = (ms) => {
      if (ms === undefined || !Number.isFinite(ms)) return ''
      const s = Math.max(0, Math.round(ms / 1000)); const h = Math.floor(s / 3600); const m = Math.floor((s % 3600) / 60)
      return h > 0 ? h + 'h' + m + 'm' : m > 0 ? m + 'm' + (s % 60) + 's' : s + 's'
    }
    function useNow() {
      const [now, setNow] = React.useState(Date.now())
      React.useEffect(() => { const t = setInterval(() => setNow(Date.now()), 1000); return () => clearInterval(t) }, [])
      return now
    }
    function SshSessionsTab(props) {
      const t = sshCopy()
      const view = props.useProjection('sshSessions')
      const now = useNow()
      const [error, setError] = React.useState(null)
      const rows = view?.rows ?? []
      const run = (line) => Promise.resolve(props.runCommand(line)).then((failure) => setError(failure ?? null))
      if (rows.length === 0) return h('div', { style: { padding: 16, opacity: 0.7 } }, t.empty)
      const live = rows.some((r) => r.state !== 'dead')
      const cell = { padding: '4px 8px', borderBottom: '1px solid var(--border, rgba(127,127,127,.2))', whiteSpace: 'nowrap' }
      return h('div', { style: { padding: 12, overflow: 'auto' } },
        error ? h('p', { style: { color: 'var(--danger, #c33)' } }, error) : null,
        h('table', { style: { borderCollapse: 'collapse', width: '100%', fontSize: 13 } },
          h('thead', null, h('tr', null, [t.host, t.id, t.state, t.cwd, t.active, t.left, ''].map((label, i) => h('th', { key: i, style: { ...cell, textAlign: 'left' } }, label)))),
          h('tbody', null, rows.map((r) => {
            const dead = r.state === 'dead'
            const capLeft = r.expiresAt === undefined ? undefined : r.expiresAt - now
            const idleLeft = r.state === 'idle' && r.idleMinutes > 0 && r.lastActivity !== undefined ? r.lastActivity + r.idleMinutes * 60000 - now : undefined
            const left = dead ? '' : capLeft !== undefined && capLeft <= 600000 ? '⏱ ' + clockText(capLeft) : clockText(idleLeft)
            const state = (t.states[r.state] ?? r.state) + (r.mode ? ' · ' + (r.mode === 'bg' ? t.bg + ' ' + (r.jobId ?? '') : t.fg) : '')
            return h('tr', { key: r.sessionId, style: dead ? { opacity: 0.55 } : undefined },
              h('td', { style: cell }, r.host ?? ''),
              h('td', { style: cell }, r.sessionId),
              h('td', { style: cell }, dead ? state + ' · ' + (r.deadReasonText ?? r.deadReason ?? '') : state),
              h('td', { style: { ...cell, maxWidth: 280, overflow: 'hidden', textOverflow: 'ellipsis' }, title: r.cwd }, r.cwd ?? ''),
              h('td', { style: cell }, r.lastActivity ? clockText(now - r.lastActivity) : ''),
              h('td', { style: cell }, left),
              h('td', { style: cell }, dead ? null : h(Button, { variant: 'ghost', size: 'sm', onClick: () => run('/ssh kill ' + r.sessionId) }, t.end)))
          }))),
        live ? h('div', { style: { marginTop: 8 } }, h(Button, { variant: 'ghost', size: 'sm', onClick: () => run('/ssh kill-all') }, t.endAll)) : null)
    }
    async function runSshCommand(remote, sessionId, line) {
      if (remote === undefined) return 'the command remote is not mounted in this client'
      try {
        const result = await remote.execute(sessionId, line, [])
        if (!result.ok) return result.error.message + ' (' + result.error.code + ')'
        if (result.value === undefined) return 'the host did not resolve "' + line + '"'
        return result.value.result.kind === 'error' ? (result.value.result.text || '"' + line + '" was refused') : null
      } catch (error) {
        return '"' + line + '" failed: ' + String(error)
      }
    }
    function applySshTab(ctx) {
      const inject = (rawSessionId) => ({ runCommand: (line) => runSshCommand(ctx.remote?.commands, rawSessionId, line) })
      ctx.slots.inject('conversation.view', () => ctx.slots.register({ name: 'conversation.view', id: 'dsh-pwsh-plugin-ssh', order: 45, label: () => sshCopy().tab, inject }, SshSessionsTab))
    }

    // ---- SSH 设置 ----
    // 宿主不会按 Config 自动生成表单：plugins.row.config 只在有条目用 `<包名>#<行 id>` 点名这一行时
    // 才出现（plugin-manager 的 rowConfigKey / configure.has），所以这里自己登记一份，
    // 另外挂在「设置」页上一个分组，方便不进插件管理也能改。
    const SSH_NS = 'ssh'
    const SSH_ROW_KEY = 'dsh-pwsh-plugin' + '#' + 'ssh'
    const SSH_FIELDS = ['enabled', 'idleMinutes', 'hardCapHours', 'globalMax', 'hosts', 'approvalList']
    const SSH_SETTINGS = {
      zh: {
        title: 'SSH 会话', summary: '管理 SSH 主机清单、审批名单与会话限额。',
        intro: '只有主机清单里的主机能被模型打开；审批名单里的主机每次操作都要人工确认。',
        group: '会话限额', hostsGroup: '主机清单', approvalGroup: '审批名单',
        enabled: '启用 SSH', on: '已启用', off: '已关闭', pending: '有尚未保存的修改',
        enabledHint: '关闭后拒绝新建会话；已经开着的会话进入 draining，跑完当前命令后关闭。',
        idleMinutes: '空闲超时（分钟，0 关闭）', hardCapHours: '硬上限（小时，1–168）', globalMax: '全局会话上限（1–64）',
        limits: '空闲只由 ssh_exec 计时；把限额改小要 5 分钟宽限才生效。',
        hosts: '主机清单（JSON 数组）',
        hostsHint: '每项 { name, address, user, port?, via?: "windows"|"wsl", wslDistro?, agentSocket?, shell?, encoding?, maxSessions?, loadProfile? }。模型只能用 name 点名主机，清单外一律拒绝。',
        approval: '审批名单（每行一条）',
        approvalHint: 'IP、CIDR、主机名或 *.example.com，# 之后是注释。命中后 ssh_open 与每条 ssh_exec 都要人工批准；留空则不拦。',
        invalid: '格式不对，保存已被拦下。', resetAll: '全部恢复默认',
        scope: '对当前 profile 的全部预设与会话生效。插件管理里的 ssh 行默认 disabled: true，先启用它，这一页才有可写的配置。',
        form: { unavailable: '配置暂不可用，请确认 ssh 条目已在当前主机启用。', readOnly: '当前部署的配置只读，无法保存修改。', saveFailed: '保存失败，请刷新配置后重试。', save: '保存', saving: '保存中…' },
      },
      en: {
        title: 'SSH sessions', summary: 'Manage SSH hosts, approval list and session limits.',
        intro: 'Only hosts in the list can be opened; every operation on an approval-listed host asks for confirmation.',
        group: 'Session limits', hostsGroup: 'Hosts', approvalGroup: 'Approval list',
        enabled: 'Enable SSH', on: 'Enabled', off: 'Disabled', pending: 'Unsaved changes',
        enabledHint: 'Turning this off refuses new sessions; open ones drain and close after the running command.',
        idleMinutes: 'Idle timeout (minutes, 0 disables)', hardCapHours: 'Hard cap (hours, 1–168)', globalMax: 'Global session limit (1–64)',
        limits: 'Only ssh_exec counts as activity; shrinking a limit takes effect after a 5 minute grace period.',
        hosts: 'Hosts (JSON array)',
        hostsHint: 'Each entry { name, address, user, port?, via?: "windows"|"wsl", wslDistro?, agentSocket?, shell?, encoding?, maxSessions?, loadProfile? }. The model may only name a host by name; anything else is refused.',
        approval: 'Approval list (one per line)',
        approvalHint: 'IP, CIDR, host name or *.example.com; # starts a comment. Matching hosts require manual approval for ssh_open and every ssh_exec. Empty means nothing is gated.',
        invalid: 'Not valid, so the save is blocked.', resetAll: 'Restore all defaults',
        scope: 'Applies to every preset and session in this profile. The ssh row in plugin management starts disabled, enable it first or this page has nothing writable.',
        form: { unavailable: 'Configuration unavailable. Check that the ssh entry is enabled on this Host.', readOnly: 'Configuration is read-only in this deployment.', saveFailed: 'Not saved. Refresh the configuration and try again.', save: 'Save', saving: 'Saving…' },
      },
    }
    const sshSettingsCopy = () => (document.documentElement.lang || navigator.language || 'en').toLowerCase().startsWith('zh') ? SSH_SETTINGS.zh : SSH_SETTINGS.en
    const inputStyle = { padding: '5px 8px', fontSize: 13, boxSizing: 'border-box', color: 'inherit', background: 'transparent', border: '1px solid var(--border, rgba(127,127,127,.4))', borderRadius: 6, fontFamily: 'inherit' }
    function SshSettingsPage(props) {
      const t = sshSettingsCopy()
      if (props.view === 'summary') return t.summary
      const state = props.useSshSettings((value) => value)
      const disabled = !state.writable || state.saving
      const field = (name) => state.fields[name] ?? { text: '', overridden: false, invalid: false }
      const number = (name, label) => h('div', { style: style.row },
        h('div', { style: style.field }, h('span', { style: style.label }, label)),
        h('input', { type: 'text', inputMode: 'numeric', value: field(name).text, disabled, spellCheck: false, onChange: (event) => props.edit(name, event.target.value), style: { ...inputStyle, width: 120 } }))
      const area = (name, label, hint, rows) => h('div', { style: { display: 'grid', gap: 6 } },
        h('span', { style: style.label }, label),
        h('textarea', { rows, value: field(name).text, disabled, spellCheck: false, onChange: (event) => props.edit(name, event.target.value), style: { ...inputStyle, width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' } }),
        h('p', { style: style.note }, hint),
        field(name).invalid ? h('p', { style: { ...style.note, color: 'var(--danger, #c33)' } }, t.invalid) : null)
      return h('div', { style: style.page, 'data-ssh-settings': '' },
        h('header', null, h('h2', { style: style.title }, t.title), h('p', { style: style.intro }, t.intro)),
        h(SettingsForm, { labels: t.form, state, onSave: props.save, onDiscard: props.discard },
          h('section', { style: style.section },
            h('h3', { style: style.group }, t.group),
            h('div', { style: style.row },
              h('div', { style: style.field }, h('span', { style: style.label }, t.enabled), h('p', { style: style.note }, t.enabledHint)),
              h(Switch, { label: t.enabled, checked: field('enabled').text === 'true', disabled, onChange: (value) => props.edit('enabled', value ? 'true' : 'false') })),
            h('div', { style: style.status, role: 'status' },
              h('span', null, state.enabled ? t.on : t.off),
              state.dirty ? h('span', null, t.pending) : null,
              state.dirty ? h(Button, { style: style.reset, variant: 'ghost', size: 'sm', disabled, onClick: () => SSH_FIELDS.forEach((name) => props.resetField(name)) }, t.resetAll) : null),
            number('idleMinutes', t.idleMinutes),
            number('hardCapHours', t.hardCapHours),
            number('globalMax', t.globalMax),
            h('p', { style: style.note }, t.limits),
            h('h3', { style: style.group }, t.hostsGroup),
            area('hosts', t.hosts, t.hostsHint, 8),
            h('h3', { style: style.group }, t.approvalGroup),
            area('approvalList', t.approval, t.approvalHint, 4),
            h('p', { style: style.note }, t.scope))))
    }
    // hosts 在 Config 里是数组（也接受 JSON 文本）：表单里按 JSON 编辑，语法错就拦住保存。
    function parseHostsText(text) {
      if (text.trim() === '') return { kind: 'clear' }
      let value
      try { value = JSON.parse(text) } catch { return undefined }
      if (!Array.isArray(value)) return undefined
      return { kind: 'set', value }
    }
    function applySshSettings(ctx) {
      const scope = ctx.configForms.get(SSH_NS)
      const specs = [
        { field: 'enabled', format: (value) => value === true ? 'true' : 'false', parse: (text) => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined },
        settingsNumberField('idleMinutes'),
        settingsNumberField('hardCapHours'),
        settingsNumberField('globalMax'),
        { field: 'hosts', format: (value) => Array.isArray(value) ? JSON.stringify(value, null, 2) : typeof value === 'string' ? value : '[]', parse: parseHostsText },
        settingsTextField('approvalList'),
      ]
      const form = new SettingsFormModel(scope, specs)
      const store = form.bind(() => ({
        ...form.shell(),
        enabled: scope.getSnapshot().value?.enabled === true,
        fields: Object.fromEntries(specs.map((spec) => [spec.field, form.field(spec.field)])),
      }))
      const inject = () => ({ hooks: { sshSettings: store }, ...form.actions() })
      ctx.effect(() => () => form.dispose(), 'ssh-settings.form')
      ctx.effect(() => {
        let dispose = () => {}
        const register = () => {
          dispose()
          // 命名空间由宿主按「行 id」服务：行没启用时这里不登记，页面上也就没有可写的配置。
          dispose = ctx.configForms.whileServed([SSH_NS], () => {
            const section = ctx.slots.inject('settings.section', () => ctx.slots.register({ name: 'settings.section', id: 'ssh', order: 44, label: sshSettingsCopy().title, inject }, SshSettingsPage))
            const row = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: SSH_ROW_KEY, inject }, SshSettingsPage))
            return () => { row(); section() }
          })
        }
        register()
        // 导航文字由注册项持有，语言改变时重新登记。
        const observer = new MutationObserver(register)
        observer.observe(document.documentElement, { attributes: true, attributeFilter: ['lang'] })
        return () => { observer.disconnect(); dispose() }
      }, 'ssh-settings.page')
    }
    function apply(ctx) {
      // SSH 标签页需要 remote.commands；单独挂成子插件，缺服务时不影响 pwsh 设置页。
      ctx.plugin?.({ name: 'ssh-sessions-tab', inject: ['slots', 'remote', 'remote.commands'], apply: applySshTab })
      applySshSettings(ctx)
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
