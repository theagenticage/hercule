/**
 * What the runner makes when the controller asks for a workspace.
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
  userCheckout,
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

/** Whether a process is gone, given the moment it takes a signal to land. */
const goneWithin = async (pid: number, within: number): Promise<boolean> => {
  const until = Date.now() + within;
  while (Date.now() < until) {
    try {
      process.kill(pid, 0);
    } catch {
      return true;
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return false;
};

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

  /**
   * AD-5, under D-20a: adopting in place is not built, so what must be proved
   * is the other half of the same promise - a checkout of this repository that
   * the user already has on this machine is not read, written or moved.
   */
  it("leaves a checkout of the same repository the user already has untouched", async () => {
    const remote = makeRemote();
    const mine = userCheckout(remote);
    git(mine, "checkout", "-b", "local-only");
    writeFileSync(join(mine, "scratch.txt"), "mine\n");
    const before = contentsOf(mine);
    const head = git(mine, "rev-parse", "HEAD");
    const storageDir = storage();
    const resourceId = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url })],
      }),
    );

    expect(report.status).toBe("ready");
    // Hydra's own clone, somewhere else entirely.
    expect(report.checkouts?.[0]?.branch).toBe("main");
    expect(existsSync(join(storageDir, "primaries", resourceId))).toBe(true);
    expect(contentsOf(mine)).toBe(before);
    expect(git(mine, "rev-parse", "HEAD")).toBe(head);
    expect(git(mine, "rev-parse", "--abbrev-ref", "HEAD")).toBe("local-only");
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

describe("a cache that has seen the branches agents made", () => {
  it("still provisions once an agent's branch is on the remote too", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const resourceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    const first = id();
    await workspaces.provision(
      provisionFrame({
        workspaceId: first,
        kind: "ephemeral",
        checkouts: [checkout({ resourceId, remote: remote.url, branch: "hydra/run-aaaaaaaa" })],
      }),
    );
    // What an agent does with its worktree: it commits and pushes the branch.
    const directory = join(storageDir, "workspaces", first);
    writeFileSync(join(directory, "work.txt"), "what the agent did\n");
    git(directory, "add", ".");
    git(directory, "commit", "-m", "the agent's work");
    git(directory, "push", remote.path, "hydra/run-aaaaaaaa");

    const second = await workspaces.provision(
      provisionFrame({
        kind: "ephemeral",
        checkouts: [checkout({ resourceId, remote: remote.url, branch: "hydra/run-bbbbbbbb" })],
      }),
    );

    // The branch is checked out here and now exists on the remote: a refresh
    // that fetched over it would refuse, and every later workspace with it.
    expect(second.status).toBe("ready");
    expect(second.checkouts?.[0]?.branch).toBe("hydra/run-bbbbbbbb");
  });

  it("gives a worktree off the primary's cache the repository's own remote", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const resourceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url })],
      }),
    );
    const workspaceId = id();

    const report = await workspaces.provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [checkout({ resourceId, remote: remote.url, branch: "hydra/run-cccccccc" })],
      }),
    );

    expect(report.status).toBe("ready");
    // Without this the agent's push would go to a bare repository on this
    // machine that nobody ever reads.
    expect(git(join(storageDir, "workspaces", workspaceId), "remote", "get-url", "origin")).toBe(
      remote.url,
    );
    // And the branch it was told to start from is the repository's own default.
    expect(report.checkouts?.[0]?.defaultBranch).toBe("main");
  });

  it("removes the worktrees it made when a later repository cannot be", async () => {
    const web = makeRemote();
    const api = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const webResource = id();

    const report = await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: webResource,
            remote: web.url,
            subdirectory: "web",
            branch: "hydra/run-dddddddd",
          }),
          checkout({
            resourceId: id(),
            remote: api.url,
            subdirectory: "api",
            branch: "hydra/run-dddddddd",
            baseBranch: "no-such-base",
          }),
        ],
      }),
    );

    expect(report.status).toBe("failed");
    const root = join(storageDir, "workspaces", workspaceId);
    expect(existsSync(root)).toBe(false);
    // And no cache is left believing a worktree of its own lives over there.
    expect(git(cacheOf(storageDir, webResource), "worktree", "list")).not.toContain(root);
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

describe("a setup command that will not finish", () => {
  it("is stopped at the deadline and reported, rather than left to hold the session", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();

    const report = await makeWorkspaces({ storageDir, setupDeadlineMs: 250 }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: remote.url,
            branch: "hydra/run-9d9d9d9d",
            setupCommand: "echo installing; sleep 60",
          }),
        ],
      }),
    );

    expect(report.status).toBe("failed");
    expect(report.message ?? "").toContain("still running");
    // What it managed to say before it was stopped is what tells the user where
    // it got stuck.
    expect(report.message ?? "").toContain("installing");
  });
});

describe("a workspace whose setup command failed", () => {
  it("is re-reported when the frame comes again, rather than made a second time", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const frame = provisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [
        checkout({
          resourceId: id(),
          remote: remote.url,
          branch: "hydra/run-7c7c7c7c",
          setupCommand: "echo could not install; exit 7",
        }),
      ],
    });
    const first = await makeWorkspaces({ storageDir }).provision(frame);
    expect(first.status).toBe("failed");
    const directory = join(storageDir, "workspaces", workspaceId);
    writeFileSync(join(directory, "half-done.txt"), "what the install got through\n");

    // The controller resends what it did not see answered, or what a runner
    // that dialled in again still owes it.
    const again = await makeWorkspaces({ storageDir }).provision(frame);

    // Making it again would fail on the branch that already exists and take the
    // directory the user was told they could look at with it.
    expect(again.status).toBe("ready");
    expect(again.checkouts?.[0]?.branch).toBe("hydra/run-7c7c7c7c");
    expect(readFileSync(join(directory, "half-done.txt"), "utf8")).toBe(
      "what the install got through\n",
    );
  });

  it("takes everything the setup command started down with it at the deadline", async () => {
    const remote = makeRemote();
    const storageDir = storage();

    const report = await makeWorkspaces({ storageDir, setupDeadlineMs: 250 }).provision(
      provisionFrame({
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: remote.url,
            branch: "hydra/run-8e8e8e8e",
            // A watcher of its own, which is what an install that hangs looks
            // like: the shell waits on a child that holds the pipes open.
            setupCommand: "sleep 60 & echo grandchild=$!; wait",
          }),
        ],
      }),
    );

    expect(report.status).toBe("failed");
    const started = Number(/grandchild=(\d+)/.exec(report.message ?? "")?.[1]);
    expect(started).toBeGreaterThan(0);
    // Killing the shell alone would leave this running, holding the workspace
    // the machine is about to give up on.
    expect(await goneWithin(started, 2_000)).toBe(true);
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
    const storageDir = storage();
    const resourceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      provisionFrame({
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url })],
      }),
    );
    // The primary is Hydra's own clone, so what it lists is written there.
    withInclude(
      join(storageDir, "primaries", resourceId),
      "# what the agent needs\n\n.env\nconfig/local.json\n",
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
