#!/usr/bin/env node

import { access, mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";
import { PATHS, ensureWorkspaceFiles, loadConfig, runScan, enforceIndustryConcentration } from "./a_share_opportunity_pool.mjs";

const __filename = fileURLToPath(import.meta.url);

const BT_PATHS = {
  dataDir: path.join(PATHS.root, "data", "opportunity_pool", "backtest"),
  cacheDir: path.join(PATHS.root, "data", "opportunity_pool", "backtest", "cache"),
  stockCacheDir: path.join(PATHS.root, "data", "opportunity_pool", "backtest", "cache", "stocks"),
  benchmarkCacheDir: path.join(PATHS.root, "data", "opportunity_pool", "backtest", "cache", "benchmarks"),
  reportsDir: path.join(PATHS.root, "reports", "opportunity_pool", "backtest")
};

const EASTMONEY_UNIVERSE_FIELDS = [
  "f2",
  "f3",
  "f5",
  "f6",
  "f8",
  "f9",
  "f12",
  "f14",
  "f20",
  "f21",
  "f23",
  "f24",
  "f25",
  "f37",
  "f62",
  "f100"
].join(",");

function parseArgs(argv) {
  const positional = [];
  const flags = new Map();

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];

    if (!token.startsWith("--")) {
      positional.push(token);
      continue;
    }

    const [flagName, inlineValue] = token.split("=", 2);
    if (inlineValue !== undefined) {
      flags.set(flagName, inlineValue);
      continue;
    }

    const nextToken = argv[index + 1];
    if (!nextToken || nextToken.startsWith("--")) {
      flags.set(flagName, true);
      continue;
    }

    flags.set(flagName, nextToken);
    index += 1;
  }

  return { positional, flags };
}

function getFlag(flags, name, fallback = undefined) {
  return flags.has(name) ? flags.get(name) : fallback;
}

function toNumber(value, fallback = 0) {
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : fallback;
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

function scoreByThresholds(value, steps) {
  for (const step of steps) {
    if (step.test(value)) {
      return step.score;
    }
  }
  return 0;
}

function ratio(numerator, denominator) {
  if (!Number.isFinite(numerator) || !Number.isFinite(denominator) || denominator === 0) {
    return 0;
  }
  return numerator / denominator;
}

function exists(filePath) {
  return access(filePath).then(() => true).catch(() => false);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function ensureBacktestDirs() {
  await ensureWorkspaceFiles();
  await mkdir(BT_PATHS.dataDir, { recursive: true });
  await mkdir(BT_PATHS.cacheDir, { recursive: true });
  await mkdir(BT_PATHS.stockCacheDir, { recursive: true });
  await mkdir(BT_PATHS.benchmarkCacheDir, { recursive: true });
  await mkdir(BT_PATHS.reportsDir, { recursive: true });
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
          referer: "https://finance.qq.com/"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return response.json();
    } catch (error) {
      lastError = error;
      if (attempt < 3) {
        await new Promise((resolve) => setTimeout(resolve, attempt * 400));
      }
    }
  }

  throw lastError;
}

function nowIso() {
  return new Date().toISOString();
}

function symbolFromCode(code) {
  return /^(5|6|9|11)/.test(code) ? `sh${code}` : `sz${code}`;
}

function secidFromCode(code) {
  return /^(5|6|9|11)/.test(code) ? `1.${code}` : `0.${code}`;
}

function formatPercent(value) {
  return Number.isFinite(value) ? `${(value * 100).toFixed(2)}%` : "N/A";
}

function formatNumber(value, digits = 2) {
  return Number.isFinite(value) ? value.toFixed(digits) : "N/A";
}

function mean(values) {
  if (values.length === 0) {
    return 0;
  }
  return values.reduce((sum, value) => sum + value, 0) / values.length;
}

function median(values) {
  if (values.length === 0) {
    return 0;
  }
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function simpleMovingAverage(values, period) {
  if (values.length < period || period <= 0) {
    return null;
  }
  const slice = values.slice(values.length - period);
  return slice.reduce((sum, value) => sum + value, 0) / period;
}

function standardDeviation(values) {
  if (values.length === 0) {
    return 0;
  }
  const avg = mean(values);
  return Math.sqrt(mean(values.map((value) => (value - avg) ** 2)));
}

function ema(values, period) {
  if (values.length === 0) {
    return [];
  }

  const alpha = 2 / (period + 1);
  const result = [values[0]];
  for (let index = 1; index < values.length; index += 1) {
    result.push(values[index] * alpha + result[index - 1] * (1 - alpha));
  }
  return result;
}

function computeRsi(values, period = 14) {
  if (values.length <= period) {
    return null;
  }

  let gain = 0;
  let loss = 0;
  for (let index = 1; index <= period; index += 1) {
    const delta = values[index] - values[index - 1];
    gain += Math.max(delta, 0);
    loss += Math.max(-delta, 0);
  }

  let averageGain = gain / period;
  let averageLoss = loss / period;

  for (let index = period + 1; index < values.length; index += 1) {
    const delta = values[index] - values[index - 1];
    averageGain = (averageGain * (period - 1) + Math.max(delta, 0)) / period;
    averageLoss = (averageLoss * (period - 1) + Math.max(-delta, 0)) / period;
  }

  if (averageLoss === 0) {
    return 100;
  }

  const rs = averageGain / averageLoss;
  return 100 - 100 / (1 + rs);
}

function computeTechnicalFromCandles(candles) {
  const closes = candles.map((candle) => candle.close);
  const volumes = candles.map((candle) => candle.volumeHands);
  const latest = candles.at(-1);

  if (!latest) {
    return {
      close: 0,
      ma20: 0,
      ma60: 0,
      rsi14: null,
      macdHist: null,
      bollingerPos: null,
      drawdown20: null,
      change5: null,
      change20: null,
      change60: null,
      ma20Slope: null,
      volumeRatio5v20: null,
      upStreak: 0,
      candlesAvailable: 0
    };
  }

  const ma20 = simpleMovingAverage(closes, 20) ?? latest.close;
  const ma60 = simpleMovingAverage(closes, 60) ?? ma20;
  const recent20 = closes.slice(-20);
  const highest20 = recent20.length > 0 ? Math.max(...recent20) : latest.close;
  const sd20 = standardDeviation(recent20);
  const upper = ma20 + sd20 * 2;
  const lower = ma20 - sd20 * 2;
  const bollingerPos = upper === lower ? 0.5 : (latest.close - lower) / (upper - lower);
  const drawdown20 = highest20 === 0 ? 0 : ((highest20 - latest.close) / highest20) * 100;
  const change5 = closes.length > 5 ? ratio(latest.close - closes.at(-6), closes.at(-6)) * 100 : null;
  const change20 = closes.length > 20 ? ratio(latest.close - closes.at(-21), closes.at(-21)) * 100 : null;
  const change60 = closes.length > 60 ? ratio(latest.close - closes.at(-61), closes.at(-61)) * 100 : change20;
  const previousMa20 = closes.length > 20 ? simpleMovingAverage(closes.slice(0, -1), 20) : null;
  const ma20Slope = previousMa20 !== null ? ma20 - previousMa20 : null;
  const volumeAvg5 = simpleMovingAverage(volumes, 5);
  const volumeAvg20 = simpleMovingAverage(volumes, 20);
  const volumeRatio5v20 =
    volumeAvg5 !== null && volumeAvg20 !== null && volumeAvg20 !== 0 ? volumeAvg5 / volumeAvg20 : null;

  let upStreak = 0;
  for (let index = closes.length - 1; index > 0; index -= 1) {
    if (closes[index] > closes[index - 1]) {
      upStreak += 1;
      continue;
    }
    break;
  }

  const ema12 = ema(closes, 12);
  const ema26 = ema(closes, 26);
  const macdLine = ema12.map((value, index) => value - ema26[index]);
  const signalLine = ema(macdLine, 9);
  const macdHist = macdLine.at(-1) - signalLine.at(-1);

  return {
    close: latest.close,
    ma20,
    ma60,
    rsi14: computeRsi(closes, 14),
    macdHist,
    bollingerPos,
    drawdown20,
    change5,
    change20,
    change60,
    ma20Slope,
    volumeRatio5v20,
    upStreak,
    candlesAvailable: candles.length
  };
}

function getMarketCapTier(snapshot) {
  const referenceCap = Math.max(snapshot.marketCap || 0, snapshot.floatCap || 0);
  if (referenceCap >= 1e11) {
    return "large";
  }
  if (referenceCap <= 2e10) {
    return "small_mid";
  }
  return "mid";
}

function scoreTechnicalReplay(snapshot, technical) {
  const streakBonus = clamp(technical.upStreak >= 3 ? 3 : technical.upStreak >= 2 ? 1 : 0, 0, 3);
  const trend = clamp(
    (technical.close > technical.ma20 ? 4 : 1) +
      (technical.ma20 > technical.ma60 ? 3 : 1) +
      (toNumber(technical.change20) > 0 ? 1 : 0) +
      streakBonus,
    0,
    8
  );

  const momentum = clamp(
    scoreByThresholds(technical.rsi14, [
      { test: (value) => value >= 55 && value <= 75, score: 3 },
      { test: (value) => value >= 45 && value < 55, score: 2 },
      { test: (value) => value > 75, score: 1.5 },
      { test: (value) => value > 0, score: 1 }
    ]) + (toNumber(technical.macdHist) > 0 ? 3 : 1),
    0,
    6
  );

  const location = clamp(
    scoreByThresholds(technical.bollingerPos, [
      { test: (value) => value >= 0.55 && value <= 0.95, score: 3 },
      { test: (value) => value >= 0.4 && value < 0.55, score: 2 },
      { test: (value) => value > 0.95, score: 1.5 }
    ]) +
      scoreByThresholds(technical.drawdown20, [
        { test: (value) => value <= 3, score: 3 },
        { test: (value) => value <= 6, score: 2 },
        { test: (value) => value <= 10, score: 1 }
      ]),
    0,
    6
  );

  const shortStrength = clamp(
    scoreByThresholds(snapshot.pctChange, [
      { test: (value) => value >= 7, score: 4 },
      { test: (value) => value >= 3, score: 3 },
      { test: (value) => value > 0, score: 1.5 }
    ]) + scoreByThresholds(technical.change5, [
      { test: (value) => value >= 8, score: 2 },
      { test: (value) => value >= 3, score: 1.5 },
      { test: (value) => value > 0, score: 1 }
    ]),
    0,
    6
  );

  const score = clamp(trend + momentum + location + shortStrength, 0, 26);
  return {
    rawScore: score,
    score: Number(((score / 26) * 65).toFixed(2))
  };
}

function scoreLiquidityReplay(snapshot) {
  const marketCapTier = getMarketCapTier(snapshot);
  const turnover = marketCapTier === "large"
    ? scoreByThresholds(snapshot.turnoverRate, [
        { test: (value) => value >= 0.3 && value <= 5, score: 4 },
        { test: (value) => value > 5 && value <= 10, score: 3 },
        { test: (value) => value > 0, score: 2 }
      ])
    : scoreByThresholds(snapshot.turnoverRate, [
        { test: (value) => value >= 2 && value <= 12, score: 4 },
        { test: (value) => value > 12 && value <= 20, score: 3 },
        { test: (value) => value >= 0.5 && value < 2, score: 2 },
        { test: (value) => value > 20, score: 1.5 }
      ]);

  const liquidity = marketCapTier === "large"
    ? scoreByThresholds(snapshot.amount, [
        { test: (value) => value >= 2e9, score: 2.5 },
        { test: (value) => value >= 1e9, score: 2 },
        { test: (value) => value >= 5e8, score: 1.5 },
        { test: (value) => value > 0, score: 0.5 }
      ])
    : marketCapTier === "small_mid"
      ? scoreByThresholds(snapshot.amount, [
          { test: (value) => value >= 2e9, score: 3 },
          { test: (value) => value >= 8e8, score: 2.5 },
          { test: (value) => value >= 3e8, score: 1.5 },
          { test: (value) => value > 0, score: 0.5 }
        ])
      : scoreByThresholds(snapshot.amount, [
          { test: (value) => value >= 5e9, score: 3 },
          { test: (value) => value >= 2e9, score: 2 },
          { test: (value) => value >= 5e8, score: 1 },
          { test: (value) => value > 0, score: 0.5 }
        ]);

  const normalized = clamp((turnover + liquidity) / 7, 0, 1) * 35;
  return {
    score: Number(normalized.toFixed(2)),
    marketCapTier
  };
}

function scoreRiskReplay(snapshot, technical, config) {
  const reasons = [];
  let total = 0;
  let veto = false;
  const marketCapTier = getMarketCapTier(snapshot);

  if (snapshot.isSt) {
    total += config.risk.stPenalty;
    reasons.push("ST risk");
    veto = true;
  }

  if (snapshot.amount < config.filters.minAmount) {
    total += config.risk.lowLiquidityPenalty;
    reasons.push("low liquidity");
    veto = true;
  }

  if (technical.candlesAvailable < config.filters.minHistoryDays) {
    total += config.risk.newListingPenalty;
    reasons.push("insufficient history");
    veto = true;
  }

  if (snapshot.turnoverRate > 25 && snapshot.pctChange > 8) {
    total += config.risk.overheatPenalty;
    reasons.push("overheated turnover");
  }

  if (technical.upStreak >= 5) {
    total += 3;
    reasons.push("five-day streak overheating");
  }

  if (marketCapTier === "small_mid" && toNumber(technical.volumeRatio5v20) > 0 && technical.volumeRatio5v20 < 0.75) {
    total += 4;
    reasons.push("small-mid shrinking volume");
  }

  if (marketCapTier === "small_mid" && snapshot.amount < 3e8) {
    total += 2;
    reasons.push("small-mid low amount");
  }

  if (technical.close < technical.ma20 && toNumber(technical.macdHist) <= 0) {
    total += config.risk.weakTrendPenalty;
    reasons.push("below MA20");
  }

  if (snapshot.change60d > 80) {
    total += 4;
    reasons.push("too extended");
  }

  return {
    total: clamp(total, 0, 30),
    reasons,
    veto
  };
}

function buildReplayStatus(totalScore, risk, config) {
  if (risk.veto) {
    return "剔除";
  }
  if (totalScore >= config.thresholds.coreScore && risk.total <= config.thresholds.maxRiskForCore) {
    return "核心机会池";
  }
  if (totalScore >= config.thresholds.watchScore) {
    return "观察池";
  }
  return "剔除";
}

function buildTrendLabel(snapshot, technical) {
  const ma20Up = toNumber(technical.ma20Slope) > 0;
  const ma20AboveMa60 = technical.ma20 > technical.ma60;
  const midTermPositive = toNumber(snapshot.change60d) > 5 || toNumber(technical.change60) > 5;
  const shortTermPositive = toNumber(technical.change20) > 0;

  if (technical.close > technical.ma20 && ma20AboveMa60 && ma20Up && midTermPositive) {
    return "uptrend";
  }
  if (technical.close > technical.ma20 && !ma20AboveMa60 && shortTermPositive) {
    return "rebound";
  }
  if (technical.close < technical.ma20 && !ma20AboveMa60 && !ma20Up && toNumber(snapshot.change60d) < 0) {
    return "downtrend";
  }
  return "sideways";
}

function buildTargetEntryRange(technical) {
  const lower = technical.ma20 * 0.95;
  const upper = technical.ma20 * 1.05;
  return {
    lower: Number(lower.toFixed(2)),
    upper: Number(upper.toFixed(2)),
    label: `${lower.toFixed(2)}-${upper.toFixed(2)}`
  };
}

function buildEntryRangeStatus(price, range) {
  if (price < range.lower) {
    return "below_range";
  }
  if (price > range.upper) {
    return "above_range";
  }
  return "within_range";
}

function compareReplayCandidate(left, right) {
  return (
    right.score - left.score ||
    right.subscores.technical - left.subscores.technical ||
    right.subscores.liquidity - left.subscores.liquidity ||
    right.code.localeCompare(left.code)
  );
}

function markOverflowAsDropped(candidates, reason) {
  return candidates.map((candidate) => ({
    ...candidate,
    status: "剔除",
    risks: [...candidate.risks, reason]
  }));
}

function parseTencentDayBars(payload, symbol) {
  const rows = payload?.data?.[symbol]?.qfqday ?? payload?.data?.[symbol]?.day ?? [];
  return rows.map((row) => ({
    date: row[0],
    open: toNumber(row[1]),
    close: toNumber(row[2]),
    high: toNumber(row[3]),
    low: toNumber(row[4]),
    volumeHands: toNumber(row[5])
  }));
}

function parseEastmoneyDayBars(payload) {
  const rows = payload?.data?.klines ?? [];
  return rows.map((line) => {
    const [date, open, close, high, low, volume, amount, , , , turnover] = String(line).split(",");
    return {
      date,
      open: toNumber(open),
      close: toNumber(close),
      high: toNumber(high),
      low: toNumber(low),
      volumeHands: toNumber(volume),
      amount: toNumber(amount),
      turnoverRate: toNumber(turnover)
    };
  });
}

function finalizeBars(rawBars, meta) {
  return rawBars.map((bar) => {
    const averagePrice = mean([bar.open, bar.high, bar.low, bar.close]);
    const volumeShares = bar.volumeHands * 100;
    const amount = Number.isFinite(bar.amount) && bar.amount > 0 ? bar.amount : averagePrice * volumeShares;
    const turnoverRate =
      Number.isFinite(bar.turnoverRate) && bar.turnoverRate > 0
        ? bar.turnoverRate
        : meta.floatShares
          ? (volumeShares / meta.floatShares) * 100
          : 0;

    return {
      date: bar.date,
      open: bar.open,
      close: bar.close,
      high: bar.high,
      low: bar.low,
      volumeHands: bar.volumeHands,
      amount,
      turnoverRate
    };
  });
}

async function readCachedSeries(cachePath) {
  if (!(await exists(cachePath))) {
    return null;
  }
  return readJson(cachePath);
}

function localDateString(date = new Date()) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function expectedLatestTradingDate(date = new Date()) {
  const probe = new Date(date);
  while (probe.getDay() === 0 || probe.getDay() === 6) {
    probe.setDate(probe.getDate() - 1);
  }
  return localDateString(probe);
}

function latestBarDate(cached) {
  return cached?.bars?.[cached.bars.length - 1]?.date ?? null;
}

function hasFallbackBarCache(cached, barsNeeded) {
  return cached?.bars?.length >= barsNeeded;
}

function hasUsableBarCache(cached, barsNeeded, expectedLatestDate) {
  return hasFallbackBarCache(cached, barsNeeded) && String(latestBarDate(cached)) >= expectedLatestDate;
}

function cacheRecordedDate(cached) {
  if (!cached?.cachedAt) {
    return null;
  }

  const parsed = new Date(cached.cachedAt);
  if (Number.isNaN(parsed.getTime())) {
    return null;
  }

  return localDateString(parsed);
}

function hasFallbackSnapshotCache(cached) {
  return cached?.value?.length > 0;
}

function hasUsableSnapshotCache(cached, expectedLatestDate) {
  const recordedDate = cacheRecordedDate(cached);
  return hasFallbackSnapshotCache(cached) && recordedDate !== null && recordedDate >= expectedLatestDate;
}

async function fetchStockBars(meta, barsNeeded, runtime) {
  const cachePath = path.join(BT_PATHS.stockCacheDir, `${meta.code}.json`);
  const cached = await readCachedSeries(cachePath);
  const expectedLatestDate = expectedLatestTradingDate();
  if (hasUsableBarCache(cached, barsNeeded, expectedLatestDate)) {
    runtime.providersUsed.push(`stock-cache:${meta.code}`);
    return cached.bars.slice(-barsNeeded);
  }

  const symbol = symbolFromCode(meta.code);
  const tencentUrl = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${barsNeeded},qfq`;
  const eastmoneyUrl =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secidFromCode(meta.code)}` +
    `&klt=101&fqt=1&lmt=${barsNeeded}&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6` +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";

  let source = "tencent";
  let bars;

  try {
    bars = finalizeBars(parseTencentDayBars(await fetchJson(tencentUrl), symbol), meta);
    runtime.providersUsed.push(`stock-tencent:${meta.code}`);
  } catch (error) {
    runtime.warnings.push(`stock tencent fallback for ${meta.code}: ${error.message}`);
    try {
      bars = finalizeBars(parseEastmoneyDayBars(await fetchJson(eastmoneyUrl)), meta);
      source = "eastmoney";
      runtime.providersUsed.push(`stock-eastmoney:${meta.code}`);
      runtime.fallbackEvents.push(`stock:${meta.code}:switched-to-eastmoney`);
    } catch (fallbackError) {
      runtime.warnings.push(`stock eastmoney fallback for ${meta.code}: ${fallbackError.message}`);
      if (hasFallbackBarCache(cached, barsNeeded)) {
        runtime.providersUsed.push(`stock-cache-stale:${meta.code}`);
        runtime.fallbackEvents.push(`stock:${meta.code}:using-stale-cache`);
        return cached.bars.slice(-barsNeeded);
      }
      throw fallbackError;
    }
  }

  await writeJson(cachePath, {
    cachedAt: nowIso(),
    source,
    bars
  });

  return bars.slice(-barsNeeded);
}

async function fetchBenchmarkBars(symbol, barsNeeded, runtime) {
  const cachePath = path.join(BT_PATHS.benchmarkCacheDir, `${symbol}.json`);
  const cached = await readCachedSeries(cachePath);
  const expectedLatestDate = expectedLatestTradingDate();
  if (hasUsableBarCache(cached, barsNeeded, expectedLatestDate)) {
    runtime.providersUsed.push(`benchmark-cache:${symbol}`);
    return cached.bars.slice(-barsNeeded);
  }

  const url = `https://web.ifzq.gtimg.cn/appstock/app/fqkline/get?param=${symbol},day,,,${barsNeeded},qfq`;
  try {
    const bars = parseTencentDayBars(await fetchJson(url), symbol);
    if (bars.length === 0) {
      throw new Error(`No benchmark bars returned for ${symbol}`);
    }

    runtime.providersUsed.push(`benchmark-tencent:${symbol}`);
    await writeJson(cachePath, {
      cachedAt: nowIso(),
      source: "tencent",
      bars
    });

    return bars.slice(-barsNeeded);
  } catch (error) {
    runtime.warnings.push(`benchmark tencent fallback for ${symbol}: ${error.message}`);
    if (hasFallbackBarCache(cached, barsNeeded)) {
      runtime.providersUsed.push(`benchmark-cache-stale:${symbol}`);
      runtime.fallbackEvents.push(`benchmark:${symbol}:using-stale-cache`);
      return cached.bars.slice(-barsNeeded);
    }
    throw error;
  }
}

async function ensureBacktestBootstrap() {
  const universeCachePath = path.join(PATHS.cacheDir, "universe", "live.json");
  const profileDir = path.join(PATHS.cacheDir, "profile");
  const universeExists = await exists(universeCachePath);
  const profileExists = await exists(profileDir);
  const profileCount = profileExists ? (await readdir(profileDir)).length : 0;

  if (universeExists && profileCount > 0) {
    return;
  }

  await runScan({
    mode: "live",
    stateKey: `backtest-bootstrap-${Date.now()}`,
    coreSize: 1,
    watchSize: 1
  });
}

function universeCandidateEligible(snapshot, config) {
  return snapshot.price >= config.filters.minPrice && snapshot.amount >= config.filters.minAmount / 2;
}

function normalizeEastmoneyUniverseSnapshot(row) {
  return {
    code: String(row.f12),
    name: String(row.f14),
    industry: String(row.f100 || "未分类"),
    price: toNumber(row.f2),
    pctChange: toNumber(row.f3),
    amount: toNumber(row.f6),
    turnoverRate: toNumber(row.f8),
    pe: toNumber(row.f9),
    marketCap: toNumber(row.f20),
    floatCap: toNumber(row.f21),
    pb: toNumber(row.f23),
    change60d: toNumber(row.f24),
    changeYtd: toNumber(row.f25),
    roe: toNumber(row.f37),
    mainNetInflow: toNumber(row.f62),
    isSt: /(ST|\*ST|退)/i.test(String(row.f14))
  };
}

async function fetchEastmoneyUniverseForBacktest(config, runtime) {
  const cachePath = path.join(BT_PATHS.cacheDir, "eastmoney_universe.json");
  const cached = await readCachedSeries(cachePath);
  const expectedLatestDate = expectedLatestTradingDate();
  if (hasUsableSnapshotCache(cached, expectedLatestDate)) {
    runtime.providersUsed.push("backtest-universe-cache");
    return cached.value;
  }

  try {
    const firstUrl =
      `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${config.live.pageSize}` +
      `&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:13,m:1+t:2,m:1+t:23&fields=${EASTMONEY_UNIVERSE_FIELDS}`;
    const firstPayload = await fetchJson(firstUrl);
    const total = toNumber(firstPayload?.data?.total);
    const pages = Math.ceil(total / config.live.pageSize);
    const firstPage = firstPayload?.data?.diff ?? [];
    const allPages = [firstPage];

    for (let page = 2; page <= pages; page += 1) {
      const url =
        `https://push2.eastmoney.com/api/qt/clist/get?pn=${page}&pz=${config.live.pageSize}` +
        `&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:13,m:1+t:2,m:1+t:23&fields=${EASTMONEY_UNIVERSE_FIELDS}`;
      const payload = await fetchJson(url);
      allPages.push(payload?.data?.diff ?? []);
    }

    const snapshots = allPages.flat().map(normalizeEastmoneyUniverseSnapshot);
    await writeJson(cachePath, {
      cachedAt: nowIso(),
      value: snapshots
    });
    runtime.providersUsed.push("backtest-universe-eastmoney");
    return snapshots;
  } catch (error) {
    runtime.warnings.push(`backtest universe eastmoney fallback: ${error.message}`);
    if (hasFallbackSnapshotCache(cached)) {
      runtime.providersUsed.push("backtest-universe-cache-stale");
      runtime.fallbackEvents.push("backtest-universe:using-stale-cache");
      return cached.value;
    }
    const liveUniverse = await readJson(path.join(PATHS.cacheDir, "universe", "live.json"));
    runtime.providersUsed.push("backtest-universe-live-cache");
    runtime.fallbackEvents.push("backtest-universe:switched-to-live-cache");
    return liveUniverse.value;
  }
}

async function loadBacktestUniverse(config, maxUniverse) {
  await ensureBacktestBootstrap();

  const runtime = loadBacktestUniverse.runtime;
  const universe = await fetchEastmoneyUniverseForBacktest(config, runtime);
  const profileDir = path.join(PATHS.cacheDir, "profile");
  const profileFiles = await readdir(profileDir);
  const profileMap = new Map();

  for (const profileFile of profileFiles) {
    if (!profileFile.endsWith(".json")) {
      continue;
    }
    const code = profileFile.replace(/\.json$/i, "");
    const envelope = await readJson(path.join(profileDir, profileFile));
    profileMap.set(code, envelope.value);
  }

  const deduped = new Map();
  for (const snapshot of universe) {
    const current = deduped.get(snapshot.code);
    if (!current || snapshot.amount > current.amount) {
      deduped.set(snapshot.code, snapshot);
    }
  }

  return [...deduped.values()]
    .filter((snapshot) => universeCandidateEligible(snapshot, config))
    .map((snapshot) => {
      const profile = profileMap.get(snapshot.code);
      return {
        code: snapshot.code,
        name: snapshot.name,
        industry: profile?.industry || snapshot.industry || "未分类",
        concepts: profile?.concepts || [],
        marketCap: snapshot.marketCap,
        floatCap: snapshot.floatCap,
        currentPrice: snapshot.price,
        currentAmount: snapshot.amount,
        totalShares: snapshot.price > 0 ? snapshot.marketCap / snapshot.price : null,
        floatShares: snapshot.price > 0 ? snapshot.floatCap / snapshot.price : null
      };
    })
    .sort((left, right) => right.currentAmount - left.currentAmount || right.marketCap - left.marketCap)
    .slice(0, maxUniverse);
}

function buildDateMap(bars) {
  return new Map(bars.map((bar, index) => [bar.date, index]));
}

function intersectDates(leftBars, rightBars) {
  const rightDates = new Set(rightBars.map((bar) => bar.date));
  return leftBars.map((bar) => bar.date).filter((date) => rightDates.has(date));
}

function pickTradeCalendar(benchmarkHs300, benchmarkZz500, days) {
  return intersectDates(benchmarkHs300, benchmarkZz500).slice(-days);
}

async function buildHistoricalInputs(config, options) {
  const runtime = {
    warnings: [],
    providersUsed: [],
    fallbackEvents: []
  };
  const warmupDays = 80;
  const horizonMax = 5;
  const barsNeeded = options.days + warmupDays + horizonMax + 5;
  loadBacktestUniverse.runtime = runtime;
  const universe = await loadBacktestUniverse(config, options.maxUniverse);
  const benchmarkHs300 = await fetchBenchmarkBars("sh000300", barsNeeded, runtime);
  const benchmarkZz500 = await fetchBenchmarkBars("sz399905", barsNeeded, runtime);
  const calendar = pickTradeCalendar(benchmarkHs300, benchmarkZz500, options.days + horizonMax + 5);
  const benchmarkCalendar = calendar.slice(-options.days);

  const stockHistories = new Map();
  for (const meta of universe) {
    const bars = await fetchStockBars(meta, barsNeeded, runtime);
    stockHistories.set(meta.code, {
      meta,
      bars,
      byDate: buildDateMap(bars)
    });
  }

  return {
    runtime,
    universe,
    stockHistories,
    benchmarks: {
      hs300: {
        symbol: "sh000300",
        bars: benchmarkHs300,
        byDate: buildDateMap(benchmarkHs300)
      },
      zz500: {
        symbol: "sz399905",
        bars: benchmarkZz500,
        byDate: buildDateMap(benchmarkZz500)
      }
    },
    calendar: benchmarkCalendar
  };
}

function buildApproximateSnapshot(meta, bars, endIndex) {
  const bar = bars[endIndex];
  const previousBar = endIndex > 0 ? bars[endIndex - 1] : null;
  const close = bar.close;
  const priceChange = previousBar ? ((close - previousBar.close) / previousBar.close) * 100 : 0;

  return {
    code: meta.code,
    name: meta.name,
    industry: meta.industry,
    concepts: meta.concepts,
    price: close,
    pctChange: priceChange,
    amount: bar.amount,
    turnoverRate: bar.turnoverRate,
    marketCap: meta.totalShares ? meta.totalShares * close : meta.marketCap,
    floatCap: meta.floatShares ? meta.floatShares * close : meta.floatCap,
    change60d: 0,
    isSt: /(ST|\*ST|退)/i.test(meta.name)
  };
}

function buildReplayLiteCandidate(meta, bars, endIndex, config) {
  const history = bars.slice(0, endIndex + 1);
  const technical = computeTechnicalFromCandles(history);
  const snapshot = buildApproximateSnapshot(meta, bars, endIndex);
  snapshot.change60d = toNumber(technical.change60);

  const technicalScore = scoreTechnicalReplay(snapshot, technical);
  const liquidityScore = scoreLiquidityReplay(snapshot);
  const risk = scoreRiskReplay(snapshot, technical, config);
  const targetEntryRange = buildTargetEntryRange(technical);
  const totalScore = Number(clamp(technicalScore.score + liquidityScore.score - risk.total, 0, 100).toFixed(2));

  return {
    code: meta.code,
    name: meta.name,
    industry: meta.industry,
    concepts: meta.concepts,
    status: buildReplayStatus(totalScore, risk, config),
    score: totalScore,
    totalScore,
    trendLabel: buildTrendLabel(snapshot, technical),
    targetEntryRange,
    entryRangeStatus: buildEntryRangeStatus(snapshot.price, targetEntryRange),
    risks: risk.reasons,
    subscores: {
      technical: technicalScore.score,
      liquidity: liquidityScore.score,
      risk: risk.total
    },
    scores: {
      fundamental: 0,
      technical: technicalScore.score,
      capital: liquidityScore.score,
      message: 0,
      riskDeduction: risk.total
    },
    raw: {
      technical,
      snapshot,
      marketCapTier: liquidityScore.marketCapTier,
      riskVeto: risk.veto
    }
  };
}

function summarizeReplayPool(candidates, coreSize, watchSize) {
  const sorted = [...candidates].sort(compareReplayCandidate);
  const baseCore = sorted.filter((candidate) => candidate.status === "核心机会池");
  const baseWatch = sorted.filter((candidate) => candidate.status === "观察池");
  const baseDropped = sorted.filter((candidate) => candidate.status === "剔除");
  const core = baseCore.slice(0, coreSize);
  const watch = baseWatch.slice(0, watchSize);
  const dropped = [
    ...baseDropped,
    ...markOverflowAsDropped(baseCore.slice(coreSize), "overflow core bucket"),
    ...markOverflowAsDropped(baseWatch.slice(watchSize), "overflow watch bucket")
  ].sort(compareReplayCandidate);

  return { core, watch, dropped };
}

function buildDailyPools(candidates, config) {
  const concentrated = enforceIndustryConcentration(candidates, config);
  const summarized = summarizeReplayPool(
    [...concentrated.kept, ...concentrated.dropped],
    config.pool.coreSize,
    config.pool.watchSize
  );

  return {
    core: summarized.core,
    watch: summarized.watch,
    combined: [...summarized.core, ...summarized.watch].sort(compareReplayCandidate),
    dropped: summarized.dropped
  };
}

function buildDailySignals(inputs, config) {
  const dailySignals = [];

  for (const tradeDate of inputs.calendar) {
    const candidates = [];

    for (const history of inputs.stockHistories.values()) {
      const endIndex = history.byDate.get(tradeDate);
      if (endIndex === undefined || endIndex < 60) {
        continue;
      }

      candidates.push(buildReplayLiteCandidate(history.meta, history.bars, endIndex, config));
    }

    dailySignals.push({
      tradeDate,
      ...buildDailyPools(candidates, config)
    });
  }

  return dailySignals;
}

function createEvent(candidate, history, benchmarks, calendar, tradeDateIndex, holdingDays, entryMode, poolType) {
  const tradeDate = calendar[tradeDateIndex];
  const entryDateIndex = tradeDateIndex + 1;
  const exitDateIndex = tradeDateIndex + holdingDays;

  if (entryDateIndex >= calendar.length || exitDateIndex >= calendar.length) {
    return null;
  }

  const entryDate = calendar[entryDateIndex];
  const exitDate = calendar[exitDateIndex];
  const signalBarIndex = history.byDate.get(tradeDate);
  const entryBarIndex = history.byDate.get(entryDate);
  const exitBarIndex = history.byDate.get(exitDate);

  if (signalBarIndex === undefined || entryBarIndex === undefined || exitBarIndex === undefined) {
    return null;
  }

  const signalBar = history.bars[signalBarIndex];
  const entryBar = history.bars[entryBarIndex];
  const exitBar = history.bars[exitBarIndex];
  const entryPrice = entryMode === "same_close" ? signalBar.close : entryBar.open;
  const exitPrice = exitBar.close;

  if (!Number.isFinite(entryPrice) || entryPrice <= 0 || !Number.isFinite(exitPrice) || exitPrice <= 0) {
    return null;
  }

  const benchmarkEvents = {};
  for (const [benchmarkKey, benchmark] of Object.entries(benchmarks)) {
    const signalBenchmarkIndex = benchmark.byDate.get(tradeDate);
    const entryBenchmarkIndex = benchmark.byDate.get(entryDate);
    const exitBenchmarkIndex = benchmark.byDate.get(exitDate);
    if (signalBenchmarkIndex === undefined || entryBenchmarkIndex === undefined || exitBenchmarkIndex === undefined) {
      return null;
    }

    const signalBenchmarkBar = benchmark.bars[signalBenchmarkIndex];
    const entryBenchmarkBar = benchmark.bars[entryBenchmarkIndex];
    const exitBenchmarkBar = benchmark.bars[exitBenchmarkIndex];
    const benchmarkEntryPrice = entryMode === "same_close" ? signalBenchmarkBar.close : entryBenchmarkBar.open;
    const benchmarkExitPrice = exitBenchmarkBar.close;
    benchmarkEvents[benchmarkKey] = ratio(benchmarkExitPrice - benchmarkEntryPrice, benchmarkEntryPrice);
  }

  const rawReturn = ratio(exitPrice - entryPrice, entryPrice);
  return {
    tradeDate,
    entryDate,
    exitDate,
    code: candidate.code,
    name: candidate.name,
    poolType,
    entryMode,
    entryPrice: Number(entryPrice.toFixed(4)),
    exitPrice: Number(exitPrice.toFixed(4)),
    holdingDays,
    rawReturn: Number(rawReturn.toFixed(6)),
    benchmarkReturn_hs300: Number(benchmarkEvents.hs300.toFixed(6)),
    benchmarkReturn_zz500: Number(benchmarkEvents.zz500.toFixed(6)),
    excessReturn_hs300: Number((rawReturn - benchmarkEvents.hs300).toFixed(6)),
    excessReturn_zz500: Number((rawReturn - benchmarkEvents.zz500).toFixed(6)),
    score: candidate.score,
    trendLabel: candidate.trendLabel,
    targetEntryRange: candidate.targetEntryRange,
    industry: candidate.industry,
    industryRank: candidate.industryRank ?? null
  };
}

function buildEventStudy(dailySignals, inputs) {
  const events = [];
  const holdingWindows = [1, 3, 5];
  const entryModes = ["same_close", "next_open"];

  for (let tradeDateIndex = 0; tradeDateIndex < inputs.calendar.length - 5; tradeDateIndex += 1) {
    const signal = dailySignals[tradeDateIndex];
    const groups = [
      { poolType: "core", candidates: signal.core },
      { poolType: "watch", candidates: signal.watch },
      { poolType: "combined", candidates: signal.combined }
    ];

    for (const group of groups) {
      for (const candidate of group.candidates) {
        const history = inputs.stockHistories.get(candidate.code);
        if (!history) {
          continue;
        }

        for (const entryMode of entryModes) {
          for (const holdingDays of holdingWindows) {
            const event = createEvent(candidate, history, inputs.benchmarks, inputs.calendar, tradeDateIndex, holdingDays, entryMode, group.poolType);
            if (event) {
              events.push(event);
            }
          }
        }
      }
    }
  }

  return events;
}

function summarizeEvents(events) {
  const groups = new Map();
  const poolTypes = ["core", "watch", "combined"];
  const entryModes = ["same_close", "next_open"];
  const holdingWindows = [1, 3, 5];

  for (const event of events) {
    const key = `${event.poolType}_${event.entryMode}_h${event.holdingDays}`;
    if (!groups.has(key)) {
      groups.set(key, []);
    }
    groups.get(key).push(event);
  }

  const summary = Object.fromEntries(
    [...groups.entries()].map(([key, group]) => {
      const rawReturns = group.map((event) => event.rawReturn);
      return [
        key,
        {
          count: group.length,
          averageReturn: Number(mean(rawReturns).toFixed(6)),
          medianReturn: Number(median(rawReturns).toFixed(6)),
          winRate: Number(ratio(group.filter((event) => event.rawReturn > 0).length, group.length).toFixed(6)),
          averageExcessHs300: Number(mean(group.map((event) => event.excessReturn_hs300)).toFixed(6)),
          averageExcessZz500: Number(mean(group.map((event) => event.excessReturn_zz500)).toFixed(6))
        }
      ];
    })
  );

  for (const poolType of poolTypes) {
    for (const entryMode of entryModes) {
      for (const holdingDays of holdingWindows) {
        const key = `${poolType}_${entryMode}_h${holdingDays}`;
        if (!(key in summary)) {
          summary[key] = {
            count: 0,
            averageReturn: 0,
            medianReturn: 0,
            winRate: 0,
            averageExcessHs300: 0,
            averageExcessZz500: 0
          };
        }
      }
    }
  }

  return summary;
}

function groupEventsForPortfolio(events) {
  const grouped = new Map();

  for (const event of events) {
    const strategyKey = `${event.poolType}_h${event.holdingDays}_${event.entryMode}`;
    const signalKey = `${strategyKey}:${event.tradeDate}`;
    if (!grouped.has(signalKey)) {
      grouped.set(signalKey, {
        strategyKey,
        poolType: event.poolType,
        holdingDays: event.holdingDays,
        entryMode: event.entryMode,
        tradeDate: event.tradeDate,
        entryDate: event.entryDate,
        exitDate: event.exitDate,
        events: []
      });
    }
    grouped.get(signalKey).events.push(event);
  }

  return [...grouped.values()];
}

function buildGroupDailyReturns(group, inputs) {
  const calendarIndexByDate = new Map(inputs.calendar.map((date, index) => [date, index]));
  const startIndex = calendarIndexByDate.get(group.entryDate);
  const endIndex = calendarIndexByDate.get(group.exitDate);
  if (startIndex === undefined || endIndex === undefined || endIndex < startIndex) {
    return [];
  }

  const series = [];
  for (let calendarIndex = startIndex; calendarIndex <= endIndex; calendarIndex += 1) {
    const date = inputs.calendar[calendarIndex];
    const stockReturns = [];

    for (const event of group.events) {
      const history = inputs.stockHistories.get(event.code);
      const currentBarIndex = history?.byDate.get(date);
      if (currentBarIndex === undefined) {
        continue;
      }
      const currentBar = history.bars[currentBarIndex];

      let dailyReturn = null;
      if (date === group.entryDate) {
        if (group.entryMode === "same_close") {
          const signalBar = history.bars[history.byDate.get(group.tradeDate)];
          dailyReturn = ratio(currentBar.close - signalBar.close, signalBar.close);
        } else {
          dailyReturn = ratio(currentBar.close - currentBar.open, currentBar.open);
        }
      } else {
        const previousBarIndex = history.byDate.get(inputs.calendar[calendarIndex - 1]);
        if (previousBarIndex === undefined) {
          continue;
        }
        const previousBar = history.bars[previousBarIndex];
        dailyReturn = ratio(currentBar.close - previousBar.close, previousBar.close);
      }

      if (Number.isFinite(dailyReturn)) {
        stockReturns.push(dailyReturn);
      }
    }

    if (stockReturns.length > 0) {
      series.push({
        date,
        return: mean(stockReturns)
      });
    }
  }

  return series;
}

function buildBenchmarkDailyReturns(inputs) {
  const results = {};

  for (const [key, benchmark] of Object.entries(inputs.benchmarks)) {
    const daily = [];
    for (let index = 1; index < inputs.calendar.length; index += 1) {
      const currentDate = inputs.calendar[index];
      const previousDate = inputs.calendar[index - 1];
      const currentBarIndex = benchmark.byDate.get(currentDate);
      const previousBarIndex = benchmark.byDate.get(previousDate);
      if (currentBarIndex === undefined || previousBarIndex === undefined) {
        continue;
      }
      const currentBar = benchmark.bars[currentBarIndex];
      const previousBar = benchmark.bars[previousBarIndex];
      daily.push({
        date: currentDate,
        return: ratio(currentBar.close - previousBar.close, previousBar.close)
      });
    }
    results[key] = daily;
  }

  return results;
}

function buildPortfolioMetrics(strategyKey, groups, inputs, benchmarkDailyReturns) {
  const calendar = inputs.calendar.slice(1);
  const groupDailySeries = groups.map((group) => ({
    group,
    series: buildGroupDailyReturns(group, inputs)
  }));
  const dailyRecords = [];
  let nav = 1;
  let peak = 1;
  let maxDrawdown = 0;

  for (const date of calendar) {
    const activeReturns = [];
    const activeStocks = new Set();
    const industryWeights = new Map();

    for (const groupEntry of groupDailySeries) {
      const dayPoint = groupEntry.series.find((point) => point.date === date);
      if (!dayPoint) {
        continue;
      }

      activeReturns.push(dayPoint.return);
      const stockWeight = 1 / groupEntry.group.events.length;
      for (const event of groupEntry.group.events) {
        activeStocks.add(event.code);
        industryWeights.set(event.industry, (industryWeights.get(event.industry) ?? 0) + stockWeight);
      }
    }

    const dailyReturn = activeReturns.length > 0 ? mean(activeReturns) : 0;
    nav *= 1 + dailyReturn;
    peak = Math.max(peak, nav);
    maxDrawdown = Math.min(maxDrawdown, nav / peak - 1);

    dailyRecords.push({
      date,
      return: Number(dailyReturn.toFixed(6)),
      nav: Number(nav.toFixed(6)),
      holdingsCount: activeStocks.size,
      industries: Object.fromEntries(
        [...industryWeights.entries()].map(([industry, weight]) => [industry, Number(weight.toFixed(6))])
      )
    });
  }

  const benchmarkHs300 = new Map(benchmarkDailyReturns.hs300.map((record) => [record.date, record.return]));
  const benchmarkZz500 = new Map(benchmarkDailyReturns.zz500.map((record) => [record.date, record.return]));
  const hs300Excess = dailyRecords.map((record) => record.return - (benchmarkHs300.get(record.date) ?? 0));
  const zz500Excess = dailyRecords.map((record) => record.return - (benchmarkZz500.get(record.date) ?? 0));
  const avgHoldingsCount = mean(dailyRecords.map((record) => record.holdingsCount));

  const exposureAccumulator = new Map();
  for (const record of dailyRecords) {
    for (const [industry, weight] of Object.entries(record.industries)) {
      exposureAccumulator.set(industry, (exposureAccumulator.get(industry) ?? 0) + weight);
    }
  }

  const industryExposure = Object.fromEntries(
    [...exposureAccumulator.entries()]
      .map(([industry, totalWeight]) => [industry, Number((totalWeight / Math.max(dailyRecords.length, 1)).toFixed(6))])
      .sort((left, right) => right[1] - left[1])
  );

  const dailyEntryCounts = new Map();
  for (const group of groups) {
    dailyEntryCounts.set(group.entryDate, (dailyEntryCounts.get(group.entryDate) ?? 0) + group.events.length);
  }
  const turnoverValues = [];
  let previousHoldings = 0;
  for (const record of dailyRecords) {
    const entryCount = dailyEntryCounts.get(record.date) ?? 0;
    turnoverValues.push(previousHoldings > 0 ? entryCount / previousHoldings : entryCount > 0 ? 1 : 0);
    previousHoldings = Math.max(record.holdingsCount, 1);
  }

  return {
    strategyKey,
    cumulativeReturn: Number((nav - 1).toFixed(6)),
    averagePeriodReturn: Number(mean(dailyRecords.map((record) => record.return)).toFixed(6)),
    winRate: Number(ratio(dailyRecords.filter((record) => record.return > 0).length, Math.max(dailyRecords.length, 1)).toFixed(6)),
    maxDrawdown: Number(maxDrawdown.toFixed(6)),
    averageExcessHs300: Number(mean(hs300Excess).toFixed(6)),
    averageExcessZz500: Number(mean(zz500Excess).toFixed(6)),
    averageHoldingsCount: Number(avgHoldingsCount.toFixed(4)),
    turnoverFrequency: Number(mean(turnoverValues).toFixed(6)),
    industryExposure,
    daily: dailyRecords
  };
}

function buildPortfolioStudy(events, inputs) {
  const groups = groupEventsForPortfolio(events);
  const benchmarkDailyReturns = buildBenchmarkDailyReturns(inputs);
  const groupedByStrategy = new Map();
  const summary = {};

  for (const group of groups) {
    if (!groupedByStrategy.has(group.strategyKey)) {
      groupedByStrategy.set(group.strategyKey, []);
    }
    groupedByStrategy.get(group.strategyKey).push(group);
  }

  for (const [strategyKey, strategyGroups] of groupedByStrategy.entries()) {
    summary[strategyKey] = buildPortfolioMetrics(strategyKey, strategyGroups, inputs, benchmarkDailyReturns);
  }

  for (const poolType of ["core", "watch", "combined"]) {
    for (const holdingDays of [1, 3, 5]) {
      for (const entryMode of ["same_close", "next_open"]) {
        const strategyKey = `${poolType}_h${holdingDays}_${entryMode}`;
        if (!(strategyKey in summary)) {
          summary[strategyKey] = buildPortfolioMetrics(strategyKey, [], inputs, benchmarkDailyReturns);
        }
      }
    }
  }

  return summary;
}

function buildBacktestSummary(result) {
  return {
    metadata: result.metadata,
    eventStudy: result.eventStudySummary,
    portfolio: Object.fromEntries(
      Object.entries(result.portfolio).map(([key, value]) => [
        key,
        {
          cumulativeReturn: value.cumulativeReturn,
          averagePeriodReturn: value.averagePeriodReturn,
          winRate: value.winRate,
          maxDrawdown: value.maxDrawdown,
          averageExcessHs300: value.averageExcessHs300,
          averageExcessZz500: value.averageExcessZz500,
          averageHoldingsCount: value.averageHoldingsCount,
          turnoverFrequency: value.turnoverFrequency
        }
      ])
    )
  };
}

function buildBacktestReport(result) {
  const lines = [];
  lines.push("# A股机会池回测报告");
  lines.push("");
  lines.push(`- 运行时间：${result.metadata.generatedAt}`);
  lines.push(`- 回测口径：${result.metadata.mode}`);
  lines.push(`- 时间范围：最近 ${result.metadata.days} 个交易日`);
  lines.push(`- 宇宙规模：${result.metadata.universeCount}`);
  lines.push(`- 交易口径：same_close 与 next_open`);
  lines.push(`- 评估窗口：1 / 3 / 5 日`);
  lines.push(`- 说明：这是 replay-lite，不是严格四维 PIT 回测。`);
  lines.push("");
  lines.push("## 事件研究");
  lines.push("");
  lines.push("| 策略 | 样本数 | 平均收益 | 中位数 | 胜率 | HS300超额 | ZZ500超额 |");
  lines.push("| ---- | ---- | ---- | ---- | ---- | ---- | ---- |");
  for (const [key, summary] of Object.entries(result.eventStudySummary)) {
    lines.push(
      `| ${key} | ${summary.count} | ${formatPercent(summary.averageReturn)} | ${formatPercent(summary.medianReturn)} | ${formatPercent(summary.winRate)} | ${formatPercent(summary.averageExcessHs300)} | ${formatPercent(summary.averageExcessZz500)} |`
    );
  }

  lines.push("");
  lines.push("## 滚动组合");
  lines.push("");
  lines.push("| 策略 | 累计收益 | 胜率 | 最大回撤 | HS300超额 | ZZ500超额 | 日均持仓 | 换手频率 |");
  lines.push("| ---- | ---- | ---- | ---- | ---- | ---- | ---- | ---- |");
  for (const [key, summary] of Object.entries(result.portfolio)) {
    lines.push(
      `| ${key} | ${formatPercent(summary.cumulativeReturn)} | ${formatPercent(summary.winRate)} | ${formatPercent(summary.maxDrawdown)} | ${formatPercent(summary.averageExcessHs300)} | ${formatPercent(summary.averageExcessZz500)} | ${formatNumber(summary.averageHoldingsCount, 2)} | ${formatPercent(summary.turnoverFrequency)} |`
    );
  }

  lines.push("");
  lines.push("## 元数据");
  lines.push("");
  lines.push(`- providersUsed：${result.metadata.providersUsed.join(", ") || "N/A"}`);
  lines.push(`- fallbackEvents：${result.metadata.fallbackEvents.join(", ") || "N/A"}`);
  lines.push(`- warnings：${result.metadata.warnings.join(" | ") || "N/A"}`);
  return `${lines.join("\n")}\n`;
}

async function writeBacktestOutputs(result) {
  await writeJson(path.join(BT_PATHS.dataDir, "summary.json"), buildBacktestSummary(result));
  await writeJson(path.join(BT_PATHS.dataDir, "events.json"), result.events);
  await writeJson(path.join(BT_PATHS.dataDir, "portfolio.json"), result.portfolio);
  await writeText(
    path.join(BT_PATHS.reportsDir, `${new Date().toISOString().slice(0, 10)}-backtest.md`),
    buildBacktestReport(result)
  );
}

async function runBacktest(options = {}) {
  await ensureBacktestDirs();
  const config = await loadConfig();
  const days = toNumber(options.days, 252);
  const maxUniverse = toNumber(options.maxUniverse, config.pool.shortlistSize);
  const inputs = await buildHistoricalInputs(config, { days, maxUniverse });
  const dailySignals = buildDailySignals(inputs, config);
  const events = buildEventStudy(dailySignals, inputs);
  const portfolio = buildPortfolioStudy(events, inputs);

  const result = {
    metadata: {
      generatedAt: nowIso(),
      mode: "replay-lite",
      days,
      maxUniverse,
      universeCount: inputs.universe.length,
      providersUsed: [...new Set(inputs.runtime.providersUsed)],
      fallbackEvents: [...new Set(inputs.runtime.fallbackEvents)],
      warnings: [...new Set(inputs.runtime.warnings)],
      assumptions: {
        poolScope: "core primary; watch and combined as supplementary outputs",
        entryModes: ["same_close", "next_open"],
        holdingWindows: [1, 3, 5],
        benchmarkSymbols: {
          hs300: "sh000300",
          zz500: "sz399905"
        }
      }
    },
    dailySignals,
    events,
    eventStudySummary: summarizeEvents(events),
    portfolio
  };

  await writeBacktestOutputs(result);
  return result;
}

async function cli() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "run";

  if (command !== "run") {
    throw new Error(`Unsupported command: ${command}`);
  }

  const result = await runBacktest({
    days: getFlag(flags, "--days"),
    maxUniverse: getFlag(flags, "--max-universe")
  });

  console.log(
    JSON.stringify(
      {
        ok: true,
        outputDir: BT_PATHS.dataDir,
        reportDir: BT_PATHS.reportsDir,
        metadata: result.metadata,
        eventStrategies: Object.keys(result.eventStudySummary),
        portfolioStrategies: Object.keys(result.portfolio)
      },
      null,
      2
    )
  );
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  cli().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

export { BT_PATHS, runBacktest };
