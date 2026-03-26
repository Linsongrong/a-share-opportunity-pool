#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import process from "node:process";
import {
  PATHS,
  deriveIndustryBoards,
  deriveThemeLookup,
  enforceIndustryConcentration,
  ensureWorkspaceFiles,
  runScan
} from "./a_share_opportunity_pool.mjs";

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

function parseArgs(argv) {
  const flags = new Set(argv);
  return {
    live: flags.has("--live")
  };
}

async function readUtf8(filePath) {
  return readFile(filePath, "utf8");
}

async function validateSkillDoc() {
  const skillDoc = await readUtf8(PATHS.skill);
  assert(skillDoc.includes("node .\\scripts\\a_share_opportunity_pool.mjs scan --mode live"), "SKILL.md 缺少 live 扫描命令。");
  assert(skillDoc.includes("data/opportunity_pool/latest.json"), "SKILL.md 缺少 latest.json 路径说明。");
  assert(skillDoc.includes("catalyst_overrides.json"), "SKILL.md 缺少 catalyst_overrides.json 路径说明。");
}

function validateIndustryConcentrationLogic() {
  const config = {
    pool: {
      maxPerIndustry: 2,
      secondNameMaxGap: 5
    }
  };

  const { kept, dropped } = enforceIndustryConcentration(
    [
      {
        code: "000001",
        name: "Leader",
        industry: "TestIndustry",
        status: "核心机会池",
        totalScore: 80,
        trendLabel: "uptrend",
        concepts: ["A", "B"],
        risks: [],
        raw: { narrativeThemes: [{ name: "ThemeA" }] }
      },
      {
        code: "000002",
        name: "Second",
        industry: "TestIndustry",
        status: "核心机会池",
        totalScore: 76,
        trendLabel: "rebound",
        concepts: ["C", "D"],
        risks: [],
        raw: { narrativeThemes: [{ name: "ThemeB" }] }
      },
      {
        code: "000003",
        name: "Third",
        industry: "TestIndustry",
        status: "核心机会池",
        totalScore: 70,
        trendLabel: "uptrend",
        concepts: ["A", "B"],
        risks: [],
        raw: { narrativeThemes: [{ name: "ThemeA" }] }
      },
      {
        code: "000004",
        name: "GapLeader",
        industry: "GapIndustry",
        status: "核心机会池",
        totalScore: 79,
        trendLabel: "uptrend",
        concepts: ["P", "Q"],
        risks: [],
        raw: { narrativeThemes: [{ name: "ThemeP" }] }
      },
      {
        code: "000005",
        name: "GapSecond",
        industry: "GapIndustry",
        status: "核心机会池",
        totalScore: 72,
        trendLabel: "rebound",
        concepts: ["X", "Y"],
        risks: [],
        raw: { narrativeThemes: [{ name: "ThemeX" }] }
      }
    ],
    config
  );

  const keptCodes = new Set(kept.map((candidate) => candidate.code));
  const droppedCodes = new Set(dropped.map((candidate) => candidate.code));

  assert(keptCodes.has("000001"), "行业龙头未被保留。");
  assert(keptCodes.has("000002"), "分差合理且差异化的第 2 只未被保留。");
  assert(droppedCodes.has("000003"), "同一行业第 3 只标的未被剔除。");
  assert(droppedCodes.has("000005"), "与第 1 名分差过大的第 2 只标的未被剔除。");
}

function validateLeaderTieBreak() {
  const universe = [
    {
      name: "PrimaryLeader",
      industry: "TestIndustry",
      pctChange: 5,
      amount: 1000,
      concepts: ["ThemeX"]
    },
    {
      name: "LowerAmountFollower",
      industry: "TestIndustry",
      pctChange: 5,
      amount: 800,
      concepts: ["ThemeX"]
    },
    {
      name: "AverageBeaterOnly",
      industry: "TestIndustry",
      pctChange: 5,
      amount: 900,
      concepts: ["ThemeX"]
    }
  ];

  const boardLookup = deriveIndustryBoards(universe);
  const themeLookup = deriveThemeLookup(universe);

  assert(boardLookup.get("TestIndustry")?.leader === "PrimaryLeader", "行业龙头在同涨幅 tie-break 下被错误替换。");
  assert(themeLookup.get("ThemeX")?.leader === "PrimaryLeader", "题材龙头在同涨幅 tie-break 下被错误替换。");
}

async function validateHistoryTransitions() {
  const stateKey = `sample-history-validation-${Date.now()}`;
  const firstRun = await runScan({
    mode: "sample",
    stateKey,
    coreSize: 4,
    watchSize: 6
  });
  const secondRun = await runScan({
    mode: "sample",
    stateKey,
    coreSize: 1,
    watchSize: 1
  });

  const firstRunCandidates = firstRun.result.pools.core.concat(firstRun.result.pools.watch);
  assert(firstRunCandidates.some((candidate) => candidate.isNew === true), "首次扫描未标记任何 isNew 候选。");
  assert(
    secondRun.result.pools.dropped.some(
      (candidate) => candidate.isDropped === true && candidate.previousScore !== null
    ),
    "二次扫描未标记带 previousScore 的 isDropped 候选。"
  );
}

function assertPoolConstraints(result, label) {
  const pooled = result.pools.core.concat(result.pools.watch);
  const all = pooled.concat(result.pools.dropped);

  assert(pooled.every((candidate) => typeof candidate.industryRank === "number"), `${label} 缺少 industryRank。`);
  assert(
    Object.values(
      pooled.reduce((accumulator, candidate) => {
        accumulator[candidate.industry] = (accumulator[candidate.industry] ?? 0) + 1;
        return accumulator;
      }, {})
    ).every((count) => count <= 2),
    `${label} 未满足同一行业最多 2 只。`
  );
  assert(pooled.every((candidate) => typeof candidate.trendLabel === "string"), `${label} 缺少 trendLabel。`);
  assert(pooled.every((candidate) => candidate.targetEntryRange?.label), `${label} 缺少 targetEntryRange。`);
  assert(pooled.every((candidate) => typeof candidate.entryRangeStatus === "string"), `${label} 缺少 entryRangeStatus。`);
  assert(all.every((candidate) => "previousScore" in candidate), `${label} 缺少 previousScore。`);
  assert(all.every((candidate) => "scoreChange" in candidate), `${label} 缺少 scoreChange。`);
  assert(all.every((candidate) => typeof candidate.isNew === "boolean"), `${label} 缺少 isNew。`);
  assert(all.every((candidate) => typeof candidate.isDropped === "boolean"), `${label} 缺少 isDropped。`);
}

async function validateSampleRun() {
  const stateKey = `sample-validation-${Date.now()}`;
  await runScan({
    mode: "sample",
    stateKey,
    coreSize: 4,
    watchSize: 6
  });
  const { result, outputPath, reportPath } = await runScan({
    mode: "sample",
    stateKey,
    coreSize: 4,
    watchSize: 6
  });

  assert(result.meta.mode === "sample", "sample 模式没有写入 sample 标记。");
  assert(result.summary.coreCount >= 1, "sample 模式没有生成核心机会池。");
  assert(result.summary.watchCount >= 1, "sample 模式没有生成观察池。");
  assert(await fileExists(outputPath), "sample 模式没有生成 latest.json。");
  assert(await fileExists(reportPath), "sample 模式没有生成 Markdown 报告。");

  const raw = JSON.parse(await readUtf8(outputPath));
  assert(Array.isArray(raw.pools.core), "latest.json 里的核心池格式不正确。");
  assert(raw.pools.core[0].evidence.length >= 1, "核心池股票缺少 evidence。");
  assert(raw.meta.preselection !== null, "sample 模式缺少 preselection。");
  assert(Array.isArray(raw.meta.providersUsed), "sample 模式缺少 providersUsed。");
  assertPoolConstraints(raw, "sample 模式");
  assert(raw.pools.core.concat(raw.pools.watch).some((candidate) => candidate.previousScore !== null), "sample 模式第二次扫描后未产生 previousScore。");

  return {
    outputPath,
    reportPath,
    summary: result.summary
  };
}

async function validateLiveRun() {
  const stateKey = `live-validation-${Date.now()}`;
  await runScan({
    mode: "live",
    stateKey,
    shortlistSize: 40,
    coreSize: 6,
    watchSize: 10
  });
  const { result, outputPath, reportPath } = await runScan({
    mode: "live",
    stateKey,
    shortlistSize: 40,
    coreSize: 6,
    watchSize: 10
  });

  assert(result.meta.mode === "live", "live 模式没有写入 live 标记。");
  assert(result.meta.candidatesScanned > 0, "live 模式没有扫描到候选股票。");
  assert(result.summary.coreCount + result.summary.watchCount >= 1, "live 模式没有生成任何机会池结果。");
  assert(await fileExists(outputPath), "live 模式没有生成 latest.json。");
  assert(await fileExists(reportPath), "live 模式没有生成 Markdown 报告。");
  assert(result.meta.preselection !== null, "live 模式缺少 preselection。");
  assert(Array.isArray(result.meta.providersUsed), "live 模式缺少 providersUsed。");
  assert(Array.isArray(result.meta.fallbackEvents), "live 模式缺少 fallbackEvents。");
  assertPoolConstraints(result, "live 模式");
  assert(
    result.pools.core.concat(result.pools.watch).some((candidate) => candidate.previousScore !== null),
    "live 模式第二次扫描后未产生 previousScore。"
  );

  return {
    outputPath,
    reportPath,
    summary: result.summary
  };
}

async function main() {
  const { live } = parseArgs(process.argv.slice(2));
  await ensureWorkspaceFiles();
  validateIndustryConcentrationLogic();
  validateLeaderTieBreak();
  await validateSkillDoc();
  await validateHistoryTransitions();

  const sample = await validateSampleRun();
  const response = {
    ok: true,
    sample
  };

  if (live) {
    response.live = await validateLiveRun();
  }

  console.log(JSON.stringify(response, null, 2));
}

main().catch((error) => {
  console.error(error.stack || error.message);
  process.exit(1);
});
