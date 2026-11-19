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

/**
 * @param host parseHost() 的结果
 * @param paths { privateKnownHosts, userKnownHosts? } 已按 via 换算好的路径（WSL 侧给 Linux 路径）
 * @param sshPath Windows 侧 ssh 可执行文件（默认 ssh）
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
  sshArgs.push('-p', String(host.port), '-l', host.user, '--', host.sshHost, 'exec /bin/sh')

  if (host.via === 'windows') return { command: sshPath, args: sshArgs }
  const wslArgs = []
  if (host.wslDistro !== undefined) wslArgs.push('-d', host.wslDistro)
  wslArgs.push('-e', 'env')
  if (host.agentSocket !== undefined) wslArgs.push('SSH_AUTH_SOCK=' + host.agentSocket)
  wslArgs.push('ssh', ...sshArgs)
  return { command: wslPath, args: wslArgs }
}
