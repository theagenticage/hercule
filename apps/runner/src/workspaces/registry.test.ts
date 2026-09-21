/**
 * What the runner still knows about its workspaces after it restarts.
 *
 * The controller stores no path, so this registry is the only place a
 * workspace's directory exists. A daemon that forgets it has stranded the
 * user's work on its own disk.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeWorkspaces } from "./index";
import {
  checkout,
  cleanTemporaries,
  git,
  id,
  makeRemote,
  provisionFrame,
  temporary,
} from "./testing";

afterAll(cleanTemporaries);

const storage = (): string => temporary("hercule-storage-");

describe("resolving a workspace", () => {
  it("reads an ephemeral back after a restart, with its checkouts", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const resourceId = id();
    const checkoutId = id();
    await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({ checkoutId, resourceId, remote: remote.url, branch: "hercule/run-1a1a1a1a" }),
        ],
      }),
    );

    // A second instance over the same storage: the daemon after a restart.
    const resolved = makeWorkspaces({ storageDir }).resolve(workspaceId);

    const directory = join(storageDir, "workspaces", workspaceId);
    expect(resolved?.root).toBe(directory);
    // A single-repo ephemeral runs in the checkout itself, not above it.
    expect(resolved?.cwd).toBe(directory);
    expect(resolved?.checkouts).toEqual([
      { checkoutId, resourceId, remote: remote.url, path: directory },
    ]);
  });

  it("runs a multi-repo ephemeral above its repositories", async () => {
    const web = makeRemote();
    const api = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          checkout({
            resourceId: id(),
            remote: web.url,
            subdirectory: "web",
            branch: "hercule/run-2b2b2b2b",
          }),
          checkout({
            resourceId: id(),
            remote: api.url,
            subdirectory: "api",
            branch: "hercule/run-2b2b2b2b",
          }),
        ],
      }),
    );

    const resolved = makeWorkspaces({ storageDir }).resolve(workspaceId);

    const root = join(storageDir, "workspaces", workspaceId);
    expect(resolved?.cwd).toBe(root);
    expect(resolved?.checkouts.map((one) => one.path)).toEqual([
      join(root, "web"),
      join(root, "api"),
    ]);
  });

  // D-20a: a primary is Hercule's own clone under the machine's storage.
  it("runs a primary in the clone it made for the repository", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const resourceId = id();
    await makeWorkspaces({ storageDir }).provision(
      provisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url })],
      }),
    );

    const resolved = makeWorkspaces({ storageDir }).resolve(workspaceId);

    const directory = join(storageDir, "primaries", resourceId);
    expect(resolved?.cwd).toBe(directory);
    expect(resolved?.root).toBe(directory);
  });

  it("knows nothing about a workspace it does not hold", () => {
    expect(makeWorkspaces({ storageDir: storage() }).resolve(id())).toBeUndefined();
  });
});

describe("provisioning a workspace this runner already holds", () => {
  it("re-reports it rather than making it again", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const resourceId = id();
    const frame = provisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [checkout({ resourceId, remote: remote.url, branch: "hercule/run-3c3c3c3c" })],
    });
    const workspaces = makeWorkspaces({ storageDir });
    const first = await workspaces.provision(frame);
    const directory = join(storageDir, "workspaces", workspaceId);
    writeFileSync(join(directory, "work-in-progress.txt"), "the agent's work\n");

    const again = await makeWorkspaces({ storageDir }).provision(frame);

    expect(again.status).toBe("ready");
    expect(again.checkouts?.[0]?.branch).toBe(first.checkouts?.[0]?.branch);
    // A repeated frame must never throw the work in the workspace away.
    expect(git(directory, "status", "--porcelain")).toContain("work-in-progress.txt");
  });

  /**
   * D-21 F12: the registry is written when a provisioning finishes, so a frame
   * that arrives while the first is still cloning would find nothing there and
   * provision a second time - failing on the branch the first had just made and
   * tearing down what it found. Whoever arrives second waits for the one in
   * flight and reports what it reported.
   */
  it("reports the one in flight rather than provisioning twice", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const frame = provisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [
        checkout({ resourceId: id(), remote: remote.url, branch: "hercule/run-1d1d1d1d" }),
      ],
    });
    const workspaces = makeWorkspaces({ storageDir });

    // Both sent before either has answered: one daemon, one frame resent.
    const [first, second] = await Promise.all([
      workspaces.provision(frame),
      workspaces.provision(frame),
    ]);

    expect(first.status, first.message ?? "").toBe("ready");
    expect(second).toEqual(first);
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(git(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe("hercule/run-1d1d1d1d");
  });
});

describe("a workspace whose directory is gone", () => {
  it("is nowhere to run, and is reported failed rather than re-reported ready", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const frame = provisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [
        checkout({ resourceId: id(), remote: remote.url, branch: "hercule/run-5e5e0000" }),
      ],
    });
    await makeWorkspaces({ storageDir }).provision(frame);
    // Somebody cleaned up their disk, or a temporary directory was swept.
    rmSync(join(storageDir, "workspaces", workspaceId), { recursive: true, force: true });

    // A session placed here would start in a directory that does not exist.
    expect(makeWorkspaces({ storageDir }).resolve(workspaceId)).toBeUndefined();

    const again = await makeWorkspaces({ storageDir }).provision(frame);

    expect(again.status).toBe("failed");
    expect(again.message ?? "").toContain("gone");
    // Forgotten, so the next frame for it makes the workspace afresh.
    expect(makeWorkspaces({ storageDir }).resolve(workspaceId)).toBeUndefined();
  });
});

describe("what a primary is re-reported as after a session in it", () => {
  it("re-reads the branch the session left the checkout on", async () => {
    const remote = makeRemote();
    const storageDir = storage();
    const workspaceId = id();
    const resourceId = id();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      provisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [checkout({ resourceId, remote: remote.url })],
      }),
    );
    const folder = join(storageDir, "primaries", resourceId);
    // What a session does: it works on a branch of its own.
    git(folder, "checkout", "-b", "feature/what-the-agent-did");

    const report = await workspaces.reportAfterSession(workspaceId);

    expect(report?.status).toBe("ready");
    expect(report?.workspaceId).toBe(workspaceId);
    expect(report?.checkouts?.[0]?.branch).toBe("feature/what-the-agent-did");
    expect([...(report?.checkouts?.[0]?.branches ?? [])].sort()).toEqual([
      "feature/what-the-agent-did",
      "main",
    ]);
  });

  it("has nothing to say about a workspace it does not hold", async () => {
    expect(
      await makeWorkspaces({ storageDir: storage() }).reportAfterSession(id()),
    ).toBeUndefined();
  });
});
