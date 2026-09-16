/**
 * What the runner makes when the controller asks for a workspace (AC-9, AC-10).
 *
 * Every repository here is real: a bare "remote" on disk, reached over
 * `file://` so no credential is in play, and real clones and worktrees made by
 * real git. The assertions are on what a user would find afterwards - a branch,
 * a file, an untouched folder - not on how the runner got there.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeWorkspaces } from "./index";
import {
  addBranch,
  adoptedCheckout,
  checkout,
  cleanTemporaries,
  contentsOf,
  git,
  id,
  makeRemote,
  provisionFrame,
  temporary,
} from "./testing";

afterAll(cleanTemporaries);

const storage = (): string => temporary("hydra-storage-");

const cacheOf = (storageDir: string, resourceId: string): string =>
  join(storageDir, "cache", `${resourceId}.git`);

describe("a primary that adopts the folder the user already has", () => {
  it("reports the folder's branches and seeds the cache from it, writing nothing under it", async () => {
    const remote = makeRemote();
    addBranch(remote, "spike");
    const folder = adoptedCheckout(remote);
    git(folder, "checkout", "-b", "local-only");
    const head = git(folder, "rev-parse", "HEAD");
    const before = contentsOf(folder);
    const storageDir = storage();
    const resourceId = id();
    const checkoutId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ checkoutId, resourceId, remote: remote.url, path: folder })],
      }),
    );

    expect(report.status).toBe("ready");
    const reported = report.checkouts?.[0];
    expect(reported?.checkoutId).toBe(checkoutId);
    // The branch the user left it on, and the branches they can switch to.
    expect(reported?.branch).toBe("local-only");
    expect([...(reported?.branches ?? [])].sort()).toEqual(["local-only", "main"]);
    expect(reported?.defaultBranch).toBe("main");
    // The cache is seeded from the folder, so an ephemeral needs no network.
    expect(existsSync(cacheOf(storageDir, resourceId))).toBe(true);
    expect(git(cacheOf(storageDir, resourceId), "cat-file", "-t", head)).toBe("commit");
    // AD-5: Hydra never touches a primary beyond what the user asked.
    expect(contentsOf(folder)).toBe(before);
  });

  it("fails, naming the folder, when there is no git repository there", async () => {
    const remote = makeRemote();
    const folder = join(temporary("hydra-not-a-repo-"), "plain");
    mkdirSync(folder);
    writeFileSync(join(folder, "notes.txt"), "just files\n");
    const storageDir = storage();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ resourceId: id(), remote: remote.url, path: folder })],
      }),
    );

    expect(report.status).toBe("failed");
    expect(report.message ?? "").toContain(folder);
    // Nothing was adopted, so nothing was cached either.
    expect(report.checkouts ?? []).toEqual([]);
  });

  it("fails when the folder's origin is another remote", async () => {
    const asked = makeRemote();
    const other = makeRemote();
    const folder = adoptedCheckout(other);
    const storageDir = storage();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ resourceId: id(), remote: asked.url, path: folder })],
      }),
    );

    expect(report.status).toBe("failed");
    // The user has to be able to see which two remotes disagreed.
    expect(report.message ?? "").toContain("origin");
    expect(report.message ?? "").toContain(other.path);
  });
});

describe("a primary cloned fresh", () => {
  it("clones from the cache into the runner's own directory and points origin at the remote", async () => {
    const remote = makeRemote();
    const head = git(remote.work, "rev-parse", "HEAD");
    const storageDir = storage();
    const resourceId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url })],
      }),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "primaries", resourceId);
    expect(git(directory, "rev-parse", "HEAD")).toBe(head);
    expect(git(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    // Fetching and pushing must reach the real remote, not the local cache.
    expect(git(directory, "remote", "get-url", "origin")).toBe(remote.url);
    expect(report.checkouts?.[0]?.branch).toBe("main");
    expect(report.checkouts?.[0]?.defaultBranch).toBe("main");
    // Hardlinked objects: one copy on disk however many primaries there are.
    const objects = join(directory, ".git", "objects");
    const shared = readdirSync(objects, { recursive: true, encoding: "utf8" })
      .map((entry) => statSync(join(objects, entry)))
      .some((stat) => stat.isFile() && stat.nlink > 1);
    expect(shared).toBe(true);
  });
});

describe("an ephemeral workspace", () => {
  it("is a worktree on a new branch, from the base branch that was asked for", async () => {
    const remote = makeRemote();
    const base = addBranch(remote, "release");
    const storageDir = storage();
    const workspaceId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: remote.url,
            branch: "hydra/run-3f1a2b4c",
            baseBranch: "release",
          }),
        ],
      }),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(git(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("hydra/run-3f1a2b4c");
    expect(git(directory, "rev-parse", "HEAD")).toBe(base);
    expect(report.checkouts?.[0]?.branch).toBe("hydra/run-3f1a2b4c");
  });

  it("puts each repository under its own subdirectory when there are several", async () => {
    const web = makeRemote();
    const api = makeRemote();
    const storageDir = storage();
    const workspaceId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: web.url,
            subdirectory: "web",
            branch: "hydra/run-00000001",
          }),
          checkout({
            resourceId: id(),
            remote: api.url,
            subdirectory: "api",
            branch: "hydra/run-00000001",
          }),
        ],
      }),
    );

    expect(report.status).toBe("ready");
    const root = join(storageDir, "workspaces", workspaceId);
    expect(git(join(root, "web"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("hydra/run-00000001");
    expect(git(join(root, "api"), "rev-parse", "--abbrev-ref", "HEAD")).toBe("hydra/run-00000001");
    expect(report.checkouts?.map((one) => one.branch)).toEqual([
      "hydra/run-00000001",
      "hydra/run-00000001",
    ]);
  });

  it("with no checkouts is an empty directory", async () => {
    const storageDir = storage();
    const workspaceId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({ workspaceId, kind: "ephemeral", checkouts: [] }),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(readdirSync(directory)).toEqual([]);
    expect(report.checkouts ?? []).toEqual([]);
  });
});

describe("the setup command", () => {
  it("runs in the checkout, with the environment the runner's git uses", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();

    const report = await makeWorkspaces({
      storageDir,
      gitEnv: { HYDRA_RUNNER_SOCKET: "/tmp/hydra-test.sock" },
    }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: remote.url,
            branch: "hydra/run-5e5e5e5e",
            setupCommand: 'printf "%s\\n" "$HYDRA_RUNNER_SOCKET" > setup-ran.txt',
          }),
        ],
      }),
    );

    expect(report.status).toBe("ready");
    const ran = join(storageDir, "workspaces", workspaceId, "setup-ran.txt");
    // In the checkout, because a setup command installs dependencies there.
    expect(readFileSync(ran, "utf8")).toBe("/tmp/hydra-test.sock\n");
  });

  it("fails the workspace with its last 20 lines, leaving the directory in place", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: remote.url,
            branch: "hydra/run-6f6f6f6f",
            setupCommand: "for i in $(seq 1 30); do echo line$i; done; exit 3",
          }),
        ],
      }),
    );

    expect(report.status).toBe("failed");
    // The tail is what says why; the head of a long install log is noise.
    expect(report.message ?? "").toContain("line30");
    expect(report.message ?? "").toContain("line11");
    expect(report.message ?? "").not.toContain("line10");
    // Left in place: the user is the one who decides to throw the work away.
    expect(existsSync(join(storageDir, "workspaces", workspaceId))).toBe(true);
  });
});

describe(".workspaceinclude", () => {
  const withInclude = (folder: string, lines: string): void => {
    writeFileSync(join(folder, ".workspaceinclude"), lines);
    writeFileSync(join(folder, ".env"), "SECRET=local\n");
    mkdirSync(join(folder, "config"), { recursive: true });
    writeFileSync(join(folder, "config", "local.json"), "{}\n");
  };

  it("copies what the primary lists into the worktree", async () => {
    const remote = makeRemote();
    const folder = adoptedCheckout(remote);
    withInclude(folder, "# what the agent needs\n\n.env\nconfig/local.json\n");
    const storageDir = storage();
    const resourceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url, path: folder })],
      }),
    );
    const workspaceId = id();

    const report = await workspaces.provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId,
            remote: remote.url,
            branch: "hydra/run-7a7a7a7a",
            workspaceInclude: true,
          }),
        ],
      }),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe("SECRET=local\n");
    expect(readFileSync(join(directory, "config", "local.json"), "utf8")).toBe("{}\n");
    // A comment and a blank line are neither paths nor a failure.
    expect(existsSync(join(directory, "# what the agent needs"))).toBe(false);
    expect(report.warnings ?? []).toEqual([]);
  });

  it("warns rather than fails when this machine holds no primary of the repository", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: remote.url,
            branch: "hydra/run-8b8b8b8b",
            workspaceInclude: true,
          }),
        ],
      }),
    );

    // The workspace is usable; the user is told what it does not have.
    expect(report.status).toBe("ready");
    expect(report.warnings?.length).toBe(1);
    expect(report.warnings?.[0] ?? "").toContain("no primary");
    expect(report.warnings?.[0] ?? "").toContain(".workspaceinclude skipped");
    expect(
      git(join(storageDir, "workspaces", workspaceId), "rev-parse", "--abbrev-ref", "HEAD"),
    ).toBe("hydra/run-8b8b8b8b");
  });
});
