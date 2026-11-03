/**
 * Tests for removing a workspace whole, the way an archived Thread's workspace
 * and a finished run's workspace are removed:
 *
 * - every file goes, including dependencies, uncommitted work and the files of
 *   a multi-repo root, and every worktree is unregistered from its repository,
 * - a removal that does not discard changes still refuses on those files,
 * - the harness files of the archived sessions the removal lists are deleted
 *   afterwards, and a file that stays becomes a warning that a replay repeats.
 */
import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import type { ArchivedSession } from "@hercule/protocol";
import * as Effect from "effect/Effect";
import { afterAll, describe, expect, it } from "vitest";
import type { DeleteSessionFiles } from "./archived-session-files";
import {
  buildCheckout,
  buildProvisionFrame,
  cleanTemporaries,
  createId,
  createTemporaryDir,
  makeRemote,
  makeTestWorkspaces,
  runGitOrThrow,
} from "./testing";

afterAll(cleanTemporaries);

/**
 * Provisions a workspace with `count` checkouts, each from its own repository,
 * and fills it with what blocks an ordinary removal: an ignored dependency
 * folder and a modified tracked file in every checkout, and a file at the root
 * of a workspace with several.
 */
const provisionUsedWorkspace = async (
  count: number,
  deleteSessionFiles: DeleteSessionFiles = () => Effect.void,
) => {
  const storageDir = createTemporaryDir("hercule-storage-");
  const workspaceId = createId();
  const workspaces = makeTestWorkspaces({ storageDir, deleteSessionFiles });
  const resourceIds = Array.from({ length: count }, () => createId());
  await Effect.runPromise(
    workspaces.provision(
      buildProvisionFrame({
        workspaceId,
        kind: "ephemeral",
        checkouts: resourceIds.map((resourceId, at) =>
          buildCheckout({
            resourceId,
            remote: makeRemote().url,
            subdirectory: count === 1 ? null : `repo-${String(at)}`,
            branch: `work-${createId()}`,
          }),
        ),
      }),
    ),
  );
  const root = join(storageDir, "workspaces", workspaceId);
  const checkoutDirs =
    count === 1 ? [root] : resourceIds.map((_, at) => join(root, `repo-${String(at)}`));
  for (const dir of checkoutDirs) {
    const exclude = runGitOrThrow(
      dir,
      "rev-parse",
      "--path-format=absolute",
      "--git-path",
      "info/exclude",
    );
    appendFileSync(exclude, "node_modules/\n");
    mkdirSync(join(dir, "node_modules", "left-pad"), { recursive: true });
    writeFileSync(join(dir, "node_modules", "left-pad", "index.js"), "module.exports = 1;\n");
    appendFileSync(join(dir, "README.md"), "uncommitted\n");
  }
  if (count > 1) writeFileSync(join(root, "notes.txt"), "a file at the root\n");
  const caches = resourceIds.map((resourceId) => join(storageDir, "cache", `${resourceId}.git`));
  return { storageDir, workspaces, workspaceId, root, checkoutDirs, caches };
};

describe("removing a workspace whole", () => {
  it.each([1, 2])(
    "removes the dependencies, uncommitted work and root files of a workspace with %i checkouts",
    async (count) => {
      const { workspaces, workspaceId, root, checkoutDirs, caches } =
        await provisionUsedWorkspace(count);

      const report = await Effect.runPromise(
        workspaces.dispose({ _tag: "workspaceDispose", workspaceId, discardChanges: true }),
      );

      expect(report.status).toBe("deleted");
      expect(report.warnings).toBeUndefined();
      expect(existsSync(root)).toBe(false);
      // Each repository keeps no record of a worktree whose folder is gone.
      caches.forEach((cache, at) => {
        expect(runGitOrThrow(cache, "worktree", "list")).not.toContain(checkoutDirs[at]!);
      });
      // A restart must not resurrect it.
      expect(Effect.runSync(workspaces.resolve(workspaceId))).toBeUndefined();
    },
  );

  it.each([1, 2])(
    "refuses to remove a workspace with %i checkouts that holds those files, when changes are not discarded",
    async (count) => {
      const { workspaces, workspaceId, root, checkoutDirs, caches } =
        await provisionUsedWorkspace(count);

      const report = await Effect.runPromise(
        workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
      );

      expect(report.status).toBe("failed");
      expect(existsSync(join(checkoutDirs[0]!, "node_modules", "left-pad", "index.js"))).toBe(true);
      expect(existsSync(root)).toBe(true);
      expect(runGitOrThrow(caches[0]!, "worktree", "list")).toContain(checkoutDirs[0]!);
    },
  );
});

describe("removing a workspace whose repository is gone", () => {
  it("deletes the folder and warns when changes are discarded", async () => {
    const { workspaces, workspaceId, root, caches } = await provisionUsedWorkspace(2);
    caches.forEach((cache) => rmSync(cache, { recursive: true }));

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId, discardChanges: true }),
    );

    expect(report.status).toBe("deleted");
    expect(existsSync(root)).toBe(false);
    expect(report.warnings).toHaveLength(2);
    expect(report.warnings![0]).toMatch(
      /repository of the checkout at .*repo-0.* could not be found/,
    );
  });

  it("refuses when changes are not discarded, and keeps the folder", async () => {
    const { workspaces, workspaceId, root, caches } = await provisionUsedWorkspace(1);
    caches.forEach((cache) => rmSync(cache, { recursive: true }));

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId }),
    );

    expect(report.status).toBe("failed");
    expect(existsSync(root)).toBe(true);
  });
});

describe("removing a workspace whose repository cannot be determined", () => {
  it("refuses even when changes are discarded, because the repository may still exist", async () => {
    const { storageDir, workspaces, workspaceId, root } = await provisionUsedWorkspace(1);
    // An older registry entry has no recorded repository path, so Git must say
    // where it is, and a broken checkout cannot.
    const registryPath = join(storageDir, "workspaces.json");
    const registry = JSON.parse(readFileSync(registryPath, "utf8")) as {
      workspaces: Array<{ checkouts: Array<Record<string, unknown>> }>;
    };
    for (const workspace of registry.workspaces)
      for (const checkout of workspace.checkouts) {
        delete checkout["commonDirectory"];
        delete checkout["commonDirectoryIdentity"];
      }
    writeFileSync(registryPath, JSON.stringify(registry));
    writeFileSync(join(root, ".git"), "gitdir: /nonexistent\n");

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId, discardChanges: true }),
    );

    expect(report.status).toBe("failed");
    expect(report.message).toMatch(/repository is unavailable/);
    expect(existsSync(join(root, "node_modules"))).toBe(true);
  });
});

describe("removing a workspace whose repository refuses", () => {
  it("keeps the folder and says why, even when changes are discarded", async () => {
    const { workspaces, workspaceId, root, checkoutDirs, caches } = await provisionUsedWorkspace(1);
    runGitOrThrow(caches[0]!, "worktree", "lock", checkoutDirs[0]!);

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId, discardChanges: true }),
    );

    expect(report.status).toBe("failed");
    expect(report.message).toMatch(/locked/);
    expect(existsSync(join(root, "node_modules"))).toBe(true);
    expect(runGitOrThrow(caches[0]!, "worktree", "list")).toContain(checkoutDirs[0]!);
  });
});

describe("deleting the harness files of archived sessions", () => {
  const sessions: ReadonlyArray<ArchivedSession> = [
    { harnessId: "claude-code", harnessHome: "providers/account-1", nativeSessionId: "native-1" },
    { harnessId: "claude-code", harnessHome: "providers/account-1", nativeSessionId: "native-2" },
    { harnessId: "codex", harnessHome: "providers/account-2", nativeSessionId: "native-3" },
  ];

  /** A delete function that records its calls and refuses every Claude Code session. */
  const makeRecordingDelete = () => {
    const calls: Array<ArchivedSession> = [];
    const deleteSessionFiles = (session: ArchivedSession) =>
      Effect.suspend(() => {
        calls.push(session);
        return session.harnessId === "claude-code"
          ? Effect.fail({ harnessName: "Claude Code", reason: "permission denied" })
          : Effect.void;
      });
    return { calls, deleteSessionFiles };
  };

  it("deletes each session's files after the workspace, and reports one warning per harness that kept some", async () => {
    const { calls, deleteSessionFiles } = makeRecordingDelete();
    const { workspaces, workspaceId, root } = await provisionUsedWorkspace(1, deleteSessionFiles);

    const report = await Effect.runPromise(
      workspaces.dispose({
        _tag: "workspaceDispose",
        workspaceId,
        discardChanges: true,
        archivedSessions: sessions,
      }),
    );

    expect(report.status).toBe("deleted");
    expect(existsSync(root)).toBe(false);
    expect(calls).toEqual(sessions);
    expect(report.warnings).toEqual([
      "Claude Code kept the files of 2 sessions: permission denied",
    ]);
  });

  it("deletes no session files when the workspace is not removed", async () => {
    const { calls, deleteSessionFiles } = makeRecordingDelete();
    const { workspaces, workspaceId, root } = await provisionUsedWorkspace(1, deleteSessionFiles);

    const report = await Effect.runPromise(
      workspaces.dispose({ _tag: "workspaceDispose", workspaceId, archivedSessions: sessions }),
    );

    expect(report.status).toBe("failed");
    expect(existsSync(root)).toBe(true);
    expect(calls).toEqual([]);
  });

  it("replays the same report without deleting anything again", async () => {
    const { calls, deleteSessionFiles } = makeRecordingDelete();
    const { workspaces, workspaceId } = await provisionUsedWorkspace(1, deleteSessionFiles);
    const frame = {
      _tag: "workspaceDispose",
      workspaceId,
      requestId: createId(),
      discardChanges: true,
      archivedSessions: sessions,
    } as const;
    const first = await Effect.runPromise(workspaces.dispose(frame));

    const replay = await Effect.runPromise(workspaces.dispose(frame));

    expect(replay).toEqual(first);
    expect(replay.warnings).toHaveLength(1);
    expect(calls).toHaveLength(sessions.length);
  });

  it("treats a request id that comes back with the list as the same request", async () => {
    const { calls, deleteSessionFiles } = makeRecordingDelete();
    const { workspaces, workspaceId } = await provisionUsedWorkspace(1, deleteSessionFiles);
    const frame = {
      _tag: "workspaceDispose",
      workspaceId,
      requestId: createId(),
      discardChanges: true,
    } as const;
    // An older runner removed the workspace from a frame that had no list.
    const first = await Effect.runPromise(workspaces.dispose(frame));

    const resent = await Effect.runPromise(
      workspaces.dispose({ ...frame, archivedSessions: sessions }),
    );

    expect(resent).toEqual(first);
    expect(calls).toEqual([]);
  });

  it("refuses a request id that comes back with another discard choice", async () => {
    const { workspaces, workspaceId } = await provisionUsedWorkspace(1);
    const frame = { _tag: "workspaceDispose", workspaceId, requestId: createId() } as const;
    await Effect.runPromise(workspaces.dispose(frame));

    const changed = await Effect.runPromise(workspaces.dispose({ ...frame, discardChanges: true }));

    expect(changed.status).toBe("failed");
    expect(changed.message).toMatch(/different removal instruction/);
  });
});
