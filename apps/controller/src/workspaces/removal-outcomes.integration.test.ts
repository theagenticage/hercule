import { expect, it } from "vitest";
import type { WorkspaceDispose } from "@hercule/protocol";
import { post, send } from "../http/testing";
import { spawnSessionOrFail, waitForFrames, waitUntil } from "../sessions/testing";
import { endResumable, readWorkspace, spawnThread, withFleet } from "./testing";

it("settles only the current removal instruction and preserves disposing across fresh observations", async () => {
  await withFleet(async (arranged) => {
    const session = await spawnThread(arranged, { kind: "ephemeral", checkouts: [] }, 1);
    const workspaceId = session.workspaceId!;
    await endResumable(arranged, session);
    const barrier = await spawnSessionOrFail(arranged, {
      prompt: "Observe another workspace to fence the runner report queue",
      workspace: { kind: "ephemeral", checkouts: [] },
    });
    const finishReports = async (): Promise<void> => {
      const observedAt = new Date().toISOString();
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: barrier.workspaceId!,
        status: "ready",
        available: true,
        observedAt,
      });
      await waitUntil("handled the preceding reports in the fleet queue", async () => {
        const workspace = await readWorkspace(arranged, barrier.workspaceId!);
        return workspace.observedAt === observedAt ? true : undefined;
      });
    };
    const askRemoval = async (discardChanges: boolean): Promise<WorkspaceDispose> => {
      const response = await send(
        "DELETE",
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}`,
        {
          body: { discardChanges },
          token: arranged.token,
        },
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const frames = await waitForFrames<WorkspaceDispose>(
        arranged.wire,
        "workspaceDispose",
        discardChanges ? 2 : 1,
      );
      return frames.at(-1)!;
    };
    const ordinary = await askRemoval(false);
    expect(ordinary.requestId).toBeTruthy();
    const changedIntent = await send(
      "DELETE",
      arranged.harness.base,
      `/api/v1/workspaces/${workspaceId}`,
      {
        body: { discardChanges: true },
        token: arranged.token,
      },
    );
    expect(changedIntent.status, await changedIntent.clone().text()).toBe(409);
    for (const status of ["ready", "failed", "deleted"] as const) {
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status,
        available: true,
        observedAt: new Date().toISOString(),
        ...(status === "deleted" ? { requestId: "unrelated-removal" } : {}),
      });
    }
    await finishReports();
    expect((await readWorkspace(arranged, workspaceId)).status).toBe("disposing");
    arranged.wire.send({
      _tag: "workspaceReport",
      workspaceId,
      status: "failed",
      available: true,
      observedAt: new Date().toISOString(),
      requestId: ordinary.requestId!,
      message: "Ignored private files remain. Preserve them or choose discard changes.",
    });
    await waitUntil("restored retained working files", async () =>
      (await readWorkspace(arranged, workspaceId)).status === "ready" ? true : undefined,
    );
    for (const available of [true, false, true]) {
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: available ? "ready" : "failed",
        available,
        observedAt: new Date().toISOString(),
        ...(available
          ? {}
          : { message: "The recorded checkout is unavailable. Restore its files." }),
      });
      await finishReports();
      const observed = await readWorkspace(arranged, workspaceId);
      expect(observed.status).toBe(available ? "ready" : "failed");
      expect(observed.message).toMatch(
        available ? /ignored private files/i : /unavailable.*restore/i,
      );
      expect(observed.keptUntil).toBeNull();
    }
    const forced = await askRemoval(true);
    expect(forced.requestId).not.toBe(ordinary.requestId);
    arranged.wire.send({
      _tag: "workspaceReport",
      workspaceId,
      status: "failed",
      available: true,
      observedAt: new Date().toISOString(),
      requestId: ordinary.requestId!,
      message: "Delayed ordinary removal refusal",
    });
    await finishReports();
    expect((await readWorkspace(arranged, workspaceId)).status).toBe("disposing");
    const joined = await post(
      arranged.harness.base,
      "/api/v1/sessions",
      {
        prompt: "Join while explicit discard is reserved",
        workspace: { kind: "existing", workspaceId },
      },
      arranged.token,
    );
    expect([400, 409]).toContain(joined.status);
    arranged.wire.send({
      _tag: "workspaceReport",
      workspaceId,
      status: "deleted",
      requestId: forced.requestId!,
    });
    await waitUntil("confirmed only matching completed removal", async () =>
      (await readWorkspace(arranged, workspaceId)).status === "deleted" ? true : undefined,
    );
  });
});
