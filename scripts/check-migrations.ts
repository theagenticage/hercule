#!/usr/bin/env bun
/**
 * Checks that no migration file already on `main` has been modified, renamed,
 * or deleted. A landed migration is never edited: editing one in place breaks
 * every database that already ran the old version.
 *
 * Exits 0 when all existing migrations are unchanged, or 1 with a message
 * naming the file and saying to write a new migration instead.
 *
 * Called in CI on pull requests. Locally, run
 * `git diff $(git merge-base origin/main HEAD) --name-status` to check
 * before pushing.
 */
import { spawnSync } from "node:child_process";

const BASE_REF = process.env["BASE_REF"] ?? "main";
const MIGRATIONS_DIR = "apps/controller/src/db/migrations/";

/**
 * Returns the ref `git diff` should read as the baseline. A pull-request
 * checkout has `origin/<branch>` after a full fetch, and may not have a local
 * branch of the same name.
 */
function resolveBaseRef(name: string): string {
  const remote = `origin/${name}`;
  const remoteCheck = spawnSync("git", ["rev-parse", "--verify", remote], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "ignore"],
  });
  if (remoteCheck.status === 0) return remote;
  return name;
}

/** One `git diff --name-status` line under the migrations directory. */
interface DiffEntry {
  readonly status: string;
  readonly source: string;
  readonly dest: string | undefined;
}

/**
 * Parses one `git diff --name-status` line. Rename lines are `R100 source dest`;
 * every other status has a single path.
 */
export function parseNameStatusLine(line: string): DiffEntry | undefined {
  const trimmed = line.trim();
  if (trimmed.length === 0) return undefined;
  const [status, ...rest] = trimmed.split(/\s+/);
  if (status === undefined || rest.length === 0) return undefined;
  if (status.startsWith("R")) {
    const [source, dest] = rest;
    if (source === undefined) return undefined;
    return { status, source, dest };
  }
  return { status, source: rest.join(" "), dest: undefined };
}

/** Checks whether `path` is a numbered migration, not a test or the index. */
function isLandedMigration(path: string): boolean {
  return path.endsWith(".ts") && !path.endsWith(".test.ts") && !path.endsWith("/index.ts");
}

/**
 * Returns one failure message per landed migration that was modified, renamed,
 * or deleted in `diffStdout`. A rename is judged on the original path, before
 * any destination exclusion (so renaming a landed file to `index.ts` still
 * fails). New files, and edits to `index.ts`, are allowed.
 */
export function findMigrationProblems(diffStdout: string): string[] {
  const problems: string[] = [];
  for (const line of diffStdout.split("\n")) {
    const entry = parseNameStatusLine(line);
    if (entry === undefined) continue;

    if (entry.status.startsWith("R")) {
      if (isLandedMigration(entry.source)) {
        problems.push(
          `Migration ${entry.source} has been renamed. A landed migration is never renamed: renaming one breaks the migration run on a database that already ran it under the old name. Write a new migration instead.`,
        );
      }
      continue;
    }

    if (entry.status === "A") continue;
    if (!isLandedMigration(entry.source)) continue;

    if (entry.status === "M") {
      problems.push(
        `Migration ${entry.source} has been modified. A landed migration is never edited: editing one in place breaks every database that already ran the old version. Write a new migration instead.`,
      );
    } else if (entry.status === "D") {
      problems.push(
        `Migration ${entry.source} has been deleted. A landed migration is never removed: removing one breaks the migration run on a database that already has it. Write a new migration to undo its changes instead, if needed.`,
      );
    } else {
      problems.push(
        `Migration ${entry.source} has been changed (status: ${entry.status}). Only new migrations may be added; existing migrations are never modified, renamed, or deleted.`,
      );
    }
  }
  return problems;
}

if (import.meta.main) {
  const baseRef = resolveBaseRef(BASE_REF);
  // Diff from the merge base, not from current main: a migration that landed
  // on main after this branch is not a deletion, and uncommitted edits on
  // this branch still show up.
  const mergeBase = spawnSync("git", ["merge-base", baseRef, "HEAD"], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "inherit"],
  });
  if (mergeBase.status !== 0) {
    console.error("git merge-base failed");
    process.exit(1);
  }
  const result = spawnSync(
    "git",
    ["diff", mergeBase.stdout.trim(), "--name-status", "--", MIGRATIONS_DIR],
    {
      encoding: "utf8",
      stdio: ["inherit", "pipe", "inherit"],
    },
  );

  if (result.status !== 0) {
    console.error("git diff failed");
    process.exit(1);
  }

  const problems = findMigrationProblems(result.stdout);
  if (problems.length > 0) {
    console.error("Migration check failed:\n");
    for (const message of problems) {
      console.error(message);
      console.error("");
    }
    process.exit(1);
  }

  console.log("All migrations on main are unchanged.");
}
