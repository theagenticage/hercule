import { makeTestWorkspaces } from "./testing";
import * as Effect from "effect/Effect";
/**
 * Tests for provisioning workspaces.
 *
 * Every repository here is real: a bare "remote" on disk, reached over
 * `file://` so no credential is needed, and real clones and worktrees made by
 * real git. The assertions check what a user would find afterwards (a branch,
 * a file, an untouched folder), not how the runner got there.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";

import {
  addBranch,
  cloneUserCheckout,
  buildCheckout,
  cleanTemporaries,
  hashContents,
  runGitOrThrow,
  createId,
  makeRemote,
  buildProvisionFrame,
  createTemporaryDir,
} from "./testing";

afterAll(cleanTemporaries);

const createStorageDir = (): string => createTemporaryDir("hercule-storage-");

const buildCacheDir = (storageDir: string, resourceId: string): string =>
  join(storageDir, "cache", `${resourceId}.git`);

/**
 * Checks whether a process exits within `within` milliseconds. It polls,
 * because a signal takes a moment to land.
 */
const isGoneWithin = async (pid: number, within: number): Promise<boolean> => {
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

describe("a fresh managed primary worktree", () => {
  it("shares the managed repository and keeps origin pointed at the remote", async () => {
    const remote = makeRemote();
    const head = runGitOrThrow(remote.work, "rev-parse", "HEAD");
    const storageDir = createStorageDir();
    const resourceId = createId();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remote.url })],
        }),
      ),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "primaries", workspaceId);
    expect(runGitOrThrow(directory, "rev-parse", "HEAD")).toBe(head);
    expect(runGitOrThrow(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      `hercule/main-${workspaceId}`,
    );
    // Fetching and pushing must reach the real remote, not the local cache.
    expect(runGitOrThrow(directory, "remote", "get-url", "origin")).toBe(remote.url);
    expect(report.checkouts?.[0]?.branch).toBe(`hercule/main-${workspaceId}`);
    expect(report.checkouts?.[0]?.defaultBranch).toBe("main");
    expect(statSync(join(directory, ".git")).isFile()).toBe(true);
    expect(
      runGitOrThrow(directory, "rev-parse", "--path-format=absolute", "--git-common-dir"),
    ).toBe(
      runGitOrThrow(
        buildCacheDir(storageDir, resourceId),
        "rev-parse",
        "--path-format=absolute",
        "--git-common-dir",
      ),
    );
  });

  /**
   * Hercule never takes over a folder the user already has. This checks that a
   * checkout of the same repository that the user already has on this machine
   * is left unchanged.
   */
  it("leaves a checkout of the same repository the user already has untouched", async () => {
    const remote = makeRemote();
    const mine = cloneUserCheckout(remote);
    runGitOrThrow(mine, "checkout", "-b", "local-only");
    writeFileSync(join(mine, "scratch.txt"), "mine\n");
    const before = hashContents(mine);
    const head = runGitOrThrow(mine, "rev-parse", "HEAD");
    const storageDir = createStorageDir();
    const resourceId = createId();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remote.url })],
        }),
      ),
    );

    expect(report.status).toBe("ready");
    expect(report.checkouts?.[0]?.branch).toBe(`hercule/main-${workspaceId}`);
    expect(existsSync(join(storageDir, "primaries", workspaceId))).toBe(true);
    expect(hashContents(mine)).toBe(before);
    expect(runGitOrThrow(mine, "rev-parse", "HEAD")).toBe(head);
    expect(runGitOrThrow(mine, "rev-parse", "--abbrev-ref", "HEAD")).toBe("local-only");
  });
});

describe("an ephemeral workspace", () => {
  it("is a worktree on a new branch, created from the requested base branch", async () => {
    const remote = makeRemote();
    const base = addBranch(remote, "release");
    const storageDir = createStorageDir();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId: createId(),
              remote: remote.url,
              branch: "hercule/run-3f1a2b4c",
              baseBranch: "release",
            }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(runGitOrThrow(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "hercule/run-3f1a2b4c",
    );
    expect(runGitOrThrow(directory, "rev-parse", "HEAD")).toBe(base);
    expect(report.checkouts?.[0]?.branch).toBe("hercule/run-3f1a2b4c");
  });

  it("puts each repository under its own subdirectory when there are several", async () => {
    const web = makeRemote();
    const api = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId: createId(),
              remote: web.url,
              subdirectory: "web",
              branch: "hercule/run-00000001",
            }),
            buildCheckout({
              resourceId: createId(),
              remote: api.url,
              subdirectory: "api",
              branch: "hercule/run-00000001",
            }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("ready");
    const root = join(storageDir, "workspaces", workspaceId);
    expect(runGitOrThrow(join(root, "web"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "hercule/run-00000001",
    );
    expect(runGitOrThrow(join(root, "api"), "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "hercule/run-00000001",
    );
    expect(report.checkouts?.map((one) => one.branch)).toEqual([
      "hercule/run-00000001",
      "hercule/run-00000001",
    ]);
  });

  it("with no checkouts is an empty directory", async () => {
    const storageDir = createStorageDir();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({ workspaceId, kind: "ephemeral", checkouts: [] }),
      ),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(readdirSync(directory)).toEqual([]);
    expect(report.checkouts ?? []).toEqual([]);
  });
});

describe("provisioning from a shared cache", () => {
  it("still provisions after an agent has pushed its branch to the remote", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const resourceId = createId();
    const workspaces = makeTestWorkspaces({ storageDir });
    const first = createId();
    await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          workspaceId: first,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({ resourceId, remote: remote.url, branch: "hercule/run-aaaaaaaa" }),
          ],
        }),
      ),
    );
    // What an agent does in its worktree: it commits and pushes the branch.
    const directory = join(storageDir, "workspaces", first);
    writeFileSync(join(directory, "work.txt"), "what the agent did\n");
    runGitOrThrow(directory, "add", ".");
    runGitOrThrow(directory, "commit", "-m", "the agent's work");
    runGitOrThrow(directory, "push", remote.path, "hercule/run-aaaaaaaa");

    const second = await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          kind: "ephemeral",
          checkouts: [
            buildCheckout({ resourceId, remote: remote.url, branch: "hercule/run-bbbbbbbb" }),
          ],
        }),
      ),
    );

    // The agent's branch is checked out in a worktree and now also exists on
    // the remote. A fetch into `refs/heads` would fail on it, and so would
    // every later workspace.
    expect(second.status).toBe("ready");
    expect(second.checkouts?.[0]?.branch).toBe("hercule/run-bbbbbbbb");
  });

  it("points a worktree created from the primary's cache at the real remote", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const resourceId = createId();
    const workspaces = makeTestWorkspaces({ storageDir });
    await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remote.url })],
        }),
      ),
    );
    const workspaceId = createId();

    const report = await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({ resourceId, remote: remote.url, branch: "hercule/run-cccccccc" }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("ready");
    // Without this the agent's push would go to a bare repository on this
    // machine that nobody ever reads.
    expect(
      runGitOrThrow(join(storageDir, "workspaces", workspaceId), "remote", "get-url", "origin"),
    ).toBe(remote.url);
    // And the reported default branch is the repository's own.
    expect(report.checkouts?.[0]?.defaultBranch).toBe("main");
  });

  it("removes the worktrees it created when a later repository fails", async () => {
    const web = makeRemote();
    const api = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const webResource = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId: webResource,
              remote: web.url,
              subdirectory: "web",
              branch: "hercule/run-dddddddd",
            }),
            buildCheckout({
              resourceId: createId(),
              remote: api.url,
              subdirectory: "api",
              branch: "hercule/run-dddddddd",
              baseBranch: "no-such-base",
            }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("failed");
    const root = join(storageDir, "workspaces", workspaceId);
    expect(existsSync(root)).toBe(false);
    // And no cache still lists a worktree there.
    expect(runGitOrThrow(buildCacheDir(storageDir, webResource), "worktree", "list")).not.toContain(
      root,
    );
  });
});

describe("the setup command", () => {
  it("runs in the checkout, with the runner's git environment minus the credential socket and the runner's own settings", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    // The runner's own Home. A `hercule` command in the setup command would act on it.
    vi.stubEnv("HERCULE_HOME", "/tmp/not-the-live-home");
    try {
      expect(process.env["HERCULE_HOME"]).toBe("/tmp/not-the-live-home");
      const report = await Effect.runPromise(
        makeTestWorkspaces({
          storageDir,
          gitEnv: { HERCULE_RUNNER_SOCKET: "/tmp/hercule-test.sock" },
        }).provision(
          buildProvisionFrame({
            workspaceId,
            kind: "ephemeral",
            checkouts: [
              buildCheckout({
                resourceId: createId(),
                remote: remote.url,
                branch: "hercule/run-5e5e5e5e",
                setupCommand: "env > setup-env.txt",
              }),
            ],
          }),
        ),
      );

      expect(report.status).toBe("ready");
      // In the checkout, because a setup command installs dependencies there.
      const env = readFileSync(
        join(storageDir, "workspaces", workspaceId, "setup-env.txt"),
        "utf8",
      );
      // The substrate environment reached the setup command, not an empty one.
      expect(env).toMatch(/^GIT_TERMINAL_PROMPT=0$/m);
      // Without the socket, the credential helper git is configured with answers nothing.
      expect(env).not.toMatch(/^HERCULE_RUNNER_SOCKET=/m);
      expect(env).not.toMatch(/^HERCULE_HOME=/m);
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("fails the workspace with the last 20 lines of output, and leaves the directory in place", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId: createId(),
              remote: remote.url,
              branch: "hercule/run-6f6f6f6f",
              setupCommand: "for i in $(seq 1 30); do echo line$i; done; exit 3",
            }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("failed");
    // The end of the output usually shows why; the start of a long install log is noise.
    expect(report.message ?? "").toContain("line30");
    expect(report.message ?? "").toContain("line11");
    expect(report.message ?? "").not.toContain("line10");
    // Left in place: the user decides whether to throw the work away.
    expect(existsSync(join(storageDir, "workspaces", workspaceId))).toBe(true);
  });
});

describe("a setup command that will not finish", () => {
  it("is stopped at the deadline and reported as failed, so the session does not wait forever", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir, setupDeadlineMs: 250 }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId: createId(),
              remote: remote.url,
              branch: "hercule/run-9d9d9d9d",
              setupCommand: "echo installing; sleep 60",
            }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("failed");
    expect(report.message ?? "").toContain("still running");
    // The output printed before it was stopped shows the user where it got
    // stuck.
    expect(report.message ?? "").toContain("installing");
  });
});

describe("a workspace whose setup command failed", () => {
  it("leaves a failed main attempt's files unchanged when a fresh main is created", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const resourceId = createId();
    const failedId = createId();
    const failed = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId: failedId,
          kind: "primary",
          checkouts: [
            buildCheckout({
              resourceId,
              remote: remote.url,
              setupCommand: "echo partial-install > unfinished.txt; exit 7",
            }),
          ],
        }),
      ),
    );
    expect(failed.status).toBe("failed");
    const failedRoot = join(storageDir, "primaries", failedId);
    const before = hashContents(failedRoot);
    const freshId = createId();
    const manager = makeTestWorkspaces({ storageDir });
    const ready = await Effect.runPromise(
      manager.provision(
        buildProvisionFrame({
          workspaceId: freshId,
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remote.url })],
        }),
      ),
    );
    expect(ready.status, ready.message).toBe("ready");
    expect(Effect.runSync(manager.resolve(freshId))?.root).not.toBe(failedRoot);
    expect(hashContents(failedRoot)).toBe(before);
    expect(Effect.runSync(manager.resolve(failedId))).toBeUndefined();
  });

  it("is reported again when the frame is resent, instead of created a second time", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const frame = buildProvisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [
        buildCheckout({
          resourceId: createId(),
          remote: remote.url,
          branch: "hercule/run-7c7c7c7c",
          setupCommand: "echo could not install; exit 7",
        }),
      ],
    });
    const first = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));
    expect(first.status).toBe("failed");
    const directory = join(storageDir, "workspaces", workspaceId);
    writeFileSync(join(directory, "half-done.txt"), "what the install got through\n");

    // The controller resends a frame it got no report for, and resends frames
    // to a runner that reconnects.
    const again = await Effect.runPromise(makeTestWorkspaces({ storageDir }).provision(frame));

    // Creating it again would fail on the branch that already exists, and would
    // remove the directory the user was told they could inspect.
    expect(again).toEqual(first);
    expect(readFileSync(join(directory, "half-done.txt"), "utf8")).toBe(
      "what the install got through\n",
    );
  });

  it("kills every process the setup command started when the deadline passes", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir, setupDeadlineMs: 250 }).provision(
        buildProvisionFrame({
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId: createId(),
              remote: remote.url,
              branch: "hercule/run-8e8e8e8e",
              // A background process, like an install that hangs: the shell
              // waits on a child that holds the pipes open.
              setupCommand: "sleep 60 & echo grandchild=$!; wait",
            }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("failed");
    const started = Number(/grandchild=(\d+)/.exec(report.message ?? "")?.[1]);
    expect(started).toBeGreaterThan(0);
    // Killing only the shell would leave this process running in the
    // workspace.
    expect(await isGoneWithin(started, 2_000)).toBe(true);
  });
});

describe(".workspaceinclude", () => {
  const writeWorkspaceInclude = (folder: string, lines: string): void => {
    writeFileSync(join(folder, ".workspaceinclude"), lines);
    writeFileSync(join(folder, ".env"), "SECRET=local\n");
    mkdirSync(join(folder, "config"), { recursive: true });
    writeFileSync(join(folder, "config", "local.json"), "{}\n");
  };

  it("copies the files the primary lists into the worktree", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const resourceId = createId();
    const workspaces = makeTestWorkspaces({ storageDir });
    const primaryId = createId();
    await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          workspaceId: primaryId,
          kind: "primary",
          checkouts: [buildCheckout({ resourceId, remote: remote.url })],
        }),
      ),
    );
    // The primary is Hercule's own clone, so the test writes the list and files there.
    writeWorkspaceInclude(
      join(storageDir, "primaries", primaryId),
      "# what the agent needs\n\n.env\nconfig/local.json\n",
    );
    const workspaceId = createId();

    const report = await Effect.runPromise(
      workspaces.provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId,
              remote: remote.url,
              branch: "hercule/run-7a7a7a7a",
              workspaceInclude: true,
            }),
          ],
        }),
      ),
    );

    expect(report.status).toBe("ready");
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(readFileSync(join(directory, ".env"), "utf8")).toBe("SECRET=local\n");
    expect(readFileSync(join(directory, "config", "local.json"), "utf8")).toBe("{}\n");
    // Comment lines and blank lines are skipped, not treated as paths or errors.
    expect(existsSync(join(directory, "# what the agent needs"))).toBe(false);
    expect(report.warnings ?? []).toEqual([]);
  });

  it("warns instead of failing when this runner has no primary for the repository", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();

    const report = await Effect.runPromise(
      makeTestWorkspaces({ storageDir }).provision(
        buildProvisionFrame({
          workspaceId,
          kind: "ephemeral",
          checkouts: [
            buildCheckout({
              resourceId: createId(),
              remote: remote.url,
              branch: "hercule/run-8b8b8b8b",
              workspaceInclude: true,
            }),
          ],
        }),
      ),
    );

    // The workspace is usable; the user is told what it does not have.
    expect(report.status).toBe("ready");
    expect(report.warnings?.length).toBe(1);
    expect(report.warnings?.[0] ?? "").toContain("no main workspace");
    expect(report.warnings?.[0] ?? "").toContain(".workspaceinclude skipped");
    expect(
      runGitOrThrow(
        join(storageDir, "workspaces", workspaceId),
        "rev-parse",
        "--abbrev-ref",
        "HEAD",
      ),
    ).toBe("hercule/run-8b8b8b8b");
  });
});
