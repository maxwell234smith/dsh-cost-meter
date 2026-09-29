/**
 * 费用账本：把「一次已计价的调用」累积进持久状态。
 *
 * 设计要点：
 *   - 所有写入都是纯函数，返回新状态，便于单测与回放。
 *   - 同一会话内的事件用 (sessionId, seq) 作为幂等键（水位线 highWater），
 *     因此「历史回填」与「实时记账」可以重复运行而不会重复计费。
 *   - 金额全部为人民币元；金额累加用整数微元（1e-6 元）记账以避免浮点漂移。
 *
 * @module dsh-cost-meter/ledger
 */

/** 账本状态版本，结构变更时递增。 */
export const LEDGER_VERSION = 1

/** 金额记账精度：1 元 = 1e6 微元。 */
const MICRO = 1_000_000

/**
 * 把金额换算成整数微元。
 * @param {number} cny 人民币金额。
 * @returns {number} 整数微元。
 */
export function toMicro(cny) {
  return Math.round(cny * MICRO)
}

/**
 * 把整数微元还原成人民币金额。
 * @param {number} micro 整数微元。
 * @returns {number} 人民币金额。
 */
export function fromMicro(micro) {
  return micro / MICRO
}

/** 分桶的规范字段；只有这些字段参与累加，会话元信息不受影响。 */
const BUCKET_KEYS = Object.freeze(Object.keys(emptyBucket()))

/**
 * 创建一个空的分桶计数。
 * @returns {object} 全零分桶。
 */
function emptyBucket() {
  return {
    requests: 0,
    cnyMicro: 0,
    peakRequests: 0,
    peakCnyMicro: 0,
    offPeakRequests: 0,
    offPeakCnyMicro: 0,
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    outputTokens: 0,
    peakCacheHitTokens: 0,
    peakCacheMissTokens: 0,
    peakOutputTokens: 0,
    offPeakCacheHitTokens: 0,
    offPeakCacheMissTokens: 0,
    offPeakOutputTokens: 0,
  }
}

/**
 * 创建一个空账本。
 * @param {{ pricesFingerprint?: string, now?: number }} [options] 初始元信息。
 * @returns {object} 账本状态。
 */
export function createLedger(options = {}) {
  const now = options.now ?? Date.now()
  return {
    version: LEDGER_VERSION,
    createdAt: now,
    updatedAt: now,
    backfilledAt: null,
    pricesFingerprint: options.pricesFingerprint ?? null,
    totals: emptyBucket(),
    days: {},
    models: {},
    sessions: {},
    highWater: {},
    /** 不属于任何会话的直接调用（实验性脚本调用 ctx.llm.stream）。 */
    sessionless: emptyBucket(),
  }
}

/**
 * 把一个分桶累加到另一个分桶上（原地修改目标）。
 * 只累加规范字段，因此目标对象可以同时携带会话元信息（firstAt/lastAt/origin 等）。
 * @param {object} target 目标分桶。
 * @param {object} source 来源分桶。
 * @returns {object} 目标分桶。
 */
function addBucket(target, source) {
  for (const key of BUCKET_KEYS) target[key] += source[key] ?? 0
  return target
}

/**
 * 给一个「已计价调用」构造分桶增量。
 * @param {{ cny: number, peak: boolean, tokens: { cacheHit: number, cacheMiss: number, output: number } }} priced 计价结果。
 * @returns {object} 该调用对应的分桶增量。
 */
function bucketOf(priced) {
  const bucket = emptyBucket()
  const micro = toMicro(priced.cny)
  bucket.requests = 1
  bucket.cnyMicro = micro
  bucket.cacheHitTokens = priced.tokens.cacheHit
  bucket.cacheMissTokens = priced.tokens.cacheMiss
  bucket.outputTokens = priced.tokens.output
  if (priced.peak) {
    bucket.peakRequests = 1
    bucket.peakCnyMicro = micro
    bucket.peakCacheHitTokens = priced.tokens.cacheHit
    bucket.peakCacheMissTokens = priced.tokens.cacheMiss
    bucket.peakOutputTokens = priced.tokens.output
  } else {
    bucket.offPeakRequests = 1
    bucket.offPeakCnyMicro = micro
    bucket.offPeakCacheHitTokens = priced.tokens.cacheHit
    bucket.offPeakCacheMissTokens = priced.tokens.cacheMiss
    bucket.offPeakOutputTokens = priced.tokens.output
  }
  return bucket
}

/**
 * 一次待记账的调用。
 *
 * 既可以是一条计价明细（扁平形式，便于测试与简单接入），
 * 也可以是一批明细（`samples`）；批量形式用于「一个 step 内的多次计费尝试」
 * 必须原子记账、原子去重的场景。
 *
 * @typedef {object} LedgerEntry
 * @property {number} [cny] 费用（人民币元，扁平形式）。
 * @property {boolean} [peak] 是否忙时（扁平形式）。
 * @property {{ cacheHit: number, cacheMiss: number, output: number }} [tokens] 三桶 token（扁平形式）。
 * @property {Array<{ cny: number, peak: boolean, tokens: { cacheHit: number, cacheMiss: number, output: number }, model?: string }>} [samples] 批量明细。
 * @property {number} at 结算时刻（epoch 毫秒）。
 * @property {string} [day] 北京时间日期 YYYY-MM-DD；缺省由 at 推导。
 * @property {string} [model] 实际计价的模型 id（扁平形式）。
 * @property {string} [sessionId] 所属会话；缺省表示不属于任何会话。
 * @property {number} [seq] 会话内事件序号（幂等键）；批量形式取批次内最大序号。
 * @property {string} [origin] 会话来源（subagent / user 等）。
 */

/**
 * 判断条目相对水位线的状态。
 *
 * 同一个会话的日志 seq 单调递增，因此用「已记账的最大 seq」作为水位线：
 *   - seq 大于水位线：新事件，正常记账；
 *   - seq 等于水位线：重复（实时记账后回填又读到同一条）；
 *   - seq 小于水位线：过期（说明回填跑在了实时订阅之后，属于调用顺序错误）。
 * 插件必须保证「先回填、后订阅实时事件」，否则过期条目会被跳过并留下缺口。
 *
 * @param {object} ledger 账本。
 * @param {LedgerEntry} entry 待记账条目。
 * @returns {'new' | 'duplicate' | 'stale'} 条目相对水位线的状态。
 */
export function watermarkState(ledger, entry) {
  if (entry.sessionId === undefined || entry.seq === undefined) return 'new'
  const watermark = ledger.highWater[entry.sessionId]
  if (watermark === undefined) return 'new'
  if (entry.seq > watermark) return 'new'
  return entry.seq === watermark ? 'duplicate' : 'stale'
}

/**
 * 条目是否已经记账（重复或过期）。
 * @param {object} ledger 账本。
 * @param {LedgerEntry} entry 待记账条目。
 * @returns {boolean} true 表示不应再次记账。
 */
export function isRecorded(ledger, entry) {
  return watermarkState(ledger, entry) !== 'new'
}

/**
 * 把一个已计价调用记入账本，返回新的账本状态。
 * 已记账的条目（seq 不高于水位线）会被忽略，保证回填与实时记账可重复执行。
 * @param {object} ledger 当前账本。
 * @param {LedgerEntry} entry 待记账条目。
 * @returns {{ ledger: object, applied: boolean, state: 'new' | 'duplicate' | 'stale' }} 新账本、是否真正记账、水位线状态。
 */
export function applyEntry(ledger, entry) {
  const state = watermarkState(ledger, entry)
  if (state !== 'new') return { ledger, applied: false, state }

  const next = {
    ...ledger,
    totals: { ...ledger.totals },
    days: { ...ledger.days },
    models: { ...ledger.models },
    sessions: { ...ledger.sessions },
    highWater: { ...ledger.highWater },
    sessionless: { ...ledger.sessionless },
    updatedAt: Math.max(ledger.updatedAt, entry.at),
  }

  const samples = entry.samples ?? [entry]
  // 分桶必须先复制再累加：浅拷贝的容器仍共享内层对象，就地修改会污染旧状态。
  const dayBuckets = new Map()
  const modelBuckets = new Map()

  for (const sample of samples) {
    const delta = bucketOf(sample)
    addBucket(next.totals, delta)

    const dayKey = sample.day ?? entry.day ?? beijingDay(entry.at)
    let day = dayBuckets.get(dayKey)
    if (day === undefined) {
      day = { ...(next.days[dayKey] ?? emptyBucket()) }
      next.days[dayKey] = day
      dayBuckets.set(dayKey, day)
    }
    addBucket(day, delta)

    const modelId = sample.model ?? entry.model
    if (modelId !== undefined) {
      let model = modelBuckets.get(modelId)
      if (model === undefined) {
        model = { ...(next.models[modelId] ?? emptyBucket()) }
        next.models[modelId] = model
        modelBuckets.set(modelId, model)
      }
      addBucket(model, delta)
    }
  }

  if (entry.sessionId === undefined) {
    addBucket(next.sessionless, samples.reduce((sum, sample) => addBucket(sum, bucketOf(sample)), emptyBucket()))
  } else {
    const session = {
      ...(next.sessions[entry.sessionId] ?? {
        ...emptyBucket(),
        firstAt: entry.at,
        lastAt: entry.at,
        day: entry.day ?? beijingDay(entry.at),
        origin: entry.origin ?? null,
      }),
    }
    next.sessions[entry.sessionId] = session
    for (const sample of samples) addBucket(session, bucketOf(sample))
    session.lastAt = Math.max(session.lastAt, entry.at)
    session.firstAt = Math.min(session.firstAt, entry.at)
    if (entry.origin !== undefined) session.origin = entry.origin
    if (entry.seq !== undefined) {
      next.highWater[entry.sessionId] = Math.max(next.highWater[entry.sessionId] ?? 0, entry.seq)
    }
  }

  return { ledger: next, applied: true, state: 'new' }
}

/**
 * 由时间戳推导北京时间日期。
 * @param {number} at epoch 毫秒。
 * @returns {string} YYYY-MM-DD（北京时间）。
 */
function beijingDay(at) {
  const shifted = new Date(at + 8 * 3_600_000)
  return shifted.toISOString().slice(0, 10)
}

/**
 * 账本读数的对外快照（把微元还原成金额、折算汇总字段）。
 * @param {object | undefined} bucket 分桶；缺省视为空桶。
 * @returns {object} 便于展示的读数。
 */
export function readBucket(bucket) {
  const source = bucket ?? emptyBucket()
  return {
    requests: source.requests,
    cny: fromMicro(source.cnyMicro),
    peak: { requests: source.peakRequests, cny: fromMicro(source.peakCnyMicro) },
    offPeak: { requests: source.offPeakRequests, cny: fromMicro(source.offPeakCnyMicro) },
    tokens: {
      cacheHit: source.cacheHitTokens,
      cacheMiss: source.cacheMissTokens,
      output: source.outputTokens,
      total: source.cacheHitTokens + source.cacheMissTokens + source.outputTokens,
    },
    peakTokens: {
      cacheHit: source.peakCacheHitTokens,
      cacheMiss: source.peakCacheMissTokens,
      output: source.peakOutputTokens,
    },
    offPeakTokens: {
      cacheHit: source.offPeakCacheHitTokens,
      cacheMiss: source.offPeakCacheMissTokens,
      output: source.offPeakOutputTokens,
    },
  }
}

/**
 * 归一化账本里的会话键：把历史遗留的 `session-<uuid>` 键并入裸 `<uuid>` 键。
 *
 * DSH 里主会话 id 带 `session-` 前缀、子代理会话不带，而界面侧统一用裸 uuid 查表。
 * 老版本账本存的是原始 id，这里做一次迁移，保证「本次会话」查得到历史。
 *
 * @param {object} ledger 账本。
 * @returns {object} 迁移后的账本；无需迁移时返回原对象。
 */
export function normalizeSessionKeys(ledger) {
  const needsMigration = Object.keys(ledger.sessions).some((id) => id.startsWith('session-'))
  if (!needsMigration) return ledger

  const sessions = {}
  const highWater = { ...ledger.highWater }
  for (const [id, session] of Object.entries(ledger.sessions)) {
    const key = id.replace(/^session-/, '')
    const existing = sessions[key]
    if (existing === undefined) {
      sessions[key] = key === id ? session : { ...session }
    } else {
      // 同一个会话的两种写法都出现过：分桶相加，时间取并集。
      const merged = { ...existing }
      addBucket(merged, session)
      merged.firstAt = Math.min(existing.firstAt ?? session.firstAt, session.firstAt ?? existing.firstAt)
      merged.lastAt = Math.max(existing.lastAt ?? 0, session.lastAt ?? 0)
      if (existing.origin == null && session.origin != null) merged.origin = session.origin
      sessions[key] = merged
    }
    const watermark = highWater[id]
    if (watermark !== undefined) {
      highWater[key] = Math.max(highWater[key] ?? 0, watermark)
      if (key !== id) delete highWater[id]
    }
  }
  return { ...ledger, sessions, highWater }
}

/**
 * 清理过期的会话明细，控制持久化体积（总量与按天数据不受影响）。
 * @param {object} ledger 账本。
 * @param {{ now?: number, keepDays?: number, max?: number }} [options] 保留策略。
 * @returns {object} 清理后的账本（无变化时返回原对象）。
 */
export function pruneSessions(ledger, options = {}) {
  const now = options.now ?? Date.now()
  const keepDays = options.keepDays ?? 90
  const max = options.max ?? 500
  const cutoff = now - keepDays * 86_400_000

  const kept = Object.entries(ledger.sessions).filter(([, session]) => session.lastAt >= cutoff)
  const dropped = Object.keys(ledger.sessions).length - kept.length
  const overflow = kept.length > max ? kept.length - max : 0
  if (dropped === 0 && overflow === 0) return ledger

  const sorted = kept.sort((a, b) => b[1].lastAt - a[1].lastAt).slice(0, max)
  return { ...ledger, sessions: Object.fromEntries(sorted) }
}
