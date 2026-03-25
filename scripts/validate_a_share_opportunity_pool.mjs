#!/usr/bin/env node

import { access, readFile } from "node:fs/promises";
import process from "node:process";
import { PATHS, ensureWorkspaceFiles, runScan } from "./a_share_opportunity_pool.mjs";

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
  assert(skillDoc.includes("catalyst_overrides.json"), "SKILL.md 缺少催化覆盖文件说明。");
}

async function validateSampleRun() {
  const { result, outputPath, reportPath } = await runScan({ mode: "sample", coreSize: 4, watchSize: 6 });
  assert(result.meta.mode === "sample", "样例模式没有写入 sample 标记。");
  assert(result.summary.coreCount >= 1, "样例模式没有生成核心机会池。");
  assert(result.summary.watchCount >= 1, "样例模式没有生成观察池。");
  assert(await fileExists(outputPath), "样例模式没有生成 latest.json。");
  assert(await fileExists(reportPath), "样例模式没有生成 Markdown 报告。");

  const raw = JSON.parse(await readUtf8(outputPath));
  assert(Array.isArray(raw.pools.core), "latest.json 里的核心池格式不正确。");
  assert(raw.pools.core[0].evidence.length >= 1, "核心池股票缺少证据字段。");
  assert(raw.meta.preselection !== null, "sample 模式缺少初筛解释信息。");
  assert(typeof raw.pools.core[0].confidence === "number", "核心池股票缺少置信度字段。");
  assert(Array.isArray(raw.meta.providersUsed), "sample 模式缺少 providersUsed 元数据。");

  return {
    outputPath,
    reportPath,
    summary: result.summary
  };
}

async function validateLiveRun() {
  const { result, outputPath, reportPath } = await runScan({
    mode: "live",
    shortlistSize: 40,
    coreSize: 6,
    watchSize: 10
  });

  assert(result.meta.mode === "live", "live 模式没有写入 live 标记。");
  assert(result.meta.candidatesScanned > 0, "live 模式没有扫描到候选股票。");
  assert(result.summary.coreCount + result.summary.watchCount >= 1, "live 模式没有生成任何机会池结果。");
  assert(await fileExists(outputPath), "live 模式没有生成 latest.json。");
  assert(await fileExists(reportPath), "live 模式没有生成 Markdown 报告。");
  assert(result.meta.preselection !== null, "live 模式缺少初筛解释信息。");
  assert(Array.isArray(result.meta.providersUsed), "live 模式缺少 providersUsed 元数据。");
  assert(Array.isArray(result.meta.fallbackEvents), "live 模式缺少 fallbackEvents 元数据。");

  return {
    outputPath,
    reportPath,
    summary: result.summary
  };
}

async function main() {
  const { live } = parseArgs(process.argv.slice(2));
  await ensureWorkspaceFiles();
  await validateSkillDoc();
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
