import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFAULT_PRICES,
  OFF_PEAK_FACTOR,
  beijingMoment,
  isPeak,
  normalizeModel,
  priceUsage,
} from '../src/pricing.js'

/** 构造一个北京时间字面量的 UTC 时间点。 */
function beijing(text) {
  return new Date(`${text}+08:00`)
}

test('北京时间分解：日期、星期与当日分钟数', () => {
  const moment = beijingMoment(beijing('2026-09-29T10:30:00'))
  assert.equal(moment.date, '2026-09-29')
  assert.equal(moment.weekday, 2) // 周二
  assert.equal(moment.minutes, 10 * 60 + 30)
})

test('忙时边界：09:00 与 14:00 起算，12:00 与 18:00 结束，午休属闲时', () => {
  const tuesday = '2026-09-29'
  assert.equal(isPeak(beijing(`${tuesday}T08:59:59`)), false)
  assert.equal(isPeak(beijing(`${tuesday}T09:00:00`)), true)
  assert.equal(isPeak(beijing(`${tuesday}T11:59:59`)), true)
  assert.equal(isPeak(beijing(`${tuesday}T12:00:00`)), false) // 午休
  assert.equal(isPeak(beijing(`${tuesday}T13:59:59`)), false)
  assert.equal(isPeak(beijing(`${tuesday}T14:00:00`)), true)
  assert.equal(isPeak(beijing(`${tuesday}T17:59:59`)), true)
  assert.equal(isPeak(beijing(`${tuesday}T18:00:00`)), false)
  assert.equal(isPeak(beijing(`${tuesday}T23:30:00`)), false)
})

test('周末全天属闲时', () => {
  assert.equal(isPeak(beijing('2026-09-26T10:00:00')), false) // 周六
  assert.equal(isPeak(beijing('2026-09-27T15:00:00')), false) // 周日
})

test('工作日但属法定节假日时全天闲时', () => {
  const holidays = ['2026-10-01', '2026-10-02']
  assert.equal(isPeak(beijing('2026-10-01T10:00:00'), { holidays }), false) // 周四 · 国庆
  assert.equal(isPeak(beijing('2026-09-30T10:00:00'), { holidays }), true) // 周三 · 非节假日
})

test('模型 id 归一化：旧名归到 deepseek-flash', () => {
  assert.equal(normalizeModel('deepseek-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('DeepSeek-V4-Pro'), 'deepseek-v4-pro')
  assert.equal(normalizeModel('deepseek-v4-flash'), 'deepseek-flash')
  assert.equal(normalizeModel('deepseek-v4-flash-vision-exp'), 'deepseek-flash')
  assert.equal(normalizeModel('some-unknown-model'), undefined)
  assert.equal(normalizeModel(undefined), undefined)
})

test('计价：flash 忙时 1M 未命中输入 = ¥2，闲时 = ¥1', () => {
  const peak = priceUsage(
    { model: 'deepseek-flash', cacheMissTokens: 1_000_000, at: beijing('2026-09-29T10:00:00') },
  )
  assert.equal(peak.peak, true)
  assert.equal(peak.cny, 2)

  const off = priceUsage(
    { model: 'deepseek-flash', cacheMissTokens: 1_000_000, at: beijing('2026-09-29T22:00:00') },
  )
  assert.equal(off.peak, false)
  assert.equal(off.cny, 1)
})

test('计价：三桶相加且闲时统一五折（结果与运行时刻无关）', () => {
  const usage = {
    model: 'deepseek-flash',
    cacheHitTokens: 1_000_000,
    cacheMissTokens: 1_000_000,
    outputTokens: 1_000_000,
  }
  // 一律显式传 at：不传就会落在“当前时刻”上，测试会随运行时间飘。
  const peak = priceUsage({ ...usage, at: beijing('2026-09-29T10:00:00') })
  const offPeak = priceUsage({ ...usage, at: beijing('2026-09-29T22:00:00') })
  assert.equal(peak.peak, true)
  assert.equal(peak.cny, 0.04 + 2 + 8)
  assert.equal(offPeak.peak, false)
  assert.equal(offPeak.cny, (0.04 + 2 + 8) * OFF_PEAK_FACTOR)
})

test('计价：pro 单价独立，缓存写入按未命中价并入输入', () => {
  const result = priceUsage({
    model: 'deepseek-v4-pro',
    cacheMissTokens: 500_000,
    cacheWriteTokens: 500_000,
    outputTokens: 1_000_000,
    at: beijing('2026-09-29T15:00:00'),
  })
  assert.equal(result.pricedModel, 'deepseek-v4-pro')
  assert.equal(result.tokens.cacheMiss, 1_000_000)
  assert.equal(result.cny, 9 + 27)
})

test('计价：未知模型回退到 flash 价，不抛错', () => {
  const result = priceUsage({
    model: 'mystery-model',
    cacheMissTokens: 1_000_000,
    at: beijing('2026-09-29T10:00:00'),
  })
  assert.equal(result.pricedModel, 'deepseek-flash')
  assert.equal(result.cny, 2)
})

test('计价：缺失或非法 token 数按 0 处理', () => {
  const result = priceUsage({ model: 'deepseek-flash', outputTokens: Number.NaN })
  assert.equal(result.cny, 0)
  assert.deepEqual(result.tokens, { cacheHit: 0, cacheMiss: 0, output: 0 })
})

test('计价：非法时间抛类型错误', () => {
  assert.throws(() => priceUsage({ model: 'deepseek-flash', at: 'not-a-date' }), TypeError)
})

test('价表自检：与官方公布的忙时价一致', () => {
  assert.deepEqual(DEFAULT_PRICES['deepseek-flash'], {
    cacheHitInput: 0.04,
    cacheMissInput: 2.0,
    output: 8.0,
  })
  assert.deepEqual(DEFAULT_PRICES['deepseek-v4-pro'], {
    cacheHitInput: 0.3,
    cacheMissInput: 9.0,
    output: 27.0,
  })
})
