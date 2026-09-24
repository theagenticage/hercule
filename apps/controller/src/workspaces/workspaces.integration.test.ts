/**
 * Workspaces over the real API and the real runner socket: what provisioning a
 * primary writes and sends to the runner, how a runner's report changes it,
 * what a listing returns, and how a workspace is disposed of or lost.
 *
 * The frames are read off the wire as plain objects, by the field names the
 * spec gives them, so a controller that sends a differently shaped
 * `workspaceProvision` fails here rather than on a runner.
 */
import { describe, expect, it } from "vitest";
import { del, get, post, send } from "../http/testing";
import { spawnSessionOrFail, waitUntil, type Arranged, type Wire } from "../sessions/testing";
import {
  readErrorCode,
  listFramesTagged,
  provisionWorkspaceOrFail,
  readWorkspace,
  createRepo,
  withFleet as withWorkspaces,
  type CheckoutRecord,
  type Frame,
  type WorkspaceRecord,
} from "./testing";

const waitForFrameTagged = (wire: Wire, tag: string, index = 0): Promise<Frame> =>
  waitUntil(`sent ${String(index + 1)} ${tag} frames`, () => listFramesTagged(wire, tag)[index]);

const provisionWorkspace = (arranged: Arranged, body: unknown): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/workspaces", body, arranged.token);

const waitForWorkspace = (
  arranged: Arranged,
  id: string,
  ready: (record: WorkspaceRecord) => boolean,
): Promise<WorkspaceRecord> =>
  waitUntil("moved the workspace", async () => {
    const record = await readWorkspace(arranged, id);
    return ready(record) ? record : undefined;
  });

const queryWorkspaces = async (
  arranged: Arranged,
  search = "",
): Promise<ReadonlyArray<WorkspaceRecord>> => {
  const response = await get(arranged.harness.base, `/api/v1/workspaces${search}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<WorkspaceRecord> }).items;
};

const readCheckoutId = (checkout: CheckoutRecord): string => {
  const id = checkout.checkoutId ?? checkout.id;
  expect(id, "the checkout has no id").toBeTruthy();
  return String(id);
};

/** Stops a thread, which frees the workspace it was running in. */
const stopSession = async (arranged: Arranged, id: string): Promise<void> => {
  const response = await send("POST", arranged.harness.base, `/api/v1/sessions/${id}/stop`, {
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** A valid id that no record was ever created with. */
const ABSENT = "0198e4b0-0000-7000-8000-0000000000ff";

describe("workspace.provision", () => {
  it("writes a provisioning primary with one clone checkout, and sends the runner a provision frame", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");

      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(workspace.kind).toBe("primary");
      expect(workspace.status).toBe("provisioning");
      expect(workspace.runnerId).toBe(arranged.runnerId);
      expect(workspace.checkouts).toHaveLength(1);
      expect(workspace.checkouts[0]).toMatchObject({
        resourceId: web,
        form: "clone",
        subdirectory: null,
        branch: null,
      });

      const frame = await waitForFrameTagged(arranged.wire, "workspaceProvision");
      expect(frame["workspaceId"]).toBe(workspace.id);
      expect(frame["kind"]).toBe("primary");
      const checkouts = frame["checkouts"] as ReadonlyArray<Record<string, unknown>>;
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]).toMatchObject({
        checkoutId: readCheckoutId(workspace.checkouts[0]!),
        resourceId: web,
        remote: "https://github.com/acme/web",
      });
      // No path is sent at all. The runner decides where the clone goes.
      expect(checkouts[0]?.["path"] ?? null).toBeNull();
    });
  });

  // Adopting an existing folder is not supported, so the request has no path
  // field, and a request with one is rejected rather than silently ignored.
  it("rejects a path, because a main workspace is always Hercule's own clone", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const refused = await provisionWorkspace(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
        path: "/Users/rogier/code/web",
      });
      expect(await readErrorCode(refused)).toBe("validation");
    });
  });

  it("rejects a second primary of the same repo on the same runner", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      await provisionWorkspaceOrFail(arranged, { resourceId: web, runnerId: arranged.runnerId });

      const again = await provisionWorkspace(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(await readErrorCode(again)).toBe("conflict");
      expect(await queryWorkspaces(arranged)).toHaveLength(1);
    });
  });

  it("rejects a resource that is not a repo, and an unknown runner", async () => {
    await withWorkspaces(async (arranged) => {
      const folder = await post(
        arranged.harness.base,
        "/api/v1/resources",
        { kind: "folder", label: "Notes" },
        arranged.token,
      );
      expect([200, 201], await folder.clone().text()).toContain(folder.status);
      const folderId = ((await folder.json()) as { id: string }).id;

      const refused = await provisionWorkspace(arranged, {
        resourceId: folderId,
        runnerId: arranged.runnerId,
      });
      expect(await readErrorCode(refused)).toBe("invalid_state");

      const web = await createRepo(arranged, "https://github.com/acme/web");
      const nowhere = await provisionWorkspace(arranged, { resourceId: web, runnerId: ABSENT });
      expect(await readErrorCode(nowhere)).toBe("not_found");

      expect(await queryWorkspaces(arranged)).toEqual([]);
    });
  });
});

describe("a primary the runner failed to provision", () => {
  it("is marked deleted and replaced by the next provision, rather than blocking it", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const first = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await waitForFrameTagged(arranged.wire, "workspaceProvision");
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: first.id,
        status: "failed",
        message: "fatal: could not read from remote repository",
      } as never);
      await waitForWorkspace(arranged, first.id, (one) => one.status === "failed");

      const second = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("provisioning");
      await waitForFrameTagged(arranged.wire, "workspaceProvision", 1);

      // The failed primary is kept as a record of the attempt, not as a
      // workspace: it is deleted, and no longer blocks a new primary.
      const stood = await readWorkspace(arranged, first.id);
      expect(stood.status).toBe("deleted");
      expect(stood.disposedAt).not.toBeNull();
      expect(stood.message).toBe("fatal: could not read from remote repository");
    });
  });
});

describe("the runner's workspace report", () => {
  /**
   * A primary is reported again after every session that runs in it, and that
   * report is the only way to learn which branch the agent left the checkout
   * on. The workspace is already `ready`, so the status does not change; only
   * the checkouts do.
   */
  it("records the branches from a repeated report for a workspace that is already ready", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      const checkoutId = readCheckoutId(workspace.checkouts[0]!);
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: workspace.id,
        status: "ready",
        checkouts: [{ checkoutId, branch: "main", branches: ["main"], defaultBranch: "main" }],
      } as never);
      await waitForWorkspace(arranged, workspace.id, (one) => one.status === "ready");

      // The report the runner sends after a session in the workspace: the
      // agent created a branch and left the checkout on it.
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: workspace.id,
        status: "ready",
        checkouts: [
          {
            checkoutId,
            branch: "feature/what-the-agent-did",
            branches: ["main", "feature/what-the-agent-did"],
            defaultBranch: "main",
          },
        ],
      } as never);

      const after = await waitForWorkspace(
        arranged,
        workspace.id,
        (one) => one.checkouts[0]?.branch === "feature/what-the-agent-did",
      );
      expect(after.status).toBe("ready");
      expect([...(after.checkouts[0]?.branches ?? [])].sort()).toEqual([
        "feature/what-the-agent-did",
        "main",
      ]);
    });
  });

  /**
   * A report about a workspace that is gone writes nothing. Its directory no
   * longer exists, so there are no branches to record, and a stale report must
   * not overwrite what an earlier report recorded.
   */
  it("writes no checkouts when it reports ready for a workspace that is deleted", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);
      const opened = (await readWorkspace(arranged, workspaceId)).checkouts[0]!;
      const checkoutId = readCheckoutId(opened);
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "deleted",
      } as never);
      await waitForWorkspace(arranged, workspaceId, (one) => one.status === "deleted");

      // A second workspace whose report is sent after the stale one. Frames
      // are handled in the order they arrive, so once the second workspace is
      // ready, the stale report has been handled.
      const next = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "ready",
        checkouts: [
          { checkoutId, branch: "hercule/run-ffffffff", branches: ["main"], defaultBranch: "main" },
        ],
      } as never);
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: next.id,
        status: "ready",
        checkouts: [],
      } as never);
      await waitForWorkspace(arranged, next.id, (one) => one.status === "ready");

      const after = await readWorkspace(arranged, workspaceId);
      expect(after.status).toBe("deleted");
      // Still the branch it was opened with, not the one in the stale report.
      expect(after.checkouts[0]?.branch).toBe(opened.branch);
      expect(after.checkouts[0]?.branches ?? []).toEqual([]);
    });
  });

  it("changes nothing when it reports failed for a workspace that is already ready", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "ready",
        checkouts: [],
      } as never);
      await waitForWorkspace(arranged, workspaceId, (one) => one.status === "ready");

      // A report that arrives late, or twice, is about a workspace whose status
      // has already changed. It must not fail the sessions running in it.
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "failed",
        message: "fatal: could not read from remote repository",
      } as never);
      await waitUntil("dispatched the session", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/sessions/${session.id}`,
          arranged.token,
        );
        const one = (await response.json()) as { status: string };
        return one.status !== "queued" ? one : undefined;
      });

      const still = await readWorkspace(arranged, workspaceId);
      expect(still.status).toBe("ready");
      expect(still.message ?? null).toBeNull();
    });
  });

  it("moves a provisioning primary to ready and stores each checkout's branches", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      const checkoutId = readCheckoutId(workspace.checkouts[0]!);
      await waitForFrameTagged(arranged.wire, "workspaceProvision");

      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: workspace.id,
        status: "ready",
        checkouts: [
          {
            checkoutId,
            branch: "feature/x",
            branches: ["main", "feature/x"],
            defaultBranch: "main",
          },
        ],
      } as never);

      const ready = await waitForWorkspace(arranged, workspace.id, (one) => one.status === "ready");
      expect(ready.provisionedAt).not.toBeNull();
      expect(ready.checkouts[0]).toMatchObject({
        branch: "feature/x",
        branches: ["main", "feature/x"],
        defaultBranch: "main",
      });
    });
  });

  it("stores the message from a failed report", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await waitForFrameTagged(arranged.wire, "workspaceProvision");

      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: workspace.id,
        status: "failed",
        message: "/Users/rogier/code/web is not a git repository",
      } as never);

      const failed = await waitForWorkspace(
        arranged,
        workspace.id,
        (one) => one.status === "failed",
      );
      expect(failed.message).toBe("/Users/rogier/code/web is not a git repository");
    });
  });
});

describe("workspace.query and workspace.read", () => {
  it("returns a workspace's checkouts and fields, and filters by runner, repo, project, kind and status", async () => {
    await withWorkspaces(async (arranged) => {
      const hercule = await post(
        arranged.harness.base,
        "/api/v1/projects",
        { name: "Hercule" },
        arranged.token,
      );
      expect([200, 201], await hercule.clone().text()).toContain(hercule.status);
      const projectId = ((await hercule.json()) as { id: string }).id;

      const created = await post(
        arranged.harness.base,
        "/api/v1/resources",
        { kind: "repo", remote: "https://github.com/acme/web", projectIds: [projectId] },
        arranged.token,
      );
      expect([200, 201], await created.clone().text()).toContain(created.status);
      const web = ((await created.json()) as { id: string }).id;
      const api = await createRepo(arranged, "https://github.com/acme/api");

      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      const other = await provisionWorkspaceOrFail(arranged, {
        resourceId: api,
        runnerId: arranged.runnerId,
      });

      const read = await readWorkspace(arranged, primary.id);
      expect(read.checkouts).toHaveLength(1);
      // No Connection on the resource, so nothing is designated.
      expect(read.designatedConnectionId).toBeNull();
      expect(read.status).toBe("provisioning");
      expect(read.disposedAt).toBeNull();
      expect(read.sessionIds).toEqual([]);
      expect("lastUsedAt" in read, "the record has no lastUsedAt field").toBe(true);

      expect((await queryWorkspaces(arranged, `?resourceId=${web}`)).map((one) => one.id)).toEqual([
        primary.id,
      ]);
      expect(
        (await queryWorkspaces(arranged, `?projectId=${projectId}`)).map((one) => one.id),
      ).toEqual([primary.id]);
      expect(
        (await queryWorkspaces(arranged, `?runnerId=${arranged.runnerId}`))
          .map((one) => one.id)
          .sort(),
      ).toEqual([primary.id, other.id].sort());
      expect((await queryWorkspaces(arranged, "?kind=ephemeral")).map((one) => one.id)).toEqual([]);
      expect(
        (await queryWorkspaces(arranged, "?status=provisioning")).map((one) => one.id).sort(),
      ).toEqual([primary.id, other.id].sort());
      expect((await queryWorkspaces(arranged, "?status=ready")).map((one) => one.id)).toEqual([]);
    });
  });

  it("lists the sessions in a workspace that have not exited", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = session.workspaceId;
      expect(workspaceId, "the session got no workspace").toBeTruthy();

      const held = await waitForWorkspace(
        arranged,
        String(workspaceId),
        (one) => one.sessionIds.length > 0,
      );
      expect(held.sessionIds).toEqual([session.id]);
    });
  });
});

describe("a runner that was not connected", () => {
  it("is sent the pending provision frame as soon as it reconnects", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      arranged.wire.close();
      await waitUntil("saw the runner go offline", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as { connectivity: string };
        return runner.connectivity === "online" ? undefined : runner;
      });

      // The rows hold everything needed to rebuild the frame, so it can be sent
      // again later. Provisioning while the runner is offline is accepted and
      // sent on reconnect, rather than rejected.
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(workspace.status).toBe("provisioning");

      const again = await arranged.reconnect();
      const frame = await waitForFrameTagged(again, "workspaceProvision");
      expect(frame["workspaceId"]).toBe(workspace.id);
      expect(frame["kind"]).toBe("primary");
    });
  });
});

describe("workspace.dispose", () => {
  it("sends the runner a dispose frame for an ephemeral workspace, and marks it deleted", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);
      // A workspace with a running session cannot be disposed of, so the
      // thread that asked for it is stopped first.
      await stopSession(arranged, session.id);

      const response = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        arranged.token,
      );
      expect([200, 204], await response.clone().text()).toContain(response.status);

      const frame = await waitForFrameTagged(arranged.wire, "workspaceDispose");
      expect(frame["workspaceId"]).toBe(workspaceId);

      const gone = await readWorkspace(arranged, workspaceId);
      expect(gone.status).toBe("deleted");
      expect(gone.disposedAt).not.toBeNull();

      // A second dispose has nothing left to do, and fails with invalid_state.
      const again = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        arranged.token,
      );
      expect(await readErrorCode(again)).toBe("invalid_state");
    });
  });

  it("fails while a session is still running in it, and gives the number of sessions", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);
      await waitForWorkspace(arranged, workspaceId, (one) => one.sessionIds.length > 0);

      const refused = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        arranged.token,
      );
      const said = await refused.clone().text();
      expect(await readErrorCode(refused)).toBe("invalid_state");
      expect(said).toContain("1 session(s)");
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(listFramesTagged(arranged.wire, "workspaceDispose")).toEqual([]);

      // Once the thread is stopped, nothing uses the directory any more.
      const stopped = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/sessions/${session.id}/stop`,
        { token: arranged.token },
      );
      expect(stopped.status, await stopped.clone().text()).toBe(200);
      const gone = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        arranged.token,
      );
      expect([200, 204], await gone.clone().text()).toContain(gone.status);
    });
  });

  it("never tears a primary down", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const refused = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}`,
        arranged.token,
      );
      expect(await readErrorCode(refused)).toBe("invalid_state");
      expect((await readWorkspace(arranged, primary.id)).status).toBe("provisioning");
      expect(listFramesTagged(arranged.wire, "workspaceDispose")).toEqual([]);
    });
  });
});

describe("runner.retire", () => {
  it("marks every workspace on the runner as lost, except one already deleted", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await createRepo(arranged, "https://github.com/acme/web");
      const api = await createRepo(arranged, "https://github.com/acme/api");
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: api }] },
      });
      const ephemeral = String(session.workspaceId);
      await stopSession(arranged, session.id);
      const disposed = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${ephemeral}`,
        arranged.token,
      );
      expect([200, 204], await disposed.clone().text()).toContain(disposed.status);

      const retired = await send(
        "POST",
        arranged.harness.base,
        `/api/v1/runners/${arranged.runnerId}/retire`,
        { body: {}, token: arranged.token },
      );
      expect(retired.status, await retired.clone().text()).toBe(200);

      const lost = await waitForWorkspace(arranged, primary.id, (one) => one.status === "lost");
      expect(lost.status).toBe("lost");
      // The workspace that was already deleted stays deleted.
      expect((await readWorkspace(arranged, ephemeral)).status).toBe("deleted");
    });
  });
});
