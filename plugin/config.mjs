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
  // 回收站写入不可回滚，宿主批准的粒度由这里决定：session 在同一会话、同一目录、同一策略下复用
  // 一次批准；always 每次删除都重新问。范围确认（plan/execute 两段）不受影响。
  recycleApproval: Schema.union([Schema.const('session'), Schema.const('always')]).default('session').volatile(),
})
