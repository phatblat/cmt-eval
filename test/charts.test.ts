// Every chart renderer must produce valid-looking, self-contained SVG: no
// network references, and the structural elements (bars, category labels)
// a human or a downstream consumer would expect to find.

import { describe, expect, test } from "bun:test";
import { groupedBars, heatmap, scatter, stackedBars, whiskerBars } from "../evalkit/report/charts.ts";

function countOccurrences(haystack: string, needle: RegExp): number {
  return (haystack.match(needle) ?? []).length;
}

function assertCleanSvg(svg: string): void {
  expect(svg.startsWith("<svg")).toBe(true);
  expect(svg.toLowerCase().includes("http")).toBe(false);
}

describe("chart renderers", () => {
  test("groupedBars: one rect per (category x series) bar, one text per category", () => {
    const categories = ["model-a", "model-b", "model-c"];
    const series = [
      { label: "low", values: [0.2, 0.5, 0.8] },
      { label: "high", values: [0.4, 0.6, 0.9] },
    ];
    const svg = groupedBars({ title: "Composite score", categories, series, yLabel: "score", yMax: 1 });
    assertCleanSvg(svg);
    expect(countOccurrences(svg, /<rect/g)).toBeGreaterThanOrEqual(categories.length * series.length);
    for (const cat of categories) {
      expect(svg.includes(`>${cat}<`)).toBe(true);
    }
  });

  test("whiskerBars: one rect + one text per category", () => {
    const categories = ["a:low", "a:high", "b:low"];
    const svg = whiskerBars({
      title: "Wall time",
      categories,
      values: [10, 20, 30],
      low: [5, 15, 25],
      high: [15, 25, 35],
      yLabel: "seconds",
    });
    assertCleanSvg(svg);
    expect(countOccurrences(svg, /<rect/g)).toBeGreaterThanOrEqual(categories.length);
    for (const cat of categories) {
      expect(svg.includes(esc(cat))).toBe(true);
    }
  });

  test("stackedBars: one rect per (category x series) segment, one text per category", () => {
    const categories = ["model-a", "model-b"];
    const series = [
      { label: "input", values: [100, 200] },
      { label: "output", values: [50, 80] },
    ];
    const svg = stackedBars({ title: "Tokens", categories, series, yLabel: "tokens" });
    assertCleanSvg(svg);
    expect(countOccurrences(svg, /<rect/g)).toBeGreaterThanOrEqual(categories.length * series.length);
    for (const cat of categories) {
      expect(svg.includes(`>${cat}<`)).toBe(true);
    }
  });

  test("heatmap: one rect per (row x col) cell", () => {
    const rows = ["model-a:low", "model-a:high"];
    const cols = ["fixture-1", "fixture-2", "fixture-3"];
    const svg = heatmap({
      title: "Fixture heatmap",
      rows,
      cols,
      values: [
        [0.5, 0.8, 1],
        [0.3, null, 0.9],
      ],
    });
    assertCleanSvg(svg);
    expect(countOccurrences(svg, /<rect/g)).toBeGreaterThanOrEqual(rows.length * cols.length);
  });

  test("scatter: one point per input, no http reference", () => {
    const svg = scatter({
      title: "Cost vs score",
      points: [
        { x: 0.01, y: 0.8, label: "a", group: "anthropic" },
        { x: 0.02, y: 0.6, label: "b", group: "openai-codex" },
        { x: 0.0001, y: 0.4, label: "c", group: "cursor", hollow: true },
      ],
      xLabel: "cost",
      yLabel: "score",
      xLog: true,
    });
    assertCleanSvg(svg);
    expect(countOccurrences(svg, /<circle/g)).toBeGreaterThanOrEqual(3);
  });
});

function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}
