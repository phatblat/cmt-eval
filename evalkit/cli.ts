#!/usr/bin/env bun
// Subcommand dispatch for the evalkit CLI.

import { parseArgs } from "node:util";
import { join, resolve } from "node:path";
import { loadSuite } from "./suite.ts";
import { priceRun, type TokenTotals } from "./models.ts";
import { buildCells, runSuite, updateLatestSymlink, writeMeta, type ResultRow, type RunMeta } from "./runner.ts";
import { renderReport, consoleSummary } from "./report/render.ts";
import { mean } from "./report/aggregate.ts";
import { formatHits, scanAllFixtures } from "./secrets.ts";
import { buildFixtures, verifyFixtures } from "../tasks/git-commit/build.ts";

const RUNS_DIR = resolve("runs");
const SUITES_DIR = resolve("suites");
const GIT_COMMIT_FIXTURES_DIR = resolve("tasks/git-commit/fixtures");

async function readResultsJsonl(path: string): Promise<ResultRow[]> {
  const text = await Bun.file(path).text();
  return text
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line) as ResultRow);
}

function fmtDuration(totalSeconds: number): string {
  const h = Math.floor(totalSeconds / 3600);
  const m = Math.round((totalSeconds % 3600) / 60);
  return h > 0 ? `${h}h${m}m` : `${m}m`;
}

// ---------------------------------------------------------------------------
// build-fixtures / verify-fixtures / scan
// ---------------------------------------------------------------------------

async function cmdBuildFixtures(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { source: { type: "string", default: "~" }, id: { type: "string", default: "all" } },
  });
  await buildFixtures({ source: values.source!, id: values.id! });
}

async function cmdVerifyFixtures(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { id: { type: "string", default: "all" } } });
  await verifyFixtures({ id: values.id! });
}

async function cmdScan(): Promise<void> {
  const hits = await scanAllFixtures(GIT_COMMIT_FIXTURES_DIR);
  if (hits.length > 0) {
    console.error(formatHits(hits));
    console.error(`\nsecret scan found ${hits.length} hit(s)`);
    process.exit(1);
  }
  console.log("secret scan clean (0 hits)");
}

// ---------------------------------------------------------------------------
// estimate
// ---------------------------------------------------------------------------

const DEFAULT_TOKEN_PROFILE: TokenTotals = { input: 200, output: 2500, cacheRead: 120000, cacheWrite: 48000 };

async function loadTokenProfiles(profileFrom: string | undefined): Promise<Map<string, TokenTotals>> {
  const perModel = new Map<string, TokenTotals>();
  if (!profileFrom) return perModel;
  const rows = (await readResultsJsonl(join(RUNS_DIR, profileFrom, "results.jsonl"))).filter((r) => r.status === "ok");
  const byModel = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const list = byModel.get(row.model);
    if (list) {
      list.push(row);
    } else {
      byModel.set(row.model, [row]);
    }
  }
  for (const [model, modelRows] of byModel) {
    perModel.set(model, {
      input: mean(modelRows.map((r) => r.tokensInput)),
      output: mean(modelRows.map((r) => r.tokensOutput)),
      cacheRead: mean(modelRows.map((r) => r.tokensCacheRead)),
      cacheWrite: mean(modelRows.map((r) => r.tokensCacheWrite)),
    });
  }
  return perModel;
}

async function cmdEstimate(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: { suite: { type: "string" }, "profile-from": { type: "string" } },
  });
  if (!values.suite) throw new Error("estimate requires --suite <name>");

  const suite = await loadSuite(join(SUITES_DIR, `${values.suite}.toml`));
  const cells = buildCells(suite);
  const profiles = await loadTokenProfiles(values["profile-from"]);

  const runsByProvider = new Map<string, number>();
  const costByModel = new Map<string, number>();
  let totalCost = 0;
  for (const cell of cells) {
    runsByProvider.set(cell.provider, (runsByProvider.get(cell.provider) ?? 0) + 1);
    const profile = profiles.get(cell.model.selector) ?? DEFAULT_TOKEN_PROFILE;
    const cost = priceRun(cell.model, profile);
    totalCost += cost;
    costByModel.set(cell.model.selector, (costByModel.get(cell.model.selector) ?? 0) + cost);
  }

  console.log(`Suite: ${suite.name} (task=${suite.config.task})`);
  console.log(`Total runs: ${cells.length}`);
  console.log("Per-provider run counts:");
  for (const [provider, count] of [...runsByProvider.entries()].sort()) {
    console.log(`  ${provider}: ${count}`);
  }
  console.log("Projected spend by model:");
  for (const [model, cost] of [...costByModel.entries()].sort()) {
    console.log(`  ${model}: $${cost.toFixed(2)}`);
  }
  console.log(`Total projected spend: $${totalCost.toFixed(2)}`);

  const maxCellsPerProvider = Math.max(0, ...runsByProvider.values());
  const wallLow = maxCellsPerProvider * 60;
  const wallHigh = maxCellsPerProvider * 120;
  console.log(
    `Estimated wall clock (${runsByProvider.size} concurrent providers, serialized within each): ${fmtDuration(wallLow)}\u2013${fmtDuration(wallHigh)}`,
  );
}

// ---------------------------------------------------------------------------
// eval
// ---------------------------------------------------------------------------

async function cmdEval(args: string[]): Promise<void> {
  const { values } = parseArgs({
    args,
    options: {
      suite: { type: "string" },
      jobs: { type: "string" },
      "keep-repos": { type: "boolean", default: false },
    },
  });
  if (!values.suite) throw new Error("eval requires --suite <name>");

  const suite = await loadSuite(join(SUITES_DIR, `${values.suite}.toml`));
  const providerCount = new Set(suite.modelInfos.map((m) => m.provider)).size;
  const jobs = values.jobs ? Number(values.jobs) : providerCount;

  const runId = new Date().toISOString().replace(/[:.]/g, "-");
  const suiteRunDir = join(RUNS_DIR, runId);
  const startedAt = new Date().toISOString();

  console.log(`Starting eval run ${runId} (suite=${suite.name}, jobs=${jobs})`);
  const rows = await runSuite(suite, {
    runId,
    suiteRunDir,
    jobs,
    keepRepos: values["keep-repos"],
    onResult: (row) => {
      console.log(`  [${row.status.padEnd(7)}] ${row.cellId} composite=${row.composite.toFixed(3)} wall=${row.wallS.toFixed(1)}s cost=$${row.costUsd.toFixed(4)}`);
    },
  });
  const finishedAt = new Date().toISOString();

  const meta: RunMeta = await writeMeta(suite, { runId, suiteRunDir, jobs, startedAt, finishedAt, projectRoot: process.cwd() });
  updateLatestSymlink(RUNS_DIR, runId);
  await renderReport({ suiteRunDir, rows, meta });

  console.log(consoleSummary(rows));
  console.log(`Report: ${join(suiteRunDir, "report.md")}`);
}

// ---------------------------------------------------------------------------
// report
// ---------------------------------------------------------------------------

async function cmdReport(args: string[]): Promise<void> {
  const { values } = parseArgs({ args, options: { run: { type: "string", default: "latest" } } });
  const suiteRunDir = join(RUNS_DIR, values.run!);
  const rows = await readResultsJsonl(join(suiteRunDir, "results.jsonl"));
  const meta = JSON.parse(await Bun.file(join(suiteRunDir, "meta.json")).text()) as RunMeta;

  await renderReport({ suiteRunDir, rows, meta });
  console.log(consoleSummary(rows));
  console.log(`Report: ${join(suiteRunDir, "report.md")}`);
}

// ---------------------------------------------------------------------------
// dispatch
// ---------------------------------------------------------------------------

const USAGE = `Usage: evalkit <command> [options]

Commands:
  build-fixtures --source <path> --id <id|all>   Mine fixtures from a source repo's history
  verify-fixtures --id <id|all>                  Round-trip verify built fixtures
  scan                                           Secret-scan built fixtures
  estimate --suite <name> [--profile-from <id>]  Project run count, cost, and wall clock
  eval --suite <name> [--jobs N] [--keep-repos]  Run a suite and write runs/<runId>/
  report [--run <id|latest>]                     Re-render results.csv/report.md/report.html/charts`;

async function main(): Promise<void> {
  const [sub, ...rest] = process.argv.slice(2);
  switch (sub) {
    case "build-fixtures":
      return cmdBuildFixtures(rest);
    case "verify-fixtures":
      return cmdVerifyFixtures(rest);
    case "scan":
      return cmdScan();
    case "estimate":
      return cmdEstimate(rest);
    case "eval":
      return cmdEval(rest);
    case "report":
      return cmdReport(rest);
    default:
      console.error(USAGE);
      process.exit(sub === undefined ? 0 : 1);
  }
}

if (import.meta.main) {
  main().catch((err: unknown) => {
    console.error(err instanceof Error ? err.message : String(err));
    process.exit(1);
  });
}
