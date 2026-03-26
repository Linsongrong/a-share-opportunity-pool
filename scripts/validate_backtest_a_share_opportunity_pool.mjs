#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import path from "node:path";
import { BT_PATHS, runBacktest } from "./backtest_a_share_opportunity_pool.mjs";
import { PATHS, loadConfig, runScan } from "./a_share_opportunity_pool.mjs";

function assert(condition, message) {
  if (!condition) {
    throw new Error(message);
  }
}

async function fileExists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

function assertReplayPoolRules(result, config, label) {
  for (const signal of result.dailySignals) {
    assert(
      signal.core.every(
        (candidate) =>
          candidate.totalScore >= config.thresholds.coreScore &&
          candidate.scores.riskDeduction <= config.thresholds.maxRiskForCore &&
          candidate.raw?.riskVeto !== true
      ),
      `${label} 核心池包含不满足 core 阈值或 veto 规则的标的。`
    );
    assert(
      signal.watch.every(
        (candidate) => candidate.totalScore >= config.thresholds.watchScore && candidate.raw?.riskVeto !== true
      ),
      `${label} 观察池包含不满足 watch 阈值或 veto 规则的标的。`
    );
  }
}

async function validateSmokeBacktest() {
  const config = await loadConfig();
  const result = await runBacktest({
    days: 20,
    maxUniverse: 15
  });

  const summaryPath = path.join(BT_PATHS.dataDir, "summary.json");
  const eventsPath = path.join(BT_PATHS.dataDir, "events.json");
  const portfolioPath = path.join(BT_PATHS.dataDir, "portfolio.json");
  const reportPath = path.join(BT_PATHS.reportsDir, `${new Date().toISOString().slice(0, 10)}-backtest.md`);

  assert(await fileExists(summaryPath), "smoke backtest did not create summary.json");
  assert(await fileExists(eventsPath), "smoke backtest did not create events.json");
  assert(await fileExists(portfolioPath), "smoke backtest did not create portfolio.json");
  assert(await fileExists(reportPath), "smoke backtest did not create Markdown report");

  const events = await readJson(eventsPath);
  const portfolio = await readJson(portfolioPath);

  assert(events.some((event) => event.entryMode === "same_close"), "smoke backtest missing same_close events");
  assert(events.some((event) => event.entryMode === "next_open"), "smoke backtest missing next_open events");
  assert(events.some((event) => event.holdingDays === 1), "smoke backtest missing 1-day events");
  assert(events.some((event) => event.holdingDays === 3), "smoke backtest missing 3-day events");
  assert(events.some((event) => event.holdingDays === 5), "smoke backtest missing 5-day events");
  assert(events.every((event) => "excessReturn_hs300" in event), "smoke backtest missing HS300 excess return");
  assert(events.every((event) => "excessReturn_zz500" in event), "smoke backtest missing ZZ500 excess return");
  assert(events.every((event) => "netReturn" in event), "smoke backtest missing netReturn");
  assert(events.every((event) => "netExcessReturn_hs300" in event), "smoke backtest missing net HS300 excess return");
  assert(events.every((event) => "totalCostRmb" in event), "smoke backtest missing totalCostRmb");
  assert("core_h1_same_close" in portfolio, "smoke backtest missing core_h1_same_close portfolio");
  assert("core_h1_next_open" in portfolio, "smoke backtest missing core_h1_next_open portfolio");
  assert("netCumulativeReturn" in portfolio.core_h1_same_close, "smoke backtest missing net portfolio metrics");
  assertReplayPoolRules(result, config, "smoke backtest");

  return result.metadata;
}

async function validateFullBacktest() {
  const config = await loadConfig();
  const result = await runBacktest({
    days: 252,
    maxUniverse: 25
  });

  const summaryPath = path.join(BT_PATHS.dataDir, "summary.json");
  const summary = await readJson(summaryPath);

  assert(summary.metadata.days === 252, "full backtest did not run 252 trading days");
  assert(summary.metadata.universeCount > 0, "full backtest has empty universe");
  assert(Object.keys(summary.eventStudy).length > 0, "full backtest missing event summaries");
  assert(Object.keys(summary.portfolio).length > 0, "full backtest missing portfolio summaries");
  assert(summary.metadata.transactionCosts.enabled === true, "full backtest did not enable transaction costs");
  assert(summary.eventStudy.core_same_close_h5.averageNetReturn <= summary.eventStudy.core_same_close_h5.averageReturn, "net event return should not exceed gross return");
  assert(summary.portfolio.core_h5_same_close.netCumulativeReturn <= summary.portfolio.core_h5_same_close.cumulativeReturn, "net portfolio return should not exceed gross return");
  assertReplayPoolRules(result, config, "full backtest");

  return result.metadata;
}

async function validateLiveArchive() {
  const { result } = await runScan({
    mode: "live",
    stateKey: `backtest-archive-check-${Date.now()}`,
    coreSize: 3,
    watchSize: 5
  });
  const archivePath = path.join(PATHS.archiveLiveDir, `${result.meta.marketDate}.json`);
  assert(await fileExists(archivePath), "live scan did not create archive snapshot");
}

async function main() {
  const smoke = await validateSmokeBacktest();
  const full = await validateFullBacktest();
  await validateLiveArchive();

  console.log(
    JSON.stringify(
      {
        ok: true,
        smoke,
        full
      },
      null,
      2
    )
  );
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
