// 回收站批准的会话内复用。
//
// 宿主只有一种授权结果 `allowed-once`。把它延伸到整个会话是本插件替用户做的放宽，所以：
// - 默认 `always`（每次都问），`session` 必须由用户在设置页打开；
// - 打开时，发给宿主的审批理由由插件追加一句说明，让用户知道这次批准会覆盖后续回收；
// - 记录按「会话 + 工作目录 + 沙箱策略」匹配（即 file-tools 的 c.key），并核对后端身份；
// - 会话结束、开关关掉、设置页点「清除」（recycleApprovalEpoch 变化）都会丢掉记录。
// 范围清单（plan → execute）不受影响，每次删除都仍要过。

export const RECYCLE_APPROVAL_MODES = Object.freeze(['always', 'session'])

export const SESSION_NOTICE = Object.freeze({
  reason: ' [Session approval is enabled: approving this also covers later recycling in this session, working directory and sandbox policy until the session ends or the approvals are cleared in settings.]',
  display: '（已开启会话内授权：批准后，本会话在同一目录、同一沙箱策略下的后续回收不再询问，直到会话结束或在设置里清除。）',
})

export class RecycleApprovals {
  constructor() {
    /** key -> { session, backendIdentity, epoch, grantedAt } */
    this.records = new Map()
    this.mode = 'always'
    this.epoch = 0
  }

  get size() { return this.records.size }

  /** 跟上当前设置：开关不是 session，或清除计数变了，就整表丢掉。返回丢掉的条数。 */
  sync(mode, epoch) {
    const nextMode = mode === 'session' ? 'session' : 'always'
    const nextEpoch = Number.isFinite(epoch) ? epoch : 0
    let dropped = 0
    if (nextMode !== 'session' || nextEpoch !== this.epoch) dropped = this.clear()
    this.mode = nextMode
    this.epoch = nextEpoch
    return dropped
  }

  enabled() { return this.mode === 'session' }

  /** c 是 file-tools 的 context()：{ key, session, backendIdentity }。 */
  covers(c) {
    if (!this.enabled()) return false
    const record = this.records.get(c.key)
    return record !== undefined && record.session === c.session && record.backendIdentity === c.backendIdentity && record.epoch === this.epoch
  }

  grant(c, now = Date.now()) {
    if (!this.enabled()) return false
    this.records.set(c.key, { session: c.session, backendIdentity: c.backendIdentity, epoch: this.epoch, grantedAt: now })
    return true
  }

  countSession(session) {
    let count = 0
    for (const record of this.records.values()) if (record.session === session) count++
    return count
  }

  revokeSession(session) {
    let count = 0
    for (const [key, record] of this.records) {
      if (record.session === session) { this.records.delete(key); count++ }
    }
    return count
  }

  clear() {
    const count = this.records.size
    this.records.clear()
    return count
  }
}
