import Schema from '@deepseek-ai/schemastery'
import { FILE_SCAN_DEFAULTS } from './file-scan.mjs'
import { DEFAULT_MAX_OUTPUT_BYTES, MAX_TIMEOUT_MS } from './session.mjs'

// 两个入口护栏开关热更新；进程参数改变仍交给 Loader 重挂实例。
export const Config = Schema.object({
  pwshPath: Schema.string().default('pwsh'),
  timeoutMs: Schema.number().min(1).max(MAX_TIMEOUT_MS).step(1).default(120000),
  idleMs: Schema.number().min(1).step(1).default(1800000),
  maxSessions: Schema.number().min(1).step(1).default(4),
  maxOutputBytes: Schema.number().min(1).max(2147483647).step(1).default(DEFAULT_MAX_OUTPUT_BYTES),
  allowUnconfined: Schema.boolean().default(false),
  fileScanMaxEntries: Schema.number().min(1).max(2000000).step(1).default(FILE_SCAN_DEFAULTS.fileScanMaxEntries),
  fileScanMaxBytes: Schema.number().min(1).max(536870912).step(1).default(FILE_SCAN_DEFAULTS.fileScanMaxBytes),
  fileScanTimeoutMs: Schema.number().min(1).max(1800000).step(1).default(FILE_SCAN_DEFAULTS.fileScanTimeoutMs),
  fileOperationTimeoutMs: Schema.number().min(1).max(1800000).step(1).default(FILE_SCAN_DEFAULTS.fileOperationTimeoutMs),
  enforcePwshRun: Schema.boolean().default(false).volatile(),
  enforceFileRemoval: Schema.boolean().default(false).volatile(),
  // 回收站写入不可回滚。宿主只给 allowed-once，复用到整个会话是插件替用户放宽，所以默认 always（每次都问），
  // session 由用户在设置页打开：同一会话、同一目录、同一策略下复用一次批准。范围确认（plan/execute）不受影响。
  recycleApproval: Schema.union([Schema.const('always'), Schema.const('session')]).default('always').volatile(),
  // 设置页「清除会话内授权」把它加一；值一变，已有的会话内授权全部作废。
  recycleApprovalEpoch: Schema.natural().default(0).volatile(),
})
