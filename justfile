@_default:
    just --list

# Install dependencies.
deps:
    bun install

# Type-check the whole project (tsc --noEmit).
check:
    bun run check

# Run the grader-discrimination and unit tests (no tokens spent).
test:
    bun test

# Mine git-commit fixtures from a source repo's real history.
fixtures ID="all" SOURCE="~":
    bun run evalkit/cli.ts build-fixtures --id {{ID}} --source {{SOURCE}}

# Round-trip verify every built fixture (git am/apply, dirty path set, index/tree state).
verify-fixtures:
    bun run evalkit/cli.ts verify-fixtures --id all

# Secret-scan every built fixture's history/*.patch and dirty.patch.
scan:
    bun run evalkit/cli.ts scan

# Project run count, per-provider counts, and dollar cost for a suite.
estimate SUITE="focus":
    bun run evalkit/cli.ts estimate --suite {{SUITE}}

# Two real runs against the cheapest model, for a fast end-to-end sanity check.
smoke:
    bun run evalkit/cli.ts eval --suite smoke

# Run a suite end-to-end: matrix expansion, omp invocations, grading, report.
eval SUITE="focus" JOBS="":
    #!/usr/bin/env bash
    set -euo pipefail
    if [ -n "{{JOBS}}" ]; then
      bun run evalkit/cli.ts eval --suite {{SUITE}} --jobs {{JOBS}}
    else
      bun run evalkit/cli.ts eval --suite {{SUITE}}
    fi

# Re-render results.csv/report.md/report.html/charts/*.svg for a past run.
report RUN="latest":
    bun run evalkit/cli.ts report --run {{RUN}}

# Publish a run's summary artifacts (no session logs) into examples/<NAME>/.
publish-example RUN="latest" NAME="":
    #!/usr/bin/env bash
    set -euo pipefail
    name="{{NAME}}"
    if [ -z "$name" ]; then name="{{RUN}}"; fi
    dest="examples/$name"
    mkdir -p "$dest/charts"
    cp "runs/{{RUN}}/meta.json" "$dest/"
    cp "runs/{{RUN}}/results.jsonl" "$dest/"
    cp "runs/{{RUN}}/results.csv" "$dest/"
    cp "runs/{{RUN}}/report.md" "$dest/"
    cp "runs/{{RUN}}/report.html" "$dest/"
    cp "runs/{{RUN}}"/charts/*.svg "$dest/charts/"
    echo "published to $dest"

# Remove all run output (runs/ is gitignored).
clean:
    rm -rf runs/
