// 把一台已校验的主机变成 spawn 用的 { command, args }。不经任何 shell，参数数组直接交给 spawn。
// 固定选项写在用户 ~/.ssh/config 之前生效（命令行 -o 优先），远端 RemoteCommand/RequestTTY 等无法改写会话形态。

export const FIXED_OPTIONS = Object.freeze([
  'BatchMode=yes',
  'StrictHostKeyChecking=accept-new',
  'UpdateHostKeys=no',
  'ConnectTimeout=10',
  'ServerAliveInterval=15',
  'ServerAliveCountMax=4',
  'ControlMaster=no',
  'ControlPath=none',
  'RemoteCommand=none',
  'RequestTTY=no',
  'ForwardAgent=no',
  'ForwardX11=no',
  'ClearAllForwardings=yes',
  'PermitLocalCommand=no',
  'EscapeChar=none',
])

/** 一行说明这台主机用哪一侧、哪个 agent、哪把钥匙；只在连接失败时附在报错后面。 */
export function describeCredentials(host) {
  const side = host.via === 'wsl' ? 'via wsl' + (host.wslDistro !== undefined ? ' (' + host.wslDistro + ')' : '') : 'via windows'
  const agent = host.identityAgent === 'none' ? 'agent none' : host.identityAgent !== undefined ? 'agent ' + host.identityAgent : 'agent default (SSH_AUTH_SOCK of that side)'
  const key = host.identityFile !== undefined ? 'key ' + host.identityFile + ' only' : 'keys from that side\'s ~/.ssh and ssh config'
  return side + ' · ' + host.user + '@' + host.sshHost + ':' + host.port + ' · ' + agent + ' · ' + key
}

/**
 * @param host parseHost() 的结果
 * @param paths { privateKnownHosts, userKnownHosts? } 已按 via 换算好的路径（WSL 侧给 Linux 路径）
 * @param sshPath Windows 侧 ssh 可执行文件（默认 ssh）
 * @returns { command, args, env? }；env 只含要覆盖的变量，调用方叠在 process.env 上
 */
export function buildSshArgv(host, paths, { sshPath = 'ssh', wslPath = 'wsl.exe' } = {}) {
  const known = [paths.privateKnownHosts, paths.userKnownHosts].filter((item) => typeof item === 'string' && item.length > 0)
  if (known.length === 0) throw new Error('a known_hosts path is required')
  for (const file of known) {
    if (/[\s"'`]/.test(file)) throw new Error('known_hosts paths must not contain whitespace or quotes')
  }
  const sshArgs = ['-T', '-e', 'none']
  for (const option of FIXED_OPTIONS) sshArgs.push('-o', option)
  sshArgs.push('-o', 'UserKnownHostsFile=' + known.join(' '))
  // 只用这一把钥匙：IdentitiesOnly 让 agent 里其余的钥匙不再挨个试，免得 Too many authentication failures。
  if (host.identityFile !== undefined) sshArgs.push('-o', 'IdentityFile=' + host.identityFile, '-o', 'IdentitiesOnly=yes')
  if (host.identityAgent === 'none') sshArgs.push('-o', 'IdentityAgent=none')
  const agent = host.identityAgent !== undefined && host.identityAgent !== 'none' ? host.identityAgent : undefined
  sshArgs.push('-p', String(host.port), '-l', host.user, '--', host.sshHost, 'exec /bin/sh')

  // Windows 侧：管道名经环境变量交给 ssh.exe；argv 里不出现反斜杠。
  if (host.via === 'windows') return agent === undefined ? { command: sshPath, args: sshArgs } : { command: sshPath, args: sshArgs, env: { SSH_AUTH_SOCK: agent } }
  const wslArgs = []
  if (host.wslDistro !== undefined) wslArgs.push('-d', host.wslDistro)
  wslArgs.push('-e', 'env')
  if (agent !== undefined) wslArgs.push('SSH_AUTH_SOCK=' + agent)
  wslArgs.push('ssh', ...sshArgs)
  return { command: wslPath, args: wslArgs }
}
