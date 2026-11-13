import Schema from '@deepseek-ai/schemastery'
import { DEFAULT_MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS } from './session.mjs'

// 只有路由开关热更新；进程参数改变仍交给 Loader 重挂实例。
export const Config = Schema.object({
  pwshPath: Schema.string().default('pwsh'),
  timeoutMs: Schema.number().min(1).max(MAX_TIMEOUT_MS).step(1).default(120000),
  idleMs: Schema.number().min(1).step(1).default(1800000),
  maxSessions: Schema.number().min(1).step(1).default(4),
  maxOutputBytes: Schema.number().min(1).max(2147483647).step(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  allowUnconfined: Schema.boolean().default(false),
  enforcePwshRun: Schema.boolean().default(false).volatile(),
})
