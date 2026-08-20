// Fixture builder: mines a source repo's real commit history into a fixture
// directory (`history/*.patch` + `dirty.patch` + `fixture.toml`). Every read
// happens against the source repo; it is never mutated. `history/` replays 8
// real prior commits (pruned to the fixture's touched paths) so an agent's
// `git log` convention inference is genuine; `dirty.patch` is the squashed
// diff of the real multi-concern commits that follow, applied unstaged so
// the agent must re-split it.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { homedir, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { formatHits, git, gitOk, materialize, redactText, scanFixtureDir } from "@phatblat/evalkit";
import { FIXTURES_DIR, loadFixture } from "./task.ts";

type GroupSpec = { sha: string; type: string; subject: string; paths: string[] };

type FixtureSpec = {
  id: string;
  description: string;
  base: string;
  timeoutS: number;
  groups: GroupSpec[];
};

// Mined this session from `~` (dotfiles): consecutive non-merge commits <=8s
// apart, same author, disjoint file sets, conventional subjects — proxying
// "one agent split one dirty tree". See tasks/git-commit/README provenance
// table for the verified SHAs and diff-line counts.
const FIXTURE_SPECS: FixtureSpec[] = [
  {
    id: "shellcheck-1",
    description: "shellcheck lint configuration: one coherent concern across three files (over-splitting control)",
    base: "5b22c7b456dd",
    timeoutS: 300,
    groups: [
      {
        sha: "86e9ef855f37",
        type: "feat",
        subject: "feat(lint): configure shell script linting with shellcheck",
        paths: [".config/zsh/functions/ignore", ".config/zsh/functions/list", "justfile"],
      },
    ],
  },
  {
    id: "mise-zsh-2",
    description: "mise config downgrade + zsh double-sourcing fix: two unrelated concerns",
    base: "ffce3a82b236",
    timeoutS: 300,
    groups: [
      {
        sha: "27e670fd7654",
        type: "chore",
        subject: "chore(mise): downgrade android build-tools to 36.0.0",
        paths: [".config/mise/config.toml"],
      },
      {
        sha: "7b2ab943431c",
        type: "fix",
        subject: "fix(zsh): avoid double-sourcing .zshrc on interactive login shells",
        paths: [".zprofile", ".zshenv", ".zshrc"],
      },
    ],
  },
  {
    id: "harness-ci-docs-3",
    description: "safety-policy fix + CI fix + spec doc correction: three unrelated concerns",
    base: "13a3a5e3a585",
    timeoutS: 420,
    groups: [
      {
        sha: "b21fb6e5f87a",
        type: "fix",
        subject: "fix(harness): Apply path rules to shell commands, not just write tools",
        paths: [".agents/harness/hooks/safety.py", "tests/agent-harnesses.bats"],
      },
      {
        sha: "d419f4c8098d",
        type: "ci",
        subject: "ci: Fix a SIGPIPE race that could skip required checks, and widen lint's paths",
        paths: [".github/scripts/changed.sh", ".github/workflows/human-approval.yml", ".github/workflows/lint.yml"],
      },
      {
        sha: "d49834889729",
        type: "docs",
        subject: "docs(specs): Correct spec 001's category and complete its targets",
        paths: ["docs/specs/001-self-improvement-loop.md"],
      },
    ],
  },
  {
    id: "gastown-routing-4",
    description: "three unrelated single-file concerns plus a five-file feature (strongest grouping discriminator)",
    base: "0bb9e987b9e4",
    timeoutS: 480,
    groups: [
      {
        sha: "6f6ac47572bb",
        type: "style",
        subject: "style(codexbar): reorder gemini entry in config",
        paths: [".codexbar/config.json"],
      },
      {
        sha: "e689e8c92659",
        type: "feat",
        subject: "feat(tmux): add vi copy mode and wheel scroll bindings",
        paths: [".config/tmux/tmux.conf"],
      },
      {
        sha: "295bec5be970",
        type: "feat",
        subject: "feat(claude): add policy-limits.json",
        paths: [".claude/policy-limits.json"],
      },
      {
        sha: "b35eb2f114a7",
        type: "feat",
        subject: "feat(gt): add smart agent routing for gastown sling",
        paths: ["docs/gastown-agent-routing.md", "justfile", "scripts/gt-agent-policy-apply", "scripts/gt-mise-bump-polecats", "scripts/gt-sling-smart"],
      },
    ],
  },
];

function expandTilde(p: string): string {
  if (p === "~") return homedir();
  if (p.startsWith("~/")) return join(homedir(), p.slice(2));
  return resolve(p);
}

function tomlStr(s: string): string {
  return JSON.stringify(s);
}

function tomlStrArray(xs: string[]): string {
  return `[${xs.map(tomlStr).join(", ")}]`;
}

function renderFixtureToml(f: {
  id: string;
  description: string;
  expectedCommits: number;
  timeoutS: number;
  source: { repo: string; base: string; commits: string[] };
  groups: Array<{ type: string; subject: string; paths: string[] }>;
}): string {
  const lines: string[] = [
    `id = ${tomlStr(f.id)}`,
    `description = ${tomlStr(f.description)}`,
    `expectedCommits = ${f.expectedCommits}`,
    `timeoutS = ${f.timeoutS}`,
    ``,
    `[source]`,
    `repo = ${tomlStr(f.source.repo)}`,
    `base = ${tomlStr(f.source.base)}`,
    `commits = ${tomlStrArray(f.source.commits)}`,
  ];
  for (const g of f.groups) {
    lines.push(``, `[[group]]`, `type = ${tomlStr(g.type)}`, `subject = ${tomlStr(g.subject)}`, `paths = ${tomlStrArray(g.paths)}`);
  }
  lines.push(``);
  return lines.join("\n");
}

/** "fix(harness): Apply path rules" -> "harness: Apply path rules" (type is stored separately). */
function stripConventionalPrefix(subject: string): string {
  const m = subject.match(/^[a-zA-Z]+(\(([^)]+)\))?!?:\s*(.*)$/);
  if (!m) return subject;
  const scope = m[2];
  const rest = m[3] ?? "";
  return scope ? `${scope}: ${rest}` : rest;
}

/**
 * Replays the 8 real commits ending at `spec.base` into a fresh temp repo,
 * pruned to the fixture's touched paths, then exports that history as an
 * appliable patch series. Every read is against `sourceRepo`; nothing there
 * is mutated.
 */
async function buildHistoryPatches(spec: FixtureSpec, sourceRepo: string, paths: string[], historyDir: string): Promise<void> {
  const priorShas = gitOk(["rev-list", "-8", "--reverse", spec.base], sourceRepo)
    .split("\n")
    .map((s) => s.trim())
    .filter(Boolean);
  if (priorShas.length === 0) {
    throw new Error(`fixture ${spec.id}: no ancestor commits found ending at ${spec.base}`);
  }

  const replayDir = mkdtempSync(join(tmpdir(), "cmt-eval-replay-"));
  try {
    gitOk(["init", "-b", "main", replayDir], replayDir);
    gitOk(["config", "user.name", "Eval Runner"], replayDir);
    gitOk(["config", "user.email", "eval@localhost"], replayDir);
    gitOk(["config", "commit.gpgsign", "false"], replayDir);
    gitOk(["config", "advice.detachedHead", "false"], replayDir);
    gitOk(["config", "gc.auto", "0"], replayDir);

    for (const sha of priorShas) {
      const existing = new Set(
        git(["ls-tree", "-r", "--name-only", sha, "--", ...paths], sourceRepo)
          .stdout.split("\n")
          .map((s) => s.trim())
          .filter(Boolean),
      );

      for (const p of paths) {
        if (!existing.has(p)) {
          rmSync(join(replayDir, p), { force: true });
          git(["rm", "--cached", "--ignore-unmatch", "--", p], replayDir);
        }
      }

      if (existing.size > 0) {
        const archiveProc = Bun.spawn({ cmd: ["git", "archive", sha, "--", ...existing], cwd: sourceRepo, stdout: "pipe", stderr: "pipe" });
        const tarProc = Bun.spawn({ cmd: ["tar", "-x", "-C", replayDir], stdin: archiveProc.stdout, stdout: "pipe", stderr: "pipe" });
        const [tarExit, archiveExit] = await Promise.all([tarProc.exited, archiveProc.exited]);
        if (archiveExit !== 0 || tarExit !== 0) {
          const stderr = await new Response(tarProc.stderr).text();
          throw new Error(`fixture ${spec.id}: git archive | tar failed for ${sha}: ${stderr}`);
        }
        // A historical commit's file content is out of our control and may
        // legitimately contain secret-shaped strings (verified this session:
        // a bats test asserting a safety hook denies "sk-example..." input).
        // Redact rather than discard an otherwise-good fixture.
        for (const p of existing) {
          const filePath = join(replayDir, p);
          let original: string;
          try {
            original = await Bun.file(filePath).text();
          } catch {
            continue; // not valid UTF-8 (binary asset) - nothing to redact
          }
          const { text: redacted, redactions } = redactText(original);
          if (redactions > 0) {
            console.warn(`fixture ${spec.id}: redacted ${redactions} secret-pattern match(es) in ${p} @ ${sha.slice(0, 12)}`);
            await Bun.write(filePath, redacted);
          }
        }
      }
      gitOk(["add", "-A"], replayDir);

      const authorLine = gitOk(["log", "-1", "--format=%an <%ae>", sha], sourceRepo);
      const committerDate = gitOk(["log", "-1", "--format=%cI", sha], sourceRepo);
      const message = gitOk(["log", "-1", "--format=%B", sha], sourceRepo);

      gitOk(["commit", "--allow-empty", "--date", committerDate, "--author", authorLine, "-m", message], replayDir);
    }

    mkdirSync(historyDir, { recursive: true });
    // --no-signature: verified this session that git-format-patch's trailing
    // "-- \n<git version>" signature bleeds into the applied commit message
    // when a replayed commit is empty (no diff section to separate it from).
    gitOk(["format-patch", "--root", "--no-signature", "-o", historyDir], replayDir);
  } finally {
    rmSync(replayDir, { recursive: true, force: true });
  }
}

async function buildFixture(spec: FixtureSpec, source: string): Promise<void> {
  const sourceRepo = expandTilde(source);
  const fixtureDir = join(FIXTURES_DIR, spec.id);
  const historyDir = join(fixtureDir, "history");

  rmSync(fixtureDir, { recursive: true, force: true });
  mkdirSync(fixtureDir, { recursive: true });

  const paths = [...new Set(spec.groups.flatMap((g) => g.paths))].sort();

  await buildHistoryPatches(spec, sourceRepo, paths, historyDir);

  const tip = spec.groups[spec.groups.length - 1]!.sha;
  const dirtyDiffRaw = gitOk(["diff", "--binary", spec.base, tip, "--", ...paths], sourceRepo);
  const { text: dirtyDiff, redactions: dirtyRedactions } = redactText(dirtyDiffRaw);
  if (dirtyRedactions > 0) {
    console.warn(`fixture ${spec.id}: redacted ${dirtyRedactions} secret-pattern match(es) in dirty.patch`);
  }
  await Bun.write(join(fixtureDir, "dirty.patch"), dirtyDiff.length > 0 ? `${dirtyDiff}\n` : "");

  const tomlGroups = spec.groups.map((g) => ({
    type: g.type,
    subject: stripConventionalPrefix(gitOk(["log", "-1", "--format=%s", g.sha], sourceRepo)),
    paths: g.paths,
  }));
  const toml = renderFixtureToml({
    id: spec.id,
    description: spec.description,
    expectedCommits: spec.groups.length,
    timeoutS: spec.timeoutS,
    source: { repo: source, base: spec.base, commits: spec.groups.map((g) => g.sha) },
    groups: tomlGroups,
  });
  await Bun.write(join(fixtureDir, "fixture.toml"), toml);

  const hits = await scanFixtureDir(fixtureDir);
  if (hits.length > 0) {
    throw new Error(`fixture ${spec.id}: secret scan found ${hits.length} hit(s):\n${formatHits(hits)}`);
  }

  await verifyFixture(spec.id);
}

export async function buildFixtures(o: { source: string; id: string }): Promise<void> {
  const specs = o.id === "all" ? FIXTURE_SPECS : FIXTURE_SPECS.filter((s) => s.id === o.id);
  if (specs.length === 0) {
    const known = FIXTURE_SPECS.map((s) => s.id).join(", ");
    throw new Error(`unknown fixture id "${o.id}". known ids: ${known}`);
  }
  for (const spec of specs) {
    await buildFixture(spec, o.source);
    console.log(`built fixture ${spec.id} (${spec.groups.length} expected commits)`);
  }
}

/** Materializes a fixture into a scratch dir and asserts its invariants hold: git am/apply succeed, the dirty path set matches the manifest exactly, the index is clean, the tree is dirty. */
export async function verifyFixture(id: string): Promise<void> {
  const dir = join(FIXTURES_DIR, id);
  const fixture = await loadFixture(dir);
  const tmp = mkdtempSync(join(tmpdir(), "cmt-eval-verify-"));
  try {
    const prepared = await materialize(fixture, tmp); // throws if `git am`/`git apply` fail

    const dirtyPaths = new Set(fixture.groups.flatMap((g) => g.paths));
    const statusLines = git(["status", "--porcelain", "--untracked-files=all"], prepared.repo)
      .stdout.split("\n")
      .filter(Boolean);
    const dirtyFromStatus = new Set(statusLines.map((line) => line.slice(3).trim()));

    const missing = [...dirtyPaths].filter((p) => !dirtyFromStatus.has(p));
    const extra = [...dirtyFromStatus].filter((p) => !dirtyPaths.has(p));
    if (missing.length > 0 || extra.length > 0) {
      throw new Error(`fixture ${id}: dirty path set mismatch (missing=[${missing.join(", ")}] extra=[${extra.join(", ")}])`);
    }

    const stagedDiff = git(["diff", "--cached", "--name-only"], prepared.repo).stdout;
    if (stagedDiff.length > 0) {
      throw new Error(`fixture ${id}: index is not clean (staged: ${stagedDiff})`);
    }
    if (statusLines.length === 0) {
      throw new Error(`fixture ${id}: working tree is not dirty`);
    }
    if (fixture.groups.length !== fixture.expectedCommits) {
      throw new Error(`fixture ${id}: groups.length (${fixture.groups.length}) !== expectedCommits (${fixture.expectedCommits})`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

export async function verifyFixtures(o: { id: string }): Promise<void> {
  const ids = o.id === "all" ? FIXTURE_SPECS.map((s) => s.id) : [o.id];
  for (const id of ids) {
    await verifyFixture(id);
    console.log(`verified fixture ${id}`);
  }
}

export const KNOWN_FIXTURE_IDS: string[] = FIXTURE_SPECS.map((s) => s.id);
