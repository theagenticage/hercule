/**
 * Workspaces over the real API and the real runner socket: what provisioning a
 * primary writes and what it tells the machine, what the machine's report does
 * to it, what a listing says about it, and how one is torn down or lost.
 *
 * The frames are read off the wire as the objects they
 * are on it, by the field names the SPEC gives them, so a controller that sends
 * a differently shaped `workspaceProvision` fails here rather than on a machine.
 */
import { describe, expect, it } from "vitest";
import { del, get, post, send } from "../http/testing";
import { spawned, until, type Arranged, type Wire } from "../sessions/testing";
import {
  codeOf,
  framesTagged,
  provisioned,
  readWorkspace,
  repo,
  withFleet as withWorkspaces,
  type CheckoutRecord,
  type Frame,
  type WorkspaceRecord,
} from "./testing";

const frameWhen = (wire: Wire, tag: string, index = 0): Promise<Frame> =>
  until(`sent ${String(index + 1)} ${tag} frames`, () => framesTagged(wire, tag)[index]);

const provision = (arranged: Arranged, body: unknown): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/workspaces", body, arranged.token);

const workspaceWhen = (
  arranged: Arranged,
  id: string,
  ready: (record: WorkspaceRecord) => boolean,
): Promise<WorkspaceRecord> =>
  until("moved the workspace", async () => {
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

const checkoutIdOf = (checkout: CheckoutRecord): string => {
  const id = checkout.checkoutId ?? checkout.id;
  expect(id, "the checkout has no id").toBeTruthy();
  return String(id);
};

/** Ends a thread, which is what frees the workspace it was living in. */
const stopSession = async (arranged: Arranged, id: string): Promise<void> => {
  const response = await send("POST", arranged.harness.base, `/api/v1/sessions/${id}/stop`, {
    token: arranged.token,
  });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** An id of the right shape that nothing was ever created under. */
const ABSENT = "0198e4b0-0000-7000-8000-0000000000ff";

describe("workspace.provision", () => {
  it("writes a provisioning primary with one clone checkout and tells the machine to make it", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");

      const workspace = await provisioned(arranged, {
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

      const frame = await frameWhen(arranged.wire, "workspaceProvision");
      expect(frame["workspaceId"]).toBe(workspace.id);
      expect(frame["kind"]).toBe("primary");
      const checkouts = frame["checkouts"] as ReadonlyArray<Record<string, unknown>>;
      expect(checkouts).toHaveLength(1);
      expect(checkouts[0]).toMatchObject({
        checkoutId: checkoutIdOf(workspace.checkouts[0]!),
        resourceId: web,
        remote: "https://github.com/acme/web",
      });
      // Nothing was asked to be adopted, so no path rides the frame.
      expect(checkouts[0]?.["path"] ?? null).toBeNull();
    });
  });

  it("forwards an adopt-in-place path to the machine", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
        path: "/Users/rogier/code/web",
      });

      const frame = await frameWhen(arranged.wire, "workspaceProvision");
      const checkouts = frame["checkouts"] as ReadonlyArray<Record<string, unknown>>;
      expect(checkouts[0]?.["path"]).toBe("/Users/rogier/code/web");
      expect(workspace.status).toBe("provisioning");
    });
  });

  it("refuses a second primary of the same repo on the same machine", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      await provisioned(arranged, { resourceId: web, runnerId: arranged.runnerId });

      const again = await provision(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(await codeOf(again)).toBe("conflict");
      expect(await queryWorkspaces(arranged)).toHaveLength(1);
    });
  });

  it("refuses a folder or a mailbox, and a machine it does not know", async () => {
    await withWorkspaces(async (arranged) => {
      const folder = await post(
        arranged.harness.base,
        "/api/v1/resources",
        { kind: "folder", label: "Notes" },
        arranged.token,
      );
      expect([200, 201], await folder.clone().text()).toContain(folder.status);
      const folderId = ((await folder.json()) as { id: string }).id;

      const refused = await provision(arranged, {
        resourceId: folderId,
        runnerId: arranged.runnerId,
      });
      expect(await codeOf(refused)).toBe("invalid_state");

      const web = await repo(arranged, "https://github.com/acme/web");
      const nowhere = await provision(arranged, { resourceId: web, runnerId: ABSENT });
      expect(await codeOf(nowhere)).toBe("not_found");

      expect(await queryWorkspaces(arranged)).toEqual([]);
    });
  });
});

describe("a primary the machine could not make", () => {
  it("is stood down and replaced by the next provision, rather than standing in its way", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const first = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await frameWhen(arranged.wire, "workspaceProvision");
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: first.id,
        status: "failed",
        message: "fatal: could not read from remote repository",
      } as never);
      await workspaceWhen(arranged, first.id, (one) => one.status === "failed");

      const second = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(second.id).not.toBe(first.id);
      expect(second.status).toBe("provisioning");
      await frameWhen(arranged.wire, "workspaceProvision", 1);

      // The one that failed is kept as the record of an attempt, not as a
      // workspace: it is gone, and it no longer holds the repo's place.
      const stood = await readWorkspace(arranged, first.id);
      expect(stood.status).toBe("deleted");
      expect(stood.disposedAt).not.toBeNull();
      expect(stood.message).toBe("fatal: could not read from remote repository");
    });
  });
});

describe("the machine's report", () => {
  it("changes nothing when it says a workspace failed that has already come up", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await spawned(arranged, {
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
      await workspaceWhen(arranged, workspaceId, (one) => one.status === "ready");

      // A report that arrives late, or twice, is about a workspace that has
      // moved on: it must not take the sessions living in it down with it.
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "failed",
        message: "fatal: could not read from remote repository",
      } as never);
      await until("dispatched the session", async () => {
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
      const web = await repo(arranged, "https://github.com/acme/web");
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      const checkoutId = checkoutIdOf(workspace.checkouts[0]!);
      await frameWhen(arranged.wire, "workspaceProvision");

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

      const ready = await workspaceWhen(arranged, workspace.id, (one) => one.status === "ready");
      expect(ready.provisionedAt).not.toBeNull();
      expect(ready.checkouts[0]).toMatchObject({
        branch: "feature/x",
        branches: ["main", "feature/x"],
        defaultBranch: "main",
      });
    });
  });

  it("keeps the message a failed report carried", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      await frameWhen(arranged.wire, "workspaceProvision");

      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: workspace.id,
        status: "failed",
        message: "/Users/rogier/code/web is not a git repository",
      } as never);

      const failed = await workspaceWhen(arranged, workspace.id, (one) => one.status === "failed");
      expect(failed.message).toBe("/Users/rogier/code/web is not a git repository");
    });
  });
});

describe("workspace.query and workspace.read", () => {
  it("answers with what a workspace holds, and filters by machine, repo, project, kind and status", async () => {
    await withWorkspaces(async (arranged) => {
      const hydra = await post(
        arranged.harness.base,
        "/api/v1/projects",
        { name: "Hydra" },
        arranged.token,
      );
      expect([200, 201], await hydra.clone().text()).toContain(hydra.status);
      const projectId = ((await hydra.json()) as { id: string }).id;

      const created = await post(
        arranged.harness.base,
        "/api/v1/resources",
        { kind: "repo", remote: "https://github.com/acme/web", projectIds: [projectId] },
        arranged.token,
      );
      expect([200, 201], await created.clone().text()).toContain(created.status);
      const web = ((await created.json()) as { id: string }).id;
      const api = await repo(arranged, "https://github.com/acme/api");

      const primary = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      const other = await provisioned(arranged, {
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
      expect("lastUsedAt" in read, "the record says nothing about last use").toBe(true);

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

  it("names the sessions in a workspace that have not exited", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await spawned(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = session.workspaceId;
      expect(workspaceId, "the session got no workspace").toBeTruthy();

      const held = await workspaceWhen(
        arranged,
        String(workspaceId),
        (one) => one.sessionIds.length > 0,
      );
      expect(held.sessionIds).toEqual([session.id]);
    });
  });
});

describe("a machine that was not connected", () => {
  it("is told about the workspace it owes as soon as it dials in again", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      arranged.wire.close();
      await until("saw the machine go", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/runners/${arranged.runnerId}`,
          arranged.token,
        );
        const runner = (await response.json()) as { connectivity: string };
        return runner.connectivity === "online" ? undefined : runner;
      });

      // A folder to adopt is the one thing the controller never stores, so it
      // cannot be re-sent later; asking for one is refused while the machine
      // is away rather than turning into a clone behind the user's back.
      const adopt = await provision(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
        path: "/Users/rogier/code/web",
      });
      expect(await codeOf(adopt)).toBe("invalid_state");
      expect(await queryWorkspaces(arranged)).toEqual([]);

      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      expect(workspace.status).toBe("provisioning");

      const again = await arranged.reconnect();
      const frame = await frameWhen(again, "workspaceProvision");
      expect(frame["workspaceId"]).toBe(workspace.id);
      expect(frame["kind"]).toBe("primary");
    });
  });
});

describe("an adopt the machine never heard", () => {
  it("fails the workspace rather than waiting for a frame that is never re-sent", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      // A machine the fleet reads as online but holds no connection to: the
      // controller was told it went only after the frame was written.
      const stale = await arranged.harness.insertRunner({ name: "vega", connectivity: "online" });

      const workspace = await provisioned(arranged, {
        resourceId: web,
        runnerId: stale.id,
        path: "/Users/rogier/code/web",
      });

      expect(workspace.status).toBe("failed");
      expect(workspace.message).toContain("adopt the folder");
      // Nothing re-sends an adopt, so the row says so now rather than sitting
      // in `provisioning` waiting for a machine that was never told.
      expect((await readWorkspace(arranged, workspace.id)).status).toBe("failed");
    });
  });
});

describe("workspace.dispose", () => {
  it("tells the machine to tear an ephemeral down and marks it deleted", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await spawned(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);
      // A workspace somebody is working in is not torn down under them, so the
      // thread that asked for it ends before it is disposed of.
      await stopSession(arranged, session.id);

      const response = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        arranged.token,
      );
      expect([200, 204], await response.clone().text()).toContain(response.status);

      const frame = await frameWhen(arranged.wire, "workspaceDispose");
      expect(frame["workspaceId"]).toBe(workspaceId);

      const gone = await readWorkspace(arranged, workspaceId);
      expect(gone.status).toBe("deleted");
      expect(gone.disposedAt).not.toBeNull();

      // A second dispose has nothing left to do and says so.
      const again = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        arranged.token,
      );
      expect(await codeOf(again)).toBe("invalid_state");
    });
  });

  it("refuses while a session is still living in it, naming how many", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const session = await spawned(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId: web }] },
      });
      const workspaceId = String(session.workspaceId);
      await workspaceWhen(arranged, workspaceId, (one) => one.sessionIds.length > 0);

      const refused = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        arranged.token,
      );
      const said = await refused.clone().text();
      expect(await codeOf(refused)).toBe("invalid_state");
      expect(said).toContain("1 session(s)");
      expect((await readWorkspace(arranged, workspaceId)).status).not.toBe("deleted");
      expect(framesTagged(arranged.wire, "workspaceDispose")).toEqual([]);

      // Once the thread is over, the directory is nobody's.
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
      const web = await repo(arranged, "https://github.com/acme/web");
      const primary = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });

      const refused = await del(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}`,
        arranged.token,
      );
      expect(await codeOf(refused)).toBe("invalid_state");
      expect((await readWorkspace(arranged, primary.id)).status).toBe("provisioning");
      expect(framesTagged(arranged.wire, "workspaceDispose")).toEqual([]);
    });
  });
});

describe("runner.retire", () => {
  it("loses every workspace on the machine that had not already ended", async () => {
    await withWorkspaces(async (arranged) => {
      const web = await repo(arranged, "https://github.com/acme/web");
      const api = await repo(arranged, "https://github.com/acme/api");
      const primary = await provisioned(arranged, {
        resourceId: web,
        runnerId: arranged.runnerId,
      });
      const session = await spawned(arranged, {
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

      const lost = await workspaceWhen(arranged, primary.id, (one) => one.status === "lost");
      expect(lost.status).toBe("lost");
      // The one that was already gone is left as it was.
      expect((await readWorkspace(arranged, ephemeral)).status).toBe("deleted");
    });
  });
});
