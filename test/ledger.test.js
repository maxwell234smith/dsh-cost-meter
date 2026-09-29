import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyEntry,
  createLedger,
  fromMicro,
  isRecorded,
  pruneSessions,
  readBucket,
  toMicro,
  watermarkState,
} from '../src/ledger.js'

/** 递归冻结，用于证明账本更新不会就地修改旧状态。 */
function deepFreeze(value) {
  if (value === null || typeof value !== 'object') return value
  for (const inner of Object.values(value)) deepFreeze(inner)
  return Object.freeze(value)
}

/** 构造一条已计价条目。 */
function entry(overrides = {}) {
  return {
    cny: 0.002,
    peak: true,
    tokens: { cacheHit: 1000, cacheMiss: 2000, output: 300 },
    at: Date.parse('2026-09-29T10:00:00+08:00'),
    day: '2026-09-29',
    model: 'deepseek-flash',
    sessionId: 's1',
    seq: 10,
    origin: 'user',
    ...overrides,
  }
}

test('金额换算：微元往返无损', () => {
  assert.equal(toMicro(2.0), 2_000_000)
  assert.equal(fromMicro(toMicro(0.000123)), 0.000123)
  assert.equal(fromMicro(toMicro(0.1) + toMicro(0.2)), 0.3)
})

test('记账：总量、按天、按模型、按会话同时更新', () => {
  const { ledger, applied } = applyEntry(createLedger({ now: 0 }), entry())
  assert.equal(applied, true)
  assert.equal(ledger.totals.requests, 1)
  assert.equal(fromMicro(ledger.totals.cnyMicro), 0.002)
  assert.equal(ledger.days['2026-09-29'].requests, 1)
  assert.equal(ledger.models['deepseek-flash'].requests, 1)
  assert.equal(ledger.sessions.s1.requests, 1)
  assert.equal(ledger.sessions.s1.origin, 'user')
  assert.equal(ledger.highWater.s1, 10)
})

test('记账：闲忙分桶互不污染', () => {
  let ledger = createLedger({ now: 0 })
  ledger = applyEntry(ledger, entry({ seq: 1, peak: true, cny: 0.01 })).ledger
  ledger = applyEntry(ledger, entry({ seq: 2, peak: false, cny: 0.005 })).ledger

  const totals = readBucket(ledger.totals)
  assert.equal(totals.requests, 2)
  assert.equal(totals.cny, 0.015)
  assert.equal(totals.peak.cny, 0.01)
  assert.equal(totals.peak.requests, 1)
  assert.equal(totals.offPeak.cny, 0.005)
  assert.equal(totals.offPeak.requests, 1)
  assert.equal(totals.tokens.total, 2 * (1000 + 2000 + 300))
  assert.equal(totals.peakTokens.cacheMiss, 2000)
  assert.equal(totals.offPeakTokens.output, 300)
})

test('幂等：同一 (sessionId, seq) 重复记账被忽略', () => {
  const first = applyEntry(createLedger({ now: 0 }), entry())
  const second = applyEntry(first.ledger, entry({ cny: 99 }))
  assert.equal(second.applied, false)
  assert.equal(second.ledger, first.ledger, '未记账时应原样返回旧账本')
  assert.equal(fromMicro(second.ledger.totals.cnyMicro), 0.002)
})

test('幂等：回填（升序）后接实时事件，重复回填不重复计费', () => {
  // 契约：先回填历史、再订阅实时；同一会话的 seq 单调递增。
  let ledger = createLedger({ now: 0 })
  const history = [entry({ seq: 10, cny: 0.01 }), entry({ seq: 15, cny: 0.015 })]
  for (const item of history) ledger = applyEntry(ledger, item).ledger
  ledger = applyEntry(ledger, entry({ seq: 20, cny: 0.02 })).ledger
  assert.equal(readBucket(ledger.totals).requests, 3)
  assert.equal(readBucket(ledger.totals).cny, 0.045)

  // 再次回填（例如重启后又跑一次）不应改变任何数字：
  // 历史条目低于水位线 → stale，最新那条等于水位线 → duplicate
  const expectedStates = ['stale', 'stale', 'duplicate']
  for (const [index, item] of [...history, entry({ seq: 20 })].entries()) {
    const result = applyEntry(ledger, item)
    assert.equal(result.applied, false)
    assert.equal(result.state, expectedStates[index])
    ledger = result.ledger
  }
  assert.equal(readBucket(ledger.totals).requests, 3)
  assert.equal(readBucket(ledger.totals).cny, 0.045)
})

test('水位线：早于水位线的条目被判为 stale 而不是新事件', () => {
  const ledger = applyEntry(createLedger({ now: 0 }), entry({ seq: 20 })).ledger
  assert.equal(watermarkState(ledger, entry({ seq: 21 })), 'new')
  assert.equal(watermarkState(ledger, entry({ seq: 20 })), 'duplicate')
  assert.equal(watermarkState(ledger, entry({ seq: 12 })), 'stale')
  const stale = applyEntry(ledger, entry({ seq: 12, cny: 5 }))
  assert.equal(stale.applied, false)
  assert.equal(stale.state, 'stale')
  assert.equal(readBucket(stale.ledger.totals).cny, 0.002, '过期条目不得计入')
})

test('批量记账：一个 step 的多次计费尝试原子写入', () => {
  const batch = {
    sessionId: 's1',
    seq: 30,
    at: Date.parse('2026-09-29T10:00:00+08:00'),
    origin: 'user',
    samples: [
      { cny: 0.01, peak: true, tokens: { cacheHit: 10, cacheMiss: 20, output: 30 }, model: 'deepseek-flash' },
      { cny: 0.02, peak: false, tokens: { cacheHit: 1, cacheMiss: 2, output: 3 }, model: 'deepseek-flash' },
    ],
  }
  const { ledger, applied } = applyEntry(createLedger({ now: 0 }), batch)
  assert.equal(applied, true)
  const totals = readBucket(ledger.totals)
  assert.equal(totals.requests, 2)
  assert.equal(totals.cny, 0.03)
  assert.equal(totals.peak.cny, 0.01)
  assert.equal(totals.offPeak.cny, 0.02)
  assert.equal(totals.tokens.total, 66)
  assert.equal(ledger.highWater.s1, 30)
  assert.equal(applyEntry(ledger, batch).applied, false, '整批重复写入应被忽略')
})

test('幂等：不属于任何会话的调用按次累加，不参与水位线', () => {
  let ledger = createLedger({ now: 0 })
  const noSession = { ...entry(), sessionId: undefined, seq: undefined, model: 'deepseek-v4-pro' }
  ledger = applyEntry(ledger, noSession).ledger
  ledger = applyEntry(ledger, noSession).ledger
  assert.equal(ledger.sessionless.requests, 2)
  assert.equal(readBucket(ledger.totals).requests, 2)
  assert.deepEqual(ledger.highWater, {})
  assert.equal(isRecorded(ledger, noSession), false)
})

test('纯函数：更新不会就地修改传入的账本', () => {
  const frozen = deepFreeze(applyEntry(createLedger({ now: 0 }), entry()).ledger)
  const next = applyEntry(frozen, entry({ seq: 11, peak: false, cny: 0.004 }))
  assert.equal(next.applied, true)
  assert.equal(readBucket(next.ledger.totals).requests, 2)
  assert.equal(readBucket(frozen.totals).requests, 1, '旧账本必须保持 1 次调用')
  assert.equal(readBucket(frozen.totals).offPeak.cny, 0)
})

test('会话明细：首末时间随调用更新', () => {
  const early = entry({ seq: 1, at: Date.parse('2026-09-29T09:10:00+08:00') })
  const late = entry({ seq: 2, at: Date.parse('2026-09-29T23:00:00+08:00') })
  let ledger = applyEntry(createLedger({ now: 0 }), early).ledger
  ledger = applyEntry(ledger, late).ledger
  assert.equal(ledger.sessions.s1.firstAt, early.at)
  assert.equal(ledger.sessions.s1.lastAt, late.at)
})

test('清理：丢弃过期会话明细但保留水位线与总量', () => {
  const now = Date.parse('2026-09-29T12:00:00+08:00')
  let ledger = createLedger({ now: 0 })
  ledger = applyEntry(ledger, entry({ sessionId: 'old', seq: 5, at: now - 200 * 86_400_000 })).ledger
  ledger = applyEntry(ledger, entry({ sessionId: 'new', seq: 6, at: now - 3_600_000 })).ledger
  const pruned = pruneSessions(ledger, { now, keepDays: 90 })
  assert.deepEqual(Object.keys(pruned.sessions), ['new'])
  assert.equal(pruned.highWater.old, 5, '水位线必须保留，否则回填会重复计费')
  assert.equal(readBucket(pruned.totals).requests, 2)
  assert.equal(pruneSessions(pruned, { now, keepDays: 90 }), pruned, '无变化时应返回原对象')
})

test('清理：会话数量超过上限时保留最近的', () => {
  const now = Date.parse('2026-09-29T12:00:00+08:00')
  let ledger = createLedger({ now: 0 })
  for (let i = 0; i < 10; i += 1) {
    ledger = applyEntry(ledger, entry({ sessionId: `s${i}`, seq: i, at: now - i * 60_000 })).ledger
  }
  const pruned = pruneSessions(ledger, { now, keepDays: 90, max: 3 })
  assert.deepEqual(Object.keys(pruned.sessions).sort(), ['s0', 's1', 's2'])
})
