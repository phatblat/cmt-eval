#!/usr/bin/env bun
// Entry point for the cmt-eval CLI: binds the git-commit subject to the evalkit
// framework. evalkit owns the generic commands (eval/report/compare/estimate/
// scan); fixture mining lives here because replaying real dotfiles history into
// a dirty tree is specific to this subject.

import { parseArgs } from "node:util";
import { runCli, taskRegistry } from "@phatblat/evalkit";
import { gitCommitTask } from "./tasks/git-commit/task.ts";
import { buildFixtures, verifyFixtures } from "./tasks/git-commit/build.ts";

try {
  await runCli(process.argv.slice(2), {
    name: "cmt-eval",
    tasks: taskRegistry([gitCommitTask]),
    scratchNamespace: "cmt-eval",
    commands: {
      "build-fixtures": {
        usage: "build-fixtures --source <path> --id <id|all>",
        summary: "Mine fixtures from a source repo's history",
        run: async (args) => {
          const { values } = parseArgs({
            args,
            options: { source: { type: "string", default: "~" }, id: { type: "string", default: "all" } },
          });
          await buildFixtures({ source: values.source!, id: values.id! });
        },
      },
      "verify-fixtures": {
        usage: "verify-fixtures --id <id|all>",
        summary: "Round-trip verify built fixtures",
        run: async (args) => {
          const { values } = parseArgs({ args, options: { id: { type: "string", default: "all" } } });
          await verifyFixtures({ id: values.id! });
        },
      },
    },
  });
} catch (err) {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
}
