import assert from 'node:assert/strict'
import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'

import { apply } from '../src/plugin.js'
import { isPeak, priceUsage } from '../src/pricing.js'
import { resolveConfig } from '../src/rates.js'

/** 北京时间字面量 → epoch 毫秒。 */
function at(text) {
  return Date.parse(`${text}+08:00`)
}

/**
 * 造一个够用的 cordis 上下文替身，用来在没有 DSH 进程的情况下驱动插件。
 * @param {{ sessionQuery?: object }} [services] 额外提供的服务。
 * @returns {object} 替身上下文与测试辅助方法。
 */
function createHarness(services = {}) {
  const listeners = new Map()
  const disposers = []
  let rpcHandler
  let rpcChannel
  let intervalMs

  const registry = {
    sessionQuery: services.sessionQuery,
    connection: {
      rpc: {
        handle(channel, handler) {
          rpcChannel = channel
          rpcHandler = handler
        },
      },
    },
    timer: {
      interval(fn, ms) {
        intervalMs = ms
        return () => {}
      },
    },
    webServer: {
      routes: new Map(),
      register(route) {
        this.routes.set(route.path, route)
        return () => this.routes.delete(route.path)
      },
    },
  }

  /** 构造一个「注入后」的子上下文：cordis 会把服务挂在 ctx 上。 */
  const child = {
    ...registry,
    get: (name) => registry[name],
    effect(fn, label) {
      const dispose = fn()
      if (typeof dispose === 'function') disposers.push(dispose)
      return dispose
    },
    logger: { warn() {}, debug() {} },
  }

  const ctx = {
    ...child,
    on(name, listener) {
      const list = listeners.get(name) ?? []
      list.push(listener)
      listeners.set(name, list)
    },
    inject(deps, callback) {
      if (deps.every((dep) => registry[dep] !== undefined)) callback(child)
    },
  }

  return {
    ctx,
    intervalMs: () => intervalMs,
    rpcChannel: () => rpcChannel,
    /**
     * 触发一个事件。
     * @param {string} name 事件名。
     * @param {...unknown} args 事件参数。
     * @returns {unknown[]} 各监听器的返回值。
     */
    emit(name, ...args) {
      return (listeners.get(name) ?? []).map((listener) => listener(...args))
    },
    /** 触发 RPC 并返回结果值。 */
    async call(endpoint) {
      const result = await rpcHandler(endpoint, {}, undefined, undefined)
      assert.equal(result.ok, true, `RPC ${endpoint} 失败：${JSON.stringify(result.error)}`)
      return result.value
    },
    /** 触发 RPC 并返回原始信封（用于断言错误路径）。 */
    callRaw(endpoint) {
      return rpcHandler(endpoint, {}, undefined, undefined)
    },
    /**
     * 模拟浏览器访问快照路由。
     * @param {string} method HTTP 方法。
     * @param {{ body?: unknown, host?: string, origin?: string, secFetchSite?: string }} [options] 请求细节。
     * @returns {Promise<{ status: number, body: string, headers: object }>} 响应。
     */
    async http(method, options = {}) {
      const route = registry.webServer.routes.get('/cost-meter/snapshot')
      assert.ok(route !== undefined, '快照路由未注册')
      const payload = options.body === undefined ? '' : JSON.stringify(options.body)
      const req = {
        method,
        headers: {
          host: options.host ?? '127.0.0.1:19387',
          ...(options.origin === undefined ? {} : { origin: options.origin }),
          ...(options.secFetchSite === undefined ? {} : { 'sec-fetch-site': options.secFetchSite }),
        },
        async *[Symbol.asyncIterator]() {
          if (payload !== '') yield Buffer.from(payload)
        },
      }
      const captured = { status: 0, body: '', headers: {} }
      const res = {
        writeHead(status, headers) {
          captured.status = status
          captured.headers = headers ?? {}
        },
        end(body) {
          if (typeof body === 'string') captured.body = body
        },
      }
      await route.handler(req, res)
      return captured
    },
    hasRoute: (path) => registry.webServer.routes.has(path),
    /** 卸载插件（触发所有 disposer）。 */
    dispose() {
      for (const dispose of disposers.reverse()) dispose()
    },
  }
}

/** 构造一个分桶（只填测试关心的字段，其余按 0 补齐）。 */
function bucket(requests, cnyMicro) {
  return {
    requests,
    cnyMicro,
    peakRequests: requests,
    peakCnyMicro: cnyMicro,
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

/** 构造会话头事件。 */
function headerEvent(seq = 1) {
  return { type: 'request/header', seq, time: at('2026-09-29T10:00:00'), data: { header: { config: { provider: 'deepseek-official', model: 'deepseek-flash' } } } }
}

/** 构造 assistant/message 事件。 */
function messageEvent(seq, usage, time = '2026-09-29T10:00:10', step = 1) {
  return {
    type: 'assistant/message',
    seq,
    time: at(time),
    data: {
      turn: 1,
      step,
      message: { role: 'assistant', content: [], source: { kind: 'model', provider: 'deepseek-official', model: 'deepseek-flash' } },
      usage,
    },
  }
}

/** 等待回填等异步工作完成。 */
async function settle() {
  await new Promise((resolve) => setTimeout(resolve, 25))
}

/**
 * 在临时 DSH_HOME 下运行一段测试体，结束后清理。
 * @param {(home: string) => Promise<void>} body 测试体。
 */
async function withTempHome(body) {
  const home = mkdtempSync(join(tmpdir(), 'dsh-cost-meter-'))
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  try {
    await body(home)
  } finally {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
    rmSync(home, { recursive: true, force: true })
  }
}

test('端到端：实时事件 → 快照 → 落盘 → 重启后回填不重复计费', async () => {
  await withTempHome(async (home) => {
    // 历史会话：两条调用（一条忙时、一条闲时）
    const historyEvents = [
      headerEvent(1),
      messageEvent(2, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
      messageEvent(3, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }, '2026-09-29T22:00:00', 2),
    ]
    const sessionQuery = {
      async listSessions() {
        return [{ header: { id: 'session-old', origin: 'user' } }]
      },
      async readSession(id) {
        assert.equal(id, 'session-old')
        return { session: { id, origin: 'user' }, events: historyEvents }
      },
    }

    // ---- 第一次运行：只有实时通道（sessionQuery 不可用）
    const first = createHarness()
    apply(first.ctx, { backfillWaitMs: 1 })
    await settle()
    assert.equal(first.rpcChannel(), '/cost-meter')
    assert.equal(first.intervalMs(), 3_600_000)

    const liveSession = { id: 'session-live', header: { origin: 'user' } }
    first.emit('session/event', liveSession, headerEvent(1))
    first.emit(
      'session/event',
      liveSession,
      messageEvent(2, { inputTokens: 500_000, outputTokens: 1_000_000, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    )

    let snapshot = await first.call('snapshot')
    assert.equal(snapshot.total.requests, 1)
    // 忙时：0.5M 未命中输入 × ¥2/M + 1M 输出 × ¥8/M = 1 + 8 = ¥9
    assert.equal(snapshot.total.cny, 9)
    assert.equal(snapshot.total.peak.cny, 9)
    assert.equal(snapshot.total.offPeak.cny, 0)
    assert.equal(snapshot.today.cny, 9)
    assert.equal(snapshot.sessions.live.cny, 9, '会话 id 应归一化掉 session- 前缀')
    assert.equal(snapshot.date, '2026-09-29')
    assert.equal(snapshot.currency, 'CNY')
    // period 描述的是“此刻”的时段，不能用事件时刻断言；这里校验它确实按规则算出来，
    // 且下次切换时刻在未来（两条都与运行时刻无关）。
    assert.equal(snapshot.period.peak, isPeak(snapshot.now, resolveConfig({})), '当前时段应按规则计算')
    assert.match(snapshot.period.label, /^(忙时|闲时)$/)
    assert.ok(snapshot.period.nextChangeAt > snapshot.now, '下次切换时刻应在未来')

    // 非会话调用（实验脚本）：只走 llm/stream。它按**调用时刻**计价，
    // 所以期望值要用同一个规则现算，不能写死忙时价。
    const liveRates = resolveConfig({})
    const sessionlessExpected = priceUsage(
      { model: 'deepseek-flash', cacheMissTokens: 1_000_000, at: Date.now() },
      liveRates,
    ).cny
    const stream = first.emit('llm/stream', { provider: 'deepseek-official', model: 'deepseek-flash' }, () => (async function* () {
      yield { type: 'text-delta', text: 'hi' }
      yield { type: 'usage', usage: { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 } }
    })())[0]
    for await (const chunk of stream) void chunk

    snapshot = await first.call('snapshot')
    assert.equal(snapshot.sessionless.requests, 1)
    assert.equal(snapshot.sessionless.cny, sessionlessExpected)
    assert.equal(snapshot.total.cny, 9 + sessionlessExpected)

    const unknown = await first.callRaw('nope')
    assert.equal(unknown.ok, false)
    assert.equal(unknown.error.code, 'unknown_endpoint')
    first.dispose()

    // 落盘：账本文件已写入
    const file = join(home, 'storages', 'cost-meter', 'ledger.json')
    const persisted = JSON.parse(readFileSync(file, 'utf8'))
    assert.equal(persisted.totals.cnyMicro, Math.round((9 + sessionlessExpected) * 1e6))
    assert.equal(persisted.highWater.live, 2, '水位线按归一化后的会话键保存')

    // ---- 第二次运行：同一进程账本 + 历史回填补齐旧会话
    const second = createHarness({ sessionQuery })
    apply(second.ctx, {})
    await settle()

    const after = await second.call('snapshot')
    assert.equal(after.backfill.done, true)
    assert.equal(after.backfill.sessions, 1)
    assert.equal(after.backfill.entries, 2)
    assert.equal(after.total.requests, 4, '1 次会话实时 + 1 次非会话实验调用 + 2 次历史回填')
    assert.equal(after.total.cny, 9 + sessionlessExpected + 3, '历史两条：忙时 ¥2 + 闲时 ¥1')
    assert.equal(after.sessionless.cny, sessionlessExpected, '非会话调用应保留在累计里')
    assert.equal(after.sessions.old.cny, 3)
    assert.equal(after.sessions.old.origin, 'user')

    // 实时重放同一批事件（模拟回填之后再次收到重复事件）不应重复计费
    second.emit('session/event', { id: 'session-old', header: {} }, historyEvents[1])
    const replayed = await second.call('snapshot')
    assert.equal(replayed.total.cny, after.total.cny)
    second.dispose()
  })
})

test('回填先于实时：回填期间的实时事件被缓冲后按序补记', async () => {
  await withTempHome(async () => {
    const historyEvents = [
      headerEvent(1),
      messageEvent(2, { inputTokens: 1_000_000, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0 }),
    ]
    let release
    const gate = new Promise((resolve) => {
      release = resolve
    })
    const sessionQuery = {
      async listSessions() {
        return [{ header: { id: 'session-x', origin: 'user' } }]
      },
      async readSession() {
        await gate
        return { session: { id: 'session-x', origin: 'user' }, events: historyEvents }
      },
    }

    const harness = createHarness({ sessionQuery })
    apply(harness.ctx, { backfillWaitMs: 1 })

    // 回填尚未完成时来了实时事件（seq 更高）
    const liveSession = { id: 'session-x', header: { origin: 'user' } }
    const liveEvent = messageEvent(10, { inputTokens: 1_000_000, outputTokens: 0 }, '2026-09-29T10:05:00', 2)
    harness.emit('session/event', liveSession, liveEvent)

    release()
    await settle()

    const snapshot = await harness.call('snapshot')
    assert.equal(snapshot.total.requests, 2, '历史 1 次 + 缓冲的实时 1 次')
    assert.equal(snapshot.total.cny, 4)
    assert.equal(snapshot.sessions.x.cny, 4)
    harness.dispose()
  })
})

test('HTTP 快照路由：同源 GET 返回 JSON，跨站/非回环/非法方法被拒', async () => {
  await withTempHome(async (home) => {
    const harness = createHarness()
    apply(harness.ctx, { backfillWaitMs: 1 })
    await settle()
    assert.ok(harness.hasRoute('/cost-meter/snapshot'))

    const session = { id: 'session-http', header: { origin: 'user' } }
    harness.emit('session/event', session, headerEvent(1))
    harness.emit('session/event', session, messageEvent(2, { inputTokens: 1_000_000, outputTokens: 0 }))

    const ok = await harness.http('GET')
    assert.equal(ok.status, 200)
    assert.equal(ok.headers['cache-control'], 'no-store')
    const value = JSON.parse(ok.body)
    assert.equal(value.total.cny, 2)
    assert.equal(value.sessions.http.cny, 2, 'HTTP 通道读到的会话键同样已归一化')

    // 客户端上报（用于排障）应写进诊断文件
    const reported = await harness.http('POST', { body: { event: 'poll-failed', error: 'http 405' } })
    assert.equal(reported.status, 200)
    const diagnostics = JSON.parse(readFileSync(join(home, 'storages', 'cost-meter', 'diagnostics.json'), 'utf8'))
    assert.equal(diagnostics.lastClientReport.error, 'http 405')
    assert.equal(diagnostics.httpRequests >= 2, true)
    assert.equal(diagnostics.rpcRegistered, true)
    assert.equal(diagnostics.httpRegistered, true)

    // 跨站 / DNS rebinding / 非法方法
    assert.equal((await harness.http('GET', { secFetchSite: 'cross-site' })).status, 403)
    assert.equal((await harness.http('GET', { origin: 'http://evil.example' })).status, 403)
    assert.equal((await harness.http('GET', { host: 'evil.example:19387' })).status, 403)
    assert.equal((await harness.http('DELETE')).status, 405)
    assert.equal((await harness.http('GET', { host: 'localhost:19387' })).status, 200)
    harness.dispose()
  })
})

test('账本迁移：旧的 session- 前缀键并入归一化键且不丢数据', async () => {
  await withTempHome(async (home) => {
    const dir = join(home, 'storages', 'cost-meter')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    // 模拟老账本：主会话用带前缀键，时间取当前时刻（否则会被快照的近 7 天过滤掉）
    const now = Date.now()
    const legacy = {
      version: 1,
      createdAt: 1,
      updatedAt: 2,
      backfilledAt: null,
      pricesFingerprint: null,
      totals: bucket(1, 2_000_000),
      days: { '2026-09-29': bucket(1, 2_000_000) },
      models: {},
      sessions: { 'session-zzz': { ...bucket(1, 2_000_000), firstAt: now - 60_000, lastAt: now, origin: 'user' } },
      highWater: { 'session-zzz': 42 },
      sessionless: bucket(0, 0),
    }
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify(legacy))

    const harness = createHarness()
    apply(harness.ctx, { backfillWaitMs: 1 })
    await settle()
    const snapshot = await harness.call('snapshot')
    assert.equal(snapshot.sessions.zzz.cny, 2, '迁移后应按裸 id 查得到')
    assert.equal(snapshot.sessions['session-zzz'], undefined)
    assert.equal(snapshot.total.cny, 2)

    // 水位线也跟着迁移：同一 seq 的历史事件不应再被计一次
    harness.dispose()
    const migrated = JSON.parse(readFileSync(join(dir, 'ledger.json'), 'utf8'))
    assert.equal(migrated.highWater.zzz, 42)
    assert.equal(migrated.highWater['session-zzz'], undefined)
  })
})

test('sessionQuery 迟迟不就绪：等待窗口超时后放行实时记账并留下说明', async () => {
  await withTempHome(async () => {
    const harness = createHarness()
    apply(harness.ctx, { backfillWaitMs: 5 })
    // 等待窗口内先来实时事件：应被缓冲，超时后按序补记而不丢
    const session = { id: 'session-late', header: { origin: 'user' } }
    harness.emit('session/event', session, headerEvent(1))
    harness.emit('session/event', session, messageEvent(2, { inputTokens: 1_000_000, outputTokens: 0 }))
    await settle()

    const snapshot = await harness.call('snapshot')
    assert.equal(snapshot.backfill.done, true)
    assert.match(snapshot.backfill.error ?? '', /sessionQuery/)
    assert.equal(snapshot.total.cny, 2, '缓冲的实时事件不能丢')
    assert.equal(snapshot.sessions.late.cny, 2)
    harness.dispose()
  })
})

test('账本版本不符时另存 .bak 并以空账本启动', async () => {
  await withTempHome(async (home) => {
    const dir = join(home, 'storages', 'cost-meter')
    const { mkdirSync, writeFileSync } = await import('node:fs')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'ledger.json'), JSON.stringify({ version: 999, totals: {} }))

    const harness = createHarness()
    apply(harness.ctx, { backfillWaitMs: 1 })
    await settle()
    const snapshot = await harness.call('snapshot')
    assert.equal(snapshot.total.cny, 0)
    assert.ok(readFileSync(join(dir, 'ledger.json.bak'), 'utf8').includes('999'))
    harness.dispose()
  })
})

test('配置：自定义价表与额外节假日生效', async () => {
  await withTempHome(async () => {
    // 把「今天」（北京时间）配成自定义假期：无论今天星期几，当天都应是闲时。
    const today = new Date(Date.now() + 8 * 3_600_000).toISOString().slice(0, 10)
    const harness = createHarness()
    apply(harness.ctx, {
      prices: { 'deepseek-flash': { output: 100 } },
      extraHolidays: [today],
      backfillWaitMs: 1,
    })
    await settle()

    const session = { id: 'session-cfg', header: {} }
    harness.emit('session/event', session, headerEvent(1))
    harness.emit('session/event', session, messageEvent(2, { inputTokens: 0, outputTokens: 1_000_000 }))

    const snapshot = await harness.call('snapshot')
    assert.equal(snapshot.date, today, '快照日期应为北京时间当天')
    assert.equal(snapshot.period.peak, false, '被配置为假期的当天应全天闲时')
    assert.equal(snapshot.total.cny, 50, '输出单价被覆盖为 100 且当天闲时 → 五折')
    assert.equal(snapshot.total.offPeak.cny, 50)
    assert.equal(snapshot.total.peak.cny, 0)
    assert.equal(snapshot.prices['deepseek-flash'].output, 100)
    harness.dispose()
  })
})
