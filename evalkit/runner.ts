// Matrix expansion, per-provider scheduling, retries, and results writing.
//
// Cells are ordered rep-major (each rep sweeps every fixture x model x
// thinking combination) so a transient provider slowdown biases at most one
// rep, never a whole model. Cells are grouped by provider; one async worker
// per provider consumes its queue, capped at `jobs` concurrent providers
// (default: the number of distinct providers in the suite) so Anthropic and
// Codex OAuth pools are never hit concurrently with themselves, which would
// corrupt the wall-clock metric.

import { appendFileSync, mkdirSync, rmSync, symlinkSync, unlinkSync } from "node:fs";
import { join, resolve } from "node:path";
import type { Fixture, Metrics } from "./task.ts";
import type { LoadedSuite, SuiteConfig } from "./suite.ts";
import type { ModelInfo } from "./models.ts";
import { isPriced } from "./models.ts";
import { git, materialize, scratchRoot } from "./gitrepo.ts";
import { collectUsage, runOmp, writeEvalConfig, UNKNOWN_USAGE } from "./omp.ts";

export type Cell = {
  fixture: Fixture;
  model: ModelInfo;
  thinking: string;
  rep: number;
  cellId: string;
  provider: string;
};

const RETRYABLE_STDERR = /(429|rate.?limit|overloaded|ECONNRESET|fetch failed|socket hang up|503)/i;

/** Unknown-ttft sentinel: keeps every ResultRow field a plain number/boolean/string so it round-trips through JSONL and CSV without a nullable special case. */
export const TTFT_UNKNOWN = -1;

type ResultRowBase = {
  runId: string;
  cellId: string;
  fixture: string;
  model: string;
  provider: string;
  thinking: string;
  rep: number;
  status: "ok" | "timeout" | "error";
  attempts: number;
  contended: boolean;
  wallS: number;
  modelTimeS: number;
  ttftS: number;
  assistantTurns: number;
  subagents: number;
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  priced: boolean;
  composite: number;
  errorMessage: string;
};

export type ResultRow = ResultRowBase & Metrics;

/** Fixed column prefix, in the order every consumer (JSONL, CSV, report) renders them; grader metric keys are appended after these. */
export const RESULT_COLUMNS: Array<keyof ResultRowBase> = [
  "runId",
  "cellId",
  "fixture",
  "model",
  "provider",
  "thinking",
  "rep",
  "status",
  "attempts",
  "contended",
  "wallS",
  "modelTimeS",
  "ttftS",
  "assistantTurns",
  "subagents",
  "tokensInput",
  "tokensOutput",
  "tokensCacheRead",
  "tokensCacheWrite",
  "costUsd",
  "priced",
  "composite",
  "errorMessage",
];

function slugModel(selector: string): string {
  return selector.replace(/\//g, "-");
}

/** Expands a suite into cells in rep-major order. */
export function buildCells(suite: LoadedSuite): Cell[] {
  const cells: Cell[] = [];
  for (let rep = 1; rep <= suite.config.reps; rep++) {
    for (const fixture of suite.fixtureList) {
      for (const model of suite.modelInfos) {
        for (const thinking of suite.config.thinking) {
          const cellId = `${fixture.id}__${slugModel(model.selector)}__${thinking}__r${rep}`;
          cells.push({ fixture, model, thinking, rep, cellId, provider: model.provider });
        }
      }
    }
  }
  return cells;
}

function groupByProvider(cells: Cell[]): Map<string, Cell[]> {
  const byProvider = new Map<string, Cell[]>();
  for (const cell of cells) {
    const list = byProvider.get(cell.provider);
    if (list) {
      list.push(cell);
    } else {
      byProvider.set(cell.provider, [cell]);
    }
  }
  return byProvider;
}

type CellContext = {
  runId: string;
  suiteRunDir: string;
  suite: LoadedSuite;
  contended: boolean;
  keepRepos: boolean;
};

async function runCell(cell: Cell, ctx: CellContext): Promise<ResultRow> {
  const cellDir = join(ctx.suiteRunDir, "logs", cell.cellId);
  const maxAttempts = 1 + ctx.suite.config.retries;

  let attempts = 0;
  let status: "ok" | "timeout" | "error" = "error";
  let usage = UNKNOWN_USAGE;
  let metrics: Metrics = {};
  let wallS = 0;
  let errorMessage = "";

  while (attempts < maxAttempts) {
    attempts++;
    rmSync(cellDir, { recursive: true, force: true });
    mkdirSync(cellDir, { recursive: true });
    await writeEvalConfig(cellDir);

    const scratch = scratchRoot(ctx.runId, `${cell.cellId}-a${attempts}`);
    rmSync(scratch, { recursive: true, force: true });

    let repoPath: string | null = null;
    try {
      const prepared = await ctx.suite.task.prepare(cell.fixture, scratch);
      repoPath = prepared.repo;

      const prompt = ctx.suite.task.prompt(cell.fixture);
      const runResult = await runOmp({
        model: cell.model.selector,
        thinking: cell.thinking,
        repo: prepared.repo,
        runDir: cellDir,
        prompt,
        timeoutS: cell.fixture.timeoutS,
      });
      wallS = runResult.wallS;

      if (runResult.exitCode === 0) {
        usage = await collectUsage(join(cellDir, "sessions"));
        metrics = await ctx.suite.task.grade(cell.fixture, prepared);
        status = "ok";
        // PreparedRun is a framework-level {repo, baseTip} contract (see
        // evalkit/task.ts), so persisting `git log`/`git status` here — not
        // in the task — keeps this generic across any task built on it.
        // Written before the `finally` block below deletes the scratch repo.
        const gitLog = git(["log", "--format=%H%x09%s", `${prepared.baseTip}..HEAD`], prepared.repo).stdout;
        const gitStatus = git(["status", "--porcelain"], prepared.repo).stdout;
        await Promise.all([
          Bun.write(join(cellDir, "git-log.txt"), gitLog.length > 0 ? `${gitLog}\n` : ""),
          Bun.write(join(cellDir, "git-status.txt"), gitStatus.length > 0 ? `${gitStatus}\n` : ""),
        ]);
        break;
      }

      const timedOut = runResult.exitCode === null && runResult.signal === "SIGTERM";
      status = timedOut ? "timeout" : "error";
      errorMessage = `omp exited ${runResult.exitCode} signal=${runResult.signal ?? "none"}: ${runResult.stderrTail}`;

      if (attempts >= maxAttempts || !RETRYABLE_STDERR.test(runResult.stderrTail)) {
        break;
      }
      // Falls through to the next loop iteration: fresh scratch repo + cellDir.
    } catch (err) {
      status = "error";
      errorMessage = `${(err as Error).message}`;
      break; // grading/materialization errors are deterministic, not retryable
    } finally {
      if (repoPath && !ctx.keepRepos) {
        rmSync(repoPath, { recursive: true, force: true });
      }
    }
  }

  const composite = status === "ok" ? ctx.suite.task.composite(metrics, ctx.suite.config.weights) : 0;

  const base: ResultRowBase = {
    runId: ctx.runId,
    cellId: cell.cellId,
    fixture: cell.fixture.id,
    model: cell.model.selector,
    provider: cell.provider,
    thinking: cell.thinking,
    rep: cell.rep,
    status,
    attempts,
    contended: ctx.contended,
    wallS,
    modelTimeS: usage.modelTimeS,
    ttftS: usage.ttftS ?? TTFT_UNKNOWN,
    assistantTurns: usage.assistantTurns,
    subagents: usage.subagents,
    tokensInput: usage.tokensInput,
    tokensOutput: usage.tokensOutput,
    tokensCacheRead: usage.tokensCacheRead,
    tokensCacheWrite: usage.tokensCacheWrite,
    costUsd: usage.costUsd,
    priced: isPriced(cell.model),
    composite,
    errorMessage,
  };
  return { ...base, ...metrics };
}

export type RunSuiteOptions = {
  runId: string;
  suiteRunDir: string; // runs/<runId>
  jobs?: number;
  keepRepos?: boolean;
  onResult?: (row: ResultRow) => void;
};

export async function runSuite(suite: LoadedSuite, opts: RunSuiteOptions): Promise<ResultRow[]> {
  const cells = buildCells(suite);
  const byProvider = groupByProvider(cells);
  const providers = [...byProvider.keys()];
  const jobs = opts.jobs ?? providers.length;
  const perProviderJobs = suite.config.perProviderJobs;
  const contended = perProviderJobs > 1;
  const keepRepos = opts.keepRepos ?? false;

  mkdirSync(opts.suiteRunDir, { recursive: true });
  const resultsPath = join(opts.suiteRunDir, "results.jsonl");

  const rows: ResultRow[] = [];
  const appendRow = (row: ResultRow) => {
    rows.push(row);
    appendFileSync(resultsPath, `${JSON.stringify(row)}\n`);
    opts.onResult?.(row);
  };

  async function drainProvider(providerCells: Cell[]) {
    let cursor = 0;
    async function worker() {
      while (cursor < providerCells.length) {
        const i = cursor++;
        const cell = providerCells[i]!; // safe: i < length was just checked under the shared cursor
        const ctx: CellContext = { runId: opts.runId, suiteRunDir: opts.suiteRunDir, suite, contended, keepRepos };
        const row = await runCell(cell, ctx);
        appendRow(row);
      }
    }
    const workerCount = Math.min(perProviderJobs, providerCells.length);
    await Promise.all(Array.from({ length: workerCount }, () => worker()));
  }

  let providerCursor = 0;
  async function dispatchProviders() {
    while (providerCursor < providers.length) {
      const i = providerCursor++;
      const provider = providers[i]!; // safe: i < length was just checked under the shared cursor
      await drainProvider(byProvider.get(provider)!);
    }
  }
  const dispatcherCount = Math.min(jobs, providers.length);
  await Promise.all(Array.from({ length: dispatcherCount }, () => dispatchProviders()));

  return rows;
}

export type RunMeta = {
  runId: string;
  suite: string;
  config: SuiteConfig;
  ompVersion: string;
  bunVersion: string;
  projectHead: string;
  platform: string;
  arch: string;
  jobs: number;
  perProviderJobs: number;
  startedAt: string;
  finishedAt: string;
};

async function commandOutput(cmd: string[], cwd: string): Promise<string> {
  const proc = Bun.spawn({ cmd, cwd, stdout: "pipe", stderr: "pipe", env: { ...process.env, NO_COLOR: "1", FORCE_COLOR: undefined } });
  const text = await new Response(proc.stdout).text();
  await proc.exited;
  return text.trim();
}

export async function writeMeta(
  suite: LoadedSuite,
  o: { runId: string; suiteRunDir: string; jobs: number; startedAt: string; finishedAt: string; projectRoot: string },
): Promise<RunMeta> {
  const [ompVersion, projectHead] = await Promise.all([
    commandOutput(["omp", "--version"], o.projectRoot),
    commandOutput(["git", "rev-parse", "HEAD"], o.projectRoot),
  ]);
  const meta: RunMeta = {
    runId: o.runId,
    suite: suite.name,
    config: suite.config,
    ompVersion,
    bunVersion: Bun.version,
    projectHead,
    platform: process.platform,
    arch: process.arch,
    jobs: o.jobs,
    perProviderJobs: suite.config.perProviderJobs,
    startedAt: o.startedAt,
    finishedAt: o.finishedAt,
  };
  await Bun.write(join(o.suiteRunDir, "meta.json"), `${JSON.stringify(meta, null, 2)}\n`);
  return meta;
}

/** Recreates the `runs/latest` symlink to point at this run directory. */
export function updateLatestSymlink(runsDir: string, runId: string): void {
  mkdirSync(runsDir, { recursive: true });
  const latest = join(runsDir, "latest");
  try {
    unlinkSync(latest);
  } catch {
    // no prior symlink
  }
  symlinkSync(resolve(join(runsDir, runId)), latest);
}
