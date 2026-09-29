/**
 * DeepSeek 计价核心（纯函数，无副作用，便于单测）。
 *
 * 价格来源：https://api-docs.deepseek.com/zh-cn/quick_start/pricing/ （2026-09-29 抓取）
 *   deepseek-flash    缓存命中 0.04 / 未命中 2.0  / 输出 8.0   （¥ / 百万 token，忙时）
 *   deepseek-v4-pro   缓存命中 0.30 / 未命中 9.0  / 输出 27.0
 * 闲时价格 = 忙时价格 × 0.5。
 *
 * 忙时定义：北京时间（Asia/Shanghai，UTC+8，无夏令时）周一至周五
 *   09:00–12:00 与 14:00–18:00，且当天不是中国法定节假日。
 *   其余全部时段（含周末、节假日全天、12:00–14:00 午休）均为闲时。
 *   节假日数据见 ./holidays.js，默认口径与可切换项见该模块说明。
 *
 * @module dsh-cost-meter/pricing
 */

/** 百万 token 的换算基数。 */
export const TOKENS_PER_UNIT = 1_000_000

/** 闲时折扣：闲时价格 = 忙时价格 × 该系数。 */
export const OFF_PEAK_FACTOR = 0.5

/** 北京时间相对 UTC 的固定偏移（小时）。中国大陆自 1991 年起无夏令时。 */
const BEIJING_UTC_OFFSET_HOURS = 8

/** 官方价表，单位：人民币元 / 百万 token（忙时价）。 */
export const DEFAULT_PRICES = {
  'deepseek-flash': { cacheHitInput: 0.04, cacheMissInput: 2.0, output: 8.0 },
  'deepseek-v4-pro': { cacheHitInput: 0.3, cacheMissInput: 9.0, output: 27.0 },
}

/** 旧模型 id 归一化：官方说明它们由 V4.1-Flash 提供服务并按 Flash 价格计费。 */
const MODEL_ALIASES = {
  'deepseek-v4-flash': 'deepseek-flash',
  'deepseek-v4-flash-vision-exp': 'deepseek-flash',
}

/** 未在价表中登记的模型的兜底策略：'deepseek-flash' 价 or null（不计价）。 */
export const UNKNOWN_MODEL_FALLBACK = 'deepseek-flash'

/**
 * 把模型 id 归一化到价表键。
 * @param {string | undefined} model 请求里出现的模型 id。
 * @returns {string | undefined} 价表中的键，未知名返回 undefined。
 */
export function normalizeModel(model) {
  if (typeof model !== 'string' || model === '') return undefined
  const id = model.toLowerCase()
  return MODEL_ALIASES[id] ?? (DEFAULT_PRICES[id] === undefined ? undefined : id)
}

/**
 * 北京时间下的日期分解结果。
 * @typedef {{ date: string, weekday: number, minutes: number }} BeijingMoment
 */

/**
 * 把一个时间点换算为北京时间的日期、星期与当日分钟数。
 * @param {Date | number | string} at 时间点（Date、epoch 毫秒或可解析字符串）。
 * @returns {BeijingMoment} 北京时间分解，`weekday` 0=周日 … 6=周六。
 */
export function beijingMoment(at) {
  const date = at instanceof Date ? at : new Date(at)
  if (Number.isNaN(date.getTime())) throw new TypeError(`invalid time: ${String(at)}`)
  const shifted = new Date(date.getTime() + BEIJING_UTC_OFFSET_HOURS * 3_600_000)
  const year = shifted.getUTCFullYear()
  const month = String(shifted.getUTCMonth() + 1).padStart(2, '0')
  const day = String(shifted.getUTCDate()).padStart(2, '0')
  return {
    date: `${year}-${month}-${day}`,
    weekday: shifted.getUTCDay(),
    minutes: shifted.getUTCHours() * 60 + shifted.getUTCMinutes(),
  }
}

/** 忙时时段（北京时间，分钟计），左闭右开。 */
const PEAK_WINDOWS = [
  [9 * 60, 12 * 60],
  [14 * 60, 18 * 60],
]

/**
 * 判断某一时刻是否属于忙时（即按标准价计费）。
 *
 * 忙时 = 北京时间周一至周五（不含法定节假日）09:00–12:00 与 14:00–18:00。
 * 调休上班日默认仍按周末处理（全天闲时）；把 `makeupWorkdaysArePeak` 设为 true
 * 可切换为「调休上班日算工作日」的口径。
 *
 * @param {Date | number | string} at 时间点；以请求发起的时刻为准。
 * @param {{ holidays?: Iterable<string>, makeupWorkdays?: Iterable<string>, makeupWorkdaysArePeak?: boolean }} [options]
 *   节假日与调休配置；日期格式 YYYY-MM-DD（北京时间）。
 * @returns {boolean} true 表示忙时。
 */
export function isPeak(at, options = {}) {
  const { date, weekday, minutes } = beijingMoment(at)
  const weekend = weekday === 0 || weekday === 6

  if (weekend) {
    if (options.makeupWorkdaysArePeak !== true) return false
    if (!contains(options.makeupWorkdays, date)) return false
  } else if (contains(options.holidays, date)) {
    return false
  }

  return PEAK_WINDOWS.some(([start, end]) => minutes >= start && minutes < end)
}

/**
 * 判断一个日期字符串是否落在给定集合里；集合缺省视为空集。
 * @param {Iterable<string> | undefined} values 日期集合。
 * @param {string} date YYYY-MM-DD。
 * @returns {boolean} 是否命中。
 */
function contains(values, date) {
  if (values === undefined) return false
  return values instanceof Set ? values.has(date) : [...values].includes(date)
}

/** 时段可能发生切换的北京时间点（分钟计）。 */
const BOUNDARIES = [0, ...PEAK_WINDOWS.flat()]

/**
 * 求下一个闲忙切换时刻，用于界面提示「还有多久切换」。
 * @param {Date | number | string} at 起始时间点。
 * @param {{ holidays?: Iterable<string>, makeupWorkdays?: Iterable<string>, makeupWorkdaysArePeak?: boolean }} [options] 同 {@link isPeak}。
 * @returns {number | undefined} 下一次切换的 epoch 毫秒；8 天内无切换时返回 undefined。
 */
export function nextPeriodChange(at, options = {}) {
  const date = at instanceof Date ? at : new Date(at)
  const current = isPeak(date, options)
  const dayStart = Math.floor((date.getTime() + BEIJING_UTC_OFFSET_HOURS * 3_600_000) / 86_400_000) * 86_400_000
  for (let dayOffset = 0; dayOffset <= 8; dayOffset += 1) {
    for (const boundary of BOUNDARIES) {
      const candidate =
        dayStart + (dayOffset * 86_400_000 + boundary * 60_000) - BEIJING_UTC_OFFSET_HOURS * 3_600_000
      if (candidate <= date.getTime()) continue
      if (isPeak(candidate, options) !== current) return candidate
    }
  }
  return undefined
}

/**
 * 一次模型调用的 token 用量（DSH 报告的字段名归一化后）。
 * @typedef {object} UsageSample
 * @property {string} [model] 路由模型 id。
 * @property {number} [cacheHitTokens] 命中前缀缓存的输入 token。
 * @property {number} [cacheMissTokens] 未命中缓存的输入 token。
 * @property {number} [cacheWriteTokens] 缓存写入 token（DeepSeek 不单独计费，按未命中价计）。
 * @property {number} [outputTokens] 输出 token（含思维链）。
 * @property {Date | number | string} [at] 调用时刻；缺省用当前时间。
 */

/**
 * 计算一次调用的费用与所属时段。
 * @param {UsageSample} usage 归一化用量。
 * @param {{ prices?: typeof DEFAULT_PRICES, holidays?: Iterable<string>, makeupWorkdays?: Iterable<string>, makeupWorkdaysArePeak?: boolean }} [config] 价表与节假日配置。
 * @returns {{ cny: number, peak: boolean, model: string | undefined, pricedModel: string | undefined, tokens: { cacheHit: number, cacheMiss: number, output: number } }}
 */
export function priceUsage(usage, config = {}) {
  const prices = config.prices ?? DEFAULT_PRICES
  const at = usage.at ?? Date.now()
  const peak = isPeak(at, {
    holidays: config.holidays,
    makeupWorkdays: config.makeupWorkdays,
    makeupWorkdaysArePeak: config.makeupWorkdaysArePeak,
  })

  const known = normalizeModel(usage.model)
  const pricedModel = known ?? (UNKNOWN_MODEL_FALLBACK === null ? undefined : UNKNOWN_MODEL_FALLBACK)
  const rate = pricedModel === undefined ? undefined : prices[pricedModel]

  const cacheHit = finite(usage.cacheHitTokens)
  const cacheMiss = finite(usage.cacheMissTokens) + finite(usage.cacheWriteTokens)
  const output = finite(usage.outputTokens)

  const tokens = { cacheHit, cacheMiss, output }
  if (rate === undefined) return { cny: 0, peak, model: usage.model, pricedModel: undefined, tokens }

  const factor = peak ? 1 : OFF_PEAK_FACTOR
  const cny =
    ((cacheHit * rate.cacheHitInput + cacheMiss * rate.cacheMissInput + output * rate.output) /
      TOKENS_PER_UNIT) *
    factor
  return { cny, peak, model: usage.model, pricedModel, tokens }
}

/**
 * 把非负有限数归一化，其余一律当 0。
 * @param {unknown} value 原始值。
 * @returns {number} 可直接参与乘法的数值。
 */
function finite(value) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : 0
}
