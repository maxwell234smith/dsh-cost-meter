/**
 * dsh-cost-meter 的 Host 侧实现。
 *
 * 记账来源（两条互补的通道，互不重复计费）：
 *   1. `session/event`：会话内每一次模型调用的权威用量（`assistant/message` 的 usage），
 *      以 (sessionId, seq) 为幂等键——因此历史回填与实时记账可以安全地重复执行。
 *   2. `llm/stream`：只统计**不属于任何会话**的调用（插件直接调 `ctx.llm.stream()` 做实验），
 *      这类调用不落盘、无法回填，只能实时记账。
 *
 * 持久化：`$DSH_HOME/storages/cost-meter/ledger.json`，原子写入（临时文件 + rename），
 * 变更后去抖保存，卸载时立即落盘。
 *
 * @module dsh-cost-meter/plugin
 */

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'

import { createFold } from './fold.js'
import {
  applyEntry,
  createLedger,
  LEDGER_VERSION,
  normalizeSessionKeys,
  pruneSessions,
  readBucket,
} from './ledger.js'
import { beijingMoment, isPeak, nextPeriodChange, OFF_PEAK_FACTOR, priceUsage } from './pricing.js'
import { resolveConfig } from './rates.js'

/** 插件名（cordis 依赖注入与排障时显示）。 */
export const name = 'dsh-cost-meter'

/** 依赖的服务：不声明必需项，缺失的服务按可选处理，避免插件卡在 pending。 */
export const inject = []

/** Host 侧代码版本标记：改代码时递增，便于确认宿主是否加载了新代码。 */
const CODE_REVISION = 3

/** 从 package.json 读取版本号，避免两处手写不一致。 */
const VERSION = (() => {
  try {
    return JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')).version
  } catch {
    return 'unknown'
  }
})()

/** 默认配置。 */
const DEFAULTS = {
  /** 账本保存位置；相对路径按 $DSH_HOME 解析。 */
  ledgerPath: 'storages/cost-meter/ledger.json',
  /** 浏览器取数路由。 */
  httpPath: '/cost-meter/snapshot',
  /** 变更后延迟落盘的毫秒数。 */
  saveDebounceMs: 1500,
  /** 会话明细保留天数与最大条数。 */
  sessionKeepDays: 90,
  sessionKeepMax: 60,
  /** 快照里返回的会话明细条数上限。 */
  snapshotSessionLimit: 60,
  /** 回填等待期间最多缓存多少条实时事件。 */
  liveBufferLimit: 20000,
  /** 是否在挂载时回填历史会话用量。 */
  backfill: true,
  /** 等待 sessionQuery 就绪的毫秒数；超时则跳过回填、直接放行实时记账。 */
  backfillWaitMs: 15000,
  /** 允许访问取数路由的额外 Host（默认只允许回环地址）。 */
  allowHosts: [],
}

/**
 * 归一化会话 id：DSH 里主会话是 `session-<uuid>`，子代理会话是裸 `<uuid>`，
 * 而界面侧给的是带前缀的品牌化 id。统一去掉 `session-` 前缀，
 * 让账本键与界面查表键一致（否则「本次会话」永远查不到）。
 * @param {unknown} value 原始会话 id。
 * @returns {string | undefined} 归一化后的会话 id。
 */
export function normalizeSessionId(value) {
  return typeof value === 'string' && value !== '' ? value.replace(/^session-/, '') : undefined
}

/**
 * 浏览器取数路由的守门检查。
 *
 * 宿主 webserver 本身不带认证（路由 owner 自负其责），因此这里自己做最小防护：
 *   1. 只接受 GET/HEAD/POST；
 *   2. 拒绝浏览器标记的跨站请求（sec-fetch-site: cross-site）；
 *   3. Origin 与 Host 必须同源（没有 Origin 的非浏览器请求按同源处理）；
 *   4. Host 必须是回环地址——防 DNS rebinding；需要在局域网访问时用 allowHosts 显式放行。
 *
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {string[]} allowHosts 额外允许的 Host（host 或 host:port）。
 * @returns {{ status: number, code: string } | undefined} 拒绝原因，undefined 表示放行。
 */
function sameOriginGuard(req, allowHosts) {
  const method = req.method ?? 'GET'
  if (method !== 'GET' && method !== 'HEAD' && method !== 'POST') return { status: 405, code: 'method_not_allowed' }
  if (String(req.headers['sec-fetch-site'] ?? '') === 'cross-site') return { status: 403, code: 'cross_site' }

  const host = String(req.headers.host ?? '')
  const origin = req.headers.origin
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    try {
      if (new URL(origin).host !== host) return { status: 403, code: 'origin_mismatch' }
    } catch {
      return { status: 403, code: 'origin_invalid' }
    }
  }

  const allowed = new Set(['127.0.0.1', 'localhost', '[::1]', '::1'])
  for (const entry of allowHosts ?? []) allowed.add(entry.toLowerCase())
  const bare = host.toLowerCase()
  const hostname = bare.startsWith('[') ? bare.slice(0, bare.indexOf(']') + 1) : bare.split(':')[0]
  if (!allowed.has(bare) && !allowed.has(hostname)) return { status: 403, code: 'host_not_allowed' }
  return undefined
}

/**
 * 读取并解析 JSON 请求体；超限或非法时返回 undefined，绝不抛出。
 * @param {import('node:http').IncomingMessage} req 请求。
 * @param {number} limit 字节上限。
 * @returns {Promise<unknown | undefined>} 解析结果。
 */
async function readJsonBody(req, limit) {
  try {
    const chunks = []
    let size = 0
    for await (const chunk of req) {
      size += chunk.length
      if (size > limit) return undefined
      chunks.push(chunk)
    }
    if (size === 0) return undefined
    return JSON.parse(Buffer.concat(chunks).toString('utf8'))
  } catch {
    return undefined
  }
}

/**
 * 解析插件配置。
 * @param {object} [config] cordis 配置片段。
 * @returns {typeof DEFAULTS & object} 完整配置。
 */
function resolveOptions(config) {
  return { ...DEFAULTS, ...(config ?? {}) }
}

/**
 * 求 DSH 的家目录。
 * @returns {string} 绝对路径。
 */
function dshHome() {
  const home = process.env.DSH_HOME
  return typeof home === 'string' && home !== '' ? home : join(homedir(), '.dsh')
}

/**
 * 挂载 Host 侧的费用记账插件。
 * @param {object} ctx cordis 上下文。
 * @param {object} [config] 插件配置。
 */
export function apply(ctx, config) {
  const options = resolveOptions(config)
  const resolved = resolveConfig(config ?? {})
  const ledgerFile = join(dshHome(), options.ledgerPath)

  const loaded = loadLedger(ledgerFile)
  let ledger = loaded.ledger
  /** @type {Map<string, ReturnType<typeof createFold>>} */
  const folds = new Map()
  /** @type {{ sessions: number, entries: number, at: number | null, done: boolean, error?: string }} */
  const backfillState = { sessions: 0, entries: 0, at: null, done: false }
  let ready = !options.backfill
  /** @type {Array<[object, object]>} */
  let liveBuffer = []
  let saveTimer
  let dirty = false

  /** 诊断文件：出问题时先看它，避免「界面读不到数」时只能靠猜。 */
  const diagnosticsFile = join(dirname(ledgerFile), 'diagnostics.json')
  const diagnostics = {
    plugin: 'dsh-cost-meter',
    version: VERSION,
    codeRevision: CODE_REVISION,
    startedAt: Date.now(),
    pid: process.pid,
    ledgerFile,
    httpPath: options.httpPath,
    rpcRegistered: false,
    httpRegistered: false,
    rpcCalls: 0,
    httpRequests: 0,
    lastHttpAt: null,
    lastHttpMethod: null,
    lastHttpError: null,
    lastClientReport: null,
    lastClientReportAt: null,
    backfill: null,
  }

  /** 写入诊断文件（失败不影响运行）。 */
  function saveDiagnostics() {
    try {
      mkdirSync(dirname(diagnosticsFile), { recursive: true })
      diagnostics.backfill = { ...backfillState }
      const temporary = `${diagnosticsFile}.tmp`
      writeFileSync(temporary, `${JSON.stringify(diagnostics, null, 2)}\n`, 'utf8')
      renameSync(temporary, diagnosticsFile)
    } catch {
      /* 诊断写不进去就算了 */
    }
  }

  /** 轮询是每 3 秒一次，诊断文件不必跟着写这么勤：最多 20 秒落一次。 */
  let diagnosticsThrottle
  function scheduleDiagnostics() {
    if (diagnosticsThrottle !== undefined) return
    diagnosticsThrottle = setTimeout(() => {
      diagnosticsThrottle = undefined
      saveDiagnostics()
    }, 20_000)
    diagnosticsThrottle.unref?.()
  }

  // ---------------------------------------------------------------- 持久化

  /** 立即把账本写入磁盘（原子替换）。 */
  function saveNow() {
    if (!dirty) return
    clearTimeout(saveTimer)
    dirty = false
    try {
      mkdirSync(dirname(ledgerFile), { recursive: true })
      const temporary = `${ledgerFile}.tmp`
      writeFileSync(temporary, `${JSON.stringify(ledger)}\n`, 'utf8')
      renameSync(temporary, ledgerFile)
    } catch (error) {
      ctx.logger?.warn?.(`cost-meter: 账本保存失败：${String(error)}`)
    }
  }

  /** 去抖保存。 */
  function scheduleSave() {
    dirty = true
    clearTimeout(saveTimer)
    saveTimer = setTimeout(saveNow, options.saveDebounceMs)
    saveTimer.unref?.()
  }

  ctx.effect(() => () => {
    for (const fold of folds.values()) for (const entry of fold.flush()) record(entry)
    saveNow()
  }, 'cost-meter: 落盘')

  // ---------------------------------------------------------------- 记账

  /**
   * 把一条已计价条目写入账本。任何异常都只记录日志，绝不影响调用方。
   * @param {object} entry 折叠器产出的条目。
   * @returns {boolean} 是否真正记账。
   */
  function record(entry) {
    if (entry === undefined || entry === null) return false
    try {
      const result = applyEntry(ledger, entry)
      if (!result.applied) {
        if (result.state === 'stale') {
          ctx.logger?.warn?.(
            `cost-meter: 会话 ${String(entry.sessionId)} 的事件 seq=${String(entry.seq)} 早于水位线，已跳过（回填应先于实时记账）`,
          )
        }
        return false
      }
      ledger = result.ledger
      scheduleSave()
      return true
    } catch (error) {
      ctx.logger?.warn?.(`cost-meter: 记账失败（已忽略）：${String(error)}`)
      return false
    }
  }

  /**
   * 取得（或创建）某个会话的折叠器。
   * @param {string | undefined} sessionId 会话 id。
   * @param {string | null} origin 会话来源。
   * @returns {ReturnType<typeof createFold>} 折叠器。
   */
  function foldFor(sessionId, origin) {
    const key = sessionId ?? '<anonymous>'
    let fold = folds.get(key)
    if (fold === undefined) {
      fold = createFold({ config: resolved, sessionId, origin })
      folds.set(key, fold)
    }
    return fold
  }
  /**
   * 处理一条实时会话事件。
   * @param {object} session 会话对象。
   * @param {object} event 会话事件。
   */
  function applyLive(session, event) {
    try {
      const sessionId = normalizeSessionId(session?.id ?? session?.header?.id)
      const origin = session?.header?.origin ?? session?.origin ?? null
      record(foldFor(sessionId, origin).push(event))
    } catch (error) {
      // 会计失败绝不能影响会话本身。
      ctx.logger?.warn?.(`cost-meter: 处理会话事件失败（已忽略）：${String(error)}`)
    }
  }

  ctx.on('session/event', (session, event) => {
    if (!ready) {
      if (liveBuffer.length < options.liveBufferLimit) {
        liveBuffer.push([session, event])
        return
      }
      ctx.logger?.warn?.('cost-meter: 回填期间实时事件超出缓冲上限，改为立即记账（历史回填可能不完整）')
      ready = true
    }
    applyLive(session, event)
  })

  // 不属于任何会话的直接调用：只能实时记账（不落盘，无从回填）。
  ctx.on('llm/stream', (request, next) => {
    if (request?.sessionId !== undefined) return next()
    const inner = next()
    return (async function* recordSessionless() {
      let usage
      for await (const chunk of inner) {
        if (chunk?.type === 'usage' && chunk.usage !== undefined) usage = chunk.usage
        yield chunk
      }
      if (usage === undefined) return
      try {
        const now = Date.now()
        const priced = priceUsage(
          {
            model: request.model,
            cacheHitTokens: usage.cacheReadTokens,
            cacheMissTokens: usage.inputTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            outputTokens: usage.outputTokens,
            at: now,
          },
          resolved,
        )
        record({
          at: now,
          day: beijingMoment(now).date,
          origin: 'sessionless',
          samples: [
            {
              cny: priced.cny,
              peak: priced.peak,
              tokens: priced.tokens,
              model: priced.pricedModel,
              at: now,
              day: beijingMoment(now).date,
            },
          ],
        })
      } catch (error) {
        ctx.logger?.warn?.(`cost-meter: 非会话调用记账失败（已忽略）：${String(error)}`)
      }
    })()
  })

  // ---------------------------------------------------------------- 历史回填

  /**
   * 用 sessionQuery 读取全部历史会话日志并补记用量。
   * 必须在放行实时事件之前完成，否则旧 seq 会落在水位线之下。
   * @param {object} query sessionQuery 服务。
   * @returns {Promise<void>} 完成即表示历史已补齐。
   */
  async function backfill(query) {
    const records = await query.listSessions()
    for (const sessionRecord of records) {
      const sessionId = normalizeSessionId(sessionRecord?.header?.id ?? sessionRecord?.id)
      if (sessionId === undefined) continue
      let read
      try {
        read = await query.readSession(sessionRecord?.header?.id ?? sessionRecord?.id)
      } catch (error) {
        ctx.logger?.warn?.(`cost-meter: 读取会话 ${sessionId} 失败：${String(error)}`)
        continue
      }
      const origin = read?.session?.origin ?? sessionRecord?.header?.origin ?? null
      const fold = createFold({ config: resolved, sessionId, origin })
      for (const event of read?.events ?? []) {
        const entry = fold.push(event)
        if (entry !== undefined && record(entry)) backfillState.entries += (entry.samples ?? [entry]).length
      }
      for (const entry of fold.flush()) {
        if (record(entry)) backfillState.entries += (entry.samples ?? [entry]).length
      }
      backfillState.sessions += 1
    }
    backfillState.done = true
    backfillState.at = Date.now()
  }

  /** 回填结束后放行缓冲的实时事件。 */
  function finishBackfill() {
    ready = true
    const buffered = liveBuffer
    liveBuffer = []
    for (const [session, event] of buffered) applyLive(session, event)
    saveNow()
    saveDiagnostics()
  }

  if (options.backfill) {
    /** 跑一次回填，并把结果记进状态；异常只记录不抛出。 */
    const runBackfill = (query) => {
      void (async () => {
        try {
          await backfill(query)
        } catch (error) {
          ctx.logger?.warn?.(`cost-meter: 历史回填失败：${String(error)}`)
          backfillState.done = true
          backfillState.error = String(error)
        }
        finishBackfill()
      })()
    }

    const available = ctx.get('sessionQuery')
    if (available !== undefined) {
      runBackfill(available)
    } else {
      // 服务可能稍后就绪（例如插件热重载时服务图还没建齐）：
      // 等它出现再回填；期间实时事件先缓冲，保证回填仍先于实时记账。
      let started = false
      const deadline = setTimeout(() => {
        if (started) return
        ctx.logger?.warn?.('cost-meter: 等待 sessionQuery 超时，跳过历史回填（实时记账不受影响）')
        backfillState.done = true
        backfillState.error = 'sessionQuery 未在等待窗口内就绪，跳过历史回填'
        finishBackfill()
      }, options.backfillWaitMs)
      deadline.unref?.()
      ctx.effect(() => () => clearTimeout(deadline), 'cost-meter: 回填等待')
      ctx.inject(['sessionQuery'], (queryCtx) => {
        if (started) return
        started = true
        clearTimeout(deadline)
        runBackfill(queryCtx.sessionQuery)
      })
    }
  } else {
    ready = true
  }

  // ---------------------------------------------------------------- 对外快照

  /**
   * 生成给浏览器读取的快照。
   * @returns {object} 快照。
   */
  function snapshot() {
    const now = Date.now()
    const moment = beijingMoment(now)
    const peak = isPeak(now, resolved)

    const sessions = {}
    const recent = Object.entries(ledger.sessions)
      .filter(([, session]) => now - session.lastAt <= 7 * 86_400_000)
      .sort((a, b) => b[1].lastAt - a[1].lastAt)
      .slice(0, options.snapshotSessionLimit)
    for (const [id, session] of recent) {
      sessions[id] = { ...readBucket(session), lastAt: session.lastAt, firstAt: session.firstAt, origin: session.origin }
    }

    const models = {}
    for (const [id, bucket] of Object.entries(ledger.models)) models[id] = readBucket(bucket)

    return {
      currency: resolved.currency,
      offPeakFactor: OFF_PEAK_FACTOR,
      now,
      date: moment.date,
      period: {
        peak,
        label: peak ? '忙时' : '闲时',
        nextChangeAt: nextPeriodChange(now, resolved) ?? null,
      },
      today: readBucket(ledger.days[moment.date]),
      total: readBucket(ledger.totals),
      sessionless: readBucket(ledger.sessionless),
      sessions,
      models,
      updatedAt: ledger.updatedAt,
      backfill: { ...backfillState },
      prices: resolved.prices,
    }
  }

  // RPC 通道：备用通道（`rpc.handle` 内部要走调用方的 webServer 注入，所以两个服务一起注入）。
  ctx.inject(['connection', 'webServer'], (connectionCtx) => {
    try {
      connectionCtx.effect(
        () =>
          connectionCtx.connection.rpc.handle('/cost-meter', (endpoint) => {
            diagnostics.rpcCalls += 1
            if (endpoint === 'snapshot') return { ok: true, value: snapshot() }
            return { ok: false, error: { code: 'unknown_endpoint', message: `unknown endpoint ${endpoint}` } }
          }),
        'cost-meter: RPC 通道',
      )
      diagnostics.rpcRegistered = true
    } catch (error) {
      // 注册不上不影响使用：浏览器主通道是下面的 HTTP 路由。
      diagnostics.rpcError = String(error)
      ctx.logger?.warn?.(`cost-meter: RPC 通道注册失败（不影响 HTTP 路由）：${String(error)}`)
    }
    saveDiagnostics()
  })

  // 浏览器侧主通道：宿主自己的 HTTP 精确路由。
  // 比框架 RPC 通道更直接（不依赖相对 URL 解析与 /api 网关），
  // 代价是要自己守门：只允许同源页面、只允许 GET/HEAD/POST、默认只允许回环 Host。
  ctx.inject(['webServer'], (webCtx) => {
    try {
      webCtx.effect(
        () =>
          webCtx.webServer.register({
            kind: 'exact',
            path: options.httpPath,
            handler: async (req, res) => {
              const guard = sameOriginGuard(req, options.allowHosts)
              if (guard !== undefined) {
                diagnostics.lastHttpError = guard.code
                saveDiagnostics()
                res.writeHead(guard.status, { 'content-type': 'text/plain; charset=utf-8' })
                res.end(guard.code)
                return
              }
              diagnostics.httpRequests += 1
              diagnostics.lastHttpAt = Date.now()
              diagnostics.lastHttpMethod = req.method
              scheduleDiagnostics()
              if (req.method === 'GET' || req.method === 'HEAD') {
                const body = JSON.stringify(snapshot())
                res.writeHead(200, {
                  'content-type': 'application/json; charset=utf-8',
                  'cache-control': 'no-store',
                  'content-length': Buffer.byteLength(body),
                })
                res.end(req.method === 'HEAD' ? undefined : body)
                return
              }
              if (req.method === 'POST') {
                const report = await readJsonBody(req, 8 * 1024)
                if (report !== undefined) {
                  diagnostics.lastClientReport = report
                  diagnostics.lastClientReportAt = Date.now()
                }
                saveDiagnostics()
                const body = JSON.stringify({ ok: true })
                res.writeHead(200, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
                res.end(body)
                return
              }
              res.writeHead(405, { allow: 'GET, HEAD, POST' })
              res.end()
            },
          }),
        'cost-meter: 快照路由',
      )
      diagnostics.httpRegistered = true
    } catch (error) {
      diagnostics.httpError = String(error)
      ctx.logger?.warn?.(`cost-meter: 快照路由注册失败：${String(error)}`)
    }
    saveDiagnostics()
  })

  // 定期清理过期的会话明细，控制文件体积。
  ctx.inject(['timer'], (timerCtx) => {
    timerCtx.effect(
      () =>
        timerCtx.timer.interval(() => {
          const pruned = pruneSessions(ledger, {
            keepDays: options.sessionKeepDays,
            max: options.sessionKeepMax,
          })
          if (pruned !== ledger) {
            ledger = pruned
            scheduleSave()
          }
        }, 3_600_000),
      'cost-meter: 清理',
    )
  })

  ctx.logger?.debug?.(`cost-meter: 已挂载（代码版本 ${CODE_REVISION}），账本位于 ${ledgerFile}`)
  if (loaded.migrated) {
    dirty = true
    scheduleSave()
  }
  saveDiagnostics()
}

/**
 * 读取账本文件；缺失或版本不符时返回新账本（旧文件保留为 .bak）。
 * 会话键在这一步做一次归一化迁移，并把「是否迁移过」回报给调用方以便落盘。
 * @param {string} file 账本路径。
 * @returns {{ ledger: object, migrated: boolean }} 账本状态与迁移标记。
 */
function loadLedger(file) {
  let raw
  try {
    raw = readFileSync(file, 'utf8')
  } catch {
    return { ledger: createLedger({}), migrated: false }
  }
  try {
    const parsed = JSON.parse(raw)
    if (parsed?.version === LEDGER_VERSION && typeof parsed.totals === 'object') {
      const normalized = normalizeSessionKeys(parsed)
      return { ledger: normalized, migrated: normalized !== parsed }
    }
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      /* 备份失败不影响启动 */
    }
    return { ledger: createLedger({}), migrated: false }
  } catch {
    try {
      renameSync(file, `${file}.bak`)
    } catch {
      /* 同上 */
    }
    return { ledger: createLedger({}), migrated: false }
  }
}
