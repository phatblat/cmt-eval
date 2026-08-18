// Pure SVG chart renderers. No chart library, no headless browser, no native
// canvas: SVG is text, diffable, reviewable, and renders inline on GitHub and
// in the self-contained report.html with zero external references.

export type Series = { label: string; values: (number | null)[]; errors?: (number | null)[] };

const WIDTH = 900;
const HEIGHT = 480;
const PALETTE = ["#4c72b0", "#dd8452", "#55a868", "#c44e52", "#8172b2", "#937860", "#da8bc3", "#8c8c8c"];
const FONT_FAMILY = "ui-sans-serif, -apple-system, sans-serif";
const MARGIN = { top: 56, right: 180, bottom: 72, left: 72 };

export function esc(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function fmtNum(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 100) return n.toFixed(0);
  if (Math.abs(n) >= 1) return n.toFixed(2);
  return n.toFixed(4);
}

export interface PlotArea {
  x: number;
  y: number;
  w: number;
  h: number;
}

function plotArea(margin = MARGIN, width = WIDTH, height = HEIGHT): PlotArea {
  return { x: margin.left, y: margin.top, w: width - margin.left - margin.right, h: height - margin.top - margin.bottom };
}

// No `xmlns` declaration: these SVGs are inlined directly into HTML5
// (`<svg>` is auto-recognized as foreign-namespace content, no xmlns
// needed) and referenced as standalone `.svg` files that GitHub/browsers
// render without it too. Keeping it out means "no `http` substring
// anywhere" is a real, checkable no-network-reference guarantee.
function svgOpen(title: string, width = WIDTH, height = HEIGHT): string {
  return [
    `<svg viewBox="0 0 ${width} ${height}" width="${width}" height="${height}" font-family="${FONT_FAMILY}">`,
    `<title>${esc(title)}</title>`,
    `<rect x="0" y="0" width="${width}" height="${height}" fill="#ffffff"/>`,
    `<text x="${width / 2}" y="28" font-size="16" font-weight="600" text-anchor="middle" fill="#111827">${esc(title)}</text>`,
  ].join("");
}

function yAxis(maxVal: number, area: PlotArea, yLabel: string, ticks = 4): string {
  const parts: string[] = [];
  for (let t = 0; t <= ticks; t++) {
    const val = (maxVal * t) / ticks;
    const y = area.y + area.h - (val / (maxVal || 1)) * area.h;
    parts.push(`<line x1="${area.x}" y1="${y.toFixed(1)}" x2="${area.x + area.w}" y2="${y.toFixed(1)}" stroke="#e5e7eb" stroke-width="1"/>`);
    parts.push(`<text x="${area.x - 8}" y="${(y + 4).toFixed(1)}" font-size="11" text-anchor="end" fill="#374151">${fmtNum(val)}</text>`);
  }
  parts.push(
    `<text x="${area.x - 48}" y="${area.y + area.h / 2}" font-size="12" text-anchor="middle" fill="#374151" transform="rotate(-90 ${area.x - 48} ${area.y + area.h / 2})">${esc(yLabel)}</text>`,
  );
  return parts.join("");
}

function legend(labels: string[], area: PlotArea): string {
  const x = area.x + area.w + 16;
  return labels
    .map((label, i) => {
      const y = area.y + i * 22;
      const color = PALETTE[i % PALETTE.length];
      return `<rect x="${x}" y="${y}" width="12" height="12" fill="${color}"/><text x="${x + 18}" y="${y + 10}" font-size="11" fill="#111827">${esc(label)}</text>`;
    })
    .join("");
}

export function groupedBars(o: { title: string; categories: string[]; series: Series[]; yLabel: string; yMax?: number }): string {
  const area = plotArea();
  const finite = o.series.flatMap((s) => s.values.filter((v): v is number => typeof v === "number"));
  const yMax = o.yMax ?? Math.max(1e-9, ...finite);
  const groupWidth = area.w / Math.max(1, o.categories.length);
  const groupPad = groupWidth * 0.12;
  const barsWidth = groupWidth - groupPad * 2;
  const barWidth = barsWidth / Math.max(1, o.series.length);

  const bars: string[] = [];
  const labels: string[] = [];
  o.categories.forEach((cat, ci) => {
    const groupX = area.x + ci * groupWidth + groupPad;
    labels.push(`<text x="${(groupX + barsWidth / 2).toFixed(1)}" y="${area.y + area.h + 20}" font-size="11" text-anchor="middle" fill="#111827">${esc(cat)}</text>`);
    o.series.forEach((s, si) => {
      const v = s.values[ci];
      if (typeof v !== "number") return;
      const barH = (v / (yMax || 1)) * area.h;
      const x = groupX + si * barWidth;
      const y = area.y + area.h - barH;
      const color = PALETTE[si % PALETTE.length];
      bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${(barWidth * 0.86).toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}"/>`);
      const err = s.errors?.[ci];
      if (typeof err === "number" && err > 0) {
        const cx = x + (barWidth * 0.86) / 2;
        const yTop = area.y + area.h - Math.min(yMax, v + err) * (area.h / (yMax || 1));
        const yBot = area.y + area.h - Math.max(0, v - err) * (area.h / (yMax || 1));
        bars.push(`<line x1="${cx.toFixed(1)}" y1="${yTop.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yBot.toFixed(1)}" stroke="#111827" stroke-width="1.5"/>`);
      }
    });
  });

  return [
    svgOpen(o.title),
    yAxis(yMax, area, o.yLabel),
    bars.join(""),
    labels.join(""),
    legend(o.series.map((s) => s.label), area),
    `</svg>`,
  ].join("");
}

export function whiskerBars(o: { title: string; categories: string[]; values: number[]; low: number[]; high: number[]; yLabel: string }): string {
  const area = plotArea();
  const yMax = Math.max(1e-9, ...o.high);
  const barWidth = (area.w / Math.max(1, o.categories.length)) * 0.6;
  const slot = area.w / Math.max(1, o.categories.length);

  const bars: string[] = [];
  const labels: string[] = [];
  o.categories.forEach((cat, i) => {
    const cx = area.x + i * slot + slot / 2;
    const value = o.values[i] ?? 0;
    const low = o.low[i] ?? value;
    const high = o.high[i] ?? value;
    const barH = (value / (yMax || 1)) * area.h;
    const x = cx - barWidth / 2;
    const y = area.y + area.h - barH;
    const color = PALETTE[i % PALETTE.length];
    bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${barH.toFixed(1)}" fill="${color}"/>`);
    const yLow = area.y + area.h - (low / (yMax || 1)) * area.h;
    const yHigh = area.y + area.h - (high / (yMax || 1)) * area.h;
    bars.push(`<line x1="${cx.toFixed(1)}" y1="${yLow.toFixed(1)}" x2="${cx.toFixed(1)}" y2="${yHigh.toFixed(1)}" stroke="#111827" stroke-width="1.5"/>`);
    bars.push(`<line x1="${(cx - 6).toFixed(1)}" y1="${yHigh.toFixed(1)}" x2="${(cx + 6).toFixed(1)}" y2="${yHigh.toFixed(1)}" stroke="#111827" stroke-width="1.5"/>`);
    bars.push(`<line x1="${(cx - 6).toFixed(1)}" y1="${yLow.toFixed(1)}" x2="${(cx + 6).toFixed(1)}" y2="${yLow.toFixed(1)}" stroke="#111827" stroke-width="1.5"/>`);
    labels.push(`<text x="${cx.toFixed(1)}" y="${area.y + area.h + 20}" font-size="11" text-anchor="middle" fill="#111827">${esc(cat)}</text>`);
  });

  return [svgOpen(o.title), yAxis(yMax, area, o.yLabel), bars.join(""), labels.join(""), `</svg>`].join("");
}

export function scatter(o: {
  title: string;
  points: { x: number; y: number; label: string; group: string; hollow?: boolean }[];
  xLabel: string;
  yLabel: string;
  xLog?: boolean;
}): string {
  const area = plotArea();
  const groups = [...new Set(o.points.map((p) => p.group))];
  const xs = o.points.map((p) => (o.xLog ? Math.log10(Math.max(p.x, 1e-9)) : p.x));
  const ys = o.points.map((p) => p.y);
  const xMin = Math.min(0, ...xs);
  const xMax = Math.max(1e-9, ...xs);
  const yMax = Math.max(1e-9, ...ys);
  const xScale = (v: number) => area.x + ((v - xMin) / (xMax - xMin || 1)) * area.w;
  const yScale = (v: number) => area.y + area.h - (v / (yMax || 1)) * area.h;

  const points = o.points.map((p) => {
    const px = xScale(o.xLog ? Math.log10(Math.max(p.x, 1e-9)) : p.x);
    const py = yScale(p.y);
    const color = PALETTE[groups.indexOf(p.group) % PALETTE.length];
    const fill = p.hollow ? "none" : color;
    return `<circle cx="${px.toFixed(1)}" cy="${py.toFixed(1)}" r="5" fill="${fill}" stroke="${color}" stroke-width="1.5"><title>${esc(p.label)}</title></circle>`;
  });

  const axisLabels = [
    `<text x="${area.x + area.w / 2}" y="${area.y + area.h + 36}" font-size="12" text-anchor="middle" fill="#374151">${esc(o.xLabel)}</text>`,
  ];

  return [svgOpen(o.title), yAxis(yMax, area, o.yLabel), axisLabels.join(""), points.join(""), legend(groups, area), `</svg>`].join("");
}

export function heatmap(o: { title: string; rows: string[]; cols: string[]; values: (number | null)[][]; vmin?: number; vmax?: number }): string {
  const area = plotArea();
  const finite = o.values.flat().filter((v): v is number => typeof v === "number");
  const vmin = o.vmin ?? Math.min(0, ...finite);
  const vmax = o.vmax ?? Math.max(1e-9, ...finite);
  const cellW = area.w / Math.max(1, o.cols.length);
  const cellH = area.h / Math.max(1, o.rows.length);

  function colorFor(v: number): string {
    const t = Math.min(1, Math.max(0, (v - vmin) / (vmax - vmin || 1)));
    // Low -> red (#c44e52), high -> green (#55a868), interpolated through white.
    const lo = { r: 0xc4, g: 0x4e, b: 0x52 };
    const hi = { r: 0x55, g: 0xa8, b: 0x68 };
    const r = Math.round(lo.r + (hi.r - lo.r) * t);
    const g = Math.round(lo.g + (hi.g - lo.g) * t);
    const b = Math.round(lo.b + (hi.b - lo.b) * t);
    return `rgb(${r},${g},${b})`;
  }

  const cells: string[] = [];
  const rowLabels: string[] = [];
  const colLabels: string[] = [];
  o.rows.forEach((rowLabel, ri) => {
    rowLabels.push(`<text x="${area.x - 8}" y="${(area.y + ri * cellH + cellH / 2 + 4).toFixed(1)}" font-size="10" text-anchor="end" fill="#111827">${esc(rowLabel)}</text>`);
    o.cols.forEach((colLabel, ci) => {
      const v = o.values[ri]?.[ci];
      const x = area.x + ci * cellW;
      const y = area.y + ri * cellH;
      if (typeof v === "number") {
        cells.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="${colorFor(v)}" stroke="#ffffff"/>`);
        cells.push(`<text x="${(x + cellW / 2).toFixed(1)}" y="${(y + cellH / 2 + 4).toFixed(1)}" font-size="10" text-anchor="middle" fill="#111827">${fmtNum(v)}</text>`);
      } else {
        cells.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${cellW.toFixed(1)}" height="${cellH.toFixed(1)}" fill="#f3f4f6" stroke="#ffffff"/>`);
      }
      if (ri === 0) {
        colLabels.push(`<text x="${(x + cellW / 2).toFixed(1)}" y="${area.y - 8}" font-size="10" text-anchor="middle" fill="#111827">${esc(colLabel)}</text>`);
      }
    });
  });

  return [svgOpen(o.title), cells.join(""), rowLabels.join(""), colLabels.join(""), `</svg>`].join("");
}

export function stackedBars(o: { title: string; categories: string[]; series: Series[]; yLabel: string }): string {
  const area = plotArea();
  const totals = o.categories.map((_, ci) => o.series.reduce((sum, s) => sum + (typeof s.values[ci] === "number" ? (s.values[ci] as number) : 0), 0));
  const yMax = Math.max(1e-9, ...totals);
  const slot = area.w / Math.max(1, o.categories.length);
  const barWidth = slot * 0.6;

  const bars: string[] = [];
  const labels: string[] = [];
  o.categories.forEach((cat, ci) => {
    const x = area.x + ci * slot + (slot - barWidth) / 2;
    let cursor = area.y + area.h;
    o.series.forEach((s, si) => {
      const v = s.values[ci];
      if (typeof v !== "number" || v <= 0) return;
      const segH = (v / (yMax || 1)) * area.h;
      const y = cursor - segH;
      bars.push(`<rect x="${x.toFixed(1)}" y="${y.toFixed(1)}" width="${barWidth.toFixed(1)}" height="${segH.toFixed(1)}" fill="${PALETTE[si % PALETTE.length]}"/>`);
      cursor = y;
    });
    labels.push(`<text x="${(x + barWidth / 2).toFixed(1)}" y="${area.y + area.h + 20}" font-size="11" text-anchor="middle" fill="#111827">${esc(cat)}</text>`);
  });

  return [svgOpen(o.title), yAxis(yMax, area, o.yLabel), bars.join(""), labels.join(""), legend(o.series.map((s) => s.label), area), `</svg>`].join("");
}
