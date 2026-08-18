// Suite TOML load + validation. A suite is the matrix definition: which
// models × thinking levels × fixtures × repetitions to run, plus the
// composite-score weights. Validation reports every problem in one pass so a
// suite author never has to re-run to discover the next mistake.

import { pathToFileURL } from "node:url";
import { basename, extname, resolve } from "node:path";
import { catalog, type ModelInfo } from "./models.ts";
import { resolveTask, type EvalTask, type Fixture } from "./task.ts";

export type SuiteConfig = {
  task: string;
  models: string[];
  thinking: string[];
  fixtures: string[];
  reps: number;
  perProviderJobs: number;
  retries: number;
  weights: Record<string, number>;
};

export type LoadedSuite = {
  name: string;
  config: SuiteConfig;
  task: EvalTask;
  modelInfos: ModelInfo[];
  fixtureList: Fixture[];
};

export class SuiteError extends Error {
  constructor(
    public readonly path: string,
    public readonly problems: string[],
  ) {
    super(`Invalid suite ${path}:\n${problems.map((p) => `  - ${p}`).join("\n")}`);
    this.name = "SuiteError";
  }
}

const WEIGHT_TOLERANCE = 0.001;

function isStringArray(v: unknown): v is string[] {
  return Array.isArray(v) && v.every((x) => typeof x === "string");
}

export async function loadSuite(path: string): Promise<LoadedSuite> {
  const abs = resolve(path);
  // Exception to static-import-only: `path` is a CLI-supplied suite file
  // chosen at runtime, not a module known at author time. Bun's native TOML
  // loader only runs through the ESM `import()` path.
  const raw = (await import(pathToFileURL(abs).href)).default as Record<string, unknown>;
  const problems: string[] = [];

  const taskName = typeof raw.task === "string" ? raw.task : undefined;
  if (!taskName) problems.push(`"task" must be a string`);

  const modelSelectors = isStringArray(raw.models) ? raw.models : undefined;
  if (!modelSelectors || modelSelectors.length === 0) problems.push(`"models" must be a non-empty string array`);

  const thinkingLevels = isStringArray(raw.thinking) ? raw.thinking : undefined;
  if (!thinkingLevels || thinkingLevels.length === 0) problems.push(`"thinking" must be a non-empty string array`);

  const fixtureIds = isStringArray(raw.fixtures) ? raw.fixtures : undefined;
  if (!fixtureIds || fixtureIds.length === 0) problems.push(`"fixtures" must be a non-empty string array`);

  const reps = typeof raw.reps === "number" ? raw.reps : undefined;
  if (reps === undefined || !Number.isInteger(reps) || reps < 1) {
    problems.push(`"reps" must be an integer >= 1`);
  }

  const perProviderJobs = typeof raw.perProviderJobs === "number" ? raw.perProviderJobs : 1;
  if (!Number.isInteger(perProviderJobs) || perProviderJobs < 1) {
    problems.push(`"perProviderJobs" must be an integer >= 1`);
  }

  const retries = typeof raw.retries === "number" ? raw.retries : 0;
  if (!Number.isInteger(retries) || retries < 0) {
    problems.push(`"retries" must be an integer >= 0`);
  }

  const weightsRaw = raw.weights as Record<string, unknown> | undefined;
  const weights: Record<string, number> = {};
  if (typeof weightsRaw !== "object" || weightsRaw === null) {
    problems.push(`"weights" must be a table of metric -> number`);
  } else {
    let sum = 0;
    for (const [key, value] of Object.entries(weightsRaw)) {
      if (typeof value !== "number") {
        problems.push(`weights.${key} must be a number, got ${typeof value}`);
        continue;
      }
      weights[key] = value;
      sum += value;
    }
    if (Math.abs(sum - 1) > WEIGHT_TOLERANCE) {
      problems.push(`weights must sum to 1 ± ${WEIGHT_TOLERANCE} (got ${sum})`);
    }
  }

  // Resolve task, catalog, and fixtures for cross-referencing. Each lookup
  // failure becomes a problem instead of an immediate throw so the rest of
  // the suite still gets validated.
  let task: EvalTask | undefined;
  if (taskName) {
    try {
      task = resolveTask(taskName);
    } catch (err) {
      problems.push((err as Error).message);
    }
  }

  const models = await catalog();
  const modelInfos: ModelInfo[] = [];
  if (modelSelectors) {
    for (const selector of modelSelectors) {
      const info = models.get(selector);
      if (!info) {
        problems.push(`unknown model selector "${selector}"`);
        continue;
      }
      modelInfos.push(info);
      if (thinkingLevels) {
        for (const level of thinkingLevels) {
          const supported = info.thinking ?? [];
          if (!supported.includes(level)) {
            problems.push(
              `model "${selector}" does not support thinking level "${level}" (supports: ${supported.join(", ") || "(none)"})`,
            );
          }
        }
      }
    }
  }

  let fixtureList: Fixture[] = [];
  if (task && fixtureIds) {
    const allFixtures = await task.fixtures();
    const byId = new Map(allFixtures.map((f) => [f.id, f]));
    for (const id of fixtureIds) {
      const fixture = byId.get(id);
      if (!fixture) {
        const known = [...byId.keys()].sort().join(", ");
        problems.push(`unknown fixture id "${id}" for task "${task.name}" (known: ${known || "(none)"})`);
        continue;
      }
      fixtureList.push(fixture);
    }
  }

  if (problems.length > 0) {
    throw new SuiteError(abs, problems);
  }

  const name = basename(abs, extname(abs));
  return {
    name,
    config: {
      task: taskName!,
      models: modelSelectors!,
      thinking: thinkingLevels!,
      fixtures: fixtureIds!,
      reps: reps!,
      perProviderJobs,
      retries,
      weights,
    },
    task: task!,
    modelInfos,
    fixtureList,
  };
}
