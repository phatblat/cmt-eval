// results.csv, report.md, report.html, and the six SVG charts, plus the
// console summary printed by `eval` on completion and by `report` on demand.

import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { RESULT_COLUMNS, type ResultRow, type RunMeta } from "../runner.ts";
import { mean, statsByModelThinking, statsByModelThinkingFixture, suiteTotals, type CellStats } from "./aggregate.ts";
import { esc, groupedBars, heatmap, scatter, stackedBars, whiskerBars, type Series } from "./charts.ts";

const CAVEATS =
  "> **Caveats:** `cursor` and `spark` are unpriced (subscription / local box) so their dollar figures are 0; " +
  "timings were measured with providers serialized; `wallS` includes ~1\u20132s of `omp` startup while `modelTimeS` does not.";

function fmtPct(x: number): string {
  return `${(x * 100).toFixed(0)}%`;
}

function fmtUsd(x: number): string {
  return `$${x.toFixed(4)}`;
}

function fmtS(x: number): string {
  return `${x.toFixed(1)}s`;
}

function splitModelThinking(key: string): [string, string] {
  const idx = key.lastIndexOf(":");
  return [key.slice(0, idx), key.slice(idx + 1)];
}

function splitModelThinkingFixture(key: string): [string, string, string] {
  const parts = key.split(":");
  // model never contains ":" (selectors use "/"), so this is exactly [model, thinking, fixture].
  return [parts[0]!, parts[1]!, parts[2]!];
}

// ---------------------------------------------------------------------------
// Charts
// ---------------------------------------------------------------------------

export function buildCharts(rows: ResultRow[]): Record<string, string> {
  const models = [...new Set(rows.map((r) => r.model))].sort();
  const thinkingLevels = [...new Set(rows.map((r) => r.thinking))].sort();
  const fixtures = [...new Set(rows.map((r) => r.fixture))].sort();
  const byMT = new Map(statsByModelThinking(rows).map((s) => [s.key, s]));
  const byMTF = new Map(statsByModelThinkingFixture(rows).map((s) => [s.key, s]));

  const scoreSeries: Series[] = thinkingLevels.map((thinking) => ({
    label: thinking,
    values: models.map((m) => byMT.get(`${m}:${thinking}`)?.compositeMean ?? null),
    errors: models.map((m) => byMT.get(`${m}:${thinking}`)?.compositeSd ?? null),
  }));
  const scoreByModel = groupedBars({
    title: "Composite score by model",
    categories: models,
    series: scoreSeries,
    yLabel: "composite score",
    yMax: 1,
  });

  const accuracySeries: Series[] = thinkingLevels.map((thinking) => ({
    label: thinking,
    values: models.map((m) => byMT.get(`${m}:${thinking}`)?.countMatchRate ?? null),
  }));
  const commitCountAccuracy = groupedBars({
    title: "Commit-count accuracy by model",
    categories: models,
    series: accuracySeries,
    yLabel: "countMatch rate",
    yMax: 1,
  });

  const mtGroups = [...byMT.entries()].map(([key, stats]) => {
    const [model, thinking] = splitModelThinking(key);
    const sample = rows.find((r) => r.model === model && r.thinking === thinking)!;
    return { model, thinking, provider: sample.provider, priced: sample.priced, stats };
  });
  const pricedCosts = mtGroups.filter((g) => g.priced && g.stats.costMean > 0).map((g) => g.stats.costMean);
  const costFloor = pricedCosts.length > 0 ? Math.min(...pricedCosts) * 0.5 : 0.0001;
  const costVsScore = scatter({
    title: "Cost vs composite score",
    points: mtGroups.map((g) => ({
      x: g.priced ? Math.max(g.stats.costMean, costFloor) : costFloor,
      y: g.stats.compositeMean,
      label: `${g.model} (${g.thinking})`,
      group: g.provider,
      hollow: !g.priced,
    })),
    xLabel: "mean cost per run (USD, log scale; hollow = unpriced)",
    yLabel: "composite score",
    xLog: true,
  });

  const mtKeys = [...byMT.keys()].sort();
  const walltimeByModel = whiskerBars({
    title: "Wall time by model",
    categories: mtKeys.map((k) => k.replace(":", " \u00b7 ")),
    values: mtKeys.map((k) => byMT.get(k)!.wallMedian),
    low: mtKeys.map((k) => byMT.get(k)!.wallMin),
    high: mtKeys.map((k) => byMT.get(k)!.wallMax),
    yLabel: "wall seconds",
  });

  const fixtureHeatmap = heatmap({
    title: "Composite score by fixture",
    rows: mtKeys.map((k) => k.replace(":", " \u00b7 ")),
    cols: fixtures,
    values: mtKeys.map((mt) => fixtures.map((f) => byMTF.get(`${mt}:${f}`)?.compositeMean ?? null)),
    vmin: 0,
    vmax: 1,
  });

  const tokenFields: Array<{ label: string; key: keyof ResultRow }> = [
    { label: "input", key: "tokensInput" },
    { label: "output", key: "tokensOutput" },
    { label: "cacheRead", key: "tokensCacheRead" },
    { label: "cacheWrite", key: "tokensCacheWrite" },
  ];
  const tokensByModel = stackedBars({
    title: "Mean tokens per run by model",
    categories: models,
    series: tokenFields.map(({ label, key }) => ({
      label,
      values: models.map((m) => mean(rows.filter((r) => r.model === m).map((r) => Number(r[key])))),
    })),
    yLabel: "tokens/run",
  });

  return {
    score_by_model: scoreByModel,
    commit_count_accuracy: commitCountAccuracy,
    cost_vs_score: costVsScore,
    walltime_by_model: walltimeByModel,
    fixture_heatmap: fixtureHeatmap,
    tokens_by_model: tokensByModel,
  };
}

// ---------------------------------------------------------------------------
// Tables (shared data, rendered to markdown or HTML)
// ---------------------------------------------------------------------------

type TableData = { headers: string[]; body: string[][] };

function leaderboardData(rows: ResultRow[]): TableData {
  const stats = statsByModelThinking(rows).sort((a, b) => b.compositeMean - a.compositeMean);
  const body = stats.map((s) => {
    const [model, thinking] = splitModelThinking(s.key);
    const perCorrect = s.countMatchRate > 0 ? fmtUsd(s.costMean / s.countMatchRate) : "n/a";
    return [
      model,
      thinking,
      String(s.n),
      `${s.compositeMean.toFixed(3)}\u00b1${s.compositeSd.toFixed(3)}`,
      fmtPct(s.countMatchRate),
      s.groupingMean.toFixed(2),
      fmtPct(s.trailerRate),
      fmtS(s.wallMedian),
      fmtUsd(s.costMean),
      perCorrect,
      s.flaky ? "yes" : "no",
    ];
  });
  return {
    headers: ["model", "thinking", "runs", "composite (mean\u00b1sd)", "count-match", "grouping", "trailer", "median wall", "mean $", "$/correct", "flaky"],
    body,
  };
}

function fixtureTableData(rows: ResultRow[]): TableData {
  const stats = statsByModelThinkingFixture(rows).sort((a, b) => a.key.localeCompare(b.key));
  const body = stats.map((s) => {
    const [model, thinking, fixture] = splitModelThinkingFixture(s.key);
    return [model, thinking, fixture, String(s.n), s.compositeMean.toFixed(3), fmtPct(s.countMatchRate), fmtS(s.wallMedian)];
  });
  return { headers: ["model", "thinking", "fixture", "runs", "composite", "count-match", "median wall"], body };
}

function failureTableData(rows: ResultRow[]): TableData {
  const failures = rows.filter((r) => r.status !== "ok");
  const body = failures.map((r) => [r.cellId, r.status, String(r.attempts), r.errorMessage.replace(/\s+/g, " ").slice(0, 200)]);
  return { headers: ["cellId", "status", "attempts", "error"], body };
}

function mdTable(data: TableData): string {
  if (data.body.length === 0) return "_none_\n";
  const escapeCell = (c: string) => c.replace(/\|/g, "\\|");
  const head = `| ${data.headers.join(" | ")} |\n| ${data.headers.map(() => "---").join(" | ")} |`;
  const body = data.body.map((r) => `| ${r.map(escapeCell).join(" | ")} |`).join("\n");
  return `${head}\n${body}\n`;
}

function htmlTable(data: TableData): string {
  const thead = `<tr>${data.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody =
    data.body.length === 0
      ? `<tr><td colspan="${data.headers.length}"><em>none</em></td></tr>`
      : data.body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}

// ---------------------------------------------------------------------------
// results.csv
// ---------------------------------------------------------------------------

function toCsvValue(v: unknown): string {
  if (v === undefined || v === null) return "";
  const s = String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

export function rowsToCsv(rows: ResultRow[]): string {
  const metricKeys = new Set<string>();
  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!(RESULT_COLUMNS as string[]).includes(key)) metricKeys.add(key);
    }
  }
  const columns = [...(RESULT_COLUMNS as string[]), ...[...metricKeys].sort()];
  const lines = [columns.join(",")];
  for (const row of rows) {
    const record = row as unknown as Record<string, unknown>;
    lines.push(columns.map((c) => toCsvValue(record[c])).join(","));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// report.md / report.html
// ---------------------------------------------------------------------------

function metaLines(meta: RunMeta): string[] {
  return [
    `- ${meta.ompVersion}, bun ${meta.bunVersion}, project @ ${meta.projectHead.slice(0, 12)}`,
    `- platform ${meta.platform}/${meta.arch}, jobs=${meta.jobs}, perProviderJobs=${meta.perProviderJobs}`,
    `- started ${meta.startedAt}, finished ${meta.finishedAt}`,
  ];
}

const CHART_FILES: Array<{ name: string; title: string }> = [
  { name: "score_by_model", title: "Composite score by model" },
  { name: "commit_count_accuracy", title: "Commit-count accuracy" },
  { name: "cost_vs_score", title: "Cost vs score" },
  { name: "walltime_by_model", title: "Wall time by model" },
  { name: "fixture_heatmap", title: "Fixture heatmap" },
  { name: "tokens_by_model", title: "Tokens by model" },
];

export function reportMarkdown(rows: ResultRow[], meta: RunMeta): string {
  return [
    `# ${meta.suite} \u2014 ${meta.runId}`,
    "",
    ...metaLines(meta),
    "",
    "## Leaderboard",
    "",
    mdTable(leaderboardData(rows)),
    "## Per-fixture",
    "",
    mdTable(fixtureTableData(rows)),
    "## Failures",
    "",
    mdTable(failureTableData(rows)),
    "## Charts",
    "",
    ...CHART_FILES.map((c) => `![${c.title}](charts/${c.name}.svg)`),
    "",
    CAVEATS,
    "",
  ].join("\n");
}

export function reportHtml(rows: ResultRow[], meta: RunMeta, svgs: Record<string, string>): string {
  const charts = CHART_FILES.map((c) => `<section><h3>${esc(c.title)}</h3>${svgs[c.name] ?? ""}</section>`).join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8"/>
<title>${esc(meta.suite)} \u2014 ${esc(meta.runId)}</title>
<style>
body { font-family: ui-sans-serif, -apple-system, sans-serif; margin: 2rem; color: #111827; }
table { border-collapse: collapse; margin: 1rem 0; }
th, td { border: 1px solid #e5e7eb; padding: 4px 8px; font-size: 13px; text-align: left; }
th { background: #f9fafb; }
section { margin: 1.5rem 0; }
.caveats { color: #6b7280; font-size: 13px; }
</style>
</head>
<body>
<h1>${esc(meta.suite)} \u2014 ${esc(meta.runId)}</h1>
<ul>${metaLines(meta)
    .map((l) => `<li>${esc(l.replace(/^- /, ""))}</li>`)
    .join("")}</ul>
<h2>Leaderboard</h2>
${htmlTable(leaderboardData(rows))}
<h2>Per-fixture</h2>
${htmlTable(fixtureTableData(rows))}
<h2>Failures</h2>
${htmlTable(failureTableData(rows))}
<h2>Charts</h2>
${charts}
<p class="caveats">${esc(CAVEATS.replace(/^> /, ""))}</p>
</body>
</html>
`;
}

export async function renderReport(o: { suiteRunDir: string; rows: ResultRow[]; meta: RunMeta }): Promise<void> {
  const chartsDir = join(o.suiteRunDir, "charts");
  mkdirSync(chartsDir, { recursive: true });

  const svgs = buildCharts(o.rows);
  await Promise.all(Object.entries(svgs).map(([name, svg]) => Bun.write(join(chartsDir, `${name}.svg`), svg)));
  await Bun.write(join(o.suiteRunDir, "results.csv"), rowsToCsv(o.rows));
  await Bun.write(join(o.suiteRunDir, "report.md"), reportMarkdown(o.rows, o.meta));
  await Bun.write(join(o.suiteRunDir, "report.html"), reportHtml(o.rows, o.meta, svgs));
}

// ---------------------------------------------------------------------------
// Console summary
// ---------------------------------------------------------------------------

export function consoleSummary(rows: ResultRow[]): string {
  const totals = suiteTotals(rows);
  const byMT = statsByModelThinking(rows).sort((a, b) => b.compositeMean - a.compositeMean);
  const flaky = byMT.filter((s) => s.flaky).map((s) => s.key);

  const lines: string[] = [
    "",
    "Eval Summary",
    "\u2550".repeat(70),
    `  Total runs:        ${totals.totalRuns} (${totals.totalRuns - totals.errorCount} ok, ${totals.errorCount} error)`,
    `  Total spend:       $${totals.totalCostUsd.toFixed(2)}`,
    `  Mean cost/run:     $${totals.meanCostUsd.toFixed(4)}`,
    `  Median wall/run:   ${totals.medianWallS.toFixed(1)}s`,
    `  Count-match rate:  ${(totals.overallCountMatchRate * 100).toFixed(0)}%`,
    "\u2500".repeat(70),
  ];
  for (const s of byMT) {
    lines.push(
      `  ${s.key.padEnd(42)} count-match ${`${(s.countMatchRate * 100).toFixed(0)}%`.padStart(4)}  composite ${s.compositeMean.toFixed(3)}`,
    );
  }
  if (flaky.length > 0) {
    lines.push("\u2500".repeat(70));
    lines.push(`  Flaky (countMatch not unanimous): ${flaky.join(", ")}`);
  }
  lines.push("");
  return lines.join("\n");
}

export type { CellStats };
