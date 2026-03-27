#!/usr/bin/env node

import { access, readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import {
  PATHS,
  currentMarketDate,
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

async function captureFileSnapshot(filePath) {
  if (!(await fileExists(filePath))) {
    return {
      exists: false,
      mtimeMs: null,
      content: null
    };
  }

  const fileStat = await stat(filePath);
  return {
    exists: true,
    mtimeMs: fileStat.mtimeMs,
    content: await readUtf8(filePath)
  };
}

async function captureFormalReportInventory() {
  try {
    const entries = await readdir(PATHS.reportsDir, { withFileTypes: true });
    const reports = [];
    for (const entry of entries.filter((candidate) => candidate.isFile() && candidate.name.endsWith(".md"))) {
      const reportPath = path.join(PATHS.reportsDir, entry.name);
      const reportStat = await stat(reportPath);
      reports.push({
        name: entry.name,
        mtimeMs: reportStat.mtimeMs
      });
    }
    return reports.sort((left, right) => left.name.localeCompare(right.name));
  } catch {
    return [];
  }
}

function assertSnapshotUnchanged(before, after, label) {
  assert(before.exists === after.exists, `${label} 的存在状态发生变化。`);
  if (!before.exists && !after.exists) {
    return;
  }

  assert(before.mtimeMs === after.mtimeMs, `${label} 的修改时间发生变化。`);
  assert(before.content === after.content, `${label} 的内容发生变化。`);
}

function assertArrayEqual(left, right, label) {
  assert(JSON.stringify(left) === JSON.stringify(right), `${label} 发生变化。`);
}

async function validateSkillDoc() {
  const skillDoc = await readUtf8(PATHS.skill);
  assert(skillDoc.includes("node .\\scripts\\a_share_opportunity_pool.mjs scan --mode live"), "SKILL.md 缺少 live 扫描命令。");
  assert(skillDoc.includes("data/opportunity_pool/latest.json"), "SKILL.md 缺少 latest.json 路径说明。");
  assert(skillDoc.includes("catalyst_overrides.json"), "SKILL.md 缺少 catalyst_overrides.json 路径说明。");
  assert(skillDoc.includes("validation 产物会写到隔离目录"), "SKILL.md 缺少 validation 隔离说明。");
  assert(skillDoc.includes("不会覆盖正式 `latest.json`"), "SKILL.md 缺少不会覆盖正式 latest.json 的说明。");
  assert(skillDoc.includes("meta.dataQuality"), "SKILL.md 缺少 dataQuality 读取说明。");
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
  const latestBefore = await captureFileSnapshot(PATHS.outputJson);
  const reportInventoryBefore = await captureFormalReportInventory();
  const firstRun = await runScan({
    mode: "sample",
    coreSize: 4,
    watchSize: 6
  });
  const { result, outputPath, reportPath, statePath, artifactProfile } = await runScan({
    mode: "sample",
    stateKey: firstRun.result.meta.historyStateMode,
    coreSize: 4,
    watchSize: 6
  });
  const validationRunId = firstRun.result.meta.validationRunId;

  assert(firstRun.result.meta.mode === "sample", "sample 模式没有写入 sample 标记。");
  assert(firstRun.result.meta.artifactProfile === "validation", "sample 默认未写入 validation artifactProfile。");
  assert(typeof validationRunId === "string" && validationRunId.length > 0, "sample 默认未生成 validationRunId。");
  assert(firstRun.result.meta.historyStateMode === validationRunId, "sample 默认 stateKey 应与 validationRunId 对齐。");
  assert(firstRun.outputPath === path.join(PATHS.validationDataDir, validationRunId, "latest.json"), "sample 默认 latest.json 路径不正确。");
  assert(firstRun.reportPath === path.join(PATHS.validationReportsDir, validationRunId, `${firstRun.result.meta.marketDate}.md`), "sample 默认报告路径不正确。");
  assert(firstRun.statePath === path.join(PATHS.validationStateDir, `${validationRunId}.json`), "sample 默认 state 路径不正确。");

  assert(result.meta.mode === "sample", "sample 二次扫描没有写入 sample 标记。");
  assert(result.meta.artifactProfile === "validation", "sample validation 未写入 validation artifactProfile。");
  assert(artifactProfile === "validation", "sample validate 返回的 artifactProfile 不正确。");
  assert(result.summary.coreCount >= 1, "sample 模式没有生成核心机会池。");
  assert(result.summary.watchCount >= 1, "sample 模式没有生成观察池。");
  assert(await fileExists(outputPath), "sample 模式没有生成 latest.json。");
  assert(await fileExists(reportPath), "sample 模式没有生成 Markdown 报告。");
  assert(await fileExists(statePath), "sample validation 未生成隔离 state。");
  assert(statePath === firstRun.statePath, "sample 二次扫描应复用显式 stateKey 的隔离 state。");

  const raw = JSON.parse(await readUtf8(outputPath));
  const reportText = await readUtf8(reportPath);
  assert(Array.isArray(raw.pools.core), "latest.json 里的核心池格式不正确。");
  assert(raw.pools.core[0].evidence.length >= 1, "核心池股票缺少 evidence。");
  assert(raw.meta.preselection !== null, "sample 模式缺少 preselection。");
  assert(Array.isArray(raw.meta.providersUsed), "sample 模式缺少 providersUsed。");
  assert(raw.summary.note.includes("当前为样例数据，不代表实时市场"), "sample summary.note 缺少非实时市场免责声明。");
  assert(reportText.includes("当前为样例数据，不代表实时市场"), "sample 报告缺少非实时市场免责声明。");
  assertPoolConstraints(raw, "sample 模式");
  assert(raw.pools.core.concat(raw.pools.watch).some((candidate) => candidate.previousScore !== null), "sample 模式第二次扫描后未产生 previousScore。");

  const latestAfter = await captureFileSnapshot(PATHS.outputJson);
  const reportInventoryAfter = await captureFormalReportInventory();
  assertSnapshotUnchanged(latestBefore, latestAfter, "正式 latest.json");
  assertArrayEqual(reportInventoryBefore, reportInventoryAfter, "正式日报目录");

  return {
    outputPath: firstRun.outputPath,
    reportPath: firstRun.reportPath,
    statePath: firstRun.statePath,
    artifactProfile,
    validationRunId,
    summary: result.summary
  };
}

async function validateSampleOutputOverride() {
  const outputRelativePath = path.join("data", "opportunity_pool", "validation", `override-${Date.now()}.json`);
  const expectedOutputPath = path.resolve(PATHS.root, outputRelativePath);
  const { outputPath, result } = await runScan({
    mode: "sample",
    output: outputRelativePath,
    coreSize: 4,
    watchSize: 6
  });

  assert(result.meta.artifactProfile === "validation", "sample output override 不应改变 validation artifactProfile。");
  assert(outputPath === expectedOutputPath, "sample --output 未生效。");
  assert(await fileExists(outputPath), "sample --output 目标文件未生成。");
}

async function validateLiveRun() {
  const stateKey = `live-validation-${Date.now()}`;
  const validationRunId = `live-validation-${Date.now()}`;
  const latestBefore = await captureFileSnapshot(PATHS.outputJson);
  const reportInventoryBefore = await captureFormalReportInventory();
  const expectedMarketDate = currentMarketDate();
  const archivePath = path.join(PATHS.archiveLiveDir, `${expectedMarketDate}.json`);
  const archiveBefore = await captureFileSnapshot(archivePath);
  await runScan({
    mode: "live",
    stateKey,
    artifactProfile: "validation",
    validationRunId,
    shortlistSize: 40,
    coreSize: 6,
    watchSize: 10
  });
  const { result, outputPath, reportPath, statePath, artifactProfile, archivePath: writtenArchivePath } = await runScan({
    mode: "live",
    stateKey,
    artifactProfile: "validation",
    validationRunId,
    shortlistSize: 40,
    coreSize: 6,
    watchSize: 10
  });

  assert(result.meta.mode === "live", "live 模式没有写入 live 标记。");
  assert(result.meta.artifactProfile === "validation", "live validation 未写入 validation artifactProfile。");
  assert(result.meta.validationRunId === validationRunId, "live validationRunId 未写入结果元数据。");
  assert(artifactProfile === "validation", "live validate 返回的 artifactProfile 不正确。");
  assert(result.meta.candidatesScanned > 0, "live 模式没有扫描到候选股票。");
  assert(result.summary.coreCount + result.summary.watchCount >= 1, "live 模式没有生成任何机会池结果。");
  assert(await fileExists(outputPath), "live 模式没有生成 latest.json。");
  assert(await fileExists(reportPath), "live 模式没有生成 Markdown 报告。");
  assert(await fileExists(statePath), "live validation 未生成隔离 state。");
  assert(outputPath === path.join(PATHS.validationDataDir, validationRunId, "latest.json"), "live validation latest.json 路径不正确。");
  assert(reportPath === path.join(PATHS.validationReportsDir, validationRunId, `${result.meta.marketDate}.md`), "live validation 报告路径不正确。");
  assert(statePath === path.join(PATHS.validationStateDir, `${stateKey}.json`), "live validation state 路径不正确。");
  assert(writtenArchivePath === null, "live validation 不应写正式 archive。");
  assert(result.meta.preselection !== null, "live 模式缺少 preselection。");
  assert(Array.isArray(result.meta.providersUsed), "live 模式缺少 providersUsed。");
  assert(Array.isArray(result.meta.fallbackEvents), "live 模式缺少 fallbackEvents。");
  assert(result.meta.dataQuality && typeof result.meta.dataQuality.level === "string", "live 模式缺少 dataQuality。");
  assert(result.meta.dataFreshness?.universe, "live 模式缺少 universe dataFreshness。");
  assert(result.meta.fallbackSummary && typeof result.meta.fallbackSummary.warningCount === "number", "live 模式缺少 fallbackSummary。");
  assertPoolConstraints(result, "live 模式");
  assert(
    result.pools.core.concat(result.pools.watch).some((candidate) => candidate.previousScore !== null),
    "live 模式第二次扫描后未产生 previousScore。"
  );

  const latestAfter = await captureFileSnapshot(PATHS.outputJson);
  const reportInventoryAfter = await captureFormalReportInventory();
  const archiveAfter = await captureFileSnapshot(archivePath);
  assertSnapshotUnchanged(latestBefore, latestAfter, "正式 latest.json");
  assertArrayEqual(reportInventoryBefore, reportInventoryAfter, "正式日报目录");
  assertSnapshotUnchanged(archiveBefore, archiveAfter, "正式 live archive");

  return {
    outputPath,
    reportPath,
    statePath,
    artifactProfile,
    validationRunId,
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
  await validateSampleOutputOverride();
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
