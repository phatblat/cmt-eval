// Markdown/HTML table rendering shared by the per-run report (render.ts) and
// the cross-run comparison report (compare.ts). Split out once a second
// consumer needed the exact same two renderers rather than let them drift.

import { esc } from "./charts.ts";

export type TableData = { headers: string[]; body: string[][] };

export function mdTable(data: TableData): string {
  if (data.body.length === 0) return "_none_\n";
  const head = `| ${data.headers.join(" | ")} |\n| ${data.headers.map(() => "---").join(" | ")} |`;
  const body = data.body.map((r) => `| ${r.map((c) => c.replace(/\|/g, "\\|")).join(" | ")} |`).join("\n");
  return `${head}\n${body}\n`;
}

export function htmlTable(data: TableData): string {
  const thead = `<tr>${data.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr>`;
  const tbody =
    data.body.length === 0
      ? `<tr><td colspan="${data.headers.length}"><em>none</em></td></tr>`
      : data.body.map((r) => `<tr>${r.map((c) => `<td>${esc(c)}</td>`).join("")}</tr>`).join("");
  return `<table><thead>${thead}</thead><tbody>${tbody}</tbody></table>`;
}
