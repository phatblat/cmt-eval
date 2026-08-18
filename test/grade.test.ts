// Grader discrimination proof: no tokens spent. Commits the fixture's real
// expected groups by hand and confirms grade() scores a perfect split at
// composite === 1, then confirms an under-split (everything squashed into
// one commit) is scored down correctly and symmetrically.

import { describe, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { gitOk } from "../evalkit/gitrepo.ts";
import type { Metrics } from "../evalkit/task.ts";
import { gitCommitTask } from "../tasks/git-commit/task.ts";

const TRAILER = "Co-Authored-By: oh-my-pi <omp@can.ac>";

// Mirrors suites/focus.toml's [weights] table.
const WEIGHTS = {
  countMatch: 0.4,
  groupingScore: 0.3,
  convMsgs: 0.1,
  trailerOk: 0.1,
  treeClean: 0.05,
  typeMatch: 0.05,
};

async function loadHarnessFixture() {
  const fixtures = await gitCommitTask.fixtures();
  const fixture = fixtures.find((f) => f.id === "harness-ci-docs-3");
  if (!fixture) {
    throw new Error('harness-ci-docs-3 fixture not built - run "just fixtures" before "just test"');
  }
  return fixture;
}

async function withScratchRepo<T>(fn: (workdir: string) => Promise<T>): Promise<T> {
  const workdir = mkdtempSync(join(tmpdir(), "cmt-eval-grade-test-"));
  try {
    return await fn(workdir);
  } finally {
    rmSync(workdir, { recursive: true, force: true });
  }
}

describe("git-commit grader", () => {
  test("a perfect split (one commit per expected group) scores composite === 1", async () => {
    const fixture = await loadHarnessFixture();
    await withScratchRepo(async (workdir) => {
      const prepared = await gitCommitTask.prepare(fixture, workdir);

      for (const group of fixture.groups) {
        gitOk(["add", "--", ...group.paths], prepared.repo);
        gitOk(["commit", "-m", `${group.type}: ${group.subject}\n\n${TRAILER}`], prepared.repo);
      }

      const metrics: Metrics = await gitCommitTask.grade(fixture, prepared);
      expect(metrics.commits).toBe(3);
      expect(metrics.countMatch).toBe(true);
      expect(metrics.groupingScore as number).toBeCloseTo(1, 9);
      expect(metrics.trailerOk).toBe(1);
      expect(metrics.treeClean).toBe(true);
      expect(metrics.convMsgs).toBe(1);
      expect(metrics.typeMatch).toBe(1);

      const composite = gitCommitTask.composite(metrics, WEIGHTS);
      expect(composite).toBeCloseTo(1, 9);
    });
  });

  test("squashing every group into one commit is scored down symmetrically", async () => {
    const fixture = await loadHarnessFixture();
    await withScratchRepo(async (workdir) => {
      const prepared = await gitCommitTask.prepare(fixture, workdir);

      gitOk(["add", "-A"], prepared.repo);
      gitOk(["commit", "-m", `chore: apply pending changes\n\n${TRAILER}`], prepared.repo);

      const metrics: Metrics = await gitCommitTask.grade(fixture, prepared);
      expect(metrics.commits).toBe(1);
      expect(metrics.countMatch).toBe(false);

      // Fixture group sizes are 2/3/1 paths (6 total, disjoint). Squashed
      // into one commit, the best one-to-one match pairs the single actual
      // commit with the largest expected group (3/6 Jaccard); the other two
      // expected groups go unmatched (0). groupingScore = (3/6) / max(3,1).
      expect(metrics.groupingScore as number).toBeCloseTo(3 / 6 / 3, 9);

      const composite = gitCommitTask.composite(metrics, WEIGHTS);
      expect(composite).toBeGreaterThan(0.1);
      expect(composite).toBeLessThan(0.35);
    });
  });
});
