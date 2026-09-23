/**
 * Tests that the runner still knows where its workspaces are after it restarts.
 *
 * The controller stores no paths, so this registry is the only record of a
 * workspace's directory. A runner that lost it would strand the user's work on
 * its own disk.
 */
import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { makeWorkspaces } from "./index";
import {
  buildCheckout,
  cleanTemporaries,
  runGitOrThrow,
  createId,
  makeRemote,
  buildProvisionFrame,
  createTemporaryDir,
} from "./testing";

afterAll(cleanTemporaries);

const createStorageDir = (): string => createTemporaryDir("hercule-storage-");

describe("resolving a workspace", () => {
  it("finds an ephemeral workspace and its checkouts after a restart", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const resourceId = createId();
    const checkoutId = createId();
    await makeWorkspaces({ storageDir }).provision(
      buildProvisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          buildCheckout({
            checkoutId,
            resourceId,
            remote: remote.url,
            branch: "hercule/run-1a1a1a1a",
          }),
        ],
      }),
    );

    // A second instance over the same storage: the daemon after a restart.
    const resolved = makeWorkspaces({ storageDir }).resolve(workspaceId);

    const directory = join(storageDir, "workspaces", workspaceId);
    expect(resolved?.root).toBe(directory);
    // A single-repo ephemeral workspace runs in the checkout itself, not above it.
    expect(resolved?.cwd).toBe(directory);
    expect(resolved?.checkouts).toEqual([
      { checkoutId, resourceId, remote: remote.url, path: directory },
    ]);
  });

  it("runs a multi-repo ephemeral workspace in the root above its repositories", async () => {
    const web = makeRemote();
    const api = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    await makeWorkspaces({ storageDir }).provision(
      buildProvisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: [
          buildCheckout({
            resourceId: createId(),
            remote: web.url,
            subdirectory: "web",
            branch: "hercule/run-2b2b2b2b",
          }),
          buildCheckout({
            resourceId: createId(),
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

  // A primary is Hercule's own clone in the runner's storage directory.
  it("runs a primary in the clone it made for the repository", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const resourceId = createId();
    await makeWorkspaces({ storageDir }).provision(
      buildProvisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [buildCheckout({ resourceId, remote: remote.url })],
      }),
    );

    const resolved = makeWorkspaces({ storageDir }).resolve(workspaceId);

    const directory = join(storageDir, "primaries", resourceId);
    expect(resolved?.cwd).toBe(directory);
    expect(resolved?.root).toBe(directory);
  });

  it("returns undefined for a workspace the runner does not have", () => {
    expect(makeWorkspaces({ storageDir: createStorageDir() }).resolve(createId())).toBeUndefined();
  });
});

describe("provisioning a workspace this runner already has", () => {
  it("reports it again instead of creating it again", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const resourceId = createId();
    const frame = buildProvisionFrame({
      workspaceId,
      kind: "ephemeral",
      checkouts: [
        buildCheckout({ resourceId, remote: remote.url, branch: "hercule/run-3c3c3c3c" }),
      ],
    });
    const workspaces = makeWorkspaces({ storageDir });
    const first = await workspaces.provision(frame);
    const directory = join(storageDir, "workspaces", workspaceId);
    writeFileSync(join(directory, "work-in-progress.txt"), "the agent's work\n");

    const again = await makeWorkspaces({ storageDir }).provision(frame);

    expect(again.status).toBe("ready");
    expect(again.checkouts?.[0]?.branch).toBe(first.checkouts?.[0]?.branch);
    // A repeated frame must never throw the work in the workspace away.
    expect(runGitOrThrow(directory, "status", "--porcelain")).toContain("work-in-progress.txt");
  });

  /**
   * The registry is written when provisioning finishes, so a frame that
   * arrives while the first provisioning is still cloning would find no entry
   * and provision a second time. That would fail on the branch the first had
   * just created, and tear down what it found. The second call must wait for
   * the first and return the same report.
   */
  it("returns the report of the provisioning in progress instead of provisioning twice", async () => {
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
          branch: "hercule/run-1d1d1d1d",
        }),
      ],
    });
    const workspaces = makeWorkspaces({ storageDir });

    // Both calls start before either returns, like a frame resent to the same runner.
    const [first, second] = await Promise.all([
      workspaces.provision(frame),
      workspaces.provision(frame),
    ]);

    expect(first.status, first.message ?? "").toBe("ready");
    expect(second).toEqual(first);
    const directory = join(storageDir, "workspaces", workspaceId);
    expect(runGitOrThrow(directory, "rev-parse", "--abbrev-ref", "HEAD")).toBe(
      "hercule/run-1d1d1d1d",
    );
  });
});

describe("a workspace whose directory is gone", () => {
  it("cannot be resolved, and is reported failed instead of ready", async () => {
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
          branch: "hercule/run-5e5e0000",
        }),
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
    // Its entry is removed, so the next frame for it creates the workspace from scratch.
    expect(makeWorkspaces({ storageDir }).resolve(workspaceId)).toBeUndefined();
  });
});

describe("reporting a primary after a session ran in it", () => {
  it("re-reads the branch the session left the checkout on", async () => {
    const remote = makeRemote();
    const storageDir = createStorageDir();
    const workspaceId = createId();
    const resourceId = createId();
    const workspaces = makeWorkspaces({ storageDir });
    await workspaces.provision(
      buildProvisionFrame({
        workspaceId,
        kind: "primary",
        checkouts: [buildCheckout({ resourceId, remote: remote.url })],
      }),
    );
    const folder = join(storageDir, "primaries", resourceId);
    // What a session does: it works on a branch of its own.
    runGitOrThrow(folder, "checkout", "-b", "feature/what-the-agent-did");

    const report = await workspaces.reportAfterSession(workspaceId);

    expect(report?.status).toBe("ready");
    expect(report?.workspaceId).toBe(workspaceId);
    expect(report?.checkouts?.[0]?.branch).toBe("feature/what-the-agent-did");
    expect([...(report?.checkouts?.[0]?.branches ?? [])].sort()).toEqual([
      "feature/what-the-agent-did",
      "main",
    ]);
  });

  it("returns undefined for a workspace the runner does not have", async () => {
    expect(
      await makeWorkspaces({ storageDir: createStorageDir() }).reportAfterSession(createId()),
    ).toBeUndefined();
  });
});
