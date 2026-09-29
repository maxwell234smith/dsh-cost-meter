/**
 * dsh-cost-meter 的浏览器半：在输入框下方的状态区显示
 * 「本次会话费用 · 今日费用 · 当前闲忙时段」，数据来自 Host 侧 /cost-meter 通道。
 *
 * 这是手写的 lazy-CJS bundle（DSH 宿主直接下发，无需构建步骤），
 * 依赖的平台种子模块只有 react。
 */
window.__ModuleLoader__.load({
	id: 'dsh-cost-meter',
	factory: (require) => {
		var module = { exports: {} }
		var exports = module.exports
		Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

		const React = require('react')

		// ------------------------------------------------------------------ 样式
		const CSS_ID = 'dsh-cost-meter/cost-meter.css'
		if (typeof document !== 'undefined' && document.querySelector(`style[data-plugin-css="${CSS_ID}"]`) === null) {
			const style = document.createElement('style')
			style.dataset.plugin = 'dsh-cost-meter'
			style.dataset.pluginCss = CSS_ID
			style.textContent = `
.cost-meter{display:inline-flex;align-items:center;gap:6px;pointer-events:auto;
  font-size:11px;line-height:1.6;color:var(--dsw-alias-label-tertiary,#8b8b8b);
  font-variant-numeric:tabular-nums;white-space:nowrap;user-select:none}
.cost-meter__period{border-radius:999px;padding:0 6px;font-size:10px;
  border:1px solid transparent}
.cost-meter__period--peak{color:var(--dsw-alias-state-warning-primary,#b7791f);
  background:rgba(183,121,31,.12);border-color:rgba(183,121,31,.28)}
.cost-meter__period--off{color:var(--dsw-alias-state-success-primary,#2f855a);
  background:rgba(47,133,90,.12);border-color:rgba(47,133,90,.28)}
.cost-meter__sep{opacity:.45}
.cost-meter__value{color:var(--dsw-alias-label-secondary,#c8c8c8)}
.cost-meter__amount{color:var(--dsw-alias-label-primary,#f0f0f0);font-weight:500}
.cost-meter__label{opacity:.8}
.cost-meter--muted .cost-meter__amount{color:var(--dsw-alias-label-tertiary,#8b8b8b);font-weight:400}
`
			document.head.appendChild(style)
		}

		// ------------------------------------------------------------------ 数据源
		/**
		 * 极简可订阅数据源，供 slots 的 hooks 注入面绑定。
		 * @param {object} initial 初始值。
		 * @returns {{ getSnapshot: () => object, subscribe: (fn: () => void) => () => void, set: (value: object) => void }} 数据源。
		 */
		function createSource(initial) {
			let value = initial
			const listeners = new Set()
			return {
				getSnapshot: () => value,
				subscribe: (listener) => {
					listeners.add(listener)
					return () => listeners.delete(listener)
				},
				set(next) {
					value = next
					for (const listener of [...listeners]) listener()
				},
			}
		}

		const costs = createSource({ status: 'loading' })

		// ------------------------------------------------------------------ 取数
		/** 轮询间隔（毫秒）。 */
		const POLL_MS = 3000

		/**
		 * 快照路由：以页面 origin 为根锚定，避免相对路径在不同页面路由下解析错位。
		 * @returns {string} 绝对 URL。
		 */
		function snapshotUrl() {
			const origin = typeof location !== 'undefined' && location.origin !== undefined && location.origin !== 'null'
				? location.origin
				: ''
			return `${origin}/cost-meter/snapshot`
		}

		/**
		 * 向宿主上报一次客户端状态，用于排障（失败静默）。
		 * @param {object} report 上报内容。
		 */
		function report(report) {
			try {
				const url = snapshotUrl()
				const body = JSON.stringify(report)
				if (typeof navigator !== 'undefined' && typeof navigator.sendBeacon === 'function') {
					navigator.sendBeacon(url, new Blob([body], { type: 'application/json' }))
					return
				}
				void fetch(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body, keepalive: true })
			} catch {
				/* 上报失败不影响界面 */
			}
		}

		/**
		 * 校验并取出快照对象：只有形状对得上才认，避免把 SPA 的 index.html 当成数据。
		 * @param {unknown} value 解析结果。
		 * @returns {object | undefined} 快照对象。
		 */
		function asSnapshot(value) {
			if (value === null || typeof value !== 'object') return undefined
			if (value.total === undefined || value.today === undefined || value.period === undefined) return undefined
			return value
		}

		/**
		 * 取一次快照，三级退让：
		 *   1. 宿主 HTTP 精确路由（绝对 URL，最稳）；
		 *   2. 直接 POST 框架 RPC 信封到同一路径（兼容尚未重启、只有 RPC 通道的宿主）；
		 *   3. 框架 RPC 客户端（相对 URL，页面带路径时可能失效）。
		 * @param {object | undefined} connection 客户端 connection 服务。
		 * @returns {Promise<object>} `{ ok: true, value }` 或 `{ ok: false, error }`。
		 */
		async function fetchSnapshot(connection) {
			const errors = []
			const url = snapshotUrl()

			try {
				const response = await fetch(url, {
					method: 'GET',
					headers: { accept: 'application/json' },
					credentials: 'same-origin',
					cache: 'no-store',
				})
				if (response.ok) {
					const value = asSnapshot(JSON.parse(await response.text()))
					if (value !== undefined) return { ok: true, value }
					errors.push('http 返回非快照')
				} else {
					errors.push(`http ${response.status}`)
				}
			} catch (error) {
				errors.push(`http ${String(error?.message ?? error)}`)
			}

			try {
				const rpcId = `cost-meter-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
				const response = await fetch(url, {
					method: 'POST',
					headers: { 'content-type': 'application/json' },
					credentials: 'same-origin',
					cache: 'no-store',
					body: JSON.stringify({ type: 'client-request', rpcId, method: 'snapshot', payload: {} }),
				})
				if (response.ok) {
					const envelope = await response.json()
					const value = asSnapshot(envelope?.result?.value)
					if (envelope?.rpcId === rpcId && envelope?.result?.ok === true && value !== undefined) {
						return { ok: true, value }
					}
					errors.push(`信封 ${String(envelope?.result?.error?.code ?? '无效')}`)
				} else {
					errors.push(`信封 http ${response.status}`)
				}
			} catch (error) {
				errors.push(`信封 ${String(error?.message ?? error)}`)
			}

			if (connection?.rpc?.call !== undefined) {
				try {
					const result = await connection.rpc.call('/cost-meter', 'snapshot', {})
					if (result?.ok === true) return { ok: true, value: result.value }
					errors.push(`rpc ${String(result?.error?.code ?? 'failed')}`)
				} catch (error) {
					errors.push(`rpc ${String(error?.message ?? error)}`)
				}
			}
			return { ok: false, error: errors.join(' | ') }
		}

		/**
		 * 归一化会话 id：`session-` 前缀在日志与界面之间并不总是一致，两侧都去掉。
		 * @param {unknown} value 原始 id。
		 * @returns {string | undefined} 归一化后的 id。
		 */
		function normalizeSessionId(value) {
			return typeof value === 'string' && value !== '' ? value.replace(/^session-/, '') : undefined
		}

		/**
		 * 在快照的会话表里查当前会话：原样 / 去前缀 / 加前缀都试一遍，
		 * 因为账本键的形态取决于宿主侧代码版本（`session-<uuid>` 或裸 `<uuid>`）。
		 * @param {object | undefined} sessions 快照里的 sessions。
		 * @param {unknown} sessionId 插槽给的会话 id。
		 * @returns {object | undefined} 该会话的读数。
		 */
		function sessionOf(sessions, sessionId) {
			if (sessions === null || sessions === undefined || typeof sessionId !== 'string') return undefined
			if (sessions[sessionId] !== undefined) return sessions[sessionId]
			const normalized = normalizeSessionId(sessionId)
			if (normalized === undefined) return undefined
			if (sessions[normalized] !== undefined) return sessions[normalized]
			const prefixed = `session-${normalized}`
			if (sessions[prefixed] !== undefined) return sessions[prefixed]
			for (const [key, value] of Object.entries(sessions)) {
				if (key.replace(/^session-/, '') === normalized) return value
			}
			return undefined
		}

		/**
		 * 人民币金额格式化：小额保留更多小数位，避免一路 0.00。
		 * @param {number} value 金额。
		 * @returns {string} 展示文本。
		 */
		function formatCny(value) {
			if (typeof value !== 'number' || !Number.isFinite(value)) return '—'
			const abs = Math.abs(value)
			if (abs === 0) return '0.00'
			if (abs < 0.01) return value.toFixed(4)
			if (abs < 1) return value.toFixed(3)
			return value.toFixed(2)
		}

		/**
		 * 北京时间的短时刻文本。
		 * @param {number | null | undefined} at epoch 毫秒。
		 * @returns {string} HH:MM（北京时间）或 '—'。
		 */
		function formatBeijingTime(at) {
			if (typeof at !== 'number' || !Number.isFinite(at)) return '—'
			const shifted = new Date(at + 8 * 3600 * 1000)
			return `${String(shifted.getUTCHours()).padStart(2, '0')}:${String(shifted.getUTCMinutes()).padStart(2, '0')}`
		}

		/**
		 * 组装悬浮提示：给出累计、闲忙拆分、token 与数据来源。
		 * @param {object} snapshot 快照。
		 * @param {object | undefined} session 当前会话的读数。
		 * @returns {string} 提示文本。
		 */
		function tooltipOf(snapshot, session) {
			if (snapshot?.status === 'error') return `读取费用失败：${snapshot.error}`
			if (snapshot?.status !== 'ready') return '正在读取费用…'
			const value = snapshot.value
			const lines = [
				`本次会话：¥${formatCny(session?.cny ?? 0)}（${session?.requests ?? 0} 次调用）`,
				`今日：¥${formatCny(value.today?.cny ?? 0)} — 忙时 ¥${formatCny(value.today?.peak?.cny ?? 0)} / 闲时 ¥${formatCny(value.today?.offPeak?.cny ?? 0)}`,
				`累计：¥${formatCny(value.total?.cny ?? 0)}（${value.total?.requests ?? 0} 次调用）— 忙时 ¥${formatCny(value.total?.peak?.cny ?? 0)} / 闲时 ¥${formatCny(value.total?.offPeak?.cny ?? 0)}`,
				`今日 token：命中 ${value.today?.tokens?.cacheHit ?? 0} · 未命中 ${value.today?.tokens?.cacheMiss ?? 0} · 输出 ${value.today?.tokens?.output ?? 0}`,
			]
			if ((value.sessionless?.requests ?? 0) > 0) {
				lines.push(`非会话调用（实验脚本）：¥${formatCny(value.sessionless.cny)}（${value.sessionless.requests} 次）`)
			}
			lines.push(
				value.period?.peak
					? `当前忙时（标准价），${formatBeijingTime(value.period.nextChangeAt)} 起转闲时（五折）`
					: `当前闲时（五折），${formatBeijingTime(value.period.nextChangeAt)} 起转忙时（标准价）`,
			)
			const backfill = value.backfill
			if (backfill !== undefined && backfill.done !== true) lines.push('历史回填进行中…')
			else if (backfill?.error !== undefined) lines.push(`历史回填：${backfill.error}`)
			lines.push(`统计范围：本机 DSH（${value.date}，北京时间计价）`)
			return lines.join('\n')
		}

		// ------------------------------------------------------------------ 组件
		/**
		 * 输入框下方状态区里的费用徽标。
		 * @param {{ useCost: (selector: (state: object) => unknown) => unknown, sessionId?: unknown }} props 插槽注入的 props。
		 * @returns {object} React 元素。
		 */
		function CostBadge(props) {
			const snapshot = props.useCost((state) => state)
			// 保留原始 id 做查表（宿主可能存原始键），归一化只用于兜底匹配。
			const sessionId = typeof props.sessionId === 'string' ? props.sessionId : undefined
			const session = snapshot?.status === 'ready' ? sessionOf(snapshot.value.sessions, sessionId) : undefined
			const ready = snapshot?.status === 'ready'
			const value = ready ? snapshot.value : undefined
			const failed = snapshot?.status === 'error'

			const period = value?.period
			const periodLabel = period === undefined ? '—' : period.peak ? '忙时' : '闲时'
			const periodClass = period === undefined
				? 'cost-meter__period'
				: `cost-meter__period cost-meter__period--${period.peak ? 'peak' : 'off'}`

			return React.createElement(
				'div',
				{
					className: `cost-meter${ready || failed ? '' : ' cost-meter--muted'}`,
					title: tooltipOf(snapshot, session),
				},
				React.createElement('span', { className: periodClass }, periodLabel),
				React.createElement(
					'span',
					null,
					React.createElement('span', { className: 'cost-meter__label' }, '本次 '),
					React.createElement('span', { className: 'cost-meter__amount' }, `¥${formatCny(session?.cny ?? 0)}`),
				),
				React.createElement('span', { className: 'cost-meter__sep' }, '·'),
				React.createElement(
					'span',
					null,
					React.createElement('span', { className: 'cost-meter__label' }, '今日 '),
					React.createElement(
						'span',
						{ className: 'cost-meter__value' },
						failed ? '读取失败' : `¥${formatCny(value?.today?.cny ?? 0)}`,
					),
				),
				React.createElement('span', { className: 'cost-meter__sep' }, '·'),
				React.createElement(
					'span',
					null,
					React.createElement('span', { className: 'cost-meter__label' }, '累计 '),
					React.createElement('span', { className: 'cost-meter__value' }, `¥${formatCny(value?.total?.cny ?? 0)}`),
				),
			)
		}

		// ------------------------------------------------------------------ 插件
		/** 只依赖 slots；connection 通过 ctx.inject 等待，避免拖垮整个界面的启动。 */
		const inject = ['slots']

		/**
		 * 注册徽标并开始轮询 Host 快照。
		 * @param {object} ctx 客户端 cordis 上下文。
		 */
		function apply(ctx) {
			ctx.slots.inject('conversation.composer.dock', () =>
				ctx.slots.register(
					{
						name: 'conversation.composer.dock',
						id: 'cost-meter',
						order: 1,
						label: 'API 费用',
						inject: () => ({ hooks: { cost: costs } }),
					},
					CostBadge,
				),
			)

			// connection 是可选的（只用它做 RPC 兜底）；缺失时 HTTP 路由仍然工作。
			let connection
			ctx.inject(['connection'], (connectionCtx) => {
				connection = connectionCtx.connection
			})

			let stopped = false
			let lastError

			/** 拉取一次快照。 */
			async function poll() {
				if (stopped) return
				const result = await fetchSnapshot(connection)
				if (stopped) return
				if (result.ok === true) {
					if (lastError !== undefined) {
						report({ event: 'recovered', at: Date.now(), source: 'poll' })
						lastError = undefined
					}
					costs.set({ status: 'ready', value: result.value })
					return
				}
				if (result.error !== lastError) {
					lastError = result.error
					report({ event: 'poll-failed', at: Date.now(), error: result.error })
				}
				costs.set({ status: 'error', error: result.error })
			}

			void poll()
			report({ event: 'loaded', at: Date.now(), url: snapshotUrl() })

			const timer = setInterval(() => {
				if (typeof document === 'undefined' || document.hidden !== true) void poll()
			}, POLL_MS)

			ctx.effect(
				() => () => {
					stopped = true
					clearInterval(timer)
				},
				'cost-meter: 轮询',
			)
		}

		exports.apply = apply
		exports.inject = inject
		return module.exports
	},
})
