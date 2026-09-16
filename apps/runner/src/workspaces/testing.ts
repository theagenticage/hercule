/**
 * Real git in temp directories: what the workspace tests are written against.
 *
 * Nothing here fakes git or the module under test. A "remote" is a bare
 * repository on disk reached over `file://`, which needs no credential, so a
 * provisioning test proves the git substrate and never the token path.
 */
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
import type { ProvisionCheckout, WorkspaceKind, WorkspaceProvision } from "@hydra/protocol";

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

/** Runs git and fails the test with git's own words when it is unhappy. */
export const git = (cwd: string, ...args: ReadonlyArray<string>): string => {
  const done = Bun.spawnSync(["git", ...args], { cwd, env: GIT_ENV });
  if (done.exitCode !== 0) {
    throw new Error(`git ${args.join(" ")} (in ${cwd}): ${done.stderr.toString()}`);
  }
  return done.stdout.toString().trim();
};

const roots: Array<string> = [];

export const temporary = (prefix: string): string => {
  const made = mkdtempSync(join(tmpdir(), prefix));
  roots.push(made);
  return made;
};

/** Called from each suite's `afterAll`. */
export const cleanTemporaries = (): void => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
};

export interface Remote {
  /** The bare repository, as the runner is told to fetch it. */
  readonly url: string;
  readonly path: string;
  /** A working copy of it the test commits through. */
  readonly work: string;
}

/** A bare "remote" with one commit on `main`, and a working copy to grow it. */
export const makeRemote = (): Remote => {
  const under = temporary("hydra-remote-");
  const work = join(under, "work");
  mkdirSync(work);
  git(work, "init", "-b", "main");
  writeFileSync(join(work, "README.md"), "the repository\n");
  git(work, "add", ".");
  git(work, "commit", "-m", "first");
  const path = join(under, "origin.git");
  git(under, "clone", "--bare", work, path);
  git(work, "remote", "add", "origin", path);
  return { url: `file://${path}`, path, work };
};

/** Adds a branch to the remote, and returns the commit it points at. */
export const addBranch = (remote: Remote, branch: string, content = "on a branch\n"): string => {
  git(remote.work, "checkout", "-b", branch);
  writeFileSync(join(remote.work, `${branch.replaceAll("/", "-")}.txt`), content);
  git(remote.work, "add", ".");
  git(remote.work, "commit", "-m", `work on ${branch}`);
  const sha = git(remote.work, "rev-parse", "HEAD");
  git(remote.work, "push", remote.path, branch);
  git(remote.work, "checkout", "main");
  return sha;
};

/** A checkout the user already has: cloned from the remote, origin set to it. */
export const userCheckout = (remote: Remote, branch = "main"): string => {
  const under = temporary("hydra-user-checkout-");
  const path = join(under, "checkout");
  git(under, "clone", remote.url, path);
  if (branch !== "main") git(path, "checkout", branch);
  return path;
};

/** Every byte under a directory, so "nothing was written here" is checkable. */
export const contentsOf = (dir: string): string => {
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

export const id = (): string => crypto.randomUUID();

type CheckoutOverrides = Partial<ProvisionCheckout> &
  Pick<ProvisionCheckout, "resourceId" | "remote">;

export const checkout = (overrides: CheckoutOverrides): ProvisionCheckout => ({
  checkoutId: id(),
  subdirectory: null,
  branch: null,
  baseBranch: null,
  setupCommand: null,
  workspaceInclude: false,
  ...overrides,
});

export const provisionFrame = (options: {
  readonly workspaceId?: string;
  readonly kind: WorkspaceKind;
  readonly checkouts: ReadonlyArray<ProvisionCheckout>;
}): WorkspaceProvision => ({
  _tag: "workspaceProvision",
  workspaceId: options.workspaceId ?? id(),
  kind: options.kind,
  checkouts: options.checkouts,
});
