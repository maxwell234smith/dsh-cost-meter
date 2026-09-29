import assert from 'node:assert/strict'
import test from 'node:test'

import { HOLIDAY_DATA, HOLIDAY_SET, isYearPublished } from '../src/holidays.js'
import { resolveConfig } from '../src/rates.js'
import { isPeak } from '../src/pricing.js'

/** 构造一个北京时间字面量的 UTC 时间点。 */
function beijing(text) {
  return new Date(`${text}+08:00`)
}

test('节假日数据：已收录 2025/2026，2027 明确标记未发布', () => {
  assert.equal(isYearPublished(2025), true)
  assert.equal(isYearPublished(2026), true)
  assert.equal(isYearPublished(2027), false)
  assert.equal(HOLIDAY_DATA[2026].holidays.length, 33)
  assert.equal(HOLIDAY_DATA[2026].makeupWorkdays.length, 6)
  assert.equal(HOLIDAY_DATA[2025].holidays.length, 28)
})

test('节假日数据：列表内无重复、无非法日期格式', () => {
  for (const [year, data] of Object.entries(HOLIDAY_DATA)) {
    for (const key of ['holidays', 'makeupWorkdays']) {
      const list = data[key]
      assert.equal(new Set(list).size, list.length, `${year}.${key} 存在重复`)
      for (const date of list) {
        assert.match(date, /^\d{4}-\d{2}-\d{2}$/, `${year}.${key} 日期格式错误: ${date}`)
        assert.equal(date.slice(0, 4), year, `${year}.${key} 年份不匹配: ${date}`)
      }
    }
  }
})

test('节假日数据：调休上班日全部落在周末', () => {
  for (const [year, data] of Object.entries(HOLIDAY_DATA)) {
    for (const date of data.makeupWorkdays) {
      const weekday = beijing(`${date}T12:00:00`).getUTCDay()
      assert.ok(weekday === 0 || weekday === 6, `${year} 调休日 ${date} 不是周末`)
    }
  }
})

test('2026 春节与国庆：工作日遇法定节假日一律闲时', () => {
  // 2026-02-16 是周一，属春节假期
  assert.equal(isPeak(beijing('2026-02-16T10:00:00'), { holidays: HOLIDAY_SET }), false)
  // 2026-10-05 是周一，属国庆假期
  assert.equal(isPeak(beijing('2026-10-05T10:00:00'), { holidays: HOLIDAY_SET }), false)
  // 2026-10-08 是周四，假期已结束
  assert.equal(isPeak(beijing('2026-10-08T10:00:00'), { holidays: HOLIDAY_SET }), true)
})

test('2026 中秋与国庆未合并：9/28 周一是工作日', () => {
  assert.equal(isPeak(beijing('2026-09-28T10:00:00'), { holidays: HOLIDAY_SET }), true)
})

test('调休上班日口径可切换：默认闲时，开启后按工作日计', () => {
  const at = beijing('2026-05-09T10:00:00') // 周六 · 劳动节调休上班
  const base = { holidays: HOLIDAY_SET, makeupWorkdays: new Set(HOLIDAY_DATA[2026].makeupWorkdays) }
  assert.equal(isPeak(at, base), false)
  assert.equal(isPeak(at, { ...base, makeupWorkdaysArePeak: true }), true)
  // 开启后仍受时段限制：当天午休仍是闲时
  assert.equal(isPeak(beijing('2026-05-09T12:30:00'), { ...base, makeupWorkdaysArePeak: true }), false)
})

test('resolveConfig：合并价表覆盖、追加自定义假期、默认口径', () => {
  const resolved = resolveConfig({
    prices: { 'deepseek-flash': { output: 9.5 }, 'my-local-model': { cacheMissInput: 1, output: 2 } },
    extraHolidays: ['2026-12-31'],
    makeupWorkdaysArePeak: true,
    currency: 'CNY',
  })
  assert.equal(resolved.prices['deepseek-flash'].output, 9.5)
  assert.equal(resolved.prices['deepseek-flash'].cacheMissInput, 2.0, '未覆盖的字段应保留内置价')
  assert.equal(resolved.prices['my-local-model'].output, 2)
  assert.equal(resolved.makeupWorkdaysArePeak, true)
  assert.ok(resolved.holidays.has('2026-12-31'))
  assert.ok(resolved.holidays.has('2026-10-01'), '内置假期应保留')

  const fallback = resolveConfig()
  assert.equal(fallback.makeupWorkdaysArePeak, false)
  assert.equal(fallback.currency, 'CNY')
  assert.deepEqual(fallback.extraHolidays, undefined)
})
