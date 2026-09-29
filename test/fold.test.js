import assert from 'node:assert/strict'
import test from 'node:test'

import { createFold, lastUsageFromStream, normalizeUsage } from '../src/fold.js'
import { resolveConfig } from '../src/rates.js'

const config = resolveConfig({})

/** 北京时间字面量 → epoch 毫秒。 */
function at(text) {
  return Date.parse(`${text}+08:00`)
}

/** 构造 request/header 事件。 */
function header(seq, model = 'deepseek-flash', provider = 'deepseek-official') {
  return { type: 'request/header', seq, time: at('2026-09-29T10:00:00'), data: { header: { config: { provider, model } } } }
}

/** 构造 assistant/message 事件。 */
function message(seq, usage, { turn = 1, step = 1, model = 'deepseek-flash', time = '2026-09-29T10:00:10' } = {}) {
  return {
    type: 'assistant/message',
    seq,
    time: at(time),
    data: {
      turn,
      step,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model } },
      ...(usage === undefined ? {} : { usage }),
    },
  }
}

/** 构造 assistant/attempt 事件（用量藏在 stream 里）。 */
function attempt(seq, usage, { turn = 1, step = 1, time = '2026-09-29T10:00:05' } = {}) {
  return {
    type: 'assistant/attempt',
    seq,
    time: at(time),
    data: { turn, step, stream: [{ type: 'chunk', chunk: { type: 'usage', usage } }] },
  }
}

test('lastUsageFromStream：取最后一次 usage，忽略其他 chunk', () => {
  const stream = [
    { type: 'chunk', chunk: { type: 'block-start', index: 0 } },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 1 } } },
    { type: 'chunk', chunk: { type: 'usage', usage: { inputTokens: 2 } } },
    { type: 'chunk', chunk: { type: 'finish', reason: { kind: 'stop' } } },
  ]
  assert.deepEqual(lastUsageFromStream(stream)?.inputTokens, 2)
  assert.equal(lastUsageFromStream(undefined), undefined)
  assert.equal(lastUsageFromStream([]), undefined)
})

test('normalizeUsage：inputTokens 视为缓存未命中，reasoing 已含在 output 内', () => {
  const usage = { inputTokens: 100, outputTokens: 50, cacheReadTokens: 900, cacheWriteTokens: 7, reasoningTokens: 30 }
  assert.deepEqual(normalizeUsage(usage), {
    cacheHitTokens: 900,
    cacheMissTokens: 100,
    cacheWriteTokens: 7,
    outputTokens: 50,
  })
  assert.deepEqual(normalizeUsage(undefined), {
    cacheHitTokens: 0,
    cacheMissTokens: 0,
    cacheWriteTokens: 0,
    outputTokens: 0,
  })
})

test('普通一轮：一条 assistant/message 产生一条计价条目', () => {
  const fold = createFold({ config, sessionId: 's1', origin: 'user' })
  assert.equal(fold.push(header(1)), undefined)
  const entry = fold.push(message(2, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0 }))
  assert.equal(entry.sessionId, 's1')
  assert.equal(entry.seq, 2)
  assert.equal(entry.samples.length, 1)
  // 2026-09-29 是周二，10:00 属忙时：100 万未命中输入 = ¥2
  assert.equal(entry.samples[0].cny, 2)
  assert.equal(entry.samples[0].peak, true)
  assert.equal(entry.samples[0].model, 'deepseek-flash')
  assert.equal(entry.day, '2026-09-29')
})

test('模型来源：message.source 优先于 request/header', () => {
  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1, 'deepseek-v4-pro'))
  const entry = fold.push(message(2, { inputTokens: 1_000_000 }, { model: 'deepseek-flash' }))
  assert.equal(entry.samples[0].model, 'deepseek-flash')
  assert.equal(entry.samples[0].cny, 2)
})

test('无 usage 的 assistant/message 不产生条目', () => {
  const fold = createFold({ config, sessionId: 's1' })
  assert.equal(fold.push(message(2, undefined)), undefined)
  assert.deepEqual(fold.flush(), [])
})

test('重试：被重试掉的尝试与最终消息各计一次，等价样本不重复计费', () => {
  const failed = { inputTokens: 1000, outputTokens: 200, cacheReadTokens: 5000, cacheWriteTokens: 0 }
  const final = { inputTokens: 1200, outputTokens: 300, cacheReadTokens: 6000, cacheWriteTokens: 0 }

  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1))
  fold.push(attempt(2, failed))
  fold.push(attempt(3, final)) // 最终尝试也出现在 stream 里：必须与 message 去重
  const entry = fold.push(message(4, final))

  assert.equal(entry.samples.length, 2, '失败尝试 + 最终尝试 = 2 次计费')
  const total = entry.samples.reduce((sum, sample) => sum + sample.cny, 0)
  const expected =
    (1000 * 2 + 200 * 8 + 5000 * 0.04 + 1200 * 2 + 300 * 8 + 6000 * 0.04) / 1_000_000
  assert.ok(Math.abs(total - expected) < 1e-12, `期望 ${expected}，实际 ${total}`)
  assert.equal(entry.seq, 4)
})

test('step 内只有一条尝试且与消息同源：只计一次', () => {
  const usage = { inputTokens: 500, outputTokens: 100, cacheReadTokens: 0, cacheWriteTokens: 0 }
  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1))
  fold.push(attempt(2, usage))
  const entry = fold.push(message(3, usage))
  assert.equal(entry.samples.length, 1)
})

test('崩溃兜底：只有尝试样本没有消息时，在 step/end 结算', () => {
  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1))
  fold.push(attempt(2, { inputTokens: 1_000_000, outputTokens: 0 }))
  const entry = fold.push({ type: 'step/end', seq: 3, time: at('2026-09-29T10:00:20'), data: { turn: 1, step: 1 } })
  assert.equal(entry.samples.length, 1)
  assert.equal(entry.samples[0].cny, 2)
})

test('多个 step 互不干扰，序号取批次内最大值', () => {
  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1))
  const first = fold.push(message(2, { inputTokens: 1_000_000 }, { step: 1 }))
  const second = fold.push(message(3, { inputTokens: 1_000_000 }, { step: 2 }))
  assert.equal(first.samples.length, 1)
  assert.equal(second.samples.length, 1)
  assert.equal(first.seq, 2)
  assert.equal(second.seq, 3)
})

test('闲时计价：22:00 的调用按五折', () => {
  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1))
  const entry = fold.push(message(2, { inputTokens: 1_000_000 }, { time: '2026-09-29T22:00:00' }))
  assert.equal(entry.samples[0].peak, false)
  assert.equal(entry.samples[0].cny, 1)
})

test('flush：未结算的 step 在会话释放时产出条目', () => {
  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1))
  fold.push(message(2, { inputTokens: 1_000_000 }))
  assert.deepEqual(fold.flush(), [], '已结算的 step 不应再次产出')
  const fold2 = createFold({ config, sessionId: 's2' })
  fold2.push(header(1))
  fold2.push(attempt(2, { inputTokens: 1_000_000 }))
  const flushed = fold2.flush()
  assert.equal(flushed.length, 1)
  assert.equal(flushed[0].sessionId, 's2')
})

test('route：记录最近一次请求的 provider/model，未知模型回退 flash 价', () => {
  const fold = createFold({ config, sessionId: 's1' })
  fold.push(header(1, 'brand-new-model'))
  assert.deepEqual(fold.route(), { provider: 'deepseek-official', model: 'brand-new-model' })
  const entry = fold.push(message(2, { inputTokens: 1_000_000 }, { model: 'brand-new-model' }))
  assert.equal(entry.samples[0].model, 'deepseek-flash', '未知模型按 flash 价计费')
  assert.equal(entry.samples[0].cny, 2)
})
