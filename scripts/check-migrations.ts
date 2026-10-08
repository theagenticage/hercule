#!/usr/bin/env bun
/**
 * Checks that no migration file already on `main` has been modified, renamed,
 * or deleted. A landed migration is never edited: editing one in place breaks
 * every database that already ran the old version.
 *
 * Exits 0 when all existing migrations are unchanged, or 1 with a message
 * naming the file and saying to write a new migration instead.
 *
 * Called in CI on pull requests. Locally, run `git diff main --name-status` to
 * check before pushing.
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

const baseRef = resolveBaseRef(BASE_REF);

const result = spawnSync("git", ["diff", baseRef, "--name-status", "--", MIGRATIONS_DIR], {
  encoding: "utf8",
  stdio: ["inherit", "pipe", "inherit"],
});

if (result.status !== 0) {
  console.error("git diff failed");
  process.exit(1);
}

const lines = result.stdout
  .split("\n")
  .map((line) => line.trim())
  .filter((line) => line.length > 0);

const problems: Array<{ status: string; file: string; message: string }> = [];

for (const line of lines) {
  const [status, ...rest] = line.split(/\s+/);
  if (status === undefined) continue;
  const file = rest.join(" ");

  // Only .ts migration files matter, not .test.ts
  if (!file.endsWith(".ts") || file.endsWith(".test.ts")) continue;

  // Added files (A) and index.ts updates are fine
  if (status === "A" || file.endsWith("/index.ts")) continue;

  // Any other status is a problem:
  // M = modified, D = deleted, R = renamed
  let message: string;
  if (status === "M") {
    message = `Migration ${file} has been modified. A landed migration is never edited: editing one in place breaks every database that already ran the old version. Write a new migration instead.`;
  } else if (status === "D") {
    message = `Migration ${file} has been deleted. A landed migration is never removed: removing one breaks the migration run on a database that already has it. Write a new migration to undo its changes instead, if needed.`;
  } else if (status?.startsWith("R")) {
    message = `Migration ${file} has been renamed. A landed migration is never renamed: renaming one breaks the migration run on a database that already ran it under the old name. Write a new migration instead.`;
  } else {
    message = `Migration ${file} has been changed (status: ${status}). Only new migrations may be added; existing migrations are never modified, renamed, or deleted.`;
  }

  problems.push({ status, file, message });
}

if (problems.length > 0) {
  console.error("Migration check failed:\n");
  for (const problem of problems) {
    console.error(problem.message);
    console.error("");
  }
  process.exit(1);
}

console.log("All migrations on main are unchanged.");
