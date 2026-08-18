# cmt-eval

`evalkit` is a reusable framework for evaluating a CLI coding agent across a
matrix of **models × thinking levels × fixtures × repetitions**. It runs the
agent, grades what it actually did to the filesystem/git state (not what it
claims), and reports wall clock, tokens, and dollar cost.

The first subject under test is the user's local `/git:commit` skill
(`~/.claude/commands/git/commit.md`) driven by
[`omp`](https://github.com/can1357/oh-my-pi) (oh-my-pi): each run
materializes a git repo whose dirty working tree holds several logically
distinct concerns, invokes `omp -p "/git:commit"` against it, then grades
commit count, file grouping, message convention, the required attribution
trailer, and tree cleanliness.

## Quickstart

```sh
mise install
just deps        # bun install
just fixtures    # mine the git-commit fixtures from ~ (dotfiles)
just verify-fixtures
just scan        # secret-scan the built fixtures
just test        # grader-discrimination + unit tests, no tokens spent
just smoke       # 2 real omp runs against the cheapest model (~$0.10, <3 min)
just report      # render results.csv / report.md / report.html / charts/*.svg
```

To run the full evaluation matrix:

```sh
just estimate SUITE=focus   # projected run count + dollar cost before spending anything
just eval SUITE=focus       # 7 models x 2 thinking levels x 4 fixtures x 3 reps = 168 runs
just report                 # renders runs/latest/{report.md,report.html,results.csv,charts/}
```

## Suites

A suite (`suites/*.toml`) is the matrix definition: which models, thinking
levels, fixtures, and repetitions to run, plus the weights used to combine
grader metrics into one composite score.

| suite | models | thinking | fixtures | reps | total runs |
| --- | --- | --- | --- | --- | --- |
| `smoke.toml` | 1 (haiku) | low | 2 | 1 | 2 |
| `focus.toml` | 7 | low, high | 4 | 3 | 168 |
| `full.toml` | 11 | low, medium, high | 4 | 3 | 396 |

Cells run **rep-major** (every rep sweeps the whole matrix, so a transient
provider slowdown biases at most one rep) and are scheduled **serially
within a provider, in parallel across providers** — Anthropic and Codex OAuth
pools throttle under concurrency, which would corrupt the wall-clock metric.
Each result row records `jobs`, `perProviderJobs`, and `contended`.

## Fixtures

Each `git-commit` fixture (`tasks/git-commit/fixtures/<id>/`) is mined from
real commit history in a source repo (default `~`), never invented:

| fixture | expected commits | what it's testing |
| --- | --- | --- |
| `shellcheck-1` | 1 | one coherent concern across 3 files — over-splitting control |
| `mise-zsh-2` | 2 | two unrelated single-concept fixes |
| `harness-ci-docs-3` | 3 | three unrelated concerns (safety policy, CI, docs) |
| `gastown-routing-4` | 4 | three single-file concerns plus a 5-file feature that must stay together — the strongest grouping discriminator |

Each fixture directory holds:

- `history/*.patch` — a real, appliable `git format-patch` series replaying
  8 real prior commits (pruned to the fixture's touched paths), so an
  agent's `git log`-based convention inference is genuine.
- `dirty.patch` — the squashed diff of the real multi-concern commits that
  follow that history, applied unstaged. The agent under test must re-split
  this back into commits.
- `fixture.toml` — id, description, `expectedCommits`, `timeoutS`, source
  provenance (repo/base/commit SHAs), and the expected `[[group]]` table
  (type, subject, paths) used for grading.

Every fixture is regenerated with `just fixtures`, round-trip verified with
`just verify-fixtures` (asserts `git am`/`git apply` succeed, the dirty path
set matches the manifest exactly, the index is clean, and the tree is
dirty), and secret-scanned with `just scan` before being trusted. The
scanner also runs automatically at build time; any historical content that
matches a secret-shaped pattern is either redacted (benign-but-pattern-matching
content like a test asserting a safety hook denies `sk-...`-shaped input) or
must be swapped for a different fixture.

## Metrics

`grade()` reads only the resulting git state — never the session transcript:

| metric | definition |
| --- | --- |
| `commits` | count of `git rev-list <baseTip>..HEAD` |
| `countMatch` | `commits === fixture.expectedCommits` |
| `groupingScore` | best one-to-one match between expected groups and actual commits' path sets (maximizing total Jaccard similarity), divided by `max(expected, actual)` — penalizes over- and under-splitting symmetrically |
| `pathsCommitted` | fraction of the fixture's dirty paths present in >=1 new commit |
| `extraPaths` | count of committed paths outside the fixture's dirty path set |
| `treeClean` | `git status --porcelain` is empty |
| `onMain` | still on `main` |
| `convMsgs` | fraction of subjects matching Conventional Commits |
| `subjectLenOk` | fraction of subjects <= 72 chars |
| `genericSubjects` | count of subjects like "update"/"misc"/"wip" |
| `typeMatch` | fraction of expected groups whose best-matched commit uses the expected conventional type |
| `trailerOk` | fraction of new commits containing the required `Co-Authored-By` trailer exactly once |

`composite = countMatch*w + groupingScore*w + convMsgs*w + trailerOk*w + treeClean*w + typeMatch*w`,
weights configured per suite, forced to `0` for any run that didn't exit `0`.

## Reports

`just report` writes, per run directory (`runs/<runId>/`):

- `results.jsonl` / `results.csv` — one row per cell.
- `report.md` / `report.html` — leaderboard, per-fixture table, failures,
  and six SVG charts (composite by model, commit-count accuracy, cost vs.
  score, wall time, a fixture heatmap, and mean tokens by model). Charts are
  hand-rendered SVG — no chart dependency, no headless browser, no native
  canvas — so `report.html` is fully self-contained with zero network
  fetches.

**Accounting caveats:** `cursor` and `spark` models are unpriced
(subscription / local box), so their dollar figures are legitimately `0`;
timings are measured with providers serialized (`wallS` includes ~1-2s of
`omp` startup, `modelTimeS` does not).

## Adding a new subject under test

1. Implement the `EvalTask` interface (`evalkit/task.ts`) in a new
   `tasks/<name>/task.ts`: `fixtures()`, `prepare()`, `prompt()`, `grade()`,
   `composite()`.
2. Register it in `evalkit/task.ts`'s `TASKS` map.
3. Add fixtures under `tasks/<name>/fixtures/<id>/`.
4. Point a suite (`suites/*.toml`) at `task = "<name>"`.

No other framework code changes — `evalkit/` (runner, scheduler, model
catalog, reporting) is fully subject-agnostic.

## 📄 License

This repo is licensed under the MIT License. See the [LICENSE](LICENSE.md) file for rights and limitations.
