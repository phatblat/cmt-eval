// The reusable contract every eval subject implements. A "task" is a subject
// under test (e.g. the `/git:commit` skill): it supplies fixtures, materializes
// them into a scratch workdir, produces the prompt sent to the agent, and
// grades the result into a Metrics record plus a single composite score.

export type Group = {
  type: string;
  subject: string;
  paths: string[];
};

export type Fixture = {
  id: string;
  dir: string;
  description: string;
  expectedCommits: number;
  groups: Group[];
  timeoutS: number;
};

// Metric values are numbers (continuous scores/counts), booleans (pass/fail
// checks), or strings (free-form diagnostic fields not used in composites).
export type Metrics = Record<string, number | boolean | string>;

export type PreparedRun = { repo: string; baseTip: string };

export interface EvalTask {
  readonly name: string; // e.g. "git-commit"
  fixtures(): Promise<Fixture[]>; // reads tasks/<name>/fixtures/*
  prepare(fixture: Fixture, workdir: string): Promise<PreparedRun>;
  prompt(fixture: Fixture): string;
  grade(fixture: Fixture, prepared: PreparedRun): Promise<Metrics>;
  composite(m: Metrics, weights: Record<string, number>): number;
}

// Import implementations here (not the other way around) to keep the
// dependency direction "framework depends on subject", never the reverse.
import { gitCommitTask } from "../tasks/git-commit/task.ts";

export const TASKS: Record<string, EvalTask> = {
  [gitCommitTask.name]: gitCommitTask,
};

export function resolveTask(name: string): EvalTask {
  const task = TASKS[name];
  if (!task) {
    const known = Object.keys(TASKS).sort().join(", ");
    throw new Error(`Unknown task "${name}". Known tasks: ${known || "(none registered)"}`);
  }
  return task;
}
