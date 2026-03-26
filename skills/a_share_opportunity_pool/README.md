# A 股机会池技能包

这不是单独一份提示词，而是一套可执行的 OpenClaw 技能包：

- `SKILL.md` 负责告诉 agent 什么时候运行、先跑什么、输出看哪里
- `scripts/a_share_opportunity_pool.mjs` 负责扫描、打分、生成报告
- `scripts/validate_a_share_opportunity_pool.mjs` 负责自检
- `data/opportunity_pool/catalyst_overrides.json` 负责补充你人工核验过的催化信息
- `data/opportunity_pool/latest.json` 和 `reports/opportunity_pool/*.md` 是运行产物
- `data/opportunity_pool/cache/` 负责保存行情、K线和慢变量缓存
- `data/opportunity_pool/state/` 负责保存历史分数状态

## 环境要求

- Node.js 22 或更高
- 能访问公开行情接口
- 不需要 Python
- 不需要额外 npm 包

## Provider 策略

这版已经内置降级链路，不再单点依赖新浪：

- 全市场快照：新浪主，东财备，最后回退到本地缓存
- 日线/K线：新浪主，腾讯备，东财再备，最后回退到本地缓存
- 行业/概念/ROE：新浪主，失败时优先使用本地缓存

默认缓存 TTL：

- universe：10 分钟
- technical：20 分钟
- profile：1440 分钟

如果 provider 被限流或临时抖动，脚本会继续跑，并在 `latest.json` 里写入：

- `meta.providersUsed`
- `meta.fallbackEvents`
- `meta.warnings`

## 快速开始

在 OpenClaw 工作区根目录运行：

```powershell
node .\scripts\validate_a_share_opportunity_pool.mjs
```

这会做三件事：

1. 初始化需要的目录和默认文件
2. 用内置样例数据跑一遍完整流程
3. 检查 `SKILL.md`、JSON 输出、Markdown 报告是否齐全

如果你还想验证 live 模式：

```powershell
node .\scripts\validate_a_share_opportunity_pool.mjs --live
```

## 日常刷新

```powershell
node .\scripts\a_share_opportunity_pool.mjs scan --mode live
```

常用参数：

- `--core-size 10`
- `--watch-size 20`
- `--shortlist-size 80`
- `--output data/opportunity_pool/latest.json`

## 人工补充催化

消息面里最可靠的部分往往来自公告、政策、交易所披露。这个技能包默认会用：

- 行业板块强度
- 龙头股相对强度
- 成交额和资金确认

如果你想把官方公告、政策催化也纳入消息面，可把你核验过的信息写进：

`data/opportunity_pool/catalyst_overrides.json`

格式如下：

```json
{
  "stock": {
    "300308": {
      "score": 8,
      "title": "2026-03-24 公司公告订单超预期",
      "summary": "最近公告验证景气延续。",
      "source": "https://www.cninfo.com.cn/",
      "asOf": "2026-03-24"
    }
  },
  "industry": {
    "通信设备": {
      "score": 5,
      "title": "2026-03-25 行业政策催化",
      "summary": "政策支持与招标节奏改善。",
      "source": "https://www.gov.cn/",
      "asOf": "2026-03-25"
    }
  }
}
```

写入后重新执行 `scan --mode live`，消息面分数会自动带上这些催化。

## 输出说明

- `data/opportunity_pool/latest.json`
  - 给 agent 和程序读取
- `reports/opportunity_pool/YYYY-MM-DD.md`
  - 给人直接阅读

JSON 里会包含：

- 四维得分
- 风险扣分
- 核心池 / 观察池 / 剔除
- previousScore / scoreChange / isNew / isDropped
- trendLabel / targetEntryRange / entryRangeStatus
- 为什么是现在
- 证据
- 风险
- 触发条件
- 失效条件
- 下次复核时间

## 评分边界

总分公式：

`基本面 30 + 技术面 20 + 资金面 15 + 消息面 35 - 风险扣分`

默认阈值：

- `>= 70` 且风险扣分 `<= 10`：核心机会池
- `64 - 69`：观察池
- `< 64`：不入池

行业集中度规则：

- 同一行业默认最多保留 2 只
- 第 2 只只有在与第 1 只分差不大且逻辑足够区分时才保留

一票否决：

- `ST / *ST / 退`
- 明显流动性不足
- 历史数据明显不足

## 设计取舍

为了保证开箱即用，这版 live 数据层采用了公开接口和零依赖脚本，因此：

- 基本面能稳定覆盖 `ROE / PE / PB / 流动性 / 市值`
- 技术面直接由日线计算
- 资金面以主力净流入、成交额、换手率为主
- 消息面默认来自板块热度和龙头确认
- 消息面会额外补充 `所属概念板块`，把题材热度作为辅助判断
- 北向和两融在零依赖模式下默认记为 `N/A`，不强行记 0 分

补充说明：

- `confidence` 只表示证据和数据质量，不参与核心池 / 观察池分类
- live 模式会在 `latest.json` 里输出初筛解释，说明为什么从全市场缩到 shortlist
- live 模式会优先用缓存降低新浪被 `456` 限流的概率

如果你后续愿意接入更强的数据源，这套脚本可以继续往里扩。
## Backtest

You can now run a replay-lite backtest:

```powershell
node .\scripts\backtest_a_share_opportunity_pool.mjs run
```

And validate it with:

```powershell
node .\scripts\validate_backtest_a_share_opportunity_pool.mjs
```

Default outputs:

- `data/opportunity_pool/backtest/summary.json`
- `data/opportunity_pool/backtest/events.json`
- `data/opportunity_pool/backtest/portfolio.json`
- `reports/opportunity_pool/backtest/YYYY-MM-DD-backtest.md`

Caveat:

- replay-lite uses only historically replayable price, volume, technical, and liquidity features for selection
- current ROE, concept, and message fields are retained as labels only and do not drive historical selection
- backtest outputs now include both gross and net results after transaction costs
- default transaction-cost assumptions are configurable in `skills/a_share_opportunity_pool/config/scoring.json`
- current defaults are commission `0.02%` each side with `5 RMB` minimum, transfer fee `0.001%`, and sell-side stamp duty `0.05%`

Latest replay-lite snapshot (`2026-03-26`, 252 trading days):

- `25` universe, core `h5`, `same_close`: gross `2.12%`, net `2.03%`
- `100` universe, core `h5`, `same_close`: gross `2.42%`, net `2.33%`
- `200` universe, core `h5`, `same_close`: gross `1.87%`, net `1.77%`
- `300` universe, core `h5`, `same_close`: gross `1.67%`, net `1.57%`
- `300` universe, core `h5`, rolling portfolio:
  - `same_close`: gross cumulative `115.75%`, net cumulative `105.82%`
  - `next_open`: gross cumulative `95.15%`, net cumulative `86.18%`

Interpretation:

- replay-lite signal quality weakens as the universe expands beyond `100`
- even after transaction costs, the `300` universe remains positive in this replay-lite setup
- treat this as a practical validation snapshot, not as strict PIT proof
