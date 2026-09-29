# dsh-cost-meter

实时统计**你自己**的 DeepSeek API 费用，并把结果显示在 DSH 界面输入框下方的状态区：

```
[闲时]  本次 ¥0.1234 · 今日 ¥8.6027 · 累计 ¥20.6143
```

- **只算你的**：统计范围是**本机这台 DSH 安装**的全部模型调用。别人在别的机器/别的工具上用同一个 API key 产生的费用，本机看不到、也不会被算进来；本机多开几个窗口也只会算一次。
- **跨全部会话**：不止当前对话——所有历史会话、子代理（subagent）、后台任务、会话标题生成、压缩（compaction）、联网搜索，以及插件直接调 `ctx.llm.stream()` 做实验的调用，都计入。
- **按闲时/忙时区分**：忙时按标准价，闲时按官方五折，逐次调用按**发生时刻**判定，不是按总计折算。
- **实时**：界面每 3 秒拉一次快照；Host 侧每完成一次模型调用就记账并落盘。

## 安装

```sh
# 从 GitHub 安装（推荐锁到 tag 或某个提交，见仓库 Releases）
dsh plugin --profile desktop add github:maxwell234smith/dsh-cost-meter#v0.1.0

# 本地开发：直接链接源码目录
dsh plugin --profile desktop add link:D:\path\to\dsh-cost-meter
```

也可以在 DSH 网页版 **侧边栏 → 插件 → 安装 bundle** 里填 `github:maxwell234smith/dsh-cost-meter`。
装完刷新一次页面即可生效（Host 半随 profile 热重载加载，浏览器半需要页面重新加载）。

零运行时依赖，无需构建步骤：`lib/client.js` 是手写的浏览器 bundle。

## 计费规则（与官方文档一致）

价格来源：<https://api-docs.deepseek.com/zh-cn/quick_start/pricing/>（2026-09-29 核对）

| 模型 | 缓存命中输入 | 缓存未命中输入 | 输出 |
| --- | --- | --- | --- |
| `deepseek-flash` | ¥0.04 | ¥2.00 | ¥8.00 |
| `deepseek-v4-pro` | ¥0.30 | ¥9.00 | ¥27.00 |

单位：人民币元 / 百万 token，**忙时价**。

- **忙时**：北京时间（UTC+8）周一至周五 09:00–12:00、14:00–18:00，且当天不是中国法定节假日。
- **闲时**：其余全部时段——含周末、法定节假日全天、以及 12:00–14:00 午休——价格 = 忙时价 × 0.5。
- 旧模型 id（`deepseek-v4-flash`、`deepseek-v4-flash-vision-exp`）按官方说明归一到 `deepseek-flash` 计价。
- 未登记的模型 id 回退按 `deepseek-flash` 价计费（可在配置里自行补价目）。
- 节假日数据：内置 2025、2026 年国务院办公厅公布的法定节假日（`src/holidays.js`）。2027 年通知尚未发布，届时补录即可。

### 关于「调休上班日」

官方文档的表述是「周一至周五（不含中国法定节假日）」，按字面含义，**调休上班的周末不算忙时**（本插件默认口径）。若你认为调休日应视作工作日，把配置 `makeupWorkdaysArePeak` 设为 `true` 即可。两种口径每年只差 5–6 天、每天至多 6 小时。

## 界面

- `[忙时]/[闲时]`：当前时段，颜色区分；悬浮提示会给出下次切换的具体时刻。
- `本次`：当前会话累计（会话 id 自动归一化，`session-` 前缀不影响匹配）。
- `今日`：北京时间当天累计。
- `累计`：本机历史总量（首次安装时会自动回填历史会话日志）。
- 悬浮到徽标上可看到：本次/今日/累计的**忙时与闲时拆分**、今日三桶 token、非会话实验调用、回填状态、统计口径。

徽标挂在插槽 `conversation.composer.dock`（与官方 token 统计同一条状态带）。想改成整屏常驻角标，把 `lib/client.js` 里的插槽名换成 `shell.overlay` 即可。

## 数据文件

```
$DSH_HOME/storages/cost-meter/ledger.json        # 账本
$DSH_HOME/storages/cost-meter/diagnostics.json   # 诊断（排障用）
```

（本机即 `C:\Users\yxyhh\.dsh\storages\cost-meter\`）

- 原子写入（临时文件 + rename），变更后 1.5 秒去抖落盘，插件卸载时立即落盘。
- **想清零重来**：停掉 DSH，删除 `ledger.json`，再启动即可（会自动重新回填历史）。
- 文件里金额以整数「微元」记账（1 元 = 1e6），避免浮点累加漂移。

## 浏览器怎么拿到数据

浏览器半**优先走宿主自己的 HTTP 精确路由** `GET /cost-meter/snapshot`（以页面 origin 为根锚定，
不受页面路由影响），失败时才退回框架 RPC 通道 `/cost-meter → snapshot`。

为什么不用 RPC 通道作主通道：DSH 里 `ctx.connection.rpc.call()` 用的是**相对 URL**，
当页面地址带路径（例如 `/session/xxx`）时会解析到 `/session/cost-meter/snapshot` 而 404，
表现为界面显示「读取失败」。HTTP 路由没有这个问题。

该路由由插件自己守门（宿主 webserver 本身不带认证）：

| 检查 | 行为 |
| --- | --- |
| 方法 | 只允许 `GET`/`HEAD`/`POST`，其余 405 |
| 跨站 | `sec-fetch-site: cross-site` → 403 |
| 同源 | `Origin` 与 `Host` 不一致 → 403 |
| Host | 默认只允许回环（`127.0.0.1`/`localhost`/`[::1]`），防 DNS rebinding；需要局域网访问时用 `allowHosts` 显式放行 |

`POST` 同一路径用于客户端上报排障信息（写入 `diagnostics.json`），不返回业务数据。

### 界面显示「读取失败」怎么查

1. 看 `diagnostics.json`：
   - `rpcRegistered` / `httpRegistered`：两条通道是否注册成功；
   - `httpRequests` / `lastHttpAt`：浏览器有没有真的打进来；
   - `lastHttpError`：被守门拒绝的原因（`cross_site`/`origin_mismatch`/`host_not_allowed`）；
   - `lastClientReport`：浏览器侧自己上报的失败原因（`poll-failed` 的 `error` 字段最有用）。
2. 悬浮到徽标上，提示里也会带上同样的错误文本。
3. 若 `httpRegistered` 为 false，多半是路由被别的插件占用（换 `httpPath`）或宿主没加载新代码（重启 DSH）。

## 配置

在 profile 的 `cordis.patch.yml` 里按 id 覆盖，例如：

```yaml
- id: dsh-cost-meter
  name: dsh-cost-meter
  config:
    # 覆盖/新增单价（人民币 / 百万 token，忙时价）
    prices:
      deepseek-flash:
        output: 8.0
      my-proxy-model:
        cacheHitInput: 0.1
        cacheMissInput: 3.0
        output: 12.0
    # 追加自定义放假日（公司假等），北京时间 YYYY-MM-DD
    extraHolidays:
      - 2026-12-31
    # 调休上班日是否按工作日计（默认 false）
    makeupWorkdaysArePeak: false
    # 账本路径，相对 $DSH_HOME
    ledgerPath: storages/cost-meter/ledger.json
    # 浏览器取数路由
    httpPath: /cost-meter/snapshot
    # 额外允许访问取数路由的 Host（默认只允许回环地址）
    allowHosts: []
    # 是否在挂载时回填历史会话（默认 true）
    backfill: true
```

其它可调项：`saveDebounceMs`、`sessionKeepDays`（默认 90）、`sessionKeepMax`（默认 60）、`snapshotSessionLimit`、`liveBufferLimit`。

## 安装 / 更新

```powershell
# 在 profile 目录里把本包链接进来（本机已执行）
node <DSH运行时>\node\bin\node.exe <DSH运行时>\pnpm\bin\pnpm.mjs add "link:D:\.Repo\harness\dsh-cost-meter"
```

再把包名加进 `profiles/<profile>/package.json` 的 `dsh.profile.bundles`。

- **首次安装生效时机**：Host 半会在 profile 热重载后立即加载（本机实测：装完账本文件随即生成并完成历史回填）。
- **改 `lib/client.js` 不需要刷新页面**：客户端 bundle 有 500ms 的 mtime 轮询会自动替换（失败会在「设置 → 插件」里显示并可重试）。
- **改 Host 半（`index.js`/`src/*.js`）请重启 DSH**：HMR 默认只热重载配置与 bundle 列表，模块根未开启（`root: []`）。本机观察到过一次宿主代码热重载，但不可依赖——**以 `diagnostics.json` 里的 `codeRevision` 为准**：它等于源码里的 `CODE_REVISION` 常量，才说明新代码已生效。
- 两条通道的注册情况也写在 `diagnostics.json`：`httpRegistered` 是主通道；`rpcRegistered` 是备用通道，在部分组合下注册不上（原因记在 `rpcError`），**不影响使用**。

## 精度与已知限制

- **会话 id 归一化**：DSH 里主会话 id 是 `session-<uuid>`、子代理会话是裸 `<uuid>`，界面侧给的是品牌化 id。账本统一去掉 `session-` 前缀存键（老账本会在启动时自动迁移并入），保证「本次会话」查得到。
- **重试**：同一 step 内被重试掉的尝试会与最终那次分别计费（与官方 `tokenUsage` 口径一致），并用用量指纹去重，避免同一次调用被算两遍。
- **缓存写入**（`cacheWriteTokens`）：DeepSeek 不单独计费，本插件按「缓存未命中输入」价并入输入桶。
- **图像 token**：官方未明确其计费桶，本插件按「未命中输入」计（`inputTokens` 已含图像 token）。
- **时刻判定**：用会话事件里的完成时刻（`time`）判定闲忙。官方未说明是按请求发起还是完成时刻，跨时段边界的长请求可能有极小偏差。
- **按会话明细**只保留最近 90 天 / 60 个会话，但**累计与按天数据不受影响**（水位线也始终保留，因此回填永不会重复计费）。
- **2027 年节假日**通知发布前，该年的工作日一律按「周一至周五」判定。
- **共用同一 key 的其他人**无法被区分：DeepSeek 平台只提供账号级账单，不提供按人/按 key 的官方接口。要做到服务端可分账，只能每人一把独立 key。

## 结构

```
dsh-cost-meter/
├── index.js            # Host 入口（转发到 src/plugin.js）
├── src/pricing.js      # 价表、闲忙判定、单次计价、下次切换时刻
├── src/holidays.js     # 2025/2026 法定节假日与调休数据
├── src/rates.js        # 配置解析（内置价表 + 用户覆盖）
├── src/fold.js         # 会话事件 → 已计价条目（含重试去重）
├── src/ledger.js       # 账本累加（幂等水位线、闲忙分桶、微元记账）
├── src/plugin.js       # cordis 插件：订阅、回填、持久化、RPC 快照
├── lib/client.js       # 浏览器半（手写 lazy-CJS bundle，无需构建）
├── cordis.patch.yml    # bundle 注册
└── test/               # node --test：47 项单元 + 集成测试
```

## 开发

```powershell
node --test        # 全部测试
```

测试覆盖：闲忙边界（09:00/12:00/14:00/18:00/周末/节假日/调休）、官方价表自检、别名归一、未知模型回退、账本幂等与纯净性、回填与实时的一致性、重启后不重复计费、配置覆盖、以及端到端的「事件 → 快照 → 落盘 → 重启回填」流程。

## License

MIT
