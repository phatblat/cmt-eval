// Rows -> cell statistics. Mean/sd/median are implemented locally; the input
// sizes here (reps in the tens, not millions) make a stats dependency
// unjustified.

import type { ResultRow } from "../runner.ts";

export type TokensMean = { input: number; output: number; cacheRead: number; cacheWrite: number };

export type CellStats = {
  key: string;
  n: number;
  compositeMean: number;
  compositeSd: number;
  countMatchRate: number;
  groupingMean: number;
  trailerRate: number;
  wallMedian: number;
  wallMin: number;
  wallMax: number;
  costMean: number;
  tokensMean: TokensMean;
  errorCount: number;
  flaky: boolean;
};

export function mean(xs: number[]): number {
  return xs.length === 0 ? 0 : xs.reduce((a, b) => a + b, 0) / xs.length;
}

function sd(xs: number[]): number {
  if (xs.length < 2) return 0;
  const m = mean(xs);
  return Math.sqrt(mean(xs.map((x) => (x - m) ** 2)));
}

function median(xs: number[]): number {
  if (xs.length === 0) return 0;
  const sorted = [...xs].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

function numericMetric(row: ResultRow, key: string): number {
  const v = row[key];
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  return 0;
}

function groupBy(rows: ResultRow[], keyFn: (r: ResultRow) => string): Map<string, ResultRow[]> {
  const groups = new Map<string, ResultRow[]>();
  for (const row of rows) {
    const key = keyFn(row);
    const list = groups.get(key);
    if (list) {
      list.push(row);
    } else {
      groups.set(key, [row]);
    }
  }
  return groups;
}

function statsForGroup(key: string, rows: ResultRow[]): CellStats {
  const composites = rows.map((r) => r.composite);
  const countMatchFlags = rows.map((r) => numericMetric(r, "countMatch") >= 1);
  const groupingScores = rows.map((r) => numericMetric(r, "groupingScore"));
  const trailerOks = rows.map((r) => numericMetric(r, "trailerOk"));
  const walls = rows.map((r) => r.wallS);
  const costs = rows.map((r) => r.costUsd);

  return {
    key,
    n: rows.length,
    compositeMean: mean(composites),
    compositeSd: sd(composites),
    countMatchRate: mean(countMatchFlags.map((b) => (b ? 1 : 0))),
    groupingMean: mean(groupingScores),
    trailerRate: mean(trailerOks),
    wallMedian: median(walls),
    wallMin: Math.min(...walls),
    wallMax: Math.max(...walls),
    costMean: mean(costs),
    tokensMean: {
      input: mean(rows.map((r) => r.tokensInput)),
      output: mean(rows.map((r) => r.tokensOutput)),
      cacheRead: mean(rows.map((r) => r.tokensCacheRead)),
      cacheWrite: mean(rows.map((r) => r.tokensCacheWrite)),
    },
    errorCount: rows.filter((r) => r.status !== "ok").length,
    flaky: new Set(countMatchFlags).size > 1,
  };
}

function cellStats(rows: ResultRow[], keyFn: (r: ResultRow) => string): CellStats[] {
  const groups = groupBy(rows, keyFn);
  return [...groups.entries()].map(([key, groupRows]) => statsForGroup(key, groupRows));
}

export function statsByModelThinking(rows: ResultRow[]): CellStats[] {
  return cellStats(rows, (r) => `${r.model}:${r.thinking}`);
}

export function statsByModelThinkingFixture(rows: ResultRow[]): CellStats[] {
  return cellStats(rows, (r) => `${r.model}:${r.thinking}:${r.fixture}`);
}

export type SuiteTotals = {
  totalRuns: number;
  errorCount: number;
  totalCostUsd: number;
  meanCostUsd: number;
  medianWallS: number;
  overallCountMatchRate: number;
};

export function suiteTotals(rows: ResultRow[]): SuiteTotals {
  const costs = rows.map((r) => r.costUsd);
  const walls = rows.map((r) => r.wallS);
  const countMatchFlags = rows.map((r) => numericMetric(r, "countMatch") >= 1);
  return {
    totalRuns: rows.length,
    errorCount: rows.filter((r) => r.status !== "ok").length,
    totalCostUsd: costs.reduce((a, b) => a + b, 0),
    meanCostUsd: mean(costs),
    medianWallS: median(walls),
    overallCountMatchRate: mean(countMatchFlags.map((b) => (b ? 1 : 0))),
  };
}
