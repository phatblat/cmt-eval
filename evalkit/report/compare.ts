// Cross-run overlay report. A single run's report (render.ts) answers "how do
// the cells within this run compare to each other"; this answers "how does
// run A compare to run B" by treating each past eval run as one overlaid
// series against a category axis that stays meaningful even when the runs
// swept different matrices. Composite score is the only metric with a fixed
// [0,1] range and a suite-defined meaning, so it is the axis kept stable
// across differing suites (fixture and model are the categories most likely
// to be shared between an old smoke run and a later focus run).

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { ResultRow, RunMeta } from "../runner.ts";
import { mean, median, suiteTotals } from "./aggregate.ts";
import { esc, groupedBars, whiskerBars, type Series } from "./charts.ts";
import { htmlTable, mdTable, type TableData } from "./table.ts";

export type RunSeries = { runId: string; suite: string; label: string; rows: ResultRow[] };

/** "2026-08-18T02-32-40-483Z" -> "smoke@02:32:40"; falls back to the raw runId if it isn't the timestamp shape `writeMeta` produces. */
export function formatRunLabel(meta: Pick<RunMeta, "suite" | "runId">): string {
  const time = /^\d{4}-\d{2}-\d{2}T(\d{2})-(\d{2})-(\d{2})-\d{3}Z$/.exec(meta.runId);
  return time ? `${meta.suite}@${time[1]}:${time[2]}:${time[3]}` : `${meta.suite}@${meta.runId}`;
}

function meanCompositeBy(rows: ResultRow[], keyFn: (r: ResultRow) => string): Map<string, number> {
  const groups = new Map<string, number[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key);
    if (list) list.push(row.composite);
    else groups.set(key, [row.composite]);
  }
  return new Map([...groups.entries()].map(([key, composites]) => [key, mean(composites)]));
}

export function buildCompareCharts(runs: RunSeries[]): Record<string, string> {
  const fixtures = [...new Set(runs.flatMap((r) => r.rows.map((row) => row.fixture)))].sort();
  const models = [...new Set(runs.flatMap((r) => r.rows.map((row) => row.model)))].sort();

  const compositeByFixture = groupedBars({
    title: "Composite score by fixture, overlaid per run",
    categories: fixtures,
    series: runs.map((r): Series => {
      const byFixture = meanCompositeBy(r.rows, (row) => row.fixture);
      return { label: r.label, values: fixtures.map((f) => byFixture.get(f) ?? null) };
    }),
    yLabel: "composite score",
    yMax: 1,
  });

  const compositeByModel = groupedBars({
    title: "Composite score by model, overlaid per run",
    categories: models,
    series: runs.map((r): Series => {
      const byModel = meanCompositeBy(r.rows, (row) => row.model);
      return { label: r.label, values: models.map((m) => byModel.get(m) ?? null) };
    }),
    yLabel: "composite score",
    yMax: 1,
  });

  const walltimeByRun = whiskerBars({
    title: "Wall time by run",
    categories: runs.map((r) => r.label),
    values: runs.map((r) => median(r.rows.map((row) => row.wallS))),
    low: runs.map((r) => Math.min(...r.rows.map((row) => row.wallS))),
    high: runs.map((r) => Math.max(...r.rows.map((row) => row.wallS))),
    yLabel: "wall seconds",
  });

  return { composite_by_fixture: compositeByFixture, composite_by_model: compositeByModel, walltime_by_run: walltimeByRun };
}

function runTableData(runs: RunSeries[]): TableData {
  const body = runs.map((r) => {
    const totals = suiteTotals(r.rows);
    const compositeMean = mean(r.rows.map((row) => row.composite));
    return [
      r.label,
      r.suite,
      String(totals.totalRuns),
      String(totals.errorCount),
      compositeMean.toFixed(3),
      `${(totals.overallCountMatchRate * 100).toFixed(0)}%`,
      `${totals.medianWallS.toFixed(1)}s`,
      `$${totals.totalCostUsd.toFixed(2)}`,
    ];
  });
  return { headers: ["run", "suite", "cells", "errors", "composite mean", "count-match", "median wall", "total $"], body };
}

const CHART_FILES: Array<{ name: string; title: string }> = [
  { name: "composite_by_fixture", title: "Composite score by fixture" },
  { name: "composite_by_model", title: "Composite score by model" },
  { name: "walltime_by_run", title: "Wall time by run" },
];

export function compareMarkdown(runs: RunSeries[]): string {
  return [
    "# Run comparison",
    "",
    `Comparing ${runs.length} runs: ${runs.map((r) => r.label).join(", ")}`,
    "",
    "## Runs",
    "",
    mdTable(runTableData(runs)),
    "## Charts",
    "",
    ...CHART_FILES.map((c) => `![${c.title}](charts/${c.name}.svg)`),
    "",
  ].join("\n");
}

export function compareHtml(runs: RunSeries[], svgs: Record<string, string>): string {
  const charts = CHART_FILES.map((c) => `<section><h3>${esc(c.title)}</h3>${svgs[c.name] ?? ""}</section>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>Run comparison</title>
<style>
body { font-family: ui-sans-serif, -apple-system, sans-serif; margin: 2rem; color: #111827; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #e5e7eb; padding: 4px 8px; font-size: 13px; text-align: left; }
th { background: #f9fafb; }
section { margin: 1.5rem 0; }
</style>
</head>
<body>
<h1>Run comparison</h1>
<p>Comparing ${runs.length} runs: ${esc(runs.map((r) => r.label).join(", "))}</p>
<h2>Runs</h2>
${htmlTable(runTableData(runs))}
<h2>Charts</h2>
${charts}
</body>
</html>
`;
}

export async function renderCompare(o: { outDir: string; runs: RunSeries[] }): Promise<void> {
  const chartsDir = join(o.outDir, "charts");
  mkdirSync(chartsDir, { recursive: true });

  const svgs = buildCompareCharts(o.runs);
  await Promise.all(Object.entries(svgs).map(([name, svg]) => Bun.write(join(chartsDir, `${name}.svg`), svg)));
  await Bun.write(join(o.outDir, "compare.md"), compareMarkdown(o.runs));
  await Bun.write(join(o.outDir, "compare.html"), compareHtml(o.runs, svgs));
}
