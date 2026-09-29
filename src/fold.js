/**
 * 会话事件折叠：把一条会话日志（历史回填）或实时事件流（在线记账）折叠成
 * 「已计价条目」，供账本累加。
 *
 * 计费口径（依据 DSH 官方包的语义）：
 *   - 一次 step 内若发生重试（llm/retry-started），每个被重试掉的尝试都会被单独计费，
 *     而 `assistant/message` 携带的是最终那次尝试的用量。
 *   - 因此这里按 step 汇总「尝试流里的 usage」+「assistant/message 的 usage」，
 *     并用用量指纹去重：与最终用量完全相同的尝试样本视为同一次调用，不重复计费。
 *
 * 同一份实现同时用于历史回填与实时记账，保证两条路径口径一致。
 *
 * @module dsh-cost-meter/fold
 */

import { beijingMoment } from './pricing.js'
import { price } from './rates.js'

/** 一次模型调用的原始用量（DSH 的 TokenUsage）。 */
const USAGE_KEYS = ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens']

/**
 * 从事件内的 stream 数组里取最后一次 usage 报告。
 * @param {unknown} stream 事件里的 stream 字段（chunk 数组）。
 * @returns {object | undefined} TokenUsage 或 undefined。
 */
export function lastUsageFromStream(stream) {
  if (!Array.isArray(stream)) return undefined
  for (let i = stream.length - 1; i >= 0; i -= 1) {
    const chunk = stream[i]?.chunk
    if (chunk?.type === 'usage' && chunk.usage !== undefined) return chunk.usage
  }
  return undefined
}

/**
 * 用量指纹：同一 step 内数值完全相同的样本视为同一次调用。
 * @param {object} usage TokenUsage。
 * @returns {string} 指纹字符串。
 */
function fingerprint(usage) {
  return USAGE_KEYS.map((key) => Number(usage?.[key] ?? 0)).join('|')
}

/**
 * 把一个 TokenUsage 归一化成计价输入。
 * @param {object} usage TokenUsage（inputTokens 为未命中缓存的输入）。
 * @returns {{ cacheHitTokens: number, cacheMissTokens: number, cacheWriteTokens: number, outputTokens: number }} 归一化用量。
 */
export function normalizeUsage(usage) {
  return {
    cacheHitTokens: Number(usage?.cacheReadTokens ?? 0),
    cacheMissTokens: Number(usage?.inputTokens ?? 0),
    cacheWriteTokens: Number(usage?.cacheWriteTokens ?? 0),
    outputTokens: Number(usage?.outputTokens ?? 0),
  }
}

/**
 * 创建一个会话折叠器。
 * @param {{ config: ReturnType<import('./rates.js').resolveConfig>, sessionId?: string, origin?: string | null }} options 计价配置与会话上下文。
 * @returns {{ push: (event: object) => object | undefined, flush: () => object | undefined, route: () => { provider?: string, model?: string } }} 折叠器。
 */
export function createFold(options) {
  const { config, sessionId, origin = null } = options
  /** @type {{ provider?: string, model?: string }} */
  let route = {}
  /** @type {Map<string, { attempts: Map<string, { usage: object, at: number, seq: number }>, message?: { usage: object, at: number, seq: number } }>} */
  const steps = new Map()

  /**
   * 定位某个 step 的汇总槽。
   * @param {object} event 事件。
   * @returns {{ attempts: Map<string, object>, message?: object }} step 槽。
   */
  function slotOf(event) {
    const key = `${event.data?.turn ?? 0}:${event.data?.step ?? 0}`
    let slot = steps.get(key)
    if (slot === undefined) {
      slot = { attempts: new Map() }
      steps.set(key, slot)
    }
    return slot
  }

  /**
   * 结算一个 step，产出计价条目。
   * @param {string} key step 键。
   * @returns {object | undefined} 计价条目；无用量时返回 undefined。
   */
  function settle(key) {
    const slot = steps.get(key)
    if (slot === undefined) return undefined
    steps.delete(key)

    const messageFingerprint = slot.message === undefined ? undefined : fingerprint(slot.message.usage)
    /** @type {{ usage: object, at: number, seq: number }[]} */
    const chosen = []
    for (const attempt of slot.attempts.values()) {
      if (fingerprint(attempt.usage) === messageFingerprint) continue
      chosen.push(attempt)
    }
    if (slot.message !== undefined) chosen.push(slot.message)
    if (chosen.length === 0) return undefined

    const priced = chosen.map((sample) => {
      const result = price(config, { ...normalizeUsage(sample.usage), model: route.model, at: sample.at })
      return {
        cny: result.cny,
        peak: result.peak,
        tokens: result.tokens,
        model: result.pricedModel,
        at: sample.at,
        day: beijingMoment(sample.at).date,
      }
    })

    const latest = priced.reduce((max, sample) => Math.max(max, sample.at), 0)
    const settleSeq = chosen.reduce((max, sample) => Math.max(max, sample.seq), 0)
    return {
      sessionId,
      seq: settleSeq,
      at: latest,
      day: beijingMoment(latest).date,
      origin,
      samples: priced,
    }
  }

  return {
    route: () => ({ ...route }),

    /**
     * 处理一个会话事件。
     * @param {object} event 会话事件（含 type/seq/time/data）。
     * @returns {object | undefined} 需要记账的条目。
     */
    push(event) {
      const data = event?.data ?? {}
      switch (event?.type) {
        case 'request/header': {
          const config0 = data.header?.config
          if (config0?.provider !== undefined) route.provider = config0.provider
          if (config0?.model !== undefined) route.model = config0.model
          return undefined
        }
        case 'request/context': {
          if (typeof data.provider === 'string') route.provider = data.provider
          if (typeof data.model === 'string') route.model = data.model
          return undefined
        }
        case 'assistant/attempt': {
          const usage = lastUsageFromStream(data.stream)
          if (usage === undefined) return undefined
          const slot = slotOf(event)
          slot.attempts.set(fingerprint(usage), { usage, at: event.time, seq: event.seq })
          return undefined
        }
        case 'assistant/message': {
          const source = data.message?.source
          if (source?.provider !== undefined) route.provider = source.provider
          if (source?.model !== undefined) route.model = source.model
          const usage = data.usage
          if (usage === undefined) return undefined
          const slot = slotOf(event)
          slot.message = { usage, at: event.time, seq: event.seq }
          return settle(`${data.turn ?? 0}:${data.step ?? 0}`)
        }
        case 'step/end': {
          // 崩溃或中断时可能有尝试样本但没有 assistant/message，这里兜底结算。
          return settle(`${data.turn ?? 0}:${data.step ?? 0}`)
        }
        default:
          return undefined
      }
    },

    /**
     * 会话结束/句柄释放时结算剩余 step。
     * @returns {object[]} 需要记账的条目列表。
     */
    flush() {
      const entries = []
      for (const key of [...steps.keys()]) {
        const entry = settle(key)
        if (entry !== undefined) entries.push(entry)
      }
      return entries
    },
  }
}
