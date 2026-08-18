// Secret-pattern scanner. Fixture history/dirty patches are real diffs mined
// from a real repo, so every patch is scanned before it is trusted to ship.

import { join } from "node:path";
import { readdirSync } from "node:fs";
import { Glob } from "bun";

export type SecretHit = { file: string; line: number; pattern: string; excerpt: string };

const PATTERNS: Array<{ name: string; re: RegExp }> = [
  { name: "sk- token", re: /sk-[A-Za-z0-9]{16,}/ },
  { name: "GitHub PAT (classic)", re: /ghp_[A-Za-z0-9]{20,}/ },
  { name: "GitHub PAT (fine-grained)", re: /github_pat_/ },
  { name: "AWS access key", re: /AKIA[0-9A-Z]{16}/ },
  { name: "Slack token", re: /xox[baprs]-/ },
  { name: "PEM private key", re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  // `(?!\$)` excludes shell/env variable interpolation right after the quote
  // (`token="${var}"`, `token="$VAR"`) — verified false positive this
  // session on a CLI-argument loop variable literally named "token".
  { name: "inline secret assignment", re: /(api[_-]?key|secret|password|token)\s*[:=]\s*["'](?!\$)[^"']{12,}/i },
];

export async function scanFile(path: string): Promise<SecretHit[]> {
  const text = await Bun.file(path).text();
  const hits: SecretHit[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!;
    for (const { name, re } of PATTERNS) {
      if (re.test(line)) {
        hits.push({ file: path, line: i + 1, pattern: name, excerpt: line.trim().slice(0, 120) });
      }
    }
  }
  return hits;
}

/** Scans one fixture directory's `history/*.patch` and `dirty.patch`. */
export async function scanFixtureDir(dir: string): Promise<SecretHit[]> {
  const hits: SecretHit[] = [];
  const historyDir = join(dir, "history");
  const historyGlob = new Glob("*.patch");
  for await (const name of historyGlob.scan({ cwd: historyDir, dot: false })) {
    hits.push(...(await scanFile(join(historyDir, name))));
  }
  const dirtyPatch = join(dir, "dirty.patch");
  if (await Bun.file(dirtyPatch).exists()) {
    hits.push(...(await scanFile(dirtyPatch)));
  }
  return hits;
}

/** Scans every immediate subdirectory of `fixturesRoot` as a fixture. */
export async function scanAllFixtures(fixturesRoot: string): Promise<SecretHit[]> {
  const entries = readdirSync(fixturesRoot, { withFileTypes: true });
  const hits: SecretHit[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    hits.push(...(await scanFixtureDir(join(fixturesRoot, entry.name))));
  }
  return hits;
}

export function formatHits(hits: SecretHit[]): string {
  return hits.map((h) => `${h.file}:${h.line}: [${h.pattern}] ${h.excerpt}`).join("\n");
}

const REDACTION_PLACEHOLDER = "<redacted-secret-pattern>";

/**
 * Replaces every secret-pattern match with a fixed non-matching placeholder,
 * preserving line count (safe inside diff hunks, which are line-counted, not
 * byte-counted). Used when a fixture's replayed prior history legitimately
 * contains pattern-matching-but-benign content, e.g. a test asserting that a
 * safety hook denies secret-shaped input.
 */
export function redactText(text: string): { text: string; redactions: number } {
  let redactions = 0;
  let result = text;
  for (const { re } of PATTERNS) {
    const global = new RegExp(re.source, re.flags.includes("g") ? re.flags : `${re.flags}g`);
    result = result.replace(global, () => {
      redactions++;
      return REDACTION_PLACEHOLDER;
    });
  }
  return { text: result, redactions };
}
