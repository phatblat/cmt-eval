// The `/git:commit` eval subject: prompt, fixture materialization, and
// grading. Grading reasons purely from the resulting git repo state (commit
// count, path grouping, message convention, trailer) — never from the
// session transcript, so it grades what actually landed, not what the model
// claimed to do.

import { readdirSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { git, gitOk, materialize } from "../../evalkit/gitrepo.ts";
import type { EvalTask, Fixture, Group, Metrics, PreparedRun } from "../../evalkit/task.ts";

export const FIXTURES_DIR = join(import.meta.dir, "fixtures");

const CONVENTIONAL_RE = /^(feat|fix|chore|docs|refactor|perf|test|build|ci|style|revert)(\([a-z0-9._/-]+\))?!?: .{3,}$/;
const GENERIC_RE = /^(update|misc|various|wip|changes|fixes)\b/i;
const TYPE_PREFIX_RE = /^([a-zA-Z]+)(\([^)]*\))?!?:/;
const TRAILER_LINE = "Co-Authored-By: oh-my-pi <omp@can.ac>";

type RawFixtureToml = {
  id: string;
  description: string;
  expectedCommits: number;
  timeoutS: number;
  group?: Array<{ type: string; subject: string; paths: string[] }>;
};

export async function loadFixture(dir: string): Promise<Fixture> {
  const raw = (await import(pathToFileURL(join(dir, "fixture.toml")).href)).default as RawFixtureToml;
  const groups: Group[] = (raw.group ?? []).map((g) => ({ type: g.type, subject: g.subject, paths: g.paths }));
  return {
    id: raw.id,
    dir,
    description: raw.description,
    expectedCommits: raw.expectedCommits,
    groups,
    timeoutS: raw.timeoutS,
  };
}

async function listFixtures(): Promise<Fixture[]> {
  let entries: string[];
  try {
    entries = readdirSync(FIXTURES_DIR, { withFileTypes: true })
      .filter((e) => e.isDirectory())
      .map((e) => e.name)
      .sort();
  } catch {
    return [];
  }
  const fixtures: Fixture[] = [];
  for (const name of entries) {
    fixtures.push(await loadFixture(join(FIXTURES_DIR, name)));
  }
  return fixtures;
}

function jaccard(a: Set<string>, b: Set<string>): number {
  if (a.size === 0 && b.size === 0) return 1;
  let intersection = 0;
  for (const x of a) if (b.has(x)) intersection++;
  const union = a.size + b.size - intersection;
  return union === 0 ? 1 : intersection / union;
}

/**
 * Best one-to-one match between expected groups and actual commit path sets,
 * maximizing total Jaccard similarity. Exact backtracking search: expected
 * groups are capped at 6 by fixture design, and actual commit counts stay in
 * the same order of magnitude (bounded by the fixture's total touched
 * paths), so the search space never blows up in practice. A greedy fallback
 * guards against a pathologically over-splitting run.
 */
function bestMatching(expectedSets: Set<string>[], actualSets: Set<string>[]): { total: number; assignment: Map<number, number> } {
  const n = expectedSets.length;
  const m = actualSets.length;

  if (n + m > 16) {
    // Greedy fallback: repeatedly take the highest-scoring unused pair.
    const used = new Set<number>();
    const assignment = new Map<number, number>();
    let total = 0;
    for (let round = 0; round < Math.min(n, m); round++) {
      let bestScore = -1;
      let bestEi = -1;
      let bestAj = -1;
      for (let ei = 0; ei < n; ei++) {
        if (assignment.has(ei)) continue;
        for (let aj = 0; aj < m; aj++) {
          if (used.has(aj)) continue;
          const score = jaccard(expectedSets[ei]!, actualSets[aj]!);
          if (score > bestScore) {
            bestScore = score;
            bestEi = ei;
            bestAj = aj;
          }
        }
      }
      if (bestEi === -1) break;
      assignment.set(bestEi, bestAj);
      used.add(bestAj);
      total += bestScore;
    }
    return { total, assignment };
  }

  const usedActual: boolean[] = new Array(m).fill(false);
  let bestTotal = -1;
  let bestAssignment = new Map<number, number>();

  function backtrack(ei: number, currentTotal: number, currentAssignment: Map<number, number>): void {
    if (ei === n) {
      if (currentTotal > bestTotal) {
        bestTotal = currentTotal;
        bestAssignment = new Map(currentAssignment);
      }
      return;
    }
    backtrack(ei + 1, currentTotal, currentAssignment); // leave expected[ei] unmatched
    for (let aj = 0; aj < m; aj++) {
      if (usedActual[aj]) continue;
      usedActual[aj] = true;
      currentAssignment.set(ei, aj);
      backtrack(ei + 1, currentTotal + jaccard(expectedSets[ei]!, actualSets[aj]!), currentAssignment);
      currentAssignment.delete(ei);
      usedActual[aj] = false;
    }
  }
  backtrack(0, 0, new Map());
  return { total: Math.max(0, bestTotal), assignment: bestAssignment };
}

function extractType(subject: string): string | null {
  const m = subject.match(TYPE_PREFIX_RE);
  return m ? m[1]!.toLowerCase() : null;
}

function countOccurrences(haystack: string, needle: string): number {
  return haystack.split(needle).length - 1;
}

type CommitInfo = { sha: string; paths: Set<string>; allPaths: Set<string>; subject: string; body: string };

function loadCommits(repo: string, baseTip: string, dirtyPaths: Set<string>): CommitInfo[] {
  const shas = gitOk(["rev-list", "--reverse", `${baseTip}..HEAD`], repo)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);

  return shas.map((sha) => {
    const nameOnly = git(["show", "--name-only", "--format=", sha], repo);
    const allPaths = new Set(
      nameOnly.stdout
        .split("\n")
        .map((p) => p.trim())
        .filter((p) => p.length > 0),
    );
    const paths = new Set([...allPaths].filter((p) => dirtyPaths.has(p)));
    const body = gitOk(["show", "-s", "--format=%B", sha], repo);
    const subject = body.split("\n")[0] ?? "";
    return { sha, paths, allPaths, subject, body };
  });
}

async function grade(fixture: Fixture, prepared: PreparedRun): Promise<Metrics> {
  const { repo, baseTip } = prepared;
  const dirtyPaths = new Set(fixture.groups.flatMap((g) => g.paths));

  const commits = loadCommits(repo, baseTip, dirtyPaths);
  const countMatch = commits.length === fixture.expectedCommits;

  const expectedSets = fixture.groups.map((g) => new Set(g.paths));
  const actualSets = commits.map((c) => c.paths);
  const { total, assignment } = bestMatching(expectedSets, actualSets);
  const groupingScore = commits.length === 0 && fixture.groups.length === 0 ? 1 : total / Math.max(fixture.groups.length, commits.length, 1);

  const committedPaths = new Set(actualSets.flatMap((s) => [...s]));
  const pathsCommitted = dirtyPaths.size === 0 ? 1 : [...dirtyPaths].filter((p) => committedPaths.has(p)).length / dirtyPaths.size;
  const allCommittedRaw = new Set(commits.flatMap((c) => [...c.allPaths]));
  const extraPaths = [...allCommittedRaw].filter((p) => !dirtyPaths.has(p)).length;

  const treeClean = git(["status", "--porcelain"], repo).stdout.length === 0;
  const onMain = git(["rev-parse", "--abbrev-ref", "HEAD"], repo).stdout === "main";

  const subjects = commits.map((c) => c.subject);
  const convMsgs = subjects.length === 0 ? 0 : subjects.filter((s) => CONVENTIONAL_RE.test(s)).length / subjects.length;
  const subjectLenOk = subjects.length === 0 ? 0 : subjects.filter((s) => s.length <= 72).length / subjects.length;
  const genericSubjects = subjects.filter((s) => GENERIC_RE.test(s)).length;

  let typeMatches = 0;
  for (let ei = 0; ei < fixture.groups.length; ei++) {
    const aj = assignment.get(ei);
    if (aj === undefined) continue;
    const commit = commits[aj];
    if (!commit) continue;
    if (extractType(commit.subject) === fixture.groups[ei]!.type.toLowerCase()) {
      typeMatches++;
    }
  }
  const typeMatch = fixture.groups.length === 0 ? 1 : typeMatches / fixture.groups.length;

  const trailerOk = commits.length === 0 ? 0 : commits.filter((c) => countOccurrences(c.body, TRAILER_LINE) === 1).length / commits.length;

  return {
    commits: commits.length,
    countMatch,
    groupingScore,
    pathsCommitted,
    extraPaths,
    treeClean,
    onMain,
    convMsgs,
    subjectLenOk,
    genericSubjects,
    typeMatch,
    trailerOk,
  };
}

function composite(m: Metrics, w: Record<string, number>): number {
  const num = (key: string) => (typeof m[key] === "boolean" ? (m[key] ? 1 : 0) : typeof m[key] === "number" ? m[key] : 0);
  return (
    (w.countMatch ?? 0) * num("countMatch") +
    (w.groupingScore ?? 0) * num("groupingScore") +
    (w.convMsgs ?? 0) * num("convMsgs") +
    (w.trailerOk ?? 0) * num("trailerOk") +
    (w.treeClean ?? 0) * num("treeClean") +
    (w.typeMatch ?? 0) * num("typeMatch")
  );
}

export const gitCommitTask: EvalTask = {
  name: "git-commit",
  fixtures: listFixtures,
  prepare: (fixture, workdir) => materialize(fixture, workdir),
  prompt: () => "/git:commit",
  grade,
  composite,
};
