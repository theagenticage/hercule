import { readFileSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Effect } from "effect";
import type { Workspace, Session } from "@hercule/contract";
import type { WorkspaceProvision, WorkspaceReport } from "@hercule/protocol";
import {
  makeTestWorkspaces,
  cleanTemporaries,
  createTemporaryDir,
  makeRemote,
  runGitOrThrow,
} from "../../../runner/src/workspaces/testing";
import { collectMessages, fetchTicket, get, onSocket, post, waitWithin } from "../http/testing";
import {
  spawnSessionOrFail,
  waitForFrames,
  waitForRunnerGone,
  waitUntil,
} from "../sessions/testing";
import { createRepo, listFramesTagged, provisionWorkspaceOrFail, withFleet } from "./testing";

afterAll(cleanTemporaries);

const readWorkspace = async (
  arranged: Parameters<Parameters<typeof withFleet>[0]>[0],
  id: string,
): Promise<Workspace> => {
  const response = await get(arranged.harness.base, `/api/v1/workspaces/${id}`, arranged.token);
  expect(response.status).toBe(200);
  return (await response.json()) as Workspace;
};
const waitReady = (
  arranged: Parameters<Parameters<typeof withFleet>[0]>[0],
  id: string,
): Promise<Workspace> =>
  waitUntil("recorded the actual runner report", async () => {
    const workspace = await readWorkspace(arranged, id);
    expect(workspace.status, workspace.message ?? "runner rejected workspace preparation").not.toBe(
      "failed",
    );
    return workspace.status === "ready" ? workspace : undefined;
  });

describe("workspace revisions through the public API and runner socket", () => {
  it("starts automation without main, then provisions main in the same runner-local Git repository", async () => {
    const remote = makeRemote();
    const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
    const manager = makeTestWorkspaces({
      storageDir: createTemporaryDir("hercule-public-workflow-first-home-"),
      gitEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
        GIT_CONFIG_VALUE_0: remoteUrl,
      },
    });
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, remoteUrl);
      const session = await spawnSessionOrFail(arranged, {
        prompt: "Start work",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
      });
      const [first] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      arranged.wire.send(await Effect.runPromise(manager.provision(first!)));
      const firstWorkspace = await waitReady(arranged, session.workspaceId!);
      const listed = await get(
        arranged.harness.base,
        `/api/v1/workspaces?resourceId=${resourceId}`,
        arranged.token,
      );
      const items = ((await listed.json()) as { items: ReadonlyArray<Workspace> }).items;
      expect(items.map((workspace) => workspace.kind)).toEqual(["ephemeral"]);
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const frames = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        2,
      );
      arranged.wire.send(await Effect.runPromise(manager.provision(frames[1]!)));
      const main = await waitReady(arranged, primary.id);
      expect(main.checkouts[0]!.form).toBe("worktree");
      expect(firstWorkspace.checkouts[0]!.form).toBe("worktree");
      const workPath = Effect.runSync(manager.resolve(first!.workspaceId))!.cwd;
      const mainPath = Effect.runSync(manager.resolve(primary.id))!.cwd;
      expect(
        runGitOrThrow(workPath, "rev-parse", "--path-format=absolute", "--git-common-dir"),
      ).toBe(runGitOrThrow(mainPath, "rev-parse", "--path-format=absolute", "--git-common-dir"));
    });
  });

  it.each([
    { kind: "current" },
    { kind: "local", branch: "release" },
    { kind: "remote", branch: "release" },
    { kind: "remote" },
  ])(
    "preserves explicit %j from public spawn to the frozen provision frame",
    async (startingRevision) => {
      await withFleet(async (arranged) => {
        const resourceId = await createRepo(
          arranged,
          "https://fixture.invalid/acme/revision-contract",
        );
        await spawnSessionOrFail(arranged, {
          prompt: "Explicit starting revision",
          workspace: { kind: "ephemeral", checkouts: [{ resourceId, startingRevision }] },
        });
        const [frame] = await waitForFrames<WorkspaceProvision>(
          arranged.wire,
          "workspaceProvision",
          1,
        );
        expect(frame!.checkouts[0]).toMatchObject({ startingRevision });
      });
    },
  );

  it.each([{ kind: "current" }, { kind: "local", branch: "local-only" }])(
    "creates a real worktree from unpushed attached state through session.spawn using %j",
    async (startingRevision) => {
      const remote = makeRemote();
      const world = createTemporaryDir("hercule-public-local-source-");
      const source = join(world, "checkout");
      runGitOrThrow(world, "clone", remote.url, source);
      runGitOrThrow(source, "checkout", "-b", "local-only");
      writeFileSync(join(source, "local.txt"), "unpushed local file\n");
      runGitOrThrow(source, "add", ".");
      runGitOrThrow(source, "commit", "-m", "Unpushed local commit");
      const localCommit = runGitOrThrow(source, "rev-parse", "HEAD");
      writeFileSync(join(source, "README.md"), "dirty tracked source\n");
      const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
      runGitOrThrow(source, "remote", "set-url", "origin", remoteUrl);
      const manager = makeTestWorkspaces({
        storageDir: createTemporaryDir("hercule-public-local-home-"),
        gitEnv: {
          GIT_CONFIG_COUNT: "1",
          GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
          GIT_CONFIG_VALUE_0: remoteUrl,
        },
      });
      await withFleet(async (arranged) => {
        const resourceId = await createRepo(arranged, remoteUrl);
        const attached = await post(
          arranged.harness.base,
          "/api/v1/workspaces/attach",
          { resourceId, runnerId: arranged.runnerId, path: source },
          arranged.token,
        );
        expect([200, 201], await attached.clone().text()).toContain(attached.status);
        const primary = (await attached.json()) as Workspace;
        const [attachmentFrame] = await waitForFrames<WorkspaceProvision>(
          arranged.wire,
          "workspaceProvision",
          1,
        );
        arranged.wire.send(await Effect.runPromise(manager.provision(attachmentFrame!)));
        await waitReady(arranged, primary.id);
        renameSync(remote.path, `${remote.path}.unavailable`);

        const session = await spawnSessionOrFail(arranged, {
          prompt: "Continue local work",
          runnerId: arranged.runnerId,
          workspace: { kind: "ephemeral", checkouts: [{ resourceId, startingRevision }] },
        });
        const frames = await waitForFrames<WorkspaceProvision>(
          arranged.wire,
          "workspaceProvision",
          2,
        );
        const generated = frames[1]!;
        arranged.wire.send(await Effect.runPromise(manager.provision(generated)));
        const workspace = await waitReady(arranged, session.workspaceId!);

        expect(workspace.checkouts[0]).toMatchObject({
          baseCommit: localCommit,
          headCommit: localCommit,
          startingRevision,
        });
        const cwd = Effect.runSync(manager.resolve(generated.workspaceId))!.cwd;
        expect(runGitOrThrow(cwd, "rev-parse", "HEAD")).toBe(localCommit);
        expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("the repository\n");
        expect(readFileSync(join(source, "README.md"), "utf8")).toBe("dirty tracked source\n");
        expect(runGitOrThrow(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir")).toBe(
          runGitOrThrow(source, "rev-parse", "--path-format=absolute", "--git-common-dir"),
        );
      });
    },
  );

  it("rejects simultaneous deprecated and explicit revisions before persisting or sending any workspace", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(
        arranged,
        "https://fixture.invalid/acme/conflicting-revision",
      );
      const response = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        {
          prompt: "Conflicting revision",
          workspace: {
            kind: "ephemeral",
            checkouts: [{ resourceId, baseBranch: "main", startingRevision: { kind: "current" } }],
          },
        },
        arranged.token,
      );
      expect(response.status).toBe(400);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(0);
      const listed = await get(
        arranged.harness.base,
        `/api/v1/workspaces?resourceId=${resourceId}`,
        arranged.token,
      );
      expect(((await listed.json()) as { items: ReadonlyArray<Workspace> }).items).toHaveLength(0);
    });
  });

  it("correlates explicit inspection with the real runner observation and persists actual branch, HEAD and time", async () => {
    const remote = makeRemote();
    const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
    const manager = makeTestWorkspaces({
      storageDir: createTemporaryDir("hercule-explicit-inspection-home-"),
      gitEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
        GIT_CONFIG_VALUE_0: remoteUrl,
      },
    });
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, remoteUrl);
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      arranged.wire.send(await Effect.runPromise(manager.provision(frame!)));
      await waitReady(arranged, primary.id);
      const cwd = Effect.runSync(manager.resolve(primary.id))!.cwd;
      const branch = "renamed-from-outside";
      runGitOrThrow(cwd, "branch", "-m", branch);
      writeFileSync(join(cwd, "inspection.txt"), "new external commit\n");
      runGitOrThrow(cwd, "add", "inspection.txt");
      runGitOrThrow(cwd, "commit", "-m", "External state to inspect");
      const head = runGitOrThrow(cwd, "rev-parse", "HEAD");
      const pending = post(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}/inspect`,
        {},
        arranged.token,
      );
      let earlyResponse: Response | undefined;
      void pending.then((response) => {
        earlyResponse = response;
      });
      const inspection = await waitUntil("sent correlated workspace inspection", () => {
        if (earlyResponse !== undefined)
          expect(earlyResponse.status, "inspection returned before asking the runner").toBe(200);
        return listFramesTagged(arranged.wire, "workspaceInspect")[0] as
          { _tag: "workspaceInspect"; requestId: string; workspaceId: string } | undefined;
      });
      expect(inspection.workspaceId).toBe(primary.id);
      const report: WorkspaceReport = await Effect.runPromise(manager.inspect(primary.id));
      arranged.wire.send({ _tag: "workspaceInspection", requestId: inspection.requestId, report });

      const response = await pending;

      expect(response.status, await response.clone().text()).toBe(200);
      const workspace = (await response.json()) as Workspace & { observedAt: string | null };
      expect(workspace.checkouts[0]).toMatchObject({ branch, headCommit: head });
      expect(workspace.observedAt).toEqual(expect.any(String));
      expect(await readWorkspace(arranged, primary.id)).toEqual(workspace);
    });
  });

  it("does not label a persisted report fresh when explicit inspection cannot reach the runner", async () => {
    const remote = makeRemote();
    const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
    const manager = makeTestWorkspaces({
      storageDir: createTemporaryDir("hercule-offline-inspection-home-"),
      gitEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
        GIT_CONFIG_VALUE_0: remoteUrl,
      },
    });
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, remoteUrl);
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      arranged.wire.send(await Effect.runPromise(manager.provision(frame!)));
      const before = await waitReady(arranged, primary.id);
      arranged.wire.close();
      await waitForRunnerGone(arranged);

      const inspected = await post(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}/inspect`,
        {},
        arranged.token,
      );

      expect(inspected.status).toBe(409);
      expect(await inspected.text()).toMatch(/offline|unavailable|connected|reachable/i);
      expect(
        (await readWorkspace(arranged, primary.id)) as Workspace & { observedAt?: string | null },
      ).toMatchObject({
        observedAt: (before as Workspace & { observedAt?: string | null }).observedAt,
      });
    });
  });

  it("publishes refreshed primary and ephemeral branch facts through the workspace live topic", async () => {
    const remote = makeRemote();
    const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
    const storageDir = createTemporaryDir("hercule-workspace-live-home-");
    const manager = makeTestWorkspaces({
      storageDir,
      gitEnv: {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
        GIT_CONFIG_VALUE_0: remoteUrl,
      },
    });
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(arranged, remoteUrl);
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const [primaryFrame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      arranged.wire.send(await Effect.runPromise(manager.provision(primaryFrame!)));
      await waitReady(arranged, primary.id);
      const session = await spawnSessionOrFail(arranged, {
        prompt: "Observe generated work",
        workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
      });
      const frames = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        2,
      );
      arranged.wire.send(await Effect.runPromise(manager.provision(frames[1]!)));
      await waitReady(arranged, session.workspaceId!);
      const ticket = await fetchTicket(arranged.harness.base, arranged.token);
      await onSocket(arranged.harness.base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const messages = yield* collectMessages(client, { topic: "workspace" });
          expect(
            yield* Effect.promise(() => waitWithin(1000, () => messages.received.length > 0)),
          ).toBe(true);
          for (const id of [primary.id, session.workspaceId!]) {
            const cwd = Effect.runSync(manager.resolve(id))!.cwd;
            const branch = `renamed-${crypto.randomUUID()}`;
            runGitOrThrow(cwd, "branch", "-m", branch);
            writeFileSync(
              join(cwd, "external-change.txt"),
              "changed while thread remains usable\n",
            );
            runGitOrThrow(cwd, "add", "external-change.txt");
            runGitOrThrow(cwd, "commit", "-m", "External update");
            const head = runGitOrThrow(cwd, "rev-parse", "HEAD");
            const observation = yield* manager.reportAfterSession(id);
            expect(observation).toBeDefined();
            arranged.wire.send(observation!);
            const updated = yield* Effect.promise(() =>
              waitUntil("recorded current branch and HEAD", async () => {
                const record = (await readWorkspace(arranged, id)) as Workspace & {
                  observedAt?: string | null;
                  checkouts: ReadonlyArray<{ branch: string | null; headCommit?: string | null }>;
                };
                return record.checkouts[0]!.branch === branch &&
                  record.checkouts[0]!.headCommit === head
                  ? record
                  : undefined;
              }),
            );
            expect(updated.observedAt).toEqual(expect.any(String));
            expect(
              yield* Effect.promise(() =>
                waitWithin(1500, () =>
                  messages.received.some(
                    (message) => message._tag === "invalidate" && message.ids.includes(id),
                  ),
                ),
              ),
            ).toBe(true);
            expect(readFileSync(join(cwd, "external-change.txt"), "utf8")).toBe(
              "changed while thread remains usable\n",
            );
          }
        }),
      );
    });
  });
  it("keeps preparation incomplete after inspection and records a later untimestamped setup failure", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(
        arranged,
        "https://fixture.invalid/acme/observed-preparation",
      );
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const observedAt = new Date().toISOString();
      const pending = post(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}/inspect`,
        {},
        arranged.token,
      );
      const inspection = await waitUntil(
        "inspection during preparation",
        () =>
          listFramesTagged(arranged.wire, "workspaceInspect")[0] as
            { requestId: string } | undefined,
      );
      arranged.wire.send({
        _tag: "workspaceInspection",
        requestId: inspection.requestId,
        report: {
          _tag: "workspaceReport",
          workspaceId: primary.id,
          status: "ready",
          observedAt,
          checkouts: [
            {
              checkoutId: frame!.checkouts[0]!.checkoutId,
              branch: "visible-before-setup",
              branches: ["visible-before-setup"],
              defaultBranch: "main",
              headCommit: "0123456789012345678901234567890123456789",
            },
          ],
        },
      });
      const response = await pending;
      expect(response.status, await response.clone().text()).toBe(200);
      expect(await response.json()).toMatchObject({
        status: "provisioning",
        observedAt,
        provisionedAt: null,
      });
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: primary.id,
        status: "failed",
        message: "Setup failed. Correct the command and create a fresh managed workspace.",
      });
      const failed = await waitUntil("untimestamped terminal failure", async () => {
        const current = await readWorkspace(arranged, primary.id);
        return current.status === "failed" ? current : undefined;
      });
      expect(failed).toMatchObject({
        status: "failed",
        observedAt,
        provisionedAt: null,
      });
      expect(failed.message).toContain("Setup failed");
      expect(failed.checkouts[0]!.branch).toBe("visible-before-setup");
    });
  });
  it("keeps newer inspection facts and immutable creation facts when an older receipt arrives", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(
        arranged,
        "https://fixture.invalid/acme/observation-order",
      );
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const oldTime = new Date(Date.now() - 1000).toISOString();
      const newTime = new Date().toISOString();
      const baseCommit = "0123456789012345678901234567890123456789";
      const checkoutId = frame!.checkouts[0]!.checkoutId;
      const preparation: WorkspaceReport = {
        _tag: "workspaceReport",
        workspaceId: primary.id,
        status: "ready",
        observedAt: oldTime,
        warnings: ["Missing include source"],
        checkouts: [
          {
            checkoutId,
            branch: "before",
            branches: ["before"],
            defaultBranch: "main",
            baseCommit,
            headCommit: baseCommit,
          },
        ],
      };
      arranged.wire.send(preparation);
      await waitReady(arranged, primary.id);
      const inspect = async (report: WorkspaceReport): Promise<Workspace> => {
        const before = listFramesTagged(arranged.wire, "workspaceInspect").length;
        const pending = post(
          arranged.harness.base,
          `/api/v1/workspaces/${primary.id}/inspect`,
          {},
          arranged.token,
        );
        const request = await waitUntil(
          "ordered inspection",
          () =>
            listFramesTagged(arranged.wire, "workspaceInspect")[before] as
              { requestId: string } | undefined,
        );
        arranged.wire.send({ _tag: "workspaceInspection", requestId: request.requestId, report });
        const response = await pending;
        expect(response.status, await response.clone().text()).toBe(200);
        return (await response.json()) as Workspace;
      };
      const { warnings: preparationWarnings, ...facts } = preparation;
      expect(preparationWarnings).toEqual(["Missing include source"]);
      const latest = await inspect({
        ...facts,
        observedAt: newTime,
        checkouts: [
          {
            checkoutId,
            branch: "after",
            branches: ["after"],
            defaultBranch: "main",
            baseCommit: "fedcba9876543210fedcba9876543210fedcba98",
            headCommit: "1111111111111111111111111111111111111111",
          },
        ],
      });
      const replayed = await inspect(preparation);
      expect(replayed).toEqual(latest);
      expect(replayed.observedAt).toBe(newTime);
      expect(replayed.warnings).toEqual(["Missing include source"]);
      expect(replayed.checkouts[0]!.baseCommit).toBe(baseCommit);
      expect(replayed.checkouts[0]!.branch).toBe("after");
    });
  });
  it("settles an older successful receipt as unavailable when a newer inspection saw missing files", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(
        arranged,
        "https://fixture.invalid/acme/stale-preparation-success",
      );
      const session = await spawnSessionOrFail(arranged, {
        prompt: "Wait for preparation",
        workspace: { kind: "primary", resourceId },
      });
      const workspaceId = session.workspaceId!;
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const preparedAt = new Date(Date.now() - 1000).toISOString();
      const baseCommit = "0123456789012345678901234567890123456789";
      const observedAt = new Date().toISOString();
      const pending = post(
        arranged.harness.base,
        `/api/v1/workspaces/${workspaceId}/inspect`,
        {},
        arranged.token,
      );
      const request = await waitUntil(
        "unavailable inspection while preparing",
        () =>
          listFramesTagged(arranged.wire, "workspaceInspect")[0] as
            { requestId: string } | undefined,
      );
      const message = "The selected checkout is missing. Restore its files and inspect again.";
      arranged.wire.send({
        _tag: "workspaceInspection",
        requestId: request.requestId,
        report: { _tag: "workspaceReport", workspaceId, status: "failed", observedAt, message },
      });
      const inspection = await pending;
      expect(inspection.status, await inspection.clone().text()).toBe(200);
      expect(await inspection.json()).toMatchObject({
        status: "provisioning",
        observedAt,
        message,
      });
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId,
        status: "ready",
        observedAt: preparedAt,
        checkouts: [
          {
            checkoutId: frame!.checkouts[0]!.checkoutId,
            branch: "stale",
            branches: ["stale"],
            defaultBranch: "main",
            baseCommit,
          },
        ],
      });
      const unavailable = await waitUntil("stale preparation settles unavailable", async () => {
        const workspace = await readWorkspace(arranged, workspaceId);
        return workspace.status === "failed" ? workspace : undefined;
      });
      expect(unavailable).toMatchObject({ status: "failed", observedAt, message });
      expect(unavailable.provisionedAt).not.toBeNull();
      expect(unavailable.checkouts[0]!.branch).toBeNull();
      expect(unavailable.checkouts[0]!.baseCommit).toBe(baseCommit);
      await waitUntil("waiting session ends without a harness", async () => {
        const response = await get(
          arranged.harness.base,
          `/api/v1/sessions/${session.id}`,
          arranged.token,
        );
        const current = (await response.json()) as Session;
        return current.status === "exited" ? current : undefined;
      });
      expect(listFramesTagged(arranged.wire, "sessionStart")).toHaveLength(0);
    });
  });
  it("settles successful preparation after a newer inspection found readable files with preparation still incomplete", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(
        arranged,
        "https://fixture.invalid/acme/readable-preparation",
      );
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const baseCommit = "0123456789012345678901234567890123456789";
      const headCommit = "1123456789012345678901234567890123456789";
      const preparedAt = new Date(Date.now() - 1000).toISOString();
      const observedAt = new Date().toISOString();
      const pending = post(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}/inspect`,
        {},
        arranged.token,
      );
      const request = await waitUntil(
        "readable preparation inspection",
        () =>
          listFramesTagged(arranged.wire, "workspaceInspect")[0] as
            { requestId: string } | undefined,
      );
      arranged.wire.send({
        _tag: "workspaceInspection",
        requestId: request.requestId,
        report: {
          _tag: "workspaceReport",
          workspaceId: primary.id,
          status: "failed",
          available: true,
          observedAt,
          message: "Preparation has not finished yet.",
          checkouts: [
            {
              checkoutId: frame!.checkouts[0]!.checkoutId,
              branch: "newer",
              branches: ["newer"],
              defaultBranch: "main",
              headCommit,
            },
          ],
        },
      });
      expect((await pending).status).toBe(200);
      expect((await readWorkspace(arranged, primary.id)).status).toBe("provisioning");
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: primary.id,
        status: "ready",
        available: true,
        observedAt: preparedAt,
        checkouts: [
          {
            checkoutId: frame!.checkouts[0]!.checkoutId,
            branch: "older",
            branches: ["older"],
            defaultBranch: "main",
            headCommit: baseCommit,
            baseCommit,
          },
        ],
      });
      const ready = await waitReady(arranged, primary.id);
      expect(ready.observedAt).toBe(observedAt);
      expect(ready.message).toBeNull();
      expect(ready.checkouts[0]).toMatchObject({ branch: "newer", headCommit, baseCommit });
    });
  });

  it("keeps an unavailable managed main as the selected repository instead of replacing it or using another source", async () => {
    await withFleet(async (arranged) => {
      const resourceId = await createRepo(
        arranged,
        "https://fixture.invalid/acme/unavailable-managed-source",
      );
      const primary = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
      });
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      arranged.wire.send({
        _tag: "workspaceReport",
        workspaceId: primary.id,
        status: "ready",
        observedAt: new Date(Date.now() - 1000).toISOString(),
        checkouts: [
          {
            checkoutId: frame!.checkouts[0]!.checkoutId,
            branch: "local-only",
            branches: ["local-only"],
            defaultBranch: "main",
          },
        ],
      });
      await waitReady(arranged, primary.id);
      const pending = post(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}/inspect`,
        {},
        arranged.token,
      );
      const request = await waitUntil(
        "missing managed main inspection",
        () =>
          listFramesTagged(arranged.wire, "workspaceInspect")[0] as
            { requestId: string } | undefined,
      );
      arranged.wire.send({
        _tag: "workspaceInspection",
        requestId: request.requestId,
        report: {
          _tag: "workspaceReport",
          workspaceId: primary.id,
          status: "failed",
          observedAt: new Date().toISOString(),
          message: "The selected main checkout is missing. Restore it and inspect again.",
        },
      });
      expect((await pending).status).toBe(200);
      for (const workspace of [
        { kind: "primary", resourceId },
        { kind: "ephemeral", checkouts: [{ resourceId, startingRevision: { kind: "current" } }] },
      ]) {
        const response = await post(
          arranged.harness.base,
          "/api/v1/sessions",
          { prompt: "Preserve source choice", workspace },
          arranged.token,
        );
        expect(response.status, await response.clone().text()).toBe(400);
        expect(await response.text()).toMatch(/unavailable|restore|inspect/i);
      }
      const replacement = await post(
        arranged.harness.base,
        "/api/v1/workspaces",
        { resourceId, runnerId: arranged.runnerId },
        arranged.token,
      );
      expect(replacement.status).toBe(409);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(1);
      expect((await readWorkspace(arranged, primary.id)).status).toBe("failed");
    });
  });
});
