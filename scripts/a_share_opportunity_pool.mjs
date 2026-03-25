#!/usr/bin/env node

import { access, mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const ROOT = path.resolve(__dirname, "..");

const PATHS = {
  root: ROOT,
  config: path.join(ROOT, "skills", "a_share_opportunity_pool", "config", "scoring.json"),
  skill: path.join(ROOT, "skills", "a_share_opportunity_pool", "SKILL.md"),
  catalystOverrides: path.join(ROOT, "data", "opportunity_pool", "catalyst_overrides.json"),
  sampleFixture: path.join(ROOT, "data", "opportunity_pool", "fixtures", "sample_market_snapshot.json"),
  outputJson: path.join(ROOT, "data", "opportunity_pool", "latest.json"),
  reportsDir: path.join(ROOT, "reports", "opportunity_pool")
};

const A_SHARE_FIELDS = [
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

const BOARD_FIELDS = ["f12", "f14", "f2", "f3", "f8", "f104", "f105", "f128"].join(",");

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

function formatPercent(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  return `${value.toFixed(2)}%`;
}

function formatMoney(value) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }

  const absValue = Math.abs(value);
  if (absValue >= 1e8) {
    return `${(value / 1e8).toFixed(2)}亿`;
  }
  if (absValue >= 1e4) {
    return `${(value / 1e4).toFixed(2)}万`;
  }
  return `${value.toFixed(0)}`;
}

function formatNumber(value, digits = 2) {
  if (!Number.isFinite(value)) {
    return "N/A";
  }
  return value.toFixed(digits);
}

function nowIso() {
  return new Date().toISOString();
}

function addDays(dateString, days) {
  const base = dateString ? new Date(dateString) : new Date();
  const next = new Date(base.getTime());
  next.setUTCDate(next.getUTCDate() + days);
  return next.toISOString().slice(0, 10);
}

async function exists(filePath) {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function ensureJsonFile(filePath, defaultValue) {
  if (await exists(filePath)) {
    return;
  }
  await writeFile(filePath, `${JSON.stringify(defaultValue, null, 2)}\n`, "utf8");
}

async function readJson(filePath) {
  const raw = await readFile(filePath, "utf8");
  return JSON.parse(raw);
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, "utf8");
}

async function writeText(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, value, "utf8");
}

async function ensureWorkspaceFiles() {
  await mkdir(path.dirname(PATHS.outputJson), { recursive: true });
  await mkdir(PATHS.reportsDir, { recursive: true });
  await ensureJsonFile(PATHS.catalystOverrides, { stock: {}, industry: {} });
}

async function loadConfig() {
  return readJson(PATHS.config);
}

function secidFromCode(code) {
  if (/^(5|6|9|11)/.test(code)) {
    return `1.${code}`;
  }
  return `0.${code}`;
}

async function fetchJson(url) {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      return response.json();
    } catch (error) {
      lastError = error;

      if (attempt < 3) {
        await new Promise((resolve) => {
          setTimeout(resolve, attempt * 400);
        });
      }
    }
  }

  throw lastError;
}

async function fetchText(url, encoding = "utf8") {
  let lastError;

  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      const response = await fetch(url, {
        headers: {
          "user-agent": "Mozilla/5.0",
          referer: "https://finance.sina.com.cn/"
        }
      });

      if (!response.ok) {
        throw new Error(`HTTP ${response.status} for ${url}`);
      }

      const buffer = Buffer.from(await response.arrayBuffer());
      return new TextDecoder(encoding).decode(buffer);
    } catch (error) {
      lastError = error;

      if (attempt < 3) {
        await new Promise((resolve) => {
          setTimeout(resolve, attempt * 400);
        });
      }
    }
  }

  throw lastError;
}

async function mapLimit(items, limit, iteratee) {
  const results = new Array(items.length);
  let cursor = 0;

  async function worker() {
    while (cursor < items.length) {
      const current = cursor;
      cursor += 1;
      results[current] = await iteratee(items[current], current);
    }
  }

  const workers = Array.from({ length: Math.min(limit, items.length) }, () => worker());
  await Promise.all(workers);
  return results;
}

function normalizeSnapshot(row) {
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

async function fetchAshareUniverse(config) {
  const firstUrl = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${config.live.pageSize}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:13,m:1+t:2,m:1+t:23&fields=${A_SHARE_FIELDS}`;
  const firstPayload = await fetchJson(firstUrl);
  const total = toNumber(firstPayload?.data?.total);
  const pages = Math.ceil(total / config.live.pageSize);
  const firstPage = firstPayload?.data?.diff ?? [];

  const remainingPageIndexes = [];
  for (let page = 2; page <= pages; page += 1) {
    remainingPageIndexes.push(page);
  }

  const remainingPages = await mapLimit(remainingPageIndexes, config.live.fetchConcurrency, async (pageNumber) => {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pageNumber}&pz=${config.live.pageSize}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:0+t:6,m:0+t:13,m:1+t:2,m:1+t:23&fields=${A_SHARE_FIELDS}`;
    const payload = await fetchJson(url);
    return payload?.data?.diff ?? [];
  });

  return firstPage.concat(remainingPages.flat()).map(normalizeSnapshot);
}

async function fetchIndustryBoards(config) {
  const firstUrl = `https://push2.eastmoney.com/api/qt/clist/get?pn=1&pz=${config.live.boardPageSize}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=${BOARD_FIELDS}`;
  const firstPayload = await fetchJson(firstUrl);
  const total = toNumber(firstPayload?.data?.total);
  const pages = Math.ceil(total / config.live.boardPageSize);
  const firstPage = firstPayload?.data?.diff ?? [];

  const remainingPageIndexes = [];
  for (let page = 2; page <= pages; page += 1) {
    remainingPageIndexes.push(page);
  }

  const remainingPages = await mapLimit(remainingPageIndexes, config.live.fetchConcurrency, async (pageNumber) => {
    const url = `https://push2.eastmoney.com/api/qt/clist/get?pn=${pageNumber}&pz=${config.live.boardPageSize}&po=1&np=1&fltt=2&invt=2&fid=f3&fs=m:90+t:2+f:!50&fields=${BOARD_FIELDS}`;
    const payload = await fetchJson(url);
    return payload?.data?.diff ?? [];
  });

  const boards = firstPage.concat(remainingPages.flat());

  return new Map(
    boards.map((board, index) => [
      String(board.f14),
      {
        name: String(board.f14),
        rank: index + 1,
        pctChange: toNumber(board.f3),
        leader: String(board.f128 || "")
      }
    ])
  );
}

function parseKlineRecord(line) {
  const [date, open, close, high, low, volume, amount, amplitude, pctChange, change, turnover] = String(line)
    .split(",")
    .map((part) => part.trim());

  return {
    date,
    open: toNumber(open),
    close: toNumber(close),
    high: toNumber(high),
    low: toNumber(low),
    volume: toNumber(volume),
    amount: toNumber(amount),
    amplitude: toNumber(amplitude),
    pctChange: toNumber(pctChange),
    change: toNumber(change),
    turnover: toNumber(turnover)
  };
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

function simpleMovingAverage(values, period) {
  if (values.length < period || period <= 0) {
    return null;
  }
  const slice = values.slice(values.length - period);
  const sum = slice.reduce((accumulator, value) => accumulator + value, 0);
  return sum / period;
}

function standardDeviation(values) {
  if (values.length === 0) {
    return 0;
  }
  const mean = values.reduce((accumulator, value) => accumulator + value, 0) / values.length;
  const variance =
    values.reduce((accumulator, value) => accumulator + (value - mean) ** 2, 0) / values.length;
  return Math.sqrt(variance);
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

  const relativeStrength = averageGain / averageLoss;
  return 100 - 100 / (1 + relativeStrength);
}

function computeTechnicalFromCandles(candles) {
  const closes = candles.map((candle) => candle.close);
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
      candlesAvailable: 0,
      freshBreakout: false
    };
  }

  const ma20 = simpleMovingAverage(closes, 20) ?? latest.close;
  const ma60 = simpleMovingAverage(closes, 60) ?? ma20;
  const recent20 = closes.slice(-20);
  const highest20 = recent20.length > 0 ? Math.max(...recent20) : latest.close;
  const lowest20 = recent20.length > 0 ? Math.min(...recent20) : latest.close;
  const sd20 = standardDeviation(recent20);
  const upper = ma20 + sd20 * 2;
  const lower = ma20 - sd20 * 2;
  const bollingerPos = upper === lower ? 0.5 : (latest.close - lower) / (upper - lower);
  const drawdown20 = highest20 === 0 ? 0 : ((highest20 - latest.close) / highest20) * 100;
  const change5 =
    closes.length > 5 ? ratio(latest.close - closes.at(-6), closes.at(-6)) * 100 : null;
  const change20 =
    closes.length > 20 ? ratio(latest.close - closes.at(-21), closes.at(-21)) * 100 : null;
  const change60 =
    closes.length > 60 ? ratio(latest.close - closes.at(-61), closes.at(-61)) * 100 : change20;

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
    candlesAvailable: candles.length,
    freshBreakout: latest.close >= highest20 * 0.995 && latest.close > ma20 && lowest20 > 0
  };
}

async function fetchTechnicalSnapshot(code) {
  const secid = secidFromCode(code);
  const url =
    `https://push2his.eastmoney.com/api/qt/stock/kline/get?secid=${secid}` +
    "&klt=101&fqt=1&lmt=130&end=20500101&iscca=1&fields1=f1,f2,f3,f4,f5,f6" +
    "&fields2=f51,f52,f53,f54,f55,f56,f57,f58,f59,f60,f61";

  const payload = await fetchJson(url);
  const klines = payload?.data?.klines ?? [];
  const candles = klines.map(parseKlineRecord);
  return computeTechnicalFromCandles(candles);
}

function symbolFromCode(code) {
  return /^(5|6|9|11)/.test(code) ? `sh${code}` : `sz${code}`;
}

function normalizeSinaSnapshot(row) {
  return {
    code: String(row.code),
    name: String(row.name),
    industry: "待补充",
    price: toNumber(row.trade),
    pctChange: toNumber(row.changepercent),
    amount: toNumber(row.amount),
    turnoverRate: toNumber(row.turnoverratio),
    pe: toNumber(row.per),
    marketCap: toNumber(row.mktcap) * 10000,
    floatCap: toNumber(row.nmc) * 10000,
    pb: toNumber(row.pb),
    change60d: 0,
    changeYtd: 0,
    roe: NaN,
    mainNetInflow: NaN,
    isSt: /(ST|\*ST|退)/i.test(String(row.name))
  };
}

async function fetchSinaUniverse(config) {
  const countText = await fetchText(
    "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeStockCount?node=hs_a"
  );
  const total = toNumber(countText.replace(/"/g, ""));
  const pages = Math.ceil(total / config.live.pageSize);
  const pageIndexes = [];
  for (let page = 1; page <= pages; page += 1) {
    pageIndexes.push(page);
  }

  const pagesData = await mapLimit(pageIndexes, config.live.fetchConcurrency, async (pageNumber) => {
    const url =
      "https://vip.stock.finance.sina.com.cn/quotes_service/api/json_v2.php/Market_Center.getHQNodeData" +
      `?page=${pageNumber}&num=${config.live.pageSize}&sort=changepercent&asc=0&node=hs_a&symbol=&_s_r_a=page`;
    const payload = await fetchText(url);
    return JSON.parse(payload);
  });

  return pagesData.flat().map(normalizeSinaSnapshot);
}

function extractIndustryFromSinaHtml(html) {
  const match = html.match(
    /行业板块<\/td>\s*<th[^>]*>同行业个股<\/td>\s*<\/tr>\s*<tr>\s*<td[^>]*>([^<]+)<\/td>/i
  );
  return match?.[1]?.trim() || "未分类";
}

function extractRoeFromSinaHtml(html) {
  const match = html.match(/净资产收益率\(%\)<\/a><\/td><td>([^<]+)<\/td>/i);
  return toNumber(match?.[1], NaN);
}

function parseSinaKlines(text) {
  const match = text.match(/\(\s*(\[[\s\S]*\])\s*\)/);
  if (!match) {
    return [];
  }

  const entries = JSON.parse(match[1]);
  return entries.map((entry) => ({
    date: entry.day,
    open: toNumber(entry.open),
    close: toNumber(entry.close),
    high: toNumber(entry.high),
    low: toNumber(entry.low),
    volume: toNumber(entry.volume),
    amount: NaN,
    amplitude: NaN,
    pctChange: NaN,
    change: NaN,
    turnover: NaN
  }));
}

async function fetchSinaTechnicalSnapshot(code) {
  const symbol = symbolFromCode(code);
  const url =
    `https://quotes.sina.cn/cn/api/jsonp_v2.php/var%20_data=/CN_MarketData.getKLineData?symbol=${symbol}` +
    "&scale=240&ma=no&datalen=130";
  const text = await fetchText(url);
  const candles = parseSinaKlines(text);
  return computeTechnicalFromCandles(candles);
}

async function enrichSinaSnapshot(snapshot) {
  const [industryHtml, financeHtml, technical] = await Promise.all([
    fetchText(`https://vip.stock.finance.sina.com.cn/corp/go.php/vCI_CorpOtherInfo/stockid/${snapshot.code}/menu_num/4.phtml`, "gb18030"),
    fetchText(`https://vip.stock.finance.sina.com.cn/corp/go.php/vFD_FinancialGuideLine/stockid/${snapshot.code}/displaytype/4.phtml`, "gb18030"),
    fetchSinaTechnicalSnapshot(snapshot.code)
  ]);

  const enrichedSnapshot = {
    ...snapshot,
    industry: extractIndustryFromSinaHtml(industryHtml),
    roe: extractRoeFromSinaHtml(financeHtml),
    change60d: toNumber(technical.change60, snapshot.change60d),
    changeYtd: snapshot.changeYtd
  };

  return {
    snapshot: enrichedSnapshot,
    technical
  };
}

function buildBoardLookup(boards) {
  if (boards instanceof Map) {
    return boards;
  }

  return new Map(
    (boards ?? []).map((board) => [
      String(board.name),
      {
        name: String(board.name),
        rank: toNumber(board.rank, 999),
        pctChange: toNumber(board.pctChange),
        leader: String(board.leader || "")
      }
    ])
  );
}

function catalystScore(value, cap) {
  return clamp(toNumber(value), 0, cap);
}

function scoreFundamental(snapshot) {
  const profitability = scoreByThresholds(snapshot.roe, [
    { test: (value) => value >= 20, score: 12 },
    { test: (value) => value >= 15, score: 10 },
    { test: (value) => value >= 10, score: 8 },
    { test: (value) => value >= 5, score: 5 },
    { test: (value) => value > 0, score: 2 }
  ]);

  const valuationPe = scoreByThresholds(snapshot.pe, [
    { test: (value) => value > 0 && value <= 15, score: 5 },
    { test: (value) => value > 15 && value <= 25, score: 4 },
    { test: (value) => value > 25 && value <= 40, score: 3 },
    { test: (value) => value > 40 && value <= 60, score: 2 },
    { test: (value) => value > 60, score: 1 }
  ]);

  const valuationPb = scoreByThresholds(snapshot.pb, [
    { test: (value) => value > 0 && value <= 2, score: 3 },
    { test: (value) => value > 2 && value <= 4, score: 2.5 },
    { test: (value) => value > 4 && value <= 8, score: 2 },
    { test: (value) => value > 8, score: 1 }
  ]);

  const liquidityQuality =
    scoreByThresholds(snapshot.amount, [
      { test: (value) => value >= 5e9, score: 6 },
      { test: (value) => value >= 2e9, score: 5 },
      { test: (value) => value >= 1e9, score: 4 },
      { test: (value) => value >= 5e8, score: 3 },
      { test: (value) => value >= 2e8, score: 2 }
    ]) +
    scoreByThresholds(snapshot.floatCap, [
      { test: (value) => value >= 2e11, score: 4 },
      { test: (value) => value >= 5e10, score: 3 },
      { test: (value) => value >= 1e10, score: 2 },
      { test: (value) => value > 0, score: 1 }
    ]);

  return {
    score: clamp(profitability + valuationPe + valuationPb + liquidityQuality, 0, 30),
    components: {
      profitability,
      valuationPe,
      valuationPb,
      liquidityQuality
    }
  };
}

function scoreTechnical(snapshot, technical) {
  const trend = clamp(
    (technical.close > technical.ma20 ? 4 : 1) +
      (technical.ma20 > technical.ma60 ? 3 : 1) +
      (toNumber(technical.change20) > 0 ? 1 : 0),
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

  return {
    score: clamp(trend + momentum + location, 0, 20),
    components: { trend, momentum, location }
  };
}

function scoreCapital(snapshot) {
  const hasInflow = Number.isFinite(snapshot.mainNetInflow);
  const inflowRatio = hasInflow ? ratio(snapshot.mainNetInflow, snapshot.amount) * 100 : null;
  const inflow = hasInflow
    ? scoreByThresholds(inflowRatio, [
        { test: (value) => value >= 8, score: 8 },
        { test: (value) => value >= 4, score: 6 },
        { test: (value) => value >= 1, score: 4 },
        { test: (value) => value > -1, score: 2 },
        { test: (value) => value <= -1, score: 0.5 }
      ])
    : null;
  const turnover = scoreByThresholds(snapshot.turnoverRate, [
    { test: (value) => value >= 2 && value <= 12, score: 4 },
    { test: (value) => value > 12 && value <= 20, score: 3 },
    { test: (value) => value >= 0.5 && value < 2, score: 2 },
    { test: (value) => value > 20, score: 1.5 }
  ]);

  const liquidity = scoreByThresholds(snapshot.amount, [
    { test: (value) => value >= 5e9, score: 3 },
    { test: (value) => value >= 2e9, score: 2 },
    { test: (value) => value >= 5e8, score: 1 },
      { test: (value) => value > 0, score: 0.5 }
  ]);

  if (!hasInflow) {
    const normalized = clamp((turnover + liquidity) / 7, 0, 1) * 15;
    return {
      score: Number(normalized.toFixed(2)),
      components: {
        inflow: null,
        inflowRatio: null,
        turnover,
        liquidity,
        mode: "fallback_without_flow"
      }
    };
  }

  return {
    score: clamp(inflow + turnover + liquidity, 0, 15),
    components: {
      inflow,
      inflowRatio,
      turnover,
      liquidity
    }
  };
}

function scoreMessage(snapshot, technical, boardLookup, catalysts) {
  const board = boardLookup.get(snapshot.industry) ?? {
    rank: 999,
    pctChange: 0,
    leader: ""
  };

  const boardHeat = clamp(
    scoreByThresholds(board.rank, [
      { test: (value) => value <= 3, score: 12 },
      { test: (value) => value <= 10, score: 9 },
      { test: (value) => value <= 20, score: 6 },
      { test: (value) => value <= 40, score: 3 }
    ]) + scoreByThresholds(board.pctChange, [
      { test: (value) => value >= 5, score: 3 },
      { test: (value) => value >= 3, score: 2 },
      { test: (value) => value >= 1, score: 1 }
    ]),
    0,
    12
  );

  const stockLeadership = clamp(
    scoreByThresholds(snapshot.pctChange, [
      { test: (value) => value >= 6, score: 5 },
      { test: (value) => value >= 3, score: 4 },
      { test: (value) => value >= 1, score: 3 }
    ]) +
      (technical.freshBreakout ? 3 : 0),
    0,
    8
  );

  const stockCatalyst = catalystScore(catalysts.stock?.[snapshot.code]?.score, 10);
  const industryCatalyst = catalystScore(catalysts.industry?.[snapshot.industry]?.score, 5);

  return {
    score: clamp(boardHeat + stockLeadership + stockCatalyst + industryCatalyst, 0, 35),
    components: {
      boardHeat,
      stockLeadership,
      stockCatalyst,
      industryCatalyst,
      boardRank: board.rank,
      boardPctChange: board.pctChange,
      boardLeader: board.leader
    }
  };
}

function scoreRisk(snapshot, technical, config) {
  const reasons = [];
  let total = 0;
  let veto = false;

  if (snapshot.isSt) {
    total += config.risk.stPenalty;
    reasons.push("命中 ST / 退市风险标签");
    veto = true;
  }

  if (snapshot.amount < config.filters.minAmount) {
    total += config.risk.lowLiquidityPenalty;
    reasons.push("成交额低于默认流动性门槛");
    veto = true;
  }

  if (technical.candlesAvailable < config.filters.minHistoryDays) {
    total += config.risk.newListingPenalty;
    reasons.push("历史交易数据不足，难以稳定计算趋势");
    veto = true;
  }

  if (snapshot.pe <= 0) {
    total += config.risk.negativePePenalty;
    reasons.push("动态 PE 为负，盈利稳定性不足");
  }

  if (snapshot.roe < 5) {
    total += config.risk.lowRoePenalty;
    reasons.push("ROE 偏低，基本面支撑不足");
  }

  if (snapshot.turnoverRate > 25 && snapshot.pctChange > 8) {
    total += config.risk.overheatPenalty;
    reasons.push("高换手叠加大涨，存在短线过热风险");
  }

  if (technical.close < technical.ma20 && toNumber(technical.macdHist) <= 0) {
    total += config.risk.weakTrendPenalty;
    reasons.push("价格跌回 MA20 下方，趋势确认不足");
  }

  if (snapshot.change60d > 80) {
    total += 4;
    reasons.push("近 60 日涨幅过大，追高风险上升");
  }

  return { total: clamp(total, 0, 30), reasons, veto };
}

function buildStatus(totalScore, risk, config) {
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

function buildEvidence(snapshot, technical, message, capital, catalysts) {
  const evidence = [];
  const flowText =
    capital.components.inflowRatio === null
      ? `当前 provider 未提供主力净流入，改用换手率 ${formatPercent(snapshot.turnoverRate)} 与成交额 ${formatMoney(snapshot.amount)} 做资金确认。`
      : `主力净流入 ${formatMoney(snapshot.mainNetInflow)}，约占成交额 ${formatPercent(capital.components.inflowRatio)}；价格相对 MA20 ${technical.close > technical.ma20 ? "站上" : "跌破"}。`;

  evidence.push(
    `${snapshot.industry}板块当日涨幅 ${formatPercent(message.components.boardPctChange)}，行业热度排名第 ${message.components.boardRank}。`
  );
  evidence.push(
    `ROE ${formatNumber(snapshot.roe)}，动态PE ${formatNumber(snapshot.pe)}，近60日涨跌幅 ${formatPercent(snapshot.change60d)}。`
  );
  evidence.push(flowText);

  const stockCatalyst = catalysts.stock?.[snapshot.code];
  if (stockCatalyst?.title) {
    evidence.unshift(`${stockCatalyst.asOf || "待标注日期"}：${stockCatalyst.title}。${stockCatalyst.summary || ""}`);
  }

  return evidence.slice(0, 3);
}

function buildWhyNow(snapshot, technical) {
  const breakoutText = technical.freshBreakout ? "并伴随阶段新高确认" : "且没有出现明显破位";
  return `${snapshot.industry}板块热度居前，${snapshot.name}当日涨跌幅 ${formatPercent(snapshot.pctChange)}，近20日趋势向上${breakoutText}。`;
}

function buildTriggers(snapshot, technical) {
  return [
    `未来 2 个交易日维持在 MA20 ${formatNumber(technical.ma20)} 上方。`,
    `成交额保持在 ${formatMoney(Math.max(snapshot.amount * 0.8, 2e8))} 以上。`
  ];
}

function buildInvalidation(technical) {
  return [
    `收盘有效跌破 MA20 ${formatNumber(technical.ma20)}。`,
    "主力净流入连续转负且行业热度明显降温。"
  ];
}

function buildConfidence(status, risk, catalysts, message) {
  if (status === "剔除" && risk.veto) {
    return 85;
  }
  const catalystCount =
    (catalysts.stock ? Object.keys(catalysts.stock).length : 0) +
    (catalysts.industry ? Object.keys(catalysts.industry).length : 0);

  if (catalystCount > 0 && message.components.boardRank <= 10) {
    return 78;
  }
  if (message.components.boardRank <= 20) {
    return 68;
  }
  return 58;
}

function evaluateCandidate(snapshot, technical, boardLookup, catalysts, config, marketDate) {
  const fundamental = scoreFundamental(snapshot);
  const technicalScore = scoreTechnical(snapshot, technical);
  const capital = scoreCapital(snapshot);
  const message = scoreMessage(snapshot, technical, boardLookup, catalysts);
  const risk = scoreRisk(snapshot, technical, config);

  const totalScore = clamp(
    fundamental.score + technicalScore.score + capital.score + message.score - risk.total,
    0,
    100
  );

  const status = buildStatus(totalScore, risk, config);
  const confidence = buildConfidence(status, risk, catalysts, message);

  return {
    code: snapshot.code,
    name: snapshot.name,
    industry: snapshot.industry,
    status,
    totalScore: Number(totalScore.toFixed(2)),
    confidence,
    scores: {
      fundamental: Number(fundamental.score.toFixed(2)),
      technical: Number(technicalScore.score.toFixed(2)),
      capital: Number(capital.score.toFixed(2)),
      message: Number(message.score.toFixed(2)),
      riskDeduction: Number(risk.total.toFixed(2))
    },
    whyNow: buildWhyNow(snapshot, technical),
    evidence: buildEvidence(snapshot, technical, message, capital, catalysts),
    risks: risk.reasons.length > 0 ? risk.reasons : ["暂无显著额外风险扣分。"],
    triggers: buildTriggers(snapshot, technical),
    invalidation: buildInvalidation(technical),
    nextReviewDate: addDays(`${marketDate}T00:00:00.000Z`, status === "核心机会池" ? 1 : 3),
    raw: {
      snapshot,
      technical,
      boardRank: message.components.boardRank,
      boardPctChange: message.components.boardPctChange,
      boardLeader: message.components.boardLeader
    }
  };
}

function compareByScore(left, right) {
  return right.totalScore - left.totalScore || right.confidence - left.confidence || right.code.localeCompare(left.code);
}

function summarizePool(candidates, coreSize, watchSize) {
  const sorted = [...candidates].sort(compareByScore);
  const core = sorted.filter((candidate) => candidate.status === "核心机会池").slice(0, coreSize);
  const watch = sorted.filter((candidate) => candidate.status === "观察池").slice(0, watchSize);
  const dropped = sorted.filter((candidate) => candidate.status === "剔除");

  return { core, watch, dropped };
}

function buildReport(result) {
  const lines = [];
  lines.push("# A股机会池报告");
  lines.push("");
  lines.push(`- 市场日期：${result.meta.marketDate}`);
  lines.push(`- 刷新时间：${result.meta.generatedAt}`);
  lines.push(`- 数据模式：${result.meta.mode}`);
  lines.push(`- 核心机会池：${result.summary.coreCount}`);
  lines.push(`- 观察池：${result.summary.watchCount}`);
  lines.push(`- 剔除：${result.summary.droppedCount}`);
  lines.push(`- 说明：${result.summary.note}`);
  lines.push("");
  lines.push("## 核心机会池");
  lines.push("");
  lines.push("| 代码 | 名称 | 总分 | 基本面 | 技术面 | 资金面 | 消息面 | 风险扣分 | 行业 |");
  lines.push("| ---- | ---- | ---- | ------ | ------ | ------ | ------ | -------- | ---- |");

  for (const candidate of result.pools.core) {
    lines.push(
      `| ${candidate.code} | ${candidate.name} | ${candidate.totalScore} | ${candidate.scores.fundamental} | ${candidate.scores.technical} | ${candidate.scores.capital} | ${candidate.scores.message} | ${candidate.scores.riskDeduction} | ${candidate.industry} |`
    );
  }

  lines.push("");
  lines.push("## 观察池");
  lines.push("");
  lines.push("| 代码 | 名称 | 总分 | 行业 |");
  lines.push("| ---- | ---- | ---- | ---- |");
  for (const candidate of result.pools.watch) {
    lines.push(`| ${candidate.code} | ${candidate.name} | ${candidate.totalScore} | ${candidate.industry} |`);
  }

  lines.push("");
  lines.push("## 逐票说明");
  lines.push("");

  for (const candidate of result.pools.core) {
    lines.push(`### ${candidate.code} ${candidate.name}`);
    lines.push("");
    lines.push(`- 结论：${candidate.status}`);
    lines.push(`- 为什么是现在：${candidate.whyNow}`);
    lines.push(`- 证据：${candidate.evidence.join(" ")}`);
    lines.push(`- 主要风险：${candidate.risks.join("；")}`);
    lines.push(`- 触发条件：${candidate.triggers.join("；")}`);
    lines.push(`- 失效条件：${candidate.invalidation.join("；")}`);
    lines.push(`- 下次复核时间：${candidate.nextReviewDate}`);
    lines.push("");
  }

  if (result.pools.dropped.length > 0) {
    lines.push("## 调出或剔除");
    lines.push("");
    for (const candidate of result.pools.dropped.slice(0, 10)) {
      lines.push(`- ${candidate.code} ${candidate.name}：${candidate.risks.join("；")}`);
    }
    lines.push("");
  }

  return `${lines.join("\n")}\n`;
}

function roughScore(snapshot, boardLookup) {
  const board = boardLookup.get(snapshot.industry) ?? { rank: 999 };
  return (
    scoreByThresholds(snapshot.roe, [
      { test: (value) => value >= 20, score: 12 },
      { test: (value) => value >= 10, score: 8 },
      { test: (value) => value > 0, score: 4 }
    ]) +
    scoreByThresholds(snapshot.change60d, [
      { test: (value) => value >= 30, score: 8 },
      { test: (value) => value >= 15, score: 5 },
      { test: (value) => value >= 5, score: 3 }
    ]) +
    scoreByThresholds(Number.isFinite(snapshot.mainNetInflow) ? ratio(snapshot.mainNetInflow, snapshot.amount) * 100 : snapshot.turnoverRate, [
      { test: (value) => value >= 5, score: 6 },
      { test: (value) => value >= 1, score: 4 },
      { test: (value) => value > -1, score: 2 }
    ]) +
    scoreByThresholds(board.rank, [
      { test: (value) => value <= 5, score: 5 },
      { test: (value) => value <= 15, score: 3 },
      { test: (value) => value <= 30, score: 1 }
    ])
  );
}

function candidateEligible(snapshot, config) {
  if (!snapshot.code || !snapshot.name) {
    return false;
  }
  if (snapshot.price < config.filters.minPrice) {
    return false;
  }
  if (snapshot.amount < config.filters.minAmount / 2) {
    return false;
  }
  return true;
}

function deriveIndustryBoards(universe) {
  const aggregates = new Map();

  for (const snapshot of universe) {
    const key = snapshot.industry || "未分类";
    const current = aggregates.get(key) ?? {
      name: key,
      count: 0,
      pctChangeSum: 0,
      positiveCount: 0,
      amountSum: 0,
      leader: snapshot.name,
      leaderPctChange: snapshot.pctChange
    };

    current.count += 1;
    current.pctChangeSum += snapshot.pctChange;
    current.amountSum += snapshot.amount;

    if (snapshot.pctChange > 0) {
      current.positiveCount += 1;
    }

    if (
      snapshot.pctChange > current.leaderPctChange ||
      (snapshot.pctChange === current.leaderPctChange && snapshot.amount > current.amountSum / current.count)
    ) {
      current.leader = snapshot.name;
      current.leaderPctChange = snapshot.pctChange;
    }

    aggregates.set(key, current);
  }

  const rankedBoards = [...aggregates.values()]
    .map((aggregate) => {
      const averagePctChange = aggregate.count === 0 ? 0 : aggregate.pctChangeSum / aggregate.count;
      const positiveRatio = aggregate.count === 0 ? 0 : aggregate.positiveCount / aggregate.count;
      const heatScore = averagePctChange + positiveRatio * 2 + Math.log10(Math.max(aggregate.amountSum, 1)) * 0.1;

      return {
        name: aggregate.name,
        pctChange: Number(averagePctChange.toFixed(2)),
        heatScore,
        leader: aggregate.leader
      };
    })
    .sort((left, right) => right.heatScore - left.heatScore)
    .map((board, index) => ({
      ...board,
      rank: index + 1
    }));

  return new Map(
    rankedBoards.map((board) => [
      board.name,
      {
        name: board.name,
        rank: board.rank,
        pctChange: board.pctChange,
        leader: board.leader
      }
    ])
  );
}

async function loadSampleDataset() {
  const fixture = await readJson(PATHS.sampleFixture);
  const boardLookup = buildBoardLookup(fixture.boards);
  const candidates = fixture.stocks.map((entry) => ({
    snapshot: entry.snapshot,
    technical: entry.technical
  }));

  return {
    marketDate: fixture.asOf,
    boardLookup,
    candidates
  };
}

async function loadLiveDataset(config, shortlistSize) {
  const universe = await fetchSinaUniverse(config);
  const roughSorted = universe
    .filter((snapshot) => candidateEligible(snapshot, config))
    .map((snapshot) => ({
      snapshot,
      rough:
        scoreByThresholds(snapshot.turnoverRate, [
          { test: (value) => value >= 3 && value <= 15, score: 8 },
          { test: (value) => value >= 1, score: 5 },
          { test: (value) => value > 0, score: 2 }
        ]) +
        scoreByThresholds(snapshot.amount, [
          { test: (value) => value >= 5e9, score: 8 },
          { test: (value) => value >= 2e9, score: 6 },
          { test: (value) => value >= 1e9, score: 4 },
          { test: (value) => value >= 3e8, score: 2 }
        ]) +
        scoreByThresholds(snapshot.pctChange, [
          { test: (value) => value >= 7, score: 6 },
          { test: (value) => value >= 3, score: 4 },
          { test: (value) => value > 0, score: 2 }
        ]) +
        scoreByThresholds(snapshot.pe, [
          { test: (value) => value > 0 && value <= 25, score: 4 },
          { test: (value) => value > 25 && value <= 60, score: 2 },
          { test: (value) => value > 0, score: 1 }
        ])
    }))
    .sort((left, right) => right.rough - left.rough)
    .slice(0, shortlistSize);

  const enrichedCandidates = await mapLimit(
    roughSorted,
    config.live.klineConcurrency,
    async ({ snapshot }) => enrichSinaSnapshot(snapshot)
  );

  const enrichedSnapshots = enrichedCandidates.map((entry) => entry.snapshot);
  const boardLookup = deriveIndustryBoards(enrichedSnapshots);

  return {
    marketDate: new Date().toISOString().slice(0, 10),
    boardLookup,
    candidates: enrichedCandidates
  };
}

function latestReportPath(marketDate) {
  return path.join(PATHS.reportsDir, `${marketDate}.md`);
}

async function runScan(options = {}) {
  await ensureWorkspaceFiles();
  const config = await loadConfig();
  const catalysts = await readJson(PATHS.catalystOverrides);

  const mode = options.mode ?? "live";
  const shortlistSize = toNumber(options.shortlistSize, config.pool.shortlistSize);
  const coreSize = toNumber(options.coreSize, config.pool.coreSize);
  const watchSize = toNumber(options.watchSize, config.pool.watchSize);

  let dataset;
  const warnings = [];

  if (mode === "sample") {
    dataset = await loadSampleDataset();
    warnings.push("当前为样例数据，仅用于验证技能流程。");
  } else {
    dataset = await loadLiveDataset(config, shortlistSize);
  }

  const evaluated = dataset.candidates.map(({ snapshot, technical }) =>
    evaluateCandidate(snapshot, technical, dataset.boardLookup, catalysts, config, dataset.marketDate)
  );

  const pools = summarizePool(evaluated, coreSize, watchSize);
  const result = {
    meta: {
      generatedAt: nowIso(),
      marketDate: dataset.marketDate,
      mode,
      configVersion: config.version,
      candidatesScanned: evaluated.length,
      warnings
    },
    summary: {
      coreCount: pools.core.length,
      watchCount: pools.watch.length,
      droppedCount: pools.dropped.length,
      note:
        mode === "sample"
          ? "样例模式，用于验证技能闭环。"
          : "live 模式，基于公开行情接口和零依赖脚本生成。"
    },
    pools
  };

  const outputPath = options.output ? path.resolve(ROOT, options.output) : PATHS.outputJson;
  const reportPath = latestReportPath(dataset.marketDate);
  await writeJson(outputPath, result);
  await writeText(reportPath, buildReport(result));

  return { result, outputPath, reportPath };
}

async function runInit() {
  await ensureWorkspaceFiles();
  return {
    created: [PATHS.catalystOverrides, PATHS.reportsDir, path.dirname(PATHS.outputJson)]
  };
}

function printHelp() {
  console.log(`A-share Opportunity Pool

Usage:
  node ./scripts/a_share_opportunity_pool.mjs init
  node ./scripts/a_share_opportunity_pool.mjs scan [--mode live|sample] [--shortlist-size 80] [--core-size 10] [--watch-size 20]

Examples:
  node ./scripts/a_share_opportunity_pool.mjs scan --mode sample
  node ./scripts/a_share_opportunity_pool.mjs scan --mode live --core-size 8 --watch-size 15
`);
}

async function cli() {
  const { positional, flags } = parseArgs(process.argv.slice(2));
  const command = positional[0] ?? "scan";

  if (command === "help" || flags.has("--help")) {
    printHelp();
    return;
  }

  if (command === "init") {
    const result = await runInit();
    console.log(JSON.stringify(result, null, 2));
    return;
  }

  if (command === "scan") {
    const { result, outputPath, reportPath } = await runScan({
      mode: String(getFlag(flags, "--mode", "live")),
      shortlistSize: getFlag(flags, "--shortlist-size"),
      coreSize: getFlag(flags, "--core-size"),
      watchSize: getFlag(flags, "--watch-size"),
      output: getFlag(flags, "--output")
    });

    console.log(
      JSON.stringify(
        {
          ok: true,
          mode: result.meta.mode,
          marketDate: result.meta.marketDate,
          outputPath,
          reportPath,
          summary: result.summary,
          warnings: result.meta.warnings
        },
        null,
        2
      )
    );
    return;
  }

  throw new Error(`Unsupported command: ${command}`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === __filename) {
  cli().catch((error) => {
    console.error(error.stack || error.message);
    process.exit(1);
  });
}

export { PATHS, buildReport, ensureWorkspaceFiles, loadConfig, runInit, runScan };
