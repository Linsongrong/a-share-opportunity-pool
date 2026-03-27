# A-Share Opportunity Pool

一个给 OpenClaw 使用的 A 股机会池技能包，目标是开箱即用。

它不是单纯的提示词，而是一套完整的技能交付：

- `skills/a_share_opportunity_pool/SKILL.md`
- `scripts/a_share_opportunity_pool.mjs`
- `scripts/validate_a_share_opportunity_pool.mjs`
- `data/opportunity_pool/catalyst_overrides.json`
- `data/opportunity_pool/fixtures/sample_market_snapshot.json`

## 功能

- 从 A 股候选里生成核心池、观察池、剔除池
- 使用四维评分：
  - 基本面
  - 技术面
  - 资金面
  - 消息面
- 独立进行风险扣分和一票否决
- 输出结构化 JSON 和可读 Markdown 报告
- 支持 `sample` 与 `live` 两种模式
- 零额外依赖，只需要 Node.js

## 快速开始

初始化或自检：

```powershell
node .\scripts\validate_a_share_opportunity_pool.mjs
```

这会把验证产物写到隔离目录，不会覆盖正式发布结果：

- `data/opportunity_pool/validation/<run-id>/latest.json`
- `reports/opportunity_pool/validation/<run-id>/<market-date>.md`

验证 live 模式：

```powershell
node .\scripts\validate_a_share_opportunity_pool.mjs --live
```

正式刷新机会池：

```powershell
node .\scripts\a_share_opportunity_pool.mjs scan --mode live
```

正式发布结果只来自 `scan --mode live`。

## 输出文件

- 正式发布：
  - `data/opportunity_pool/latest.json`
  - `reports/opportunity_pool/YYYY-MM-DD.md`
- validation 自检：
  - `data/opportunity_pool/validation/<run-id>/latest.json`
  - `reports/opportunity_pool/validation/<run-id>/<market-date>.md`

## 消息面增强

如果你已经人工核验了公告、政策或行业催化，可以把结果补进：

- `data/opportunity_pool/catalyst_overrides.json`

再重新执行扫描，消息面分数会带上这些覆盖信息。

## OpenClaw 使用

如果这个仓库就是你的 OpenClaw workspace，skill 可以直接被 agent 调用。

如果不是，把下面目录复制到你的 OpenClaw 工作区即可：

- `skills/a_share_opportunity_pool`
- `scripts`
- `data/opportunity_pool`

## 当前状态

这套技能已经通过两类验证：

- `sample` 闭环验证
- `live` 实盘数据闭环验证

默认 live 模式下，当前实现会基于公开可访问的数据源做候选筛选和打分；在没有额外付费数据接入时，部分字段会诚实标记为 `N/A`，不会伪造。

live 结果现在会额外输出：

- `meta.dataQuality`
- `meta.dataFreshness`
- `meta.fallbackSummary`

如果存在抓取告警、备用 provider 或 stale cache，报告头部会明确标记为 `degraded`。
## Backtest

Replay-lite backtest is available now.

Run:

```powershell
node .\scripts\backtest_a_share_opportunity_pool.mjs run
```

Validate:

```powershell
node .\scripts\validate_backtest_a_share_opportunity_pool.mjs
```

Outputs:

- `data/opportunity_pool/backtest/summary.json`
- `data/opportunity_pool/backtest/events.json`
- `data/opportunity_pool/backtest/portfolio.json`
- `reports/opportunity_pool/backtest/YYYY-MM-DD-backtest.md`

Notes:

- This is `replay-lite`, not strict point-in-time four-dimension backtesting
- `next_open` is the primary execution view
- `same_close` is kept only as an optimistic reference
- It evaluates `1/3/5` trading-day holding windows
- It compares absolute returns and excess returns versus HS300 and ZZ500
- It now reports both gross and net results after transaction costs
- Default cost model uses configurable broker commission plus transfer fee and sell-side stamp duty
- Default cost assumptions: commission `0.02%` each side with `5 RMB` minimum, transfer fee `0.001%`, sell-side stamp duty `0.05%`
- Replay-lite validates historically replayable technical/liquidity/risk signals only
- Current ROE, concept, and message fields remain labels and do not prove the live four-dimension total-score model

Latest replay-lite snapshot (`2026-03-26`, 252 trading days):

- `25` universe, core `h5`, `same_close`: gross `2.12%`, net `2.03%`
- `100` universe, core `h5`, `same_close`: gross `2.42%`, net `2.33%`
- `200` universe, core `h5`, `same_close`: gross `1.87%`, net `1.77%`
- `300` universe, core `h5`, `same_close`: gross `1.67%`, net `1.57%`
- `300` universe, core `h5`, rolling portfolio:
  - `next_open`: gross cumulative `95.15%`, net cumulative `86.18%`
  - `same_close`: gross cumulative `115.75%`, net cumulative `105.82%`

Interpretation:

- The replay-lite signal weakens as the universe expands from `100` to `300`
- Even when it stays positive, it should be read as directional evidence only
- These figures do not prove that the live four-dimension total-score strategy has been historically validated
