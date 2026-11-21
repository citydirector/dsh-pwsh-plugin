window.__ModuleLoader__.load({
  id: 'dsh-pwsh-plugin',
  factory: (require) => {
    const React = require('react')
    const { SettingsForm, SettingsFormModel, Switch, Button, settingsNumberField, settingsTextField } = require('@deepseek-ai/dsh-client-ui-primitives')
    const h = React.createElement
    const NS = 'pwsh-run'
    const FIELD = 'enforcePwshRun'
    const REMOVE = 'enforceFileRemoval'
    const RECYCLE = 'recycleApproval'
    const EPOCH = 'recycleApprovalEpoch'
    const COPY = {
      zh: {
        title: 'pwsh 设置', group: '工具路由', label: '强制使用 pwsh_run',
        removal: '删除确认', removalLabel: '删除前先确认范围',
        removalHint: '识别到常见的 PowerShell 或 bash 删除命令时，先拦下原脚本，引导模型通过 file_remove 查看固定清单后再确认回收。',
        removalLimit: '这是脚本入口检查，无法覆盖任意子程序。工具登记的临时目录可通过 file_temp 清理；已有异常目录不会自动改权限。回收站需要额外权限时，仍由宿主审批。',
        recycleLabel: '会话内一次授权持续有效',
        recycleHint: '开启后，回收需要宿主批准时，同一会话、同一工作目录、同一沙箱策略下只问一次，之后的回收直接放行；批准弹窗会写明这一点。范围清单每次仍要确认。会话结束、关掉此开关或点「清除」都会作废已有授权。子会话不继承。',
        recycleClear: '清除会话内授权', recycleCleared: '已清除，下次回收会重新询问。', recycleClearFailed: '清除失败，请刷新配置后重试。',
        recycleCommand: '对话里也可以用 /recycle-approval status | revoke | revoke-all。',
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
        recycleLabel: 'Keep one approval for the session',
        recycleHint: 'When on, recycling that needs Host approval asks once per session, working directory and sandbox policy, then later recycling proceeds; the approval prompt says so. The target inventory is still reviewed every time. Ending the session, turning this off or pressing Clear revokes existing approvals. Child sessions do not inherit them.',
        recycleClear: 'Clear session approvals', recycleCleared: 'Cleared. The next recycling asks again.', recycleClearFailed: 'Not cleared. Refresh the configuration and try again.',
        recycleCommand: 'In a conversation you can also use /recycle-approval status | revoke | revoke-all.',
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
      const [cleared, setCleared] = React.useState(undefined)
      const clearApprovals = () => { setCleared(undefined); Promise.resolve(props.clearRecycleApprovals()).then((ok) => setCleared(ok === true), () => setCleared(false)) }
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
            h('p', { style: style.note }, t.removalLimit),
            h('div', { style: style.row },
              h('div', { style: style.field }, h('span', { style: style.label }, t.recycleLabel), h('p', { style: style.note }, t.recycleHint)),
              h(Switch, { label: t.recycleLabel, checked: state.recycleField.text === 'session', disabled, 'data-setting': RECYCLE, onChange: (value) => props.edit(RECYCLE, value ? 'session' : 'always') })),
            h('div', { style: style.status, role: 'status' },
              h('span', null, state.recycleAccepted ? t.on : t.off),
              cleared === true ? h('span', null, t.recycleCleared) : cleared === false ? h('span', null, t.recycleClearFailed) : null,
              h(Button, { style: style.reset, variant: 'ghost', size: 'sm', disabled: !state.writable, 'data-action': 'clear-recycle-approvals', onClick: clearApprovals }, t.recycleClear),
              state.recycleField.overridden ? h(Button, { variant: 'ghost', size: 'sm', disabled, onClick: () => props.resetField(RECYCLE) }, t.inherited) : null),
            h('p', { style: style.note }, t.recycleCommand))))
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
    // 宿主按 `<包名>#<行 id>` 给插件行找配置页。真包名从宿主给的 pkg 里取（见 applySshSettings），
    // 这里只是包名拿不到时的回退。
    const SSH_PACKAGE = 'dsh-pwsh-plugin'
    const SSH_FIELDS = ['enabled', 'approvalListInvert', 'idleMinutes', 'hardCapHours', 'globalMax', 'hosts', 'approvalList']
    const SSH_SETTINGS = {
      zh: {
        title: 'SSH 会话', summary: '管理 SSH 主机清单、审批名单与会话限额。',
        intro: '只有主机清单里的主机能被模型打开；审批名单里的主机每次操作都要人工确认。',
        group: '会话限额', hostsGroup: '主机清单', approvalGroup: '审批名单',
        enabled: '启用 SSH', on: '已启用', off: '已关闭', pending: '有尚未保存的修改',
        enabledHint: '关闭后拒绝新建会话；已经开着的会话进入 draining，跑完当前命令后关闭。',
        idleMinutes: '空闲超时（分钟，0 关闭）', hardCapHours: '硬上限（小时，1–168）', globalMax: '全局会话上限（1–64）',
        limits: '空闲只由 ssh_exec 计时；把限额改小要 5 分钟宽限才生效。',
        hosts: '主机清单（JSON）',
        hostsHint: '每台主机一项。name 是模型点名用的别名，address 写 user@host 或 host；省略 user 时用本机登录名。清单外的主机一律拒绝。',
        hostsExample: '完整示例与字段说明', hostsFill: '填入示例', hostsFillHint: '示例只在清单为空时可以填入，填入后改成你自己的主机再保存。',
        hostsShort: '只要别名和地址时，可以写成简写：',
        hostsFields: [
          ['name', '必填，别名，字母数字开头，可含 . _ -'],
          ['address', '必填，user@host 或 host；IPv6 写成 [::1]'],
          ['port', '端口，默认 22'],
          ['via', '"windows"（默认，用 Windows 的 ssh.exe）或 "wsl"（在 WSL 里跑 ssh）'],
          ['wslDistro', 'WSL 发行版名，只用于 via: "wsl"'],
          ['agentSocket', 'WSL 内的 ssh-agent socket 路径，只用于 via: "wsl"'],
          ['shell', '远端 shell：bash、zsh 或 sh'],
          ['encoding', '远端输出编码，例如 utf-8、gbk'],
          ['maxSessions', '这台主机同时开的会话数，1–64，默认 4'],
          ['hostKeyFingerprint', '主机公钥指纹，SHA256:<base64>'],
          ['loadProfile', '是否加载登录 profile，默认 false'],
        ],
        approval: '审批名单（每行一条）',
        approvalRules: 'IP、CIDR、主机名或 *.example.com，# 之后是注释。',
        approvalGate: '当前：名单内的主机在 ssh_open 与每条 ssh_exec 时都要人工批准，名单外自动放行；留空则全部放行。',
        approvalAllow: '当前：名单内的主机自动放行，名单外的主机在 ssh_open 与每条 ssh_exec 时都要人工批准；留空则全部要批准。',
        approvalInvert: '反转审批名单',
        approvalInvertOff: '关闭：名单是「要审批」的主机。',
        approvalInvertOn: '开启：名单是「免审批」的主机。',
        invalid: '格式不对，保存已被拦下。',
        hostsInvalid: '主机清单无效：别名映射不能为空（清空请写 []）；别名不能为空或含空白；地址必须是 host 或 user@host，host 不能为空或含空白；端口 1–65535；via 只能是 windows 或 wsl；不认识的字段会被拒绝。',
        resetAll: '全部恢复默认',
        scope: '对当前 profile 的全部预设与会话生效。如果插件管理里把 ssh 行停用了，这一页没有可写的配置。',
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
        hosts: 'Hosts (JSON)',
        hostsHint: 'One entry per host. name is the alias the model uses; address is user@host or host, and without a user the local login name is used. Hosts not in the list are refused.',
        hostsExample: 'Full example and field reference', hostsFill: 'Insert example', hostsFillHint: 'The example can only be inserted into an empty list; replace it with your own hosts before saving.',
        hostsShort: 'When you only need an alias and an address, the short form works too:',
        hostsFields: [
          ['name', 'required alias; starts with a letter or digit, may contain . _ -'],
          ['address', 'required, user@host or host; write IPv6 as [::1]'],
          ['port', 'port, default 22'],
          ['via', '"windows" (default, Windows ssh.exe) or "wsl" (ssh inside WSL)'],
          ['wslDistro', 'WSL distribution, only with via: "wsl"'],
          ['agentSocket', 'ssh-agent socket path inside WSL, only with via: "wsl"'],
          ['shell', 'remote shell: bash, zsh or sh'],
          ['encoding', 'remote output encoding, e.g. utf-8 or gbk'],
          ['maxSessions', 'concurrent sessions on this host, 1-64, default 4'],
          ['hostKeyFingerprint', 'host key fingerprint, SHA256:<base64>'],
          ['loadProfile', 'load the login profile, default false'],
        ],
        approval: 'Approval list (one per line)',
        approvalRules: 'IP, CIDR, host name or *.example.com; # starts a comment.',
        approvalGate: 'Now: listed hosts ask for approval on ssh_open and every ssh_exec, other hosts run without asking; an empty list gates nothing.',
        approvalAllow: 'Now: listed hosts run without asking, every other host asks for approval on ssh_open and every ssh_exec; an empty list gates everything.',
        approvalInvert: 'Invert the approval list',
        approvalInvertOff: 'Off: the list names hosts that need approval.',
        approvalInvertOn: 'On: the list names hosts that skip approval.',
        invalid: 'Not valid, so the save is blocked.',
        hostsInvalid: 'Invalid host list: an alias map may not be empty (write [] to clear); an alias may not be empty or contain whitespace; an address must be host or user@host with a non-empty host and no whitespace; port 1-65535; via is windows or wsl; unknown fields are refused.',
        resetAll: 'Restore all defaults',
        scope: 'Applies to every preset and session in this profile. If the ssh row is disabled in plugin management, this page has nothing writable.',
        form: { unavailable: 'Configuration unavailable. Check that the ssh entry is enabled on this Host.', readOnly: 'Configuration is read-only in this deployment.', saveFailed: 'Not saved. Refresh the configuration and try again.', save: 'Save', saving: 'Saving…' },
      },
    }
    // 示例只用保留地址（example.com、192.0.2.0/24），能直接通过 parseHostsText 的校验。
    const SSH_HOSTS_EXAMPLE = JSON.stringify([
      { name: 'web', address: 'deploy@web.example.com' },
      { name: 'db', address: 'admin@192.0.2.10', port: 2222, shell: 'bash', maxSessions: 2 },
      { name: 'lab', address: 'dev@lab.example.com', via: 'wsl', wslDistro: 'Ubuntu', encoding: 'utf-8' },
    ], null, 2)
    const SSH_HOSTS_SHORT_EXAMPLE = '{\n  "web": "deploy@web.example.com",\n  "db": "admin@192.0.2.10"\n}'
    const sshSettingsCopy = () => (document.documentElement.lang || navigator.language || 'en').toLowerCase().startsWith('zh') ? SSH_SETTINGS.zh : SSH_SETTINGS.en
    const inputStyle = { padding: '5px 8px', fontSize: 13, boxSizing: 'border-box', color: 'inherit', background: 'transparent', border: '1px solid var(--border, rgba(127,127,127,.4))', borderRadius: 6, fontFamily: 'inherit' }
    function SshSettingsPage(props) {
      const t = sshSettingsCopy()
      if (props.view === 'summary') return t.summary
      const state = props.useSshSettings((value) => value)
      const disabled = !state.writable || state.saving
      const field = (name) => state.fields[name] ?? { text: '', overridden: false, invalid: false }
      // 两段说明都跟着开关走（含未保存的修改），默认关闭时不会再出现自相矛盾的文案。
      const inverted = field('approvalListInvert').text === 'true'
      const hostsEmpty = ['', '[]', '{}'].includes(field('hosts').text.replace(/\s+/g, ''))
      const codeStyle = { margin: 0, padding: '6px 8px', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, whiteSpace: 'pre', overflowX: 'auto', border: '1px solid var(--border, rgba(127,127,127,.4))', borderRadius: 6 }
      const number = (name, label) => h('div', { style: style.row },
        h('div', { style: style.field }, h('span', { style: style.label }, label)),
        h('input', { type: 'text', inputMode: 'numeric', value: field(name).text, disabled, spellCheck: false, onChange: (event) => props.edit(name, event.target.value), style: { ...inputStyle, width: 120 } }))
      const area = (name, label, hint, rows, invalid = t.invalid) => h('div', { style: { display: 'grid', gap: 6 } },
        h('span', { style: style.label }, label),
        h('textarea', { rows, value: field(name).text, disabled, spellCheck: false, onChange: (event) => props.edit(name, event.target.value), style: { ...inputStyle, width: '100%', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', resize: 'vertical' } }),
        h('p', { style: style.note }, hint),
        field(name).invalid ? h('p', { style: { ...style.note, color: 'var(--danger, #c33)' } }, invalid) : null)
      return h('div', { style: style.page, 'data-ssh-settings': '' },
        h('header', null, h('h2', { style: style.title }, t.title), h('p', { style: style.intro }, t.intro)),
        h(SettingsForm, { labels: t.form, state, onSave: props.save, onDiscard: props.discard },
          h('section', { style: style.section },
            h('h3', { style: style.group }, t.group),
            h('div', { style: style.row },
              h('div', { style: style.field }, h('span', { style: style.label }, t.enabled), h('p', { style: style.note }, t.enabledHint)),
              h(Switch, { label: t.enabled, checked: field('enabled').text === 'true', disabled, 'data-setting': 'enabled', onChange: (value) => props.edit('enabled', value ? 'true' : 'false') })),
            h('div', { style: style.status, role: 'status' },
              h('span', null, state.enabled ? t.on : t.off),
              state.dirty ? h('span', null, t.pending) : null,
              state.dirty ? h(Button, { style: style.reset, variant: 'ghost', size: 'sm', disabled, onClick: () => SSH_FIELDS.forEach((name) => props.resetField(name)) }, t.resetAll) : null),
            number('idleMinutes', t.idleMinutes),
            number('hardCapHours', t.hardCapHours),
            number('globalMax', t.globalMax),
            h('p', { style: style.note }, t.limits),
            h('h3', { style: style.group }, t.hostsGroup),
            area('hosts', t.hosts, t.hostsHint, 8, t.hostsInvalid),
            h('details', { style: { ...style.note, display: 'grid', gap: 6 }, 'data-ssh-hosts-example': '' },
              h('summary', { style: { cursor: 'pointer' } }, t.hostsExample),
              h('pre', { style: codeStyle }, SSH_HOSTS_EXAMPLE),
              h('div', { style: { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' } },
                h(Button, { variant: 'ghost', size: 'sm', disabled: disabled || !hostsEmpty, 'data-action': 'fill-ssh-hosts-example', onClick: () => props.edit('hosts', SSH_HOSTS_EXAMPLE) }, t.hostsFill),
                h('span', null, t.hostsFillHint)),
              h('ul', { style: { margin: 0, paddingLeft: 18 } },
                ...t.hostsFields.map(([key, text]) => h('li', { key }, h('code', null, key), ' — ', text))),
              h('span', null, t.hostsShort),
              h('pre', { style: codeStyle }, SSH_HOSTS_SHORT_EXAMPLE)),
            h('h3', { style: style.group }, t.approvalGroup),
            h('div', { style: style.row },
              h('div', { style: style.field }, h('span', { style: style.label }, t.approvalInvert), h('p', { style: style.note }, inverted ? t.approvalInvertOn : t.approvalInvertOff)),
              h(Switch, { label: t.approvalInvert, checked: inverted, disabled, 'data-setting': 'approvalListInvert', onChange: (value) => props.edit('approvalListInvert', value ? 'true' : 'false') })),
            area('approvalList', t.approval, t.approvalRules + ' ' + (inverted ? t.approvalAllow : t.approvalGate), 4),
            h('p', { style: style.note }, t.scope))))
    }
    // hosts 在 Config 里是数组（也接受 JSON 文本）；表单还接受紧凑的别名映射：
    //   [{ name, address, user, port?, ... }]
    //   { "alias": "user@host" | "host" | { address, user?, port? } }
    // 校验口径对齐 plugin/ssh/hosts.mjs 的 parseHost：别名不含空白，host 非空且不含空白，
    // user 可省略（服务端用本机登录名），端口限 1..65535。服务端仍会逐项复核并丢弃非法条目。
    const HOST_ALIAS_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/
    const HOST_USER_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,63}$/
    const HOSTNAME_RE = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?(?:\.[A-Za-z0-9](?:[A-Za-z0-9-]{0,61}[A-Za-z0-9])?)*\.?$/
    const HOST_BAD_RE = /[\s"'\x60\\\x00-\x1f\x7f@]/
    // 与 plugin/ssh/hosts.mjs 的 KNOWN_KEYS 保持一致：服务端会把带未知字段的条目整条丢掉，
    // 表单里先拦住，免得「保存成功但主机不见了」。
    const HOST_KNOWN_KEYS = new Set(['name', 'address', 'host', 'port', 'user', 'via', 'wslDistro', 'agentSocket', 'shell', 'encoding', 'maxSessions', 'hostKeyFingerprint', 'loadProfile'])
    const isPlainObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value)
    function splitUserHost(text) {
      const at = text.lastIndexOf('@')
      if (at < 0) return { host: text }
      if (text.indexOf('@') !== at) throw new Error('address must contain at most one "@"')
      const user = text.slice(0, at)
      const host = text.slice(at + 1)
      if (user === '') throw new Error('user is empty')
      if (host === '') throw new Error('host is empty')
      return { user, host }
    }
    function checkHost(host) {
      if (typeof host !== 'string' || host.trim() === '') throw new Error('host is empty')
      if (host.startsWith('-')) throw new Error('host must not start with "-"')
      if (HOST_BAD_RE.test(host)) throw new Error('host must not contain whitespace, quotes, "@" or control characters')
      if (host.startsWith('[')) {
        if (!/^\[[^\]]+\]$/.test(host)) throw new Error('bracketed host must be an IPv6 literal')
        try { new URL('http://' + host) } catch { throw new Error('bracketed host must be an IPv6 literal') }
        return
      }
      if (host.includes(':')) throw new Error('write IPv6 addresses in brackets, e.g. [::1]')
      if (!HOSTNAME_RE.test(host)) throw new Error('host is not a valid hostname or IPv4 address')
    }
    function hostEntry(entry, index, alias) {
      if (!isPlainObject(entry)) throw new Error('hosts[' + index + '] must be an object')
      const name = alias ?? entry.name
      if (typeof name !== 'string' || name.trim() === '') throw new Error('hosts[' + index + ']: alias is required')
      if (/\s/.test(name)) throw new Error('hosts[' + index + '] "' + name + '": alias must not contain whitespace')
      if (!HOST_ALIAS_RE.test(name)) throw new Error('hosts[' + index + '] "' + name + '": alias may only contain letters, digits, ".", "_" or "-"')
      for (const key of Object.keys(entry)) if (!HOST_KNOWN_KEYS.has(key)) throw new Error('hosts[' + index + '] "' + name + '": unknown field "' + key + '"')
      if (entry.via !== undefined && entry.via !== 'windows' && entry.via !== 'wsl') throw new Error('hosts[' + index + '] "' + name + '": via must be "windows" or "wsl"')
      if (entry.loadProfile !== undefined && typeof entry.loadProfile !== 'boolean') throw new Error('hosts[' + index + '] "' + name + '": loadProfile must be true or false')
      if (entry.address !== undefined && entry.host !== undefined) throw new Error('hosts[' + index + '] "' + name + '": use either address or host, not both')
      const rawAddress = entry.address ?? entry.host
      if (typeof rawAddress !== 'string') throw new Error('hosts[' + index + '] "' + name + '": host is required')
      const split = splitUserHost(rawAddress)
      let user = entry.user
      if (split.user !== undefined) {
        if (user !== undefined && user !== split.user) throw new Error('hosts[' + index + '] "' + name + '": user is set twice')
        user = split.user
      }
      checkHost(split.host)
      if (user !== undefined && (typeof user !== 'string' || !HOST_USER_RE.test(user))) throw new Error('hosts[' + index + '] "' + name + '": user is not a plain login name')
      if (entry.port !== undefined && (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535)) throw new Error('hosts[' + index + '] "' + name + '": port must be an integer between 1 and 65535')
      const rest = { ...entry }
      delete rest.name
      delete rest.host
      delete rest.address
      delete rest.user
      const result = { name, address: split.host }
      if (user !== undefined) result.user = user
      return { ...result, ...rest }
    }
    function parseHostsText(text) {
      if (text.trim() === '') return { kind: 'clear' }
      let value
      try { value = JSON.parse(text) } catch { return undefined }
      try {
        if (Array.isArray(value)) {
          if (value.length === 0) return { kind: 'clear' }
          const seen = new Set()
          const entries = value.map((entry, index) => {
            const host = hostEntry(entry, index)
            if (seen.has(host.name)) throw new Error('duplicate host name "' + host.name + '"')
            seen.add(host.name)
            return host
          })
          return { kind: 'set', value: entries }
        }
        if (isPlainObject(value)) {
          const names = Object.keys(value)
          if (names.length === 0) return undefined
          const entries = names.map((name, index) => {
            const target = value[name]
            if (typeof target === 'string') return hostEntry({ address: target }, index, name)
            if (isPlainObject(target)) return hostEntry(target, index, name)
            throw new Error('hosts[' + index + '] "' + name + '": value must be "user@host", "host" or an object')
          })
          return { kind: 'set', value: entries }
        }
      } catch { return undefined }
      return undefined
    }
    function applySshSettings(ctx) {
      const scope = ctx.configForms.get(SSH_NS)
      const specs = [
        { field: 'enabled', format: (value) => value === true ? 'true' : 'false', parse: (text) => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined },
        { field: 'approvalListInvert', format: (value) => value === true ? 'true' : 'false', parse: (text) => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined },
        settingsNumberField('idleMinutes'),
        settingsNumberField('hardCapHours'),
        settingsNumberField('globalMax'),
        { field: 'hosts', format: (value) => Array.isArray(value) || isPlainObject(value) ? JSON.stringify(value, null, 2) : typeof value === 'string' ? value : '[]', parse: parseHostsText },
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
            const rowKey = (ctx.pkg?.name ?? SSH_PACKAGE) + '#' + SSH_NS
            const row = ctx.slots.inject('plugins.row.config', () => ctx.slots.register({ name: 'plugins.row.config', key: rowKey, inject }, SshSettingsPage))
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
      const form = new SettingsFormModel(scope, [...[FIELD, REMOVE].map(field => ({
        field,
        format: (value) => value === true ? 'true' : 'false',
        parse: (text) => text === 'true' || text === 'false' ? { kind: 'set', value: text === 'true' } : undefined,
      })), {
        field: RECYCLE,
        format: (value) => value === 'session' ? 'session' : 'always',
        parse: (text) => text === 'session' || text === 'always' ? { kind: 'set', value: text } : undefined,
      }])
      const store = form.bind(() => ({ ...form.shell(), field: form.field(FIELD), accepted: scope.getSnapshot().value?.[FIELD] === true, removalField: form.field(REMOVE), removalAccepted: scope.getSnapshot().value?.[REMOVE] === true, recycleField: form.field(RECYCLE), recycleAccepted: scope.getSnapshot().value?.[RECYCLE] === 'session' }))
      // 清除不走暂存表单：直接把清除计数加一并写入，和其他未保存的修改互不影响。
      const clearRecycleApprovals = () => {
        const snapshot = scope.getSnapshot()
        const current = Number(snapshot.value?.[EPOCH])
        return scope.mutate([{ op: 'set', path: [EPOCH], value: (Number.isSafeInteger(current) && current >= 0 ? current : 0) + 1 }], snapshot.revision)
      }
      const inject = () => ({ hooks: { pwshSettings: store }, ...form.actions(), clearRecycleApprovals })
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
