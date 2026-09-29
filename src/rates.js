/**
 * 计价配置解析：把内置官方价表与节假日数据，和用户配置合并成一份可直接使用的配置。
 * 用户配置来自插件 YAML config（见 package.json 的 cordis.patch.yml 或 profile 配置）。
 *
 * @module dsh-cost-meter/rates
 */

import { HOLIDAY_SET, MAKEUP_WORKDAY_SET } from './holidays.js'
import { DEFAULT_PRICES, priceUsage } from './pricing.js'

/**
 * 用户可配置项。
 * @typedef {object} CostMeterConfig
 * @property {Record<string, { cacheHitInput?: number, cacheMissInput?: number, output?: number }>} [prices]
 *   覆盖或新增模型单价（人民币 / 百万 token，忙时价）。与内置价表深合并。
 * @property {string[]} [extraHolidays] 追加的休市/放假日期（YYYY-MM-DD，北京时间），用于公司假等自定义情况。
 * @property {boolean} [makeupWorkdaysArePeak] 调休上班日是否按工作日计（即存在忙时时段）。默认 false。
 * @property {string} [currency] 展示币种标记，仅用于显示。默认 'CNY'。
 */

/** 默认配置。 */
export const DEFAULT_CONFIG = {
  prices: DEFAULT_PRICES,
  extraHolidays: [],
  makeupWorkdaysArePeak: false,
  currency: 'CNY',
}

/**
 * 把用户配置解析为完整配置。
 * @param {CostMeterConfig} [config] 用户在 cordis 配置里给出的片段。
 * @returns {{ prices: typeof DEFAULT_PRICES, holidays: Set<string>, makeupWorkdays: Set<string>, makeupWorkdaysArePeak: boolean, currency: string }}
 */
export function resolveConfig(config = {}) {
  const prices = { ...DEFAULT_PRICES }
  for (const [model, rates] of Object.entries(config.prices ?? {})) {
    prices[model.toLowerCase()] = { ...prices[model.toLowerCase()], ...rates }
  }

  const holidays = new Set(HOLIDAY_SET)
  for (const date of config.extraHolidays ?? []) holidays.add(date)

  return {
    prices,
    holidays,
    makeupWorkdays: MAKEUP_WORKDAY_SET,
    makeupWorkdaysArePeak: config.makeupWorkdaysArePeak === true,
    currency: typeof config.currency === 'string' && config.currency !== '' ? config.currency : 'CNY',
  }
}

/**
 * 用解析后的配置给一次调用计价。
 * @param {import('./pricing.js').UsageSample} usage 归一化用量。
 * @param {ReturnType<typeof resolveConfig>} resolved 已解析配置。
 * @returns {ReturnType<typeof priceUsage>} 计价结果。
 */
export function price(resolved, usage) {
  return priceUsage(usage, resolved)
}
