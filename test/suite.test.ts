// Suite validation: every problem is reported in one pass, and an
// unsupported thinking level for a specific model is caught before any
// omp invocation happens.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadSuite, SuiteError } from "../evalkit/suite.ts";

describe("loadSuite validation", () => {
  test("throws when a model does not support a requested thinking level", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmt-eval-suite-test-"));
    try {
      const path = join(dir, "bad.toml");
      // anthropic/claude-haiku-4-5's catalog thinking array has no "max".
      await Bun.write(
        path,
        [
          `task = "git-commit"`,
          `models = ["anthropic/claude-haiku-4-5"]`,
          `thinking = ["max"]`,
          `fixtures = ["shellcheck-1"]`,
          `reps = 1`,
          `perProviderJobs = 1`,
          `retries = 0`,
          ``,
          `[weights]`,
          `countMatch = 1.0`,
          ``,
        ].join("\n"),
      );

      let thrown: unknown;
      try {
        await loadSuite(path);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SuiteError);
      const problems = (thrown as SuiteError).problems;
      expect(problems.some((p) => p.includes("claude-haiku-4-5") && p.includes("max"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });

  test("reports every problem in one pass, not just the first", async () => {
    const dir = mkdtempSync(join(tmpdir(), "cmt-eval-suite-test-"));
    try {
      const path = join(dir, "bad.toml");
      await Bun.write(
        path,
        [
          `task = "not-a-real-task"`,
          `models = ["not/a-real-model"]`,
          `thinking = ["low"]`,
          `fixtures = ["not-a-real-fixture"]`,
          `reps = 0`,
          ``,
          `[weights]`,
          `countMatch = 0.5`,
          ``,
        ].join("\n"),
      );

      let thrown: unknown;
      try {
        await loadSuite(path);
      } catch (err) {
        thrown = err;
      }

      expect(thrown).toBeInstanceOf(SuiteError);
      const problems = (thrown as SuiteError).problems;
      expect(problems.some((p) => p.includes("not-a-real-task"))).toBe(true);
      expect(problems.some((p) => p.includes("not/a-real-model"))).toBe(true);
      expect(problems.some((p) => p.includes("reps"))).toBe(true);
      expect(problems.some((p) => p.includes("weights") && p.includes("sum"))).toBe(true);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
