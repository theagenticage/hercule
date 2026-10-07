/**
 * Picking a project's folder: the user picks a folder in the system's
 * dialog, and main describes it with git, so the first run can name the
 * project and its repository. Main only reads the folder; it never changes
 * it.
 */
import { realpathSync } from "node:fs";
import { basename } from "node:path";
import * as Effect from "effect/Effect";
import type { FolderPickOutcome } from "../ipc/contract";
import { MainWindow } from "./main-window";
import { describeFailedExit, removeVariablesWithPrefix, runProgram } from "./run-program";

/**
 * The git main runs: Apple's, which every Mac has. Homebrew's git needs the
 * Command Line Tools to install, so a Mac with another git has these too.
 * Without the Command Line Tools, Apple's git offers to install them and
 * fails, and the outcome is `GitFailed` with git's error.
 */
const GIT = "/usr/bin/git";

/** The exit code of `git config --get` when the remote does not exist. */
const NO_SUCH_REMOTE_EXIT_CODE = 1;

/**
 * Returns main's environment for git: without any `GIT_*` variable, which
 * could point git at another repository than the folder's, and with git's
 * messages in English, which `describeFolder` reads.
 */
const buildGitEnvironment = (): NodeJS.ProcessEnv => ({
  ...removeVariablesWithPrefix(process.env, "GIT_"),
  LC_ALL: "C",
});

/** Runs git with `args` in `folder` and returns how it exited. */
const runGit = (folder: string, args: ReadonlyArray<string>) =>
  runProgram(GIT, ["-C", folder, ...args], { env: buildGitEnvironment() });

/**
 * Returns `remote` without the user name and password an `http:` or
 * `https:` URL can carry, such as `https://x-access-token:ghp_...@github.com/`.
 * Returns any other remote, such as `git@github.com:ada/api.git`, unchanged.
 *
 * The remote leaves main for the renderer and is saved on the controller as
 * the project's repository, so a token in it would leak. A token gets there
 * when the user's git config has an `insteadOf` rule that adds one, or when
 * the remote was added with one.
 */
const removeRemoteCredentials = (remote: string): string => {
  if (!URL.canParse(remote)) return remote;
  const url = new URL(remote);
  if (url.protocol !== "http:" && url.protocol !== "https:") return remote;
  if (url.username === "" && url.password === "") return remote;
  url.username = "";
  url.password = "";
  return url.href;
};

/**
 * Describes `folder`, an absolute path, with git:
 *
 * - `Repository` when it is in a git repository with an `origin` remote;
 * - `NoRemote` when it is in a git repository without one;
 * - `NotGit` when it is in no git repository;
 * - `GitFailed` when git cannot read it otherwise, with git's last line.
 *
 * `path` is the normalized checkout root. `remote` is the configured origin URL,
 * before transport rewriting, with no user name or password in it.
 * `branch` is the branch checked out, also
 * in a repository with no commit yet, or null when HEAD is detached. Runs
 * git three times. Never fails.
 */
export const describeFolder = (folder: string): Effect.Effect<FolderPickOutcome> =>
  Effect.gen(function* () {
    const name = basename(folder);
    const root = yield* runGit(folder, ["rev-parse", "--show-toplevel"]);
    if (root.exitCode !== 0)
      return root.stderr.includes("not a git repository")
        ? ({ _tag: "NotGit", name } as const)
        : ({ _tag: "GitFailed", name, line: describeFailedExit(root, "Git") } as const);
    const path = realpathSync(root.stdout.trim());
    const remote = yield* runGit(path, ["config", "--get", "remote.origin.url"]);
    if (remote.exitCode !== 0 && remote.exitCode !== NO_SUCH_REMOTE_EXIT_CODE) {
      return remote.stderr.includes("not a git repository")
        ? ({ _tag: "NotGit", name } as const)
        : ({ _tag: "GitFailed", name, line: describeFailedExit(remote, "Git") } as const);
    }
    // symbolic-ref exits 1, quietly, when HEAD is detached.
    const head = yield* runGit(folder, ["symbolic-ref", "--quiet", "--short", "HEAD"]);
    if (head.exitCode !== 0 && head.exitCode !== 1) {
      return { _tag: "GitFailed", name, line: describeFailedExit(head, "Git") } as const;
    }
    const branch = head.exitCode === 0 ? head.stdout.trim() : null;
    return remote.exitCode === 0
      ? ({
          _tag: "Repository",
          name,
          path,
          remote: removeRemoteCredentials(remote.stdout.trim()),
          branch,
        } as const)
      : ({ _tag: "NoRemote", name, path, branch } as const);
  }).pipe(
    Effect.catch((error) =>
      Effect.succeed({
        _tag: "GitFailed",
        name: basename(folder),
        line: `Git could not be started: ${error.message}`,
      } as const),
    ),
  );

/**
 * Asks the user to pick a folder in the system's dialog, and describes it
 * with `describeFolder`. Returns `Cancelled` when the user cancels.
 */
export const pickFolder: Effect.Effect<FolderPickOutcome, never, MainWindow> = Effect.gen(
  function* () {
    const folder = yield* MainWindow.use((window) => window.pickFolder);
    if (folder === null) return { _tag: "Cancelled" } as const;
    return yield* describeFolder(folder);
  },
);
