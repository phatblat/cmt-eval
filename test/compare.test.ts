// Cross-run overlay chart: one series per run, categories are the union of
// fixtures/models seen across all runs so a run missing a category renders a
// gap rather than throwing. Mirrors charts.test.ts's structural assertions.

import { describe, expect, test } from "bun:test";
import { buildCompareCharts, compareHtml, compareMarkdown, formatRunLabel, type RunSeries } from "../evalkit/report/compare.ts";
import type { ResultRow } from "../evalkit/runner.ts";

function assertCleanSvg(svg: string): void {
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg.toLowerCase().includes("http")).toBe(false);
}

function makeRow(overrides: Partial<ResultRow>): ResultRow {
  return {
    runId: "run",
    cellId: "cell",
    fixture: "fixture-a",
    model: "anthropic/claude-haiku-4-5",
    provider: "anthropic",
    thinking: "low",
    rep: 1,
    status: "ok",
    attempts: 1,
    contended: false,
    wallS: 10,
    modelTimeS: 8,
    ttftS: 1,
    assistantTurns: 3,
    subagents: 0,
    tokensInput: 100,
    tokensOutput: 200,
    tokensCacheRead: 0,
    tokensCacheWrite: 0,
    costUsd: 0.01,
    priced: true,
    composite: 0.5,
    errorMessage: "",
    ...overrides,
  };
}

describe("formatRunLabel", () => {
  test("formats the writeMeta timestamp shape as suite@HH:MM:SS", () => {
    expect(formatRunLabel({ suite: "smoke", runId: "2026-08-18T02-32-40-483Z" })).toBe("smoke@02:32:40");
  });

  test("falls back to the raw runId when it isn't the timestamp shape", () => {
    expect(formatRunLabel({ suite: "smoke", runId: "custom-run-id" })).toBe("smoke@custom-run-id");
  });
});

describe("buildCompareCharts", () => {
  const runA: RunSeries = {
    runId: "run-a",
    suite: "smoke",
    label: "smoke@A",
    rows: [
      makeRow({ fixture: "fixture-a", model: "anthropic/claude-haiku-4-5", composite: 0.2, wallS: 20 }),
      makeRow({ fixture: "fixture-b", model: "anthropic/claude-haiku-4-5", composite: 0.4, wallS: 30 }),
    ],
  };
  const runB: RunSeries = {
    runId: "run-b",
    suite: "focus",
    label: "focus@B",
    rows: [
      makeRow({ fixture: "fixture-a", model: "anthropic/claude-haiku-4-5", composite: 0.6, wallS: 10 }),
      makeRow({ fixture: "fixture-c", model: "openai-codex/gpt-5.6-terra", composite: 0.8, wallS: 40 }),
    ],
  };

  test("overlays one series per run on the union of fixtures across runs", () => {
    const svgs = buildCompareCharts([runA, runB]);
    assertCleanSvg(svgs.composite_by_fixture!);
    // fixture-a is present in both runs (2 bars); fixture-b only in run A
    // and fixture-c only in run B (1 bar each) - missing combinations render
    // as gaps, not zero-height bars: 4 bar rects, plus 1 background rect and
    // 2 legend swatch rects (one per run) from the chart chrome.
    expect((svgs.composite_by_fixture!.match(/<rect/g) ?? []).length).toBe(7);
    expect(svgs.composite_by_fixture!.includes(">fixture-a<")).toBe(true);
    expect(svgs.composite_by_fixture!.includes(">fixture-b<")).toBe(true);
    expect(svgs.composite_by_fixture!.includes(">fixture-c<")).toBe(true);
    expect(svgs.composite_by_fixture!.includes(">smoke@A<")).toBe(true);
    expect(svgs.composite_by_fixture!.includes(">focus@B<")).toBe(true);
  });

  test("overlays one series per run on the union of models across runs", () => {
    const svgs = buildCompareCharts([runA, runB]);
    assertCleanSvg(svgs.composite_by_model!);
    expect(svgs.composite_by_model!.includes(">anthropic/claude-haiku-4-5<")).toBe(true);
    expect(svgs.composite_by_model!.includes(">openai-codex/gpt-5.6-terra<")).toBe(true);
  });

  test("charts wall time per run from that run's own wallS values", () => {
    const svgs = buildCompareCharts([runA, runB]);
    assertCleanSvg(svgs.walltime_by_run!);
    expect(svgs.walltime_by_run!.includes(">smoke@A<")).toBe(true);
    expect(svgs.walltime_by_run!.includes(">focus@B<")).toBe(true);
  });
});

describe("compare report text", () => {
  const runs: RunSeries[] = [
    { runId: "run-a", suite: "smoke", label: "smoke@A", rows: [makeRow({ composite: 0.5 })] },
    { runId: "run-b", suite: "focus", label: "focus@B", rows: [makeRow({ composite: 0.9, status: "error", errorMessage: "boom" })] },
  ];

  test("markdown lists every run label and links every chart file", () => {
    const md = compareMarkdown(runs);
    expect(md.includes("smoke@A")).toBe(true);
    expect(md.includes("focus@B")).toBe(true);
    expect(md.includes("charts/composite_by_fixture.svg")).toBe(true);
    expect(md.includes("charts/composite_by_model.svg")).toBe(true);
    expect(md.includes("charts/walltime_by_run.svg")).toBe(true);
  });

  test("html embeds the given svgs and stays self-contained (no http references)", () => {
    const svgs = { composite_by_fixture: "<svg>a</svg>", composite_by_model: "<svg>b</svg>", walltime_by_run: "<svg>c</svg>" };
    const html = compareHtml(runs, svgs);
    expect(html.startsWith("<!doctype html>")).toBe(true);
    expect(html.toLowerCase().includes("http")).toBe(false);
    expect(html.includes("<svg>a</svg>")).toBe(true);
    expect(html.includes("smoke@A")).toBe(true);
  });
});
