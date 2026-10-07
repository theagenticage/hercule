import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import * as Effect from "effect/Effect";
import type { RunnerDetail, Session, Workspace } from "@hercule/contract";
import type { WorkspaceDispose, WorkspaceProvision } from "@hercule/protocol";
import {
  makeTestWorkspaces,
  cleanTemporaries,
  cloneUserCheckout,
  createTemporaryDir,
  hashContents,
  makeRemote,
  runGitOrThrow,
} from "../../../runner/src/workspaces/testing";
import { get, post, send } from "../http/testing";
import {
  spawnSessionOrFail,
  waitForFrames,
  waitForRunnerGone,
  waitUntil,
  WAIT_DEADLINE_MS,
  type Arranged,
} from "../sessions/testing";
import {
  createRepo,
  listFramesTagged,
  provisionWorkspaceOrFail,
  readWorkspace,
  withFleet,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

afterAll(cleanTemporaries);

const readSession = async (arranged: Arranged, id: string): Promise<Session> => {
  const response = await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token);
  expect(response.status).toBe(200);
  return (await response.json()) as Session;
};

/** Reconnects the enrolled runner with an older build's empty capability list. */
const reconnectOlder = async (arranged: Arranged) => {
  arranged.wire.close();
  await waitForRunnerGone(arranged);
  const wire = await arranged.reconnect({ capabilities: [] });
  wire.send({ _tag: "sessionsReport", sessions: [] });
  await waitUntil("negotiated the older runner's capabilities", async () => {
    const response = await get(
      arranged.harness.base,
      `/api/v1/runners/${arranged.runnerId}`,
      arranged.token,
    );
    const runner = (await response.json()) as RunnerDetail;
    return runner.connectivity === "online" && runner.negotiatedCapabilities?.length === 0
      ? true
      : undefined;
  });
  return wire;
};

const createWorld = async (arranged: Arranged, attached = false) => {
  const remote = makeRemote();
  const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
  const resourceId = await createRepo(arranged, remoteUrl);
  const storageDir = createTemporaryDir("hercule-older-runner-home-");
  const manager = makeTestWorkspaces({
    storageDir,
    gitEnv: {
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
      GIT_CONFIG_VALUE_0: remoteUrl,
    },
  });
  const source = cloneUserCheckout(remote);
  runGitOrThrow(source, "remote", "set-url", "origin", remoteUrl);
  writeFileSync(join(source, "README.md"), "human original checkout\n");
  const response = attached
    ? await post(
        arranged.harness.base,
        "/api/v1/workspaces/attach",
        {
          resourceId,
          runnerId: arranged.runnerId,
          path: source,
        },
        arranged.token,
      )
    : undefined;
  if (response) expect([200, 201], await response.clone().text()).toContain(response.status);
  const workspace = response
    ? ((await response.json()) as Workspace)
    : await provisionWorkspaceOrFail(arranged, { resourceId, runnerId: arranged.runnerId });
  const frames = await waitForFrames<WorkspaceProvision>(arranged.wire, "workspaceProvision", 1);
  const report = await Effect.runPromise(manager.provision(frames[0]!));
  expect(report.status, report.message).toBe("ready");
  arranged.wire.send(report);
  await waitUntil("prepared real files on the supported runner", async () =>
    (await readWorkspace(arranged, workspace.id)).status === "ready" ? true : undefined,
  );
  return {
    resourceId,
    remoteUrl,
    source,
    manager,
    workspace,
    root: Effect.runSync(manager.resolve(workspace.id))!.cwd,
  };
};

const unsupported = /unsupported|capability|upgrade|support/i;

describe("workspace operations with an older connected runner", () => {
  it.each(["attach", "inspect", "ordinary", "force", "detach"] as const)(
    "refuses %s visibly without sending an unsafe frame or changing files",
    async (operation) => {
      await withFleet(async (arranged) => {
        const world = await createWorld(arranged, operation === "detach");
        const before = { root: hashContents(world.root), source: hashContents(world.source) };
        const older = await reconnectOlder(arranged);
        const response =
          operation === "attach"
            ? await post(
                arranged.harness.base,
                "/api/v1/workspaces/attach",
                { resourceId: world.resourceId, runnerId: arranged.runnerId, path: world.source },
                arranged.token,
              )
            : operation === "inspect" || operation === "detach"
              ? await post(
                  arranged.harness.base,
                  `/api/v1/workspaces/${world.workspace.id}/${operation}`,
                  {},
                  arranged.token,
                )
              : await send(
                  "DELETE",
                  arranged.harness.base,
                  `/api/v1/workspaces/${world.workspace.id}`,
                  {
                    token: arranged.token,
                    ...(operation === "force" ? { body: { discardChanges: true } } : {}),
                  },
                );
        expect([400, 409], await response.clone().text()).toContain(response.status);
        expect(await response.text()).toMatch(unsupported);
        expect((await readWorkspace(arranged, world.workspace.id)).status).toBe("ready");
        for (const tag of [
          "workspaceProvision",
          "workspaceInspect",
          "workspaceDispose",
          "workspaceDetach",
          "sessionStart",
        ])
          expect(listFramesTagged(older, tag)).toHaveLength(0);
        expect(hashContents(world.root)).toBe(before.root);
        expect(hashContents(world.source)).toBe(before.source);
      });
    },
  );

  it.each([
    { kind: "current" },
    { kind: "local", branch: "main" },
    { kind: "remote", branch: "main" },
  ])(
    "refuses a spawn with explicit %j before admitting work or sending fallback instructions",
    async (startingRevision) => {
      await withFleet(async (arranged) => {
        const world = await createWorld(arranged);
        const before = hashContents(world.root);
        const older = await reconnectOlder(arranged);
        const response = await post(
          arranged.harness.base,
          "/api/v1/sessions",
          {
            prompt: "Use exactly the requested revision",
            runnerId: arranged.runnerId,
            workspace: {
              kind: "ephemeral",
              checkouts: [{ resourceId: world.resourceId, startingRevision }],
            },
          },
          arranged.token,
        );
        expect([400, 409], await response.clone().text()).toContain(response.status);
        expect(await response.text()).toMatch(unsupported);
        expect(listFramesTagged(older, "workspaceProvision")).toHaveLength(0);
        expect(listFramesTagged(older, "sessionStart")).toHaveLength(0);
        const listed = await get(
          arranged.harness.base,
          `/api/v1/workspaces?resourceId=${world.resourceId}`,
          arranged.token,
        );
        expect(
          ((await listed.json()) as { items: Workspace[] }).items.map((workspace) => workspace.id),
        ).toEqual([world.workspace.id]);
        expect(hashContents(world.root)).toBe(before);
      });
    },
  );
});

describe("persisted work owed to a runner that reconnects without lifecycle support", () => {
  it.each([
    { kind: "current" },
    { kind: "local", branch: "main" },
    { kind: "remote", branch: "main" },
  ])(
    "fails a queued %j session visibly without a downgraded provision or start",
    async (startingRevision) => {
      await withFleet(async (arranged) => {
        const resourceId = await createRepo(
          arranged,
          `https://fixture.invalid/acme/${crypto.randomUUID()}`,
        );
        const session = await spawnSessionOrFail(arranged, {
          prompt: "Pending exact revision",
          runnerId: arranged.runnerId,
          workspace: { kind: "ephemeral", checkouts: [{ resourceId, startingRevision }] },
        });
        await waitForFrames<WorkspaceProvision>(arranged.wire, "workspaceProvision", 1);
        expect((await readSession(arranged, session.id)).status).toBe("queued");
        const older = await reconnectOlder(arranged);
        await waitUntil("settled the unsupported queued session", async () =>
          (await readSession(arranged, session.id)).status === "exited" ? true : undefined,
        );
        const workspace = await readWorkspace(arranged, session.workspaceId!);
        expect(workspace.status).toBe("failed");
        expect(workspace.message).toMatch(unsupported);
        expect(listFramesTagged(older, "workspaceProvision")).toHaveLength(0);
        expect(listFramesTagged(older, "sessionStart")).toHaveLength(0);
      });
    },
  );

  it.each([false, true])(
    "restores a refused persisted removal with discardChanges=%s without false deletion or sending it to the old runner",
    async (discardChanges) => {
      await withFleet(async (arranged) => {
        const world = await createWorld(arranged);
        const before = hashContents(world.root);
        const removal = await send(
          "DELETE",
          arranged.harness.base,
          `/api/v1/workspaces/${world.workspace.id}`,
          { token: arranged.token, body: { discardChanges } },
        );
        expect(removal.status).toBe(200);
        const [frame] = await waitForFrames<WorkspaceDispose>(arranged.wire, "workspaceDispose", 1);
        expect(frame?.requestId).toBeTruthy();
        expect((await readWorkspace(arranged, world.workspace.id)).status).toBe("disposing");
        const older = await reconnectOlder(arranged);
        await waitUntil("settled unsupported removal without reporting deletion", async () => {
          expect(listFramesTagged(older, "workspaceDispose")).toHaveLength(0);
          return (await readWorkspace(arranged, world.workspace.id)).status === "ready"
            ? true
            : undefined;
        });
        const retained = await readWorkspace(arranged, world.workspace.id);
        expect(retained.message).toMatch(unsupported);
        expect(listFramesTagged(older, "workspaceDispose")).toHaveLength(0);
        expect(existsSync(world.root)).toBe(true);
        expect(hashContents(world.root)).toBe(before);
        expect(readFileSync(join(world.source, "README.md"), "utf8")).toBe(
          "human original checkout\n",
        );
      });
    },
  );
});

it("fails a persisted attachment visibly on older reconnect while preserving the original checkout", async () => {
  const remote = makeRemote();
  const source = cloneUserCheckout(remote);
  const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
  runGitOrThrow(source, "remote", "set-url", "origin", remoteUrl);
  writeFileSync(join(source, "README.md"), "unfinished human attachment\n");
  const before = hashContents(source);
  await withFleet(async (arranged) => {
    const resourceId = await createRepo(arranged, remoteUrl);
    const response = await post(
      arranged.harness.base,
      "/api/v1/workspaces/attach",
      { resourceId, runnerId: arranged.runnerId, path: source },
      arranged.token,
    );
    expect(response.status, await response.clone().text()).toBe(200);
    const workspace = (await response.json()) as Workspace;
    await waitForFrames<WorkspaceProvision>(arranged.wire, "workspaceProvision", 1);
    expect((await readWorkspace(arranged, workspace.id)).status).toBe("provisioning");
    const older = await reconnectOlder(arranged);
    await waitUntil("settled unsupported persisted attachment", async () =>
      (await readWorkspace(arranged, workspace.id)).status === "failed" ? true : undefined,
    );
    expect((await readWorkspace(arranged, workspace.id)).message).toMatch(unsupported);
    expect(listFramesTagged(older, "workspaceProvision")).toHaveLength(0);
    expect(hashContents(source)).toBe(before);
  });
});

it("preserves ordinary scratch workspace placement and public reads on an older runner", async () => {
  await withFleet(async (arranged) => {
    const older = await reconnectOlder(arranged);
    const session = await spawnSessionOrFail(arranged, {
      prompt: "Legacy scratch placement",
      runnerId: arranged.runnerId,
      workspace: { kind: "ephemeral", checkouts: [] },
    });
    const [frame] = await waitForFrames<WorkspaceProvision>(older, "workspaceProvision", 1);
    expect(frame?.checkouts).toEqual([]);
    const manager = makeTestWorkspaces({
      storageDir: createTemporaryDir("hercule-old-scratch-home-"),
    });
    const report = await Effect.runPromise(manager.provision(frame!));
    expect(report.status, report.message).toBe("ready");
    older.send(report);
    await waitUntil("legacy scratch session has its ordinary start", () =>
      listFramesTagged(older, "sessionStart").find((frame) => frame["sessionId"] === session.id),
    );
    expect((await readWorkspace(arranged, session.workspaceId!)).status).toBe("ready");
    expect((await readSession(arranged, session.id)).workspaceId).toBe(session.workspaceId);
  });
});
