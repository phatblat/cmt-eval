// git helpers and scratch-repo materialization. Every eval run gets a fresh,
// disposable git repository built from a fixture's recorded history plus a
// dirty-tree patch, so the agent under test sees a realistic working tree.

import { homedir } from "node:os";
import { join, resolve, sep } from "node:path";
import { mkdirSync } from "node:fs";
import { Glob } from "bun";
import type { Fixture, PreparedRun } from "./task.ts";

export type GitResult = { code: number; stdout: string; stderr: string };

export class GitError extends Error {
  constructor(
    public readonly args: string[],
    public readonly cwd: string,
    public readonly code: number,
    public readonly stderr: string,
  ) {
    super(`git ${args.join(" ")} (cwd=${cwd}) exited ${code}: ${stderr.trim()}`);
    this.name = "GitError";
  }
}

/** Strips exactly one trailing newline. A full `.trim()` would eat the leading status-code space on the first line of `git status --porcelain` output, corrupting path parsing. */
function stripTrailingNewline(s: string): string {
  return s.endsWith("\n") ? s.slice(0, -1) : s;
}

export function git(args: string[], cwd: string): GitResult {
  const proc = Bun.spawnSync({
    cmd: ["git", ...args],
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  });
  return {
    code: proc.exitCode ?? -1,
    stdout: stripTrailingNewline(proc.stdout.toString("utf8")),
    stderr: proc.stderr.toString("utf8").trim(),
  };
}

export function gitOk(args: string[], cwd: string): string {
  const result = git(args, cwd);
  if (result.code !== 0) {
    throw new GitError(args, cwd, result.code, result.stderr);
  }
  return result.stdout;
}

/**
 * Root scratch directory for one (runId, cellId) pair. Deliberately outside
 * `$HOME`: `omp`'s AGENTS.md discovery walks ancestor directories, so a
 * scratch repo nested under `~/dev/...` would silently inherit this
 * project's own AGENTS.md into every run's context.
 */
export function scratchRoot(runId: string, cellId: string): string {
  const base = process.env.TMPDIR ?? "/tmp";
  const dir = resolve(join(base, "cmt-eval", runId, cellId));
  const home = resolve(homedir());
  if (dir === home || dir.startsWith(home + sep)) {
    throw new Error(
      `scratchRoot ${dir} resolves inside $HOME (${home}); set TMPDIR to a path outside the home directory`,
    );
  }
  return dir;
}

async function sortedPatchFiles(historyDir: string): Promise<string[]> {
  const glob = new Glob("*.patch");
  const names: string[] = [];
  for await (const name of glob.scan({ cwd: historyDir })) {
    names.push(name);
  }
  names.sort();
  return names.map((name) => join(historyDir, name));
}

/**
 * Build a disposable git repo at `workdir` from a fixture: replay its
 * recorded commit history, then apply its dirty-tree patch unstaged, exactly
 * as a real dirty working tree looks before a commit-splitting pass.
 */
export async function materialize(fixture: Fixture, workdir: string): Promise<PreparedRun> {
  const repo = workdir;
  mkdirSync(repo, { recursive: true });

  gitOk(["init", "-b", "main", repo], repo);

  const hooksPath = join(repo, ".git", "eval-hooks");
  mkdirSync(hooksPath, { recursive: true });

  gitOk(["config", "user.name", "Eval Runner"], repo);
  gitOk(["config", "user.email", "eval@localhost"], repo);
  gitOk(["config", "commit.gpgsign", "false"], repo);
  gitOk(["config", "tag.gpgsign", "false"], repo);
  gitOk(["config", "core.hooksPath", hooksPath], repo);
  gitOk(["config", "gc.auto", "0"], repo);
  gitOk(["config", "advice.detachedHead", "false"], repo);

  const historyDir = join(fixture.dir, "history");
  const patches = await sortedPatchFiles(historyDir);
  if (patches.length > 0) {
    // --empty=keep: a historical commit that touched nothing inside the
    // fixture's pruned path set produces a genuinely empty patch (verified
    // this session: `git am` rejects empty patches without this flag).
    gitOk(["am", "--keep-cr", "--empty=keep", ...patches], repo);
  }

  const dirtyPatch = join(fixture.dir, "dirty.patch");
  if (await Bun.file(dirtyPatch).exists()) {
    gitOk(["apply", "--binary", dirtyPatch], repo);
  }

  const baseTip = gitOk(["rev-parse", "HEAD"], repo);
  return { repo, baseTip };
}
