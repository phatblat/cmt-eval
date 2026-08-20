# Repository Guidelines

## Project Overview

`cmt-eval` evaluates the user's `/git:commit` skill using **`@phatblat/evalkit`**, an
external framework for evaluating a CLI coding agent across a matrix of **models ×
thinking levels × fixtures × repetitions**. It runs the agent against a scratch git
repo, grades **what actually landed in git state** — never the session transcript —
and reports wall clock, tokens, and dollar cost.

The first (and currently only) subject under test is the user's `/git:commit` skill
driven by [`omp`](https://github.com/can1357/oh-my-pi). Each run materializes a repo
whose dirty working tree holds several logically distinct concerns; the agent must
re-split it into commits, which are then graded on count, file grouping, Conventional
Commits conformance, the `Co-Authored-By` trailer, and tree cleanliness.

## Architecture & Data Flow

`@phatblat/evalkit` (developed at `~/dev/evals/evalkit`, consumed here via `bun link`)
is **subject-agnostic**; `tasks/<name>/` is the subject under test. The dependency
arrow points *framework → subject* only — evalkit never imports a concrete subject; this
repo supplies `gitCommitTask` to `taskRegistry([...])` in `cli.ts`. Import evalkit's
`git`/`gitOk`/`materialize`/`formatHits`/`redactText`/`scanFixtureDir` helpers and its
`EvalTask`/`Fixture`/`Metrics`/`PreparedRun` types from the `@phatblat/evalkit` package
root, never by relative path.

One `eval` run, end to end:

```
cli.ts runCli({ tasks: taskRegistry([gitCommitTask]), scratchNamespace: "cmt-eval" })
  └─ cmdEval
       suite.ts   loadSuite(path, tasks)  TOML → validate → resolveTask(tasks, name) + catalog() + task.fixtures()
       runner.ts  buildCells()            rep-major expansion → Cell[] (cellId = fixture__model__thinking__rN)
       runner.ts  runSuite()              group by provider → dispatch
            └─ runCell() per cell:
                 gitrepo.ts  scratchRoot(namespace, runId, cellId) → $TMPDIR/cmt-eval/<runId>/<cellId>
                 task.prepare()             → materialize(): git init -b main, `git am` history/*.patch,
                                              `git apply --binary` dirty.patch → { repo, baseTip }
                 omp.ts      runOmp()       → Bun.spawn omp with task.prompt(fixture)
                 omp.ts      collectUsage() → glob sessions/**/*.jsonl, sum assistant usage
                 task.grade()               → Metrics read from git state at baseTip..HEAD
                 task.composite()           → weighted score (forced to 0 unless exit code 0)
            └─ append ResultRow to runs/<runId>/results.jsonl
       report/render.ts renderReport()     → results.csv, report.md, report.html, charts/*.svg
```

**Scheduling model.** Cells are **rep-major** (every rep sweeps the whole matrix) so a
transient provider slowdown biases at most one rep. Cells are grouped by provider and
run **serially within a provider, in parallel across providers** — Anthropic and Codex
OAuth pools throttle under concurrency, which would corrupt the wall-clock metric.
Two shared cursors under `Promise.all` implement this: one across providers (capped at
`jobs`), one within each provider (capped at `perProviderJobs`, default `1`).
`contended` is recorded per row whenever `perProviderJobs > 1` — **a contended row's
timings are not comparable to a serialized one.**

**Extension point.** `EvalTask` (from `@phatblat/evalkit`) is the entire contract:

```ts
export interface EvalTask {
  readonly name: string;
  fixtures(): Promise<Fixture[]>;
  prepare(fixture: Fixture, workdir: string): Promise<PreparedRun>;
  prompt(fixture: Fixture): string;
  grade(fixture: Fixture, prepared: PreparedRun): Promise<Metrics>;
  composite(m: Metrics, weights: Record<string, number>): number;
}
```

Adding a subject: implement it in `tasks/<name>/task.ts`, add it to the
`taskRegistry([...])` array in `cli.ts`, add `tasks/<name>/fixtures/<id>/`, and point a
suite at `task = "<name>"`. No `@phatblat/evalkit` change is required.

## Key Directories

| Path | Purpose |
| --- | --- |
| `cli.ts` | Entry point: binds `gitCommitTask` + fixture-mining commands to `@phatblat/evalkit`'s `runCli()` |
| `tasks/git-commit/` | The subject under test: `task.ts` (prompt + grading), `build.ts` (fixture mining/verification) |
| `tasks/git-commit/fixtures/<id>/` | `fixture.toml`, `history/*.patch` (8 real prior commits), `dirty.patch` |
| `suites/` | `smoke.toml`, `focus.toml`, `full.toml` — matrix definitions + composite weights |
| `test/` | `bun:test` files; zero tokens, zero network |
| `runs/<runId>/` | Generated output — **gitignored**. `runs/latest` is an absolute symlink |
| `examples/` | Empty until `just publish-example` copies a run's summary artifacts in |

## Development Commands

`just` is the entry point; every recipe delegates to `bun run cli.ts <cmd>` (backed by
`@phatblat/evalkit`'s `runCli()`), except `deps`/`link`, which manage the framework
dependency itself.

`just deps` clones `@phatblat/evalkit` to `$HOME/dev/evals/evalkit` and registers it
with `bun link` on demand (both steps are skipped once already in place), then runs
`bun install`. `just link DIR=<path>` re-points the global `@phatblat/evalkit` link at a
different local checkout without a full `deps` run.

Just recipe parameters are **positional**, not `NAME=value`: `just estimate focus`, not
`just estimate SUITE=focus` — the latter is passed through as a literal and fails with
`Cannot find module '.../suites/SUITE=focus.toml'`.

**Free (no tokens, no network):**

```sh
just deps                    # clone/link @phatblat/evalkit if needed, then bun install
just link                    # re-register a different local evalkit checkout
just check                   # tsc --noEmit
just test                    # bun test
just fixtures                # mine fixtures from a dotfiles checkout; pure git, no agent
just verify-fixtures         # round-trip: git am/apply, dirty path set, index clean, tree dirty
just scan                    # secret-scan every fixture patch
just estimate focus          # projected run count + dollar cost, spends nothing
just report latest           # re-render csv/md/html/charts for a past run
just publish-example latest foo
just clean                   # rm -rf runs/
```

**Spends real money — never run unprompted:**

```sh
just smoke                   # 2 runs, cheapest model (~$0.10, <3 min)
just eval focus              # 168 runs;  eval full → 396 runs;  optional JOBS as a 2nd arg
```

Always run `just estimate <name>` before `just eval`. Direct CLI equivalent:
`bun run cli.ts eval --suite focus [--jobs N] [--keep-repos]`.

Single test file: `bun test test/grade.test.ts`.

## Code Conventions & Common Patterns

- **File headers are mandatory.** Every source file opens with a `//` comment block
  explaining *why* the module exists and what invariant it protects — not what the code
  does. Match this when adding files (see `tasks/git-commit/task.ts:1-5`, or
  `@phatblat/evalkit`'s `src/runner.ts:1-9`).
- **Imports:** local imports carry an explicit `.ts` extension
  (`allowImportingTsExtensions` is on): `import { git } from "./gitrepo.ts"`. Node
  builtins always use the `node:` prefix. Bun APIs come from the bare `bun` specifier
  (`import { Glob } from "bun"`) or the `Bun.*` global.
- **`verbatimModuleSyntax` is on** — type-only imports MUST use `import type` /
  `import { fn, type Type }`. Omitting it is a compile error.
- **`noUncheckedIndexedAccess` is on** — indexed access yields `T | undefined`. The
  codebase uses `!` with an inline justification comment where the bound is already
  checked (see `@phatblat/evalkit`'s `src/runner.ts`), rather than defensive re-checks.
- **Plain functions and `type` aliases; no classes** except error subclasses
  (`SuiteError`, `GitError`). State travels in options objects, not fields.
- **Validation collects all problems in one pass**, then throws once
  (`SuiteError.problems[]`) — never fail-fast. A suite author should see every mistake
  in one run.
- **Errors throw; there is no `Result` type.** Retryability is decided by matching
  `RETRYABLE_STDERR` (`/429|rate.?limit|overloaded|ECONNRESET|fetch failed|socket hang up|503/i`);
  everything else fails the cell deterministically.
- **No nullable fields in `ResultRow`** — every field is a plain number/boolean/string so
  it round-trips through JSONL *and* CSV without special cases. Unknowns use sentinels
  (`TTFT_UNKNOWN = -1`). Preserve this if you add a column.
- **Subprocesses:** `Bun.spawn` (async, awaits `.exited`) or `Bun.spawnSync`, always with
  `NO_COLOR=1` and `FORCE_COLOR` deleted. Trim only the trailing newline from git output
  — `.trim()` corrupts `git status --porcelain` by eating the leading status-code space.
- **TOML is loaded via `import(pathToFileURL(path).href)`** (Bun's ESM TOML loader). There
  is no TOML parser dependency.
- **Charts are hand-written SVG strings.** No chart library, no headless browser, no
  canvas, and no `http` references anywhere — `report.html` must stay fully
  self-contained and diffable (`@phatblat/evalkit`'s `test/charts.test.ts` asserts the
  absence of `http`).

## Important Files

| File | Why it matters |
| --- | --- |
| `cli.ts` | Entry point: binds `gitCommitTask` to `taskRegistry([...])` and calls `@phatblat/evalkit`'s `runCli()` |
| `@phatblat/evalkit` | External framework package (`~/dev/evals/evalkit`, consumed via `bun link`): `EvalTask`/`taskRegistry()`, `buildCells()`/`runSuite()`/`runCell()`, `loadSuite()`, `git()`/`gitOk()`/`scratchRoot()`/`materialize()`, `catalog()`/`priceRun()`, reporting |
| `tasks/git-commit/task.ts` | All grading logic; `TRAILER_LINE`, `TYPE_PREFIX_RE` |
| `tasks/git-commit/build.ts` | `FIXTURE_SPECS`, `buildFixtures()`, `verifyFixture()` |
| `mise.toml` | Pins bun `1.3.14`, just `1.58.0`, `github:can1357/oh-my-pi` `17.3.5` |

### Suite TOML schema (`suites/*.toml`)

```toml
task = "git-commit"                              # key in the taskRegistry([...]) passed to runCli in cli.ts
models = ["anthropic/claude-haiku-4-5"]          # omp selectors, validated against `omp models --json`
thinking = ["low"]                               # each level checked against each model's support
fixtures = ["mise-zsh-2", "harness-ci-docs-3"]   # ids under tasks/<task>/fixtures/
reps = 1                                         # integer >= 1
perProviderJobs = 1                              # integer >= 1; > 1 sets contended=true
retries = 2                                      # integer >= 0

[weights]                                        # MUST sum to 1 ± 0.001
countMatch = 0.40
groupingScore = 0.30
convMsgs = 0.10
trailerOk = 0.10
treeClean = 0.05
typeMatch = 0.05
```

### Fixture TOML schema (`tasks/git-commit/fixtures/<id>/fixture.toml`)

`id`, `description`, `expectedCommits`, `timeoutS`, a `[source]` provenance block
(repo, base, commit SHAs), and one `[[group]]` table per expected commit with `type`,
`subject`, and `paths`. `verifyFixture()` asserts `groups.length === expectedCommits`.

## Runtime/Tooling Preferences

- **Bun is mandatory** (`1.3.14`, pinned in `mise.toml`); Node cannot run this. The code
  depends on `Bun.spawn`/`spawnSync`, `Bun.Glob`, `Bun.file`/`Bun.write`, and Bun's ESM
  TOML loader. `tsconfig.json` sets `types: ["bun"]` and `moduleResolution: "bundler"`.
- **Zero runtime dependencies.** `bun.lock` contains only `@types/bun` and `typescript`
  (plus transitives). Keep it that way — adding a dependency is a design decision, not a
  convenience. Charts, TOML parsing, and CSV are all hand-rolled for this reason.
- **No build step.** `tsc` runs with `noEmit`; `bun run cli.ts` executes TS directly.
- **No linter, no formatter, and no CI are configured.** Do not add or assume one; match
  surrounding style by hand. `just check` (`tsc --noEmit`) is the only static gate.
- `omp` itself is a pinned tool dependency (`github:can1357/oh-my-pi 17.3.5`) — the model
  catalog and every eval run shell out to it.

## Testing & QA

- **Framework:** `bun:test` (`import { describe, expect, test } from "bun:test"`). Files
  live in `test/*.test.ts` — not colocated, no `.spec.ts`, no config needed.
- **Tests spend nothing.** No test imports `@phatblat/evalkit`'s `omp.ts` or touches the network. They
  build **real** temp git repos (`mkdtempSync` → `gitCommitTask.prepare()` → `rmSync` in a
  `finally`) and hand-commit content with `gitOk()`. Keep this property.
- `test/grade.test.ts` is the **grader-discrimination proof**: it hand-commits a fixture's
  expected groups perfectly (composite must be `1`, asserted with `toBeCloseTo(_, 9)`),
  then squashes everything into one commit and asserts the score collapses into a narrow
  band. If you change grading, this is the test that must be updated *and* must still
  discriminate.
- Suite-validation and chart-rendering tests (formerly `test/suite.test.ts` and
  `test/charts.test.ts`) now live in the `@phatblat/evalkit` repo, since the framework
  must be testable with no subject present. `test/` here holds only `grade.test.ts`.
- **Assertion style:** `toBe` for primitives, `toBeCloseTo(value, 9)` for float scores,
  `toBeInstanceOf` for error classes, `toBeGreaterThan`/`toBeLessThan` for bands. Test
  names are lowercase present-tense phrases (`"throws when a model does not support …"`).
- **No coverage tooling is configured.** Do not invent a threshold.
- Before claiming a change works: `just check && just test`. Only reach for `just smoke`
  when a change genuinely requires a live agent round trip, and say so first — it costs money.

## Invariants — do not break these

1. **Grade git state, never the transcript.** Every metric derives from `git rev-list`,
   `git show --name-only`, `git status --porcelain`, and commit bodies. Reading the
   session log to award points defeats the entire experiment.
2. **Fixtures are mined from real history, never invented.** `just fixtures` replays real
   commits from a local `phatblat/dotfiles` checkout (read-only, passed as
   `SOURCE=<path>`) and records SHAs in `fixture.toml`.
   If a fixture is unsuitable, source a different commit range — do not fabricate diffs.
3. **Scratch repos must live outside `$HOME`.** `scratchRoot()` (enforced inside
   `@phatblat/evalkit`) throws if `$TMPDIR` resolves inside the home directory, because
   `omp`'s AGENTS.md discovery walks ancestor directories — a scratch repo under
   `~/dev/...` would silently leak **this file** into every graded run's context.
4. **Every fixture patch is secret-scanned** (`@phatblat/evalkit`'s `secrets.ts`, 8 patterns) at build
   time and via `just scan`. Benign pattern-matching content is redacted with a
   line-count-preserving placeholder so diffs still apply.
5. **`composite` is forced to `0` for any run that did not exit `0`** (enforced inside
   `@phatblat/evalkit`'s `runCell()`). A crashed run is a failed run, not a missing data
   point.
6. **Weights are the opinion of the evaluation.** Changing `[weights]` reorders the
   leaderboard; do not tune them to make a result look better.
7. **Unpriced models report `costUsd = 0` legitimately** (`cursor`, `spark` are
   subscription/local). `priced: false` marks them — never treat `0` as free-and-fast.
