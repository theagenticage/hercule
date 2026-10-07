import { describe, expect, it } from "vitest";
import type { Session } from "@hercule/contract";
import type { WorkspaceProvision } from "@hercule/protocol";
import { get, post, send } from "../http/testing";
import {
  spawnSessionOrFail,
  waitForFrames,
  waitForRunnerGone,
  waitUntil,
} from "../sessions/testing";
import { createRepo, provisionWorkspaceOrFail, readWorkspace, withFleet } from "./testing";

describe("pending workspace preparation instructions", () => {
  it("keeps a session queued until preparation settles and preserves an interrupted reason after reconnect", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(
        arranged,
        "https://github.com/acme/interrupted-preparation",
      );
      const session = await spawnSessionOrFail(arranged, {
        prompt: "hello",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
      });
      const workspaceId = String(session.workspaceId);
      await waitForFrames<WorkspaceProvision>(arranged.wire, "workspaceProvision", 1);
      const readSession = async (): Promise<Session> =>
        (await (
          await get(arranged.harness.base, `/api/v1/sessions/${session.id}`, arranged.token)
        ).json()) as Session;
      expect((await readSession()).status).toBe("queued");

      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const reconnected = await arranged.reconnect();
      await waitForFrames<WorkspaceProvision>(reconnected, "workspaceProvision", 1);
      reconnected.send({ _tag: "sessionsReport", sessions: [] });
      expect((await readSession()).status).toBe("queued");
      expect(reconnected.frames.filter((frame) => frame._tag === "sessionStart")).toHaveLength(0);
      const message =
        "workspace preparation was interrupted during setup; create a fresh workspace";
      reconnected.send({ _tag: "workspaceReport", workspaceId, status: "failed", message });

      const failedWorkspace = await waitUntil("recorded interrupted preparation", async () => {
        const workspace = await readWorkspace(arranged, workspaceId);
        return workspace.status === "failed" ? workspace : undefined;
      });
      expect(failedWorkspace.message).toBe(message);
      const failedSession = await waitUntil("failed the waiting session", async () => {
        const current = await readSession();
        return current.status === "exited" ? current : undefined;
      });
      expect(failedSession.resumable).toBe(false);
      expect(reconnected.frames.filter((frame) => frame._tag === "sessionStart")).toHaveLength(0);
    });
  });

  it("keeps the setup and creation instructions opened before a Resource edit on reconnect", async () => {
    await withFleet(async (arranged) => {
      const created = await post(
        arranged.harness.base,
        "/api/v1/resources",
        {
          kind: "repo",
          remote: "https://github.com/acme/frozen-preparation",
          setupCommand: "echo original-setup",
          workspaceInclude: true,
        },
        arranged.token,
      );
      expect([200, 201], await created.clone().text()).toContain(created.status);
      const resource = (await created.json()) as { readonly id: string };
      const workspace = await provisionWorkspaceOrFail(arranged, {
        resourceId: resource.id,
        runnerId: arranged.runnerId,
      });
      const [original] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      expect(original!.workspaceId).toBe(workspace.id);
      expect(original!.checkouts[0]!.setupCommand).toBe("echo original-setup");

      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const changed = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/resources/${resource.id}`,
        {
          token: arranged.token,
          body: { setupCommand: "echo edited-setup", workspaceInclude: false },
        },
      );
      expect(changed.status, await changed.clone().text()).toBe(200);

      const reconnected = await arranged.reconnect();
      const [replayed] = await waitForFrames<WorkspaceProvision>(
        reconnected,
        "workspaceProvision",
        1,
      );

      expect(replayed).toEqual(original);
    });
  });
});
