/**
 * Test helpers that set up real git repositories in temporary directories for
 * the workspace tests.
 *
 * Nothing here fakes git or the module under test. A "remote" is a bare
 * repository on disk reached over `file://`, which needs no credential, so a
 * provisioning test covers the git code and never the credential path.
 */
import { Effect, Exit, Scope } from "effect";
import { makeWorkspaces, type Workspaces } from "./index";
import { createHash } from "node:crypto";
import {
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, relative } from "node:path";
import type { ProvisionCheckout, WorkspaceKind, WorkspaceProvision } from "@hercule/protocol";

/**
 * The user's own git configuration is kept out: a test must not depend on the
 * machine's `init.defaultBranch`, hooks, or credential helpers.
 */
const GIT_ENV: Record<string, string> = {
  PATH: process.env["PATH"] ?? "/usr/bin:/bin",
  HOME: process.env["HOME"] ?? "/tmp",
  GIT_CONFIG_GLOBAL: "/dev/null",
  GIT_CONFIG_SYSTEM: "/dev/null",
  GIT_TERMINAL_PROMPT: "0",
  GIT_AUTHOR_NAME: "Test Author",
  GIT_AUTHOR_EMAIL: "author@example.invalid",
  GIT_COMMITTER_NAME: "Test Author",
  GIT_COMMITTER_EMAIL: "author@example.invalid",
};

/** Runs git and returns its trimmed output. Throws with git's error output if git fails. */
export const runGitOrThrow = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const done = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (done.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${cwd}): ${done.stderr.toString()}`);
  }
  return done.stdout.toString().trim();
};

const roots: Array<string> = [];
const workspaceScopes: Array<Scope.Closeable> = [];

/** Constructs a manager whose workers remain alive until the test fixtures are cleaned up. */
export const makeTestWorkspaces = (options: Parameters<typeof makeWorkspaces>[0]): Workspaces => {
  const scope = Effect.runSync(Scope.make());
  workspaceScopes.push(scope);
  return Effect.runSync(makeWorkspaces(options).pipe(Scope.provide(scope)));
};

/** Stops test-owned workspace workers before their directories are removed. */
export const closeWorkspaceScopes = async (): Promise<void> => {
  for (const scope of workspaceScopes.splice(0))
    await Effect.runPromise(Scope.close(scope, Exit.void));
};

export const createTemporaryDir = (prefix: string): string => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  roots.push(made);
  return made;
};

/** Deletes every temporary directory created so far. Called from each suite's `afterAll`. */
export const cleanTemporaries = async (): Promise<void> => {
  await closeWorkspaceScopes();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export interface Remote {
  /** The bare repository's `file://` URL, which the runner is given as the remote. */
  readonly url: string;
  readonly path: string;
  /** A working copy of the remote that the test commits through. */
  readonly work: string;
}

/** Creates a bare "remote" with one commit on `main`, and a working copy for adding more. */
export const makeRemote = (): Remote => {
  const under = createTemporaryDir("hercule-remote-");
  const work = join(under, "work");
  mkdirSync(work);
  runGitOrThrow(work, "init", "-b", "main");
  writeFileSync(join(work, "README.md"), "the repository\n");
  runGitOrThrow(work, "add", ".");
  runGitOrThrow(work, "commit", "-m", "first");
  const path = join(under, "origin.git");
  runGitOrThrow(under, "clone", "--bare", work, path);
  runGitOrThrow(work, "remote", "add", "origin", path);
  return { url: `file://${path}`, path, work };
};

/** Adds a branch to the remote, and returns the commit it points at. */
export const addBranch = (remote: Remote, branch: string, content = "on a branch\n"): string => {
  runGitOrThrow(remote.work, "checkout", "-b", branch);
  writeFileSync(join(remote.work, `${branch.replaceAll("/", "-")}.txt`), content);
  runGitOrThrow(remote.work, "add", ".");
  runGitOrThrow(remote.work, "commit", "-m", `work on ${branch}`);
  const sha = runGitOrThrow(remote.work, "rev-parse", "HEAD");
  runGitOrThrow(remote.work, "push", remote.path, branch);
  runGitOrThrow(remote.work, "checkout", "main");
  return sha;
};

/**
 * Creates a checkout like one the user already has: cloned from the remote and
 * on `branch`. Returns its path.
 */
export const cloneUserCheckout = (remote: Remote, branch = "main"): string => {
  const under = createTemporaryDir("hercule-user-checkout-");
  const path = join(under, "checkout");
  runGitOrThrow(under, "clone", remote.url, path);
  if (branch !== "main") runGitOrThrow(path, "checkout", branch);
  return path;
};

/**
 * Returns a hash of every path, file mode, file and symlink under a directory,
 * so a test can check that nothing there changed.
 */
export const hashContents = (dir: string): string => {
  const entries = readdirSync(dir, { recursive: true, encoding: "utf8" }).sort();
  const hash = createHash("sha256");
  for (const entry of entries) {
    const full = join(dir, entry);
    const stat = lstatSync(full);
    hash.update(`${relative(dir, full)}\0${String(stat.mode)}\0`);
    if (stat.isSymbolicLink()) hash.update(readlinkSync(full));
    else if (stat.isFile()) hash.update(readFileSync(full));
    hash.update("\0");
  }
  return hash.digest("hex");
};

export const createId = (): string => crypto.randomUUID();

type CheckoutOverrides = Partial<ProvisionCheckout> &
  Pick<ProvisionCheckout, "resourceId" | "remote">;

export const buildCheckout = (overrides: CheckoutOverrides): ProvisionCheckout => ({
  checkoutId: createId(),
  subdirectory: null,
  branch: null,
  baseBranch: null,
  setupCommand: null,
  workspaceInclude: false,
  ...overrides,
});

export const buildProvisionFrame = (options: {
  readonly workspaceId?: string;
  readonly kind: WorkspaceKind;
  readonly checkouts: ReadonlyArray<ProvisionCheckout>;
}): WorkspaceProvision => ({
  _tag: "workspaceProvision",
  workspaceId: options.workspaceId ?? createId(),
  kind: options.kind,
  checkouts: options.checkouts,
});
