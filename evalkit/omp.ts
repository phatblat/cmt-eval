// Invocation of `omp -p` for one eval cell, plus session-usage accounting.

import { join } from "node:path";
import { mkdirSync } from "node:fs";

export type BuildArgvOptions = {
  model: string;
  thinking: string;
  repo: string;
  runDir: string;
  prompt: string;
  timeoutS: number;
};

/** Args passed to the `omp` binary (excludes the binary name itself). */
export function buildArgv(o: BuildArgvOptions): string[] {
  return [
    "-p",
    "--mode",
    "text",
    "--cwd",
    o.repo,
    "--model",
    o.model,
    "--thinking",
    o.thinking,
    "--approval-mode",
    "yolo",
    "--no-title",
    "--no-lsp",
    "--session-dir",
    join(o.runDir, "sessions"),
    "--config",
    join(o.runDir, "eval.yml"),
    "--max-time",
    String(o.timeoutS),
    o.prompt,
  ];
}

export type RunOmpResult = { exitCode: number | null; signal: string | null; wallS: number; stderrTail: string };

/**
 * Hard spawn deadline beyond the session's own `--max-time`: gives `omp` time
 * to flush a graceful stop before the OS kills it outright.
 */
const HARD_DEADLINE_GRACE_MS = 120_000;

export async function runOmp(o: BuildArgvOptions): Promise<RunOmpResult> {
  const argv = buildArgv(o);
  mkdirSync(o.runDir, { recursive: true });

  // The interactive shell exports FORCE_COLOR, which makes `omp` emit a Node
  // deprecation warning block into stderr that would otherwise pollute the
  // failure-classification regex in runner.ts.
  const env: Record<string, string> = { ...process.env } as Record<string, string>;
  delete env.FORCE_COLOR;
  env.NO_COLOR = "1";

  const proc = Bun.spawn({
    cmd: ["omp", ...argv],
    env,
    stdout: "pipe",
    stderr: "pipe",
    timeout: o.timeoutS * 1000 + HARD_DEADLINE_GRACE_MS,
  });

  const start = performance.now();
  const [stdoutText, stderrText] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  const wallS = (performance.now() - start) / 1000;

  await Promise.all([
    Bun.write(join(o.runDir, "stdout.log"), stdoutText),
    Bun.write(join(o.runDir, "stderr.log"), stderrText),
  ]);

  return {
    exitCode: proc.exitCode,
    signal: proc.signalCode ?? null,
    wallS,
    stderrTail: stderrText.slice(-2000),
  };
}

export type Usage = {
  tokensInput: number;
  tokensOutput: number;
  tokensCacheRead: number;
  tokensCacheWrite: number;
  costUsd: number;
  modelTimeS: number;
  ttftS: number | null;
  assistantTurns: number;
  subagents: number;
};

type AssistantRecord = {
  type: string;
  message?: {
    role?: string;
    usage?: {
      input?: number;
      output?: number;
      cacheRead?: number;
      cacheWrite?: number;
      cost?: { total?: number };
    };
    duration?: number;
    ttft?: number;
  };
};

/**
 * Sums token/cost/timing usage across every `*.jsonl` transcript under
 * `sessionDir`, including subagent transcripts (`<session>/<AgentName>.jsonl`
 * sit beside `<session>.jsonl`, so a recursive glob picks them up for free).
 */
export async function collectUsage(sessionDir: string): Promise<Usage> {
  const glob = new Bun.Glob("**/*.jsonl");
  const files: string[] = [];
  for await (const rel of glob.scan({ cwd: sessionDir, dot: true })) {
    files.push(join(sessionDir, rel));
  }

  let tokensInput = 0;
  let tokensOutput = 0;
  let tokensCacheRead = 0;
  let tokensCacheWrite = 0;
  let costUsd = 0;
  let modelTimeMs = 0;
  let ttftMs: number | null = null;
  let assistantTurns = 0;

  for (const file of files) {
    const text = await Bun.file(file).text();
    for (const line of text.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed) continue;
      let record: AssistantRecord;
      try {
        record = JSON.parse(trimmed);
      } catch {
        continue;
      }
      if (record.type !== "message" || record.message?.role !== "assistant") continue;
      const usage = record.message.usage;
      if (usage) {
        tokensInput += usage.input ?? 0;
        tokensOutput += usage.output ?? 0;
        tokensCacheRead += usage.cacheRead ?? 0;
        tokensCacheWrite += usage.cacheWrite ?? 0;
        costUsd += usage.cost?.total ?? 0;
      }
      modelTimeMs += record.message.duration ?? 0;
      if (ttftMs === null && typeof record.message.ttft === "number") {
        ttftMs = record.message.ttft;
      }
      assistantTurns += 1;
    }
  }

  return {
    tokensInput,
    tokensOutput,
    tokensCacheRead,
    tokensCacheWrite,
    costUsd,
    modelTimeS: modelTimeMs / 1000,
    ttftS: ttftMs === null ? null : ttftMs / 1000,
    assistantTurns,
    subagents: Math.max(0, files.length - 1),
  };
}

/**
 * Fallback usage path when `--session-dir` produces no session file at all:
 * `subagents = -1` flags that subagent spend is unaccounted for.
 */
export const UNKNOWN_USAGE: Usage = {
  tokensInput: 0,
  tokensOutput: 0,
  tokensCacheRead: 0,
  tokensCacheWrite: 0,
  costUsd: 0,
  modelTimeS: 0,
  ttftS: null,
  assistantTurns: 0,
  subagents: -1,
};

/**
 * `<runDir>/eval.yml` overlay: neutralizes global `~/.omp/agent/config.yml`
 * settings that would add extra model calls (advisor, autolearn, prewalk,
 * branch summary) or make accounting depend on mutable global state (memory
 * backend). Written once per run before any cell launches.
 */
const EVAL_CONFIG_YAML = `memory:
  backend: "off"
autolearn:
  enabled: false
advisor:
  enabled: false
prewalk:
  enabled: false
branchSummary:
  enabled: false
task:
  agentAdvisor:
    task: "off"
tools:
  approvalMode: yolo
`;

export async function writeEvalConfig(runDir: string): Promise<string> {
  mkdirSync(runDir, { recursive: true });
  const path = join(runDir, "eval.yml");
  await Bun.write(path, EVAL_CONFIG_YAML);
  return path;
}
