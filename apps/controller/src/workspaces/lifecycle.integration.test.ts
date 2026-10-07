import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { Duration, Effect, Layer } from "effect";
import type { Session, Workspace } from "@hercule/contract";
import type { SessionStart, WorkspaceDispose, WorkspaceProvision } from "@hercule/protocol";
import {
  makeTestWorkspaces,
  cleanTemporaries,
  createTemporaryDir,
  hashContents,
  makeRemote,
  runGitOrThrow,
} from "../../../runner/src/workspaces/testing";
import { buildHomePaths, HerculeHome } from "../config";
import { openDatabase } from "../db/client";
import { AuditLogLayer } from "../events";
import { get, post, send } from "../http/testing";
import { SessionTokensLayer } from "../permissions";
import { startSentWorkflow, waitForRunTo } from "../runs/testing";
import { RunWorkspaceStepActivityLayer } from "../runs";
import { masterKeyLayer } from "../secrets/masterKey";
import { secretsLayer } from "../secrets/repository";
import { SettingsLayer } from "../settings";
import {
  reportEvent,
  spawnSessionOrFail,
  waitForFrames,
  waitForRunnerGone,
  waitUntil,
  type Arranged,
  type Wire,
} from "../sessions/testing";
import { WorkspaceService, WorkspaceServiceLayer } from "./service";
import { ageLeases, createRepo, endResumable, listFramesTagged, withFleet } from "./testing";

afterAll(cleanTemporaries);
const SWEEP = Duration.millis(50);
const readWorkspace = async (arranged: Arranged, id: string): Promise<Workspace> => {
  const response = await get(arranged.harness.base, `/api/v1/workspaces/${id}`, arranged.token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Workspace;
};
const readSession = async (arranged: Arranged, id: string): Promise<Session> =>
  (await (
    await get(arranged.harness.base, `/api/v1/sessions/${id}`, arranged.token)
  ).json()) as Session;
const waitStatus = (arranged: Arranged, id: string, status: Workspace["status"]) =>
  waitUntil(`workspace became ${status}`, async () => {
    const workspace = await readWorkspace(arranged, id);
    return workspace.status === status ? workspace : undefined;
  });
const askCredential = async (wire: Wire, sessionToken: string, remote: string) => {
  const requestId = crypto.randomUUID();
  wire.send({ _tag: "credentialRequest", requestId, sessionToken, remote });
  return await waitUntil("credential eligibility answer", () =>
    listFramesTagged(wire, "credentialAnswer").find((frame) => frame["requestId"] === requestId),
  );
};
const makeWorld = async (arranged: Arranged, count = 1) => {
  const repositories = [];
  const gitEnv: Record<string, string> = {
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    GIT_CONFIG_COUNT: String(count),
  };
  for (let at = 0; at < count; at++) {
    const remote = makeRemote();
    writeFileSync(join(remote.work, ".gitignore"), "private-cache/\n");
    runGitOrThrow(remote.work, "add", ".gitignore");
    runGitOrThrow(remote.work, "commit", "-m", "Ignore private cache");
    runGitOrThrow(remote.work, "push", remote.path, "main");
    const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
    const resourceId = await createRepo(arranged, remoteUrl);
    gitEnv[`GIT_CONFIG_KEY_${at}`] = `url.${remote.url}.insteadOf`;
    gitEnv[`GIT_CONFIG_VALUE_${at}`] = remoteUrl;
    repositories.push({ remote, remoteUrl, resourceId });
  }
  const storageDir = createTemporaryDir("hercule-controller-lifecycle-runner-home-");
  return { repositories, storageDir, gitEnv, manager: makeTestWorkspaces({ storageDir, gitEnv }) };
};
type World = Awaited<ReturnType<typeof makeWorld>>;
const prepare = async (arranged: Arranged, world: World, workspaceId: string) => {
  const frame = await waitUntil(
    "received the real workspace instruction",
    () =>
      listFramesTagged(arranged.wire, "workspaceProvision").find(
        (frame) => frame["workspaceId"] === workspaceId,
      ) as WorkspaceProvision | undefined,
  );
  const report = await Effect.runPromise(world.manager.provision(frame));
  expect(report.status, report.message).toBe("ready");
  arranged.wire.send(report);
  await waitStatus(arranged, workspaceId, "ready");
  return frame;
};
const startThread = async (
  arranged: Arranged,
  world: World,
  workspace: unknown,
  permissionProfileId?: string,
) => {
  const session = await spawnSessionOrFail(arranged, {
    prompt: "Preserve human work",
    workspace,
    ...(permissionProfileId === undefined ? {} : { permissionProfileId }),
  });
  const workspaceId = session.workspaceId!;
  if ((await readWorkspace(arranged, workspaceId)).status === "provisioning")
    await prepare(arranged, world, workspaceId);
  const start = await waitUntil(
    "started the human thread",
    () =>
      listFramesTagged(arranged.wire, "sessionStart").find(
        (frame) => frame["sessionId"] === session.id,
      ) as SessionStart | undefined,
  );
  reportEvent(arranged.wire, 1, {
    eventId: crypto.randomUUID(),
    sessionId: session.id,
    at: new Date().toISOString(),
    _tag: "session.started",
  });
  await waitUntil("recorded thread start", async () =>
    (await readSession(arranged, session.id)).status === "busy" ? true : undefined,
  );
  return { session, start, workspaceId };
};
const startAutomatic = async (arranged: Arranged, world: World) => {
  const runId = await startSentWorkflow(arranged.harness.base, arranged.token, {
    definition: {
      name: "Automatic workspace cleanup",
      workspace: {
        kind: "ephemeral",
        checkouts: world.repositories.map((repo) => ({ resourceId: repo.resourceId })),
      },
      steps: [
        {
          id: "commit",
          kind: "action",
          action: "git.commit",
          params: { message: "Save workflow work", resourceId: world.repositories[0]!.resourceId },
        },
      ],
      edges: [],
    },
  });
  const step = await waitUntil("dispatched workflow commit", () =>
    listFramesTagged(arranged.wire, "workspaceStepStart").find((frame) => frame["runId"] === runId),
  );
  const workspaceId = String(step["workspaceId"]);
  await prepare(arranged, world, workspaceId);
  return { runId, workspaceId };
};
const finishAutomatic = (arranged: Arranged, world: World, runId: string, workspaceId: string) => {
  const checkout = Effect.runSync(world.manager.resolve(workspaceId))!.checkouts[0]!;
  writeFileSync(join(checkout.path, "workflow-work.txt"), "committed workflow work\n");
  runGitOrThrow(checkout.path, "add", "workflow-work.txt");
  runGitOrThrow(checkout.path, "commit", "-m", "Save workflow work");
  const sha = runGitOrThrow(checkout.path, "rev-parse", "HEAD");
  const branch = runGitOrThrow(checkout.path, "branch", "--show-current");
  return {
    sha,
    branch,
    complete: async () => {
      arranged.wire.send({
        _tag: "workspaceStepResult",
        runId,
        stepId: "commit",
        iteration: 1,
        outcome: { status: "completed", output: { sha, branch, committed: true } },
      });
      await waitForRunTo(arranged, runId, "completed", (run) => run.status === "completed");
    },
  };
};
const waitDisposal = (wire: Wire, workspaceId: string) =>
  waitUntil(
    "sent disposal instruction",
    () =>
      listFramesTagged(wire, "workspaceDispose").find(
        (frame) => frame["workspaceId"] === workspaceId,
      ) as WorkspaceDispose | undefined,
  );
const dispose = (arranged: Arranged, workspaceId: string, body?: unknown) =>
  send("DELETE", arranged.harness.base, `/api/v1/workspaces/${workspaceId}`, {
    token: arranged.token,
    ...(body === undefined ? {} : { body }),
  });

/** Reopens a durable database with the actual workspace domain and its existing dependencies. */
const reopenWorkspaceDomain = (database: string, home: string) =>
  WorkspaceServiceLayer.pipe(
    Layer.provideMerge(SessionTokensLayer),
    Layer.provideMerge(RunWorkspaceStepActivityLayer),
    Layer.provideMerge(SettingsLayer),
    Layer.provideMerge(AuditLogLayer),
    Layer.provideMerge(secretsLayer.pipe(Layer.provide(masterKeyLayer("file")))),
    Layer.provideMerge(Layer.succeed(HerculeHome, buildHomePaths(home, join(home, "data")))),
    Layer.provideMerge(openDatabase(database)),
  );

describe("human and automatic workspace retention", () => {
  it("keeps a human Thread past all TTL windows without keeping its lease or credential active", async () => {
    await withFleet(
      async (arranged) => {
        const world = await makeWorld(arranged);
        const thread = await startThread(arranged, world, {
          kind: "ephemeral",
          checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
        });
        const token = String((thread.start as unknown as Record<string, unknown>)["token"]);
        const canonicalRemote = world.repositories[0]!.remoteUrl.replace("https://", "");
        expect((await askCredential(arranged.wire, token, canonicalRemote))["error"]).toBe(
          "no_connection",
        );
        const cwd = Effect.runSync(world.manager.resolve(thread.workspaceId))!.cwd;
        writeFileSync(join(cwd, "human-notes.txt"), "unfinished human work\n");
        await endResumable(arranged, thread.session);
        await ageLeases(arranged, thread.workspaceId, 24 * 365);
        expect((await askCredential(arranged.wire, token, canonicalRemote))["error"]).toBe(
          "unauthorized",
        );
        const automatic = await startAutomatic(arranged, world);
        const done = finishAutomatic(arranged, world, automatic.runId, automatic.workspaceId);
        await done.complete();
        const cleanup = await waitDisposal(arranged.wire, automatic.workspaceId);
        arranged.wire.send(await Effect.runPromise(world.manager.dispose(cleanup)));
        await waitStatus(arranged, automatic.workspaceId, "deleted");
        const retained = await readWorkspace(arranged, thread.workspaceId);
        expect(retained).toMatchObject({
          status: "ready",
          retentionPolicy: "manual",
          sessionIds: [],
        });
        expect(readFileSync(join(cwd, "human-notes.txt"), "utf8")).toBe("unfinished human work\n");
        const active = await Effect.runPromise(
          arranged.harness.sql<{
            readonly total: number;
          }>`SELECT count(*) AS total FROM workspace_leases WHERE workspace_id = unhex(replace(${thread.workspaceId}, '-', '')) AND released_at IS NULL`,
        );
        expect(active[0]!.total).toBe(0);
        expect(
          listFramesTagged(arranged.wire, "workspaceDispose").some(
            (frame) => frame["workspaceId"] === thread.workspaceId,
          ),
        ).toBe(false);
      },
      { workspaceSweepInterval: SWEEP },
    );
  });

  it("makes a workflow workspace manual when a human joins before the run finishes", async () => {
    await withFleet(
      async (arranged) => {
        const world = await makeWorld(arranged);
        const automatic = await startAutomatic(arranged, world);
        expect((await readWorkspace(arranged, automatic.workspaceId)).retentionPolicy).toBe(
          "automatic",
        );
        const human = await startThread(arranged, world, {
          kind: "existing",
          workspaceId: automatic.workspaceId,
        });
        expect((await readWorkspace(arranged, automatic.workspaceId)).retentionPolicy).toBe(
          "manual",
        );
        const done = finishAutomatic(arranged, world, automatic.runId, automatic.workspaceId);
        await done.complete();
        await endResumable(arranged, human.session);
        await ageLeases(arranged, automatic.workspaceId, 24 * 365);
        const decoy = await startAutomatic(arranged, world);
        const decoyDone = finishAutomatic(arranged, world, decoy.runId, decoy.workspaceId);
        await decoyDone.complete();
        const cleanup = await waitDisposal(arranged.wire, decoy.workspaceId);
        arranged.wire.send(await Effect.runPromise(world.manager.dispose(cleanup)));
        await waitStatus(arranged, decoy.workspaceId, "deleted");
        expect(await readWorkspace(arranged, automatic.workspaceId)).toMatchObject({
          status: "ready",
          retentionPolicy: "manual",
          sessionIds: [],
        });
        expect(Effect.runSync(world.manager.resolve(automatic.workspaceId))).toBeDefined();
        expect(
          listFramesTagged(arranged.wire, "workspaceDispose").some(
            (frame) => frame["workspaceId"] === automatic.workspaceId,
          ),
        ).toBe(false);
      },
      { workspaceSweepInterval: SWEEP },
    );
  });

  it.each(["clean", "tracked", "untracked", "ignored", "multi-root"] as const)(
    "records the actual automatic %s removal outcome without forcing files",
    async (kind) => {
      await withFleet(
        async (arranged) => {
          const world = await makeWorld(arranged, kind === "multi-root" ? 2 : 1);
          const automatic = await startAutomatic(arranged, world);
          const done = finishAutomatic(arranged, world, automatic.runId, automatic.workspaceId);
          const resolved = Effect.runSync(world.manager.resolve(automatic.workspaceId))!;
          const cwd = resolved.checkouts[0]!.path;
          const common = runGitOrThrow(
            cwd,
            "rev-parse",
            "--path-format=absolute",
            "--git-common-dir",
          );
          if (kind === "tracked")
            writeFileSync(join(cwd, "README.md"), "unfinished tracked work\n");
          if (kind === "untracked")
            writeFileSync(join(cwd, "human-notes.txt"), "unfinished notes\n");
          if (kind === "ignored") {
            mkdirSync(join(cwd, "private-cache"));
            writeFileSync(join(cwd, "private-cache", "secret.txt"), "private ignored file\n");
          }
          if (kind === "multi-root")
            writeFileSync(join(resolved.root, "human-notes.txt"), "unfinished root notes\n");
          const before = hashContents(resolved.root);
          await done.complete();
          const cleanup = await waitDisposal(arranged.wire, automatic.workspaceId);
          expect(cleanup.discardChanges ?? false).toBe(false);
          expect((await readWorkspace(arranged, automatic.workspaceId)).status).toBe("disposing");
          const outcome = await Effect.runPromise(world.manager.dispose(cleanup));
          arranged.wire.send(outcome);
          if (kind === "clean") {
            expect(outcome.status, outcome.message).toBe("deleted");
            await waitStatus(arranged, automatic.workspaceId, "deleted");
            expect(existsSync(resolved.root)).toBe(false);
            expect(runGitOrThrow(common, "rev-parse", `refs/heads/${done.branch}`)).toBe(done.sha);
          } else {
            expect(outcome.status).toBe("failed");
            const retained = await waitStatus(arranged, automatic.workspaceId, "ready");
            expect(retained.message).toMatch(/files|changes|ignored|root|preserve|discard/i);
            expect(hashContents(resolved.root)).toBe(before);
            expect(Effect.runSync(world.manager.resolve(automatic.workspaceId))).toBeDefined();
          }
        },
        { workspaceSweepInterval: SWEEP },
      );
    },
  );
});

describe("explicit disposal and admission", () => {
  it("keeps dirty managed files without discard, then removes only their managed worktree with explicit discard", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const thread = await startThread(arranged, world, {
        kind: "ephemeral",
        checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
      });
      await endResumable(arranged, thread.session);
      const cwd = Effect.runSync(world.manager.resolve(thread.workspaceId))!.cwd;
      const common = runGitOrThrow(cwd, "rev-parse", "--path-format=absolute", "--git-common-dir");
      const branch = runGitOrThrow(cwd, "branch", "--show-current");
      const commit = runGitOrThrow(cwd, "rev-parse", "HEAD");
      writeFileSync(join(cwd, "README.md"), "unfinished tracked work\n");
      const neighbor = join(world.storageDir, "workspaces", "neighbor");
      mkdirSync(neighbor);
      writeFileSync(join(neighbor, "notes.txt"), "neighbor stays\n");
      expect((await dispose(arranged, thread.workspaceId)).status).toBe(200);
      const ordinary = await waitDisposal(arranged.wire, thread.workspaceId);
      expect((await readWorkspace(arranged, thread.workspaceId)).status).toBe("disposing");
      const refusal = await Effect.runPromise(world.manager.dispose(ordinary));
      arranged.wire.send(refusal);
      expect(refusal.status).toBe("failed");
      expect((await waitStatus(arranged, thread.workspaceId, "ready")).message).toMatch(
        /files|changes|preserve|discard/i,
      );
      expect(readFileSync(join(cwd, "README.md"), "utf8")).toBe("unfinished tracked work\n");
      const before = listFramesTagged(arranged.wire, "workspaceDispose").length;
      expect((await dispose(arranged, thread.workspaceId, { discardChanges: true })).status).toBe(
        200,
      );
      const forced = (
        await waitForFrames<WorkspaceDispose>(arranged.wire, "workspaceDispose", before + 1)
      )[before]!;
      expect(forced.discardChanges).toBe(true);
      arranged.wire.send(await Effect.runPromise(world.manager.dispose(forced)));
      await waitStatus(arranged, thread.workspaceId, "deleted");
      expect(existsSync(cwd)).toBe(false);
      expect(runGitOrThrow(common, "rev-parse", `refs/heads/${branch}`)).toBe(commit);
      expect(readFileSync(join(neighbor, "notes.txt"), "utf8")).toBe("neighbor stays\n");
    });
  });

  it("allows ordinary workspace.write disposal with a session stamp but refuses session force even with that grant", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const target = await startThread(arranged, world, {
        kind: "ephemeral",
        checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
      });
      await endResumable(arranged, target.session);
      const profileResponse = await post(
        arranged.harness.base,
        "/api/v1/profiles",
        { name: "Workspace lifecycle caller", grants: ["workspace.write"] },
        arranged.token,
      );
      expect([200, 201], await profileResponse.clone().text()).toContain(profileResponse.status);
      const profile = (await profileResponse.json()) as { id: string };
      const caller = await startThread(
        arranged,
        world,
        { kind: "ephemeral", checkouts: [] },
        profile.id,
      );
      const token = String((caller.start as unknown as Record<string, unknown>)["token"]);
      const cwd = Effect.runSync(world.manager.resolve(target.workspaceId))!.cwd;
      writeFileSync(join(cwd, "README.md"), "user must authorize discard\n");
      const before = hashContents(cwd);
      const forced = await send(
        "DELETE",
        arranged.harness.base,
        `/api/v1/workspaces/${target.workspaceId}`,
        { token, body: { discardChanges: true } },
      );
      expect(forced.status).toBe(403);
      expect(await forced.text()).toMatch(/user|session|workflow|discard/i);
      expect(hashContents(cwd)).toBe(before);
      expect(listFramesTagged(arranged.wire, "workspaceDispose")).toHaveLength(0);
      runGitOrThrow(cwd, "checkout", "--", "README.md");
      const max = await Effect.runPromise(
        arranged.harness.sql<{ readonly id: number }>`SELECT coalesce(max(id),0) AS id FROM events`,
      );
      const ordinary = await send(
        "DELETE",
        arranged.harness.base,
        `/api/v1/workspaces/${target.workspaceId}`,
        { token },
      );
      expect(ordinary.status, await ordinary.clone().text()).toBe(200);
      const instruction = await waitDisposal(arranged.wire, target.workspaceId);
      expect(instruction.discardChanges ?? false).toBe(false);
      arranged.wire.send(await Effect.runPromise(world.manager.dispose(instruction)));
      await waitStatus(arranged, target.workspaceId, "deleted");
      const audit = await Effect.runPromise(
        arranged.harness.sql<{
          readonly actor: string;
        }>`SELECT actor FROM events WHERE id>${max[0]!.id} AND kind LIKE 'workspace.%' AND json_extract(payload,'$.workspaceId')=${target.workspaceId}`,
      );
      expect(audit.map((event) => event.actor)).toContain(`session:${caller.session.id}`);
    });
  });

  it.each([undefined, null, { discardChanges: true }])(
    "accepts legacy dispose body %j but refuses active holders before sending any removal",
    async (body) => {
      await withFleet(async (arranged) => {
        const world = await makeWorld(arranged);
        const thread = await startThread(arranged, world, {
          kind: "ephemeral",
          checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
        });
        const refused = await dispose(arranged, thread.workspaceId, body);
        expect(refused.status).toBe(409);
        expect(await refused.text()).toContain(thread.session.id);
        expect(listFramesTagged(arranged.wire, "workspaceDispose")).toHaveLength(0);
        expect(Effect.runSync(world.manager.resolve(thread.workspaceId))).toBeDefined();
      });
    },
  );

  it("reserves disposal before filesystem I/O so joins and resumptions refuse until a dirty refusal restores readiness", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const thread = await startThread(arranged, world, {
        kind: "ephemeral",
        checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
      });
      await endResumable(arranged, thread.session);
      const cwd = Effect.runSync(world.manager.resolve(thread.workspaceId))!.cwd;
      writeFileSync(join(cwd, "human-notes.txt"), "retained while deleting\n");
      expect((await dispose(arranged, thread.workspaceId)).status).toBe(200);
      const instruction = await waitDisposal(arranged.wire, thread.workspaceId);
      expect((await readWorkspace(arranged, thread.workspaceId)).status).toBe("disposing");
      const beforeStarts = listFramesTagged(arranged.wire, "sessionStart").length;
      const joined = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        {
          prompt: "Join while disposing",
          workspace: { kind: "existing", workspaceId: thread.workspaceId },
        },
        arranged.token,
      );
      expect([400, 409]).toContain(joined.status);
      const resumed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${thread.session.id}/input`,
        { text: "Resume while disposing" },
        arranged.token,
      );
      expect(resumed.status).toBe(409);
      expect(listFramesTagged(arranged.wire, "sessionStart")).toHaveLength(beforeStarts);
      const active = await Effect.runPromise(
        arranged.harness.sql<{
          readonly total: number;
        }>`SELECT count(*) AS total FROM workspace_leases WHERE workspace_id = unhex(replace(${thread.workspaceId}, '-', '')) AND released_at IS NULL`,
      );
      expect(active[0]!.total).toBe(0);
      arranged.wire.send(await Effect.runPromise(world.manager.dispose(instruction)));
      await waitStatus(arranged, thread.workspaceId, "ready");
      const recovered = await post(
        arranged.harness.base,
        `/api/v1/sessions/${thread.session.id}/input`,
        { text: "Resume restored checkout" },
        arranged.token,
      );
      expect(recovered.status, await recovered.clone().text()).toBe(200);
      await waitUntil("sent resumed session only after restoring readiness", () =>
        listFramesTagged(arranged.wire, "sessionStart").length > beforeStarts ? true : undefined,
      );
      expect(readFileSync(join(cwd, "human-notes.txt"), "utf8")).toBe("retained while deleting\n");
    });
  });

  it.each(["join", "resume"] as const)(
    "admits one valid outcome when disposal and %s race through public operations",
    async (admission) => {
      await withFleet(async (arranged) => {
        const world = await makeWorld(arranged);
        const thread = await startThread(arranged, world, {
          kind: "ephemeral",
          checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
        });
        await endResumable(arranged, thread.session);
        const root = Effect.runSync(world.manager.resolve(thread.workspaceId))!.root;
        const requestAdmission = () =>
          admission === "join"
            ? post(
                arranged.harness.base,
                "/api/v1/sessions",
                {
                  prompt: "Join concurrently",
                  workspace: { kind: "existing", workspaceId: thread.workspaceId },
                },
                arranged.token,
              )
            : post(
                arranged.harness.base,
                `/api/v1/sessions/${thread.session.id}/input`,
                { text: "Resume concurrently" },
                arranged.token,
              );
        // No runner removal is delivered until both controller admission transactions finish.
        const [removal, admitted] = await Promise.all([
          dispose(arranged, thread.workspaceId),
          requestAdmission(),
        ]);
        if (removal.status === 200) {
          expect([400, 409]).toContain(admitted.status);
          expect((await readWorkspace(arranged, thread.workspaceId)).status).toBe("disposing");
          const active = await Effect.runPromise(
            arranged.harness.sql<{
              readonly total: number;
            }>`SELECT count(*) AS total FROM workspace_leases WHERE workspace_id=unhex(replace(${thread.workspaceId},'-','')) AND released_at IS NULL`,
          );
          expect(active[0]!.total).toBe(0);
          const instruction = await waitDisposal(arranged.wire, thread.workspaceId);
          arranged.wire.send(await Effect.runPromise(world.manager.dispose(instruction)));
          await waitStatus(arranged, thread.workspaceId, "deleted");
        } else {
          expect(removal.status, await removal.clone().text()).toBe(409);
          expect([200, 201], await admitted.clone().text()).toContain(admitted.status);
          await waitUntil("admitted holder has an active lease", async () =>
            (await readWorkspace(arranged, thread.workspaceId)).sessionIds.length > 0
              ? true
              : undefined,
          );
          expect((await readWorkspace(arranged, thread.workspaceId)).status).toBe("ready");
          expect(listFramesTagged(arranged.wire, "workspaceDispose")).toHaveLength(0);
          expect(existsSync(root)).toBe(true);
        }
      });
    },
  );

  it("persists disposing and the exact discard choice across a disk reopen and retries a lost acknowledgement on reconnect", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const thread = await startThread(arranged, world, {
        kind: "ephemeral",
        checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
      });
      await endResumable(arranged, thread.session);
      const root = Effect.runSync(world.manager.resolve(thread.workspaceId))!.root;
      writeFileSync(join(root, "human-notes.txt"), "explicitly discarded\n");
      expect((await dispose(arranged, thread.workspaceId, { discardChanges: true })).status).toBe(
        200,
      );
      const instruction = await waitDisposal(arranged.wire, thread.workspaceId);
      expect(instruction.discardChanges).toBe(true);
      expect((await readWorkspace(arranged, thread.workspaceId)).status).toBe("disposing");
      const recoveryHome = createTemporaryDir("hercule-disposal-disk-recovery-home-");
      copyFileSync(join(arranged.harness.home, "master.key"), join(recoveryHome, "master.key"));
      const database = join(recoveryHome, "controller.sqlite");
      await Effect.runPromise(arranged.harness.sql`VACUUM INTO ${database}`);
      const owed = await Effect.runPromise(
        Effect.gen(function* () {
          const workspaces = yield* WorkspaceService;
          return yield* workspaces.listOwedDisposals(arranged.runnerId);
        }).pipe(Effect.provide(reopenWorkspaceDomain(database, recoveryHome)), Effect.orDie),
      );
      expect(owed).toContainEqual(instruction);
      const removed = await Effect.runPromise(world.manager.dispose(instruction));
      expect(removed.status).toBe("deleted");
      expect(existsSync(root)).toBe(false);
      // The filesystem outcome is withheld, so the controller still owes the instruction.
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      expect((await readWorkspace(arranged, thread.workspaceId)).status).toBe("disposing");
      const reconnected = await arranged.reconnect();
      const replay = await waitDisposal(reconnected, thread.workspaceId);
      expect(replay).toEqual(instruction);
      const restarted = makeTestWorkspaces({ storageDir: world.storageDir, gitEnv: world.gitEnv });
      reconnected.send(await Effect.runPromise(restarted.dispose(replay)));
      await waitStatus(arranged, thread.workspaceId, "deleted");
      expect(existsSync(root)).toBe(false);
    });
  });
});

describe("public attachment detachment", () => {
  it("refuses active holders, preserves every attached byte and allows derived worktree resume after detach", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const repository = world.repositories[0]!;
      const sourceWorld = createTemporaryDir("hercule-public-detach-source-");
      const source = join(sourceWorld, "selected checkout");
      runGitOrThrow(sourceWorld, "clone", repository.remote.url, source);
      runGitOrThrow(source, "remote", "set-url", "origin", repository.remoteUrl);
      runGitOrThrow(source, "config", "user.preservation", "keep source config");
      writeFileSync(join(source, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
        mode: 0o700,
      });
      writeFileSync(join(source, "README.md"), "unfinished source work\n");
      const attached = await post(
        arranged.harness.base,
        "/api/v1/workspaces/attach",
        { resourceId: repository.resourceId, runnerId: arranged.runnerId, path: source },
        arranged.token,
      );
      expect([200, 201], await attached.clone().text()).toContain(attached.status);
      const primary = (await attached.json()) as Workspace;
      await prepare(arranged, world, primary.id);
      const holder = await startThread(arranged, world, {
        kind: "existing",
        workspaceId: primary.id,
      });
      const refused = await post(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}/detach`,
        {},
        arranged.token,
      );
      expect(refused.status).toBe(409);
      expect(await refused.text()).toContain(holder.session.id);
      expect(listFramesTagged(arranged.wire, "workspaceDetach")).toHaveLength(0);
      await endResumable(arranged, holder.session);
      const derived = await startThread(arranged, world, {
        kind: "ephemeral",
        checkouts: [{ resourceId: repository.resourceId, startingRevision: { kind: "current" } }],
      });
      await endResumable(arranged, derived.session);
      const derivedRoot = Effect.runSync(world.manager.resolve(derived.workspaceId))!.cwd;
      const sourceBefore = hashContents(source);
      const discarded = await dispose(arranged, primary.id, { discardChanges: true });
      expect(discarded.status).toBe(409);
      expect(hashContents(source)).toBe(sourceBefore);
      const detached = await post(
        arranged.harness.base,
        `/api/v1/workspaces/${primary.id}/detach`,
        {},
        arranged.token,
      );
      expect(detached.status, await detached.clone().text()).toBe(200);
      const instruction = await waitUntil(
        "sent detach instruction",
        () =>
          listFramesTagged(arranged.wire, "workspaceDetach").find(
            (frame) => frame["workspaceId"] === primary.id,
          ) as { _tag: "workspaceDetach"; workspaceId: string } | undefined,
      );
      arranged.wire.send(await Effect.runPromise(world.manager.detach(instruction)));
      await waitStatus(arranged, primary.id, "deleted");
      expect(hashContents(source)).toBe(sourceBefore);
      expect(Effect.runSync(world.manager.resolve(primary.id))).toBeUndefined();
      const newWork = await post(
        arranged.harness.base,
        "/api/v1/sessions",
        {
          prompt: "New work after detach",
          workspace: {
            kind: "ephemeral",
            checkouts: [
              { resourceId: repository.resourceId, startingRevision: { kind: "current" } },
            ],
          },
        },
        arranged.token,
      );
      expect([400, 409]).toContain(newWork.status);
      expect(await newWork.text()).toMatch(/reattach|registration|selected.*unavailable|restore/i);
      const managed = await post(
        arranged.harness.base,
        "/api/v1/workspaces",
        { resourceId: repository.resourceId, runnerId: arranged.runnerId },
        arranged.token,
      );
      expect(managed.status).toBe(409);
      const resumed = await post(
        arranged.harness.base,
        `/api/v1/sessions/${derived.session.id}/input`,
        { text: "Resume detached-source derived work" },
        arranged.token,
      );
      expect(resumed.status, await resumed.clone().text()).toBe(200);
      const starts = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 3);
      expect(starts[2]!.spec.workspaceId).toBe(derived.workspaceId);
      expect(Effect.runSync(world.manager.resolve(derived.workspaceId))?.cwd).toBe(derivedRoot);
      expect((await Effect.runPromise(world.manager.inspect(derived.workspaceId))).status).toBe(
        "ready",
      );
      expect(readFileSync(join(source, "README.md"), "utf8")).toBe("unfinished source work\n");
      expect(runGitOrThrow(source, "config", "user.preservation")).toBe("keep source config");
    });
  });
});

describe("preparation during pending disposal", () => {
  it("keeps disposing through a late real preparation receipt and restores its prepared state after a safe refusal", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const response = await post(
        arranged.harness.base,
        "/api/v1/workspaces",
        {
          runnerId: arranged.runnerId,
          resourceId: world.repositories[0]!.resourceId,
        },
        arranged.token,
      );
      expect(response.status, await response.clone().text()).toBe(200);
      const workspace = (await response.json()) as Workspace;
      const preparation = await waitUntil(
        "received pending main preparation",
        () =>
          listFramesTagged(arranged.wire, "workspaceProvision").find(
            (frame) => frame["workspaceId"] === workspace.id,
          ) as WorkspaceProvision | undefined,
      );
      expect((await dispose(arranged, workspace.id)).status).toBe(200);
      const removal = await waitDisposal(arranged.wire, workspace.id);
      const ready = await Effect.runPromise(world.manager.provision(preparation));
      expect(ready.status, ready.message).toBe("ready");
      arranged.wire.send(ready);
      await waitUntil("recorded preparation facts while removal remains pending", async () => {
        const current = await readWorkspace(arranged, workspace.id);
        return current.observedAt === ready.observedAt ? current : undefined;
      });
      expect((await readWorkspace(arranged, workspace.id)).status).toBe("disposing");
      writeFileSync(
        join(Effect.runSync(world.manager.resolve(workspace.id))!.root, "human-notes.txt"),
        "retain this file\n",
      );
      const refusal = await Effect.runPromise(world.manager.dispose(removal));
      expect(refusal.status, refusal.message).toBe("failed");
      arranged.wire.send(refusal);
      await waitUntil("recorded the correlated refusal", async () =>
        (await arranged.harness.audit("workspace.disposalRefused")).some(
          (entry) => entry.payload["workspaceId"] === workspace.id,
        )
          ? true
          : undefined,
      );
      expect((await readWorkspace(arranged, workspace.id)).status).toBe("ready");
      expect(
        existsSync(
          join(Effect.runSync(world.manager.resolve(workspace.id))!.root, "human-notes.txt"),
        ),
      ).toBe(true);
    });
  });
});

describe("retained removal diagnostics", () => {
  it("preserves the refusal reason through healthy inspection and unavailable-to-healthy recovery", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const thread = await startThread(arranged, world, {
        kind: "ephemeral",
        checkouts: [{ resourceId: world.repositories[0]!.resourceId }],
      });
      await endResumable(arranged, thread.session);
      const root = Effect.runSync(world.manager.resolve(thread.workspaceId))!.root;
      writeFileSync(join(root, "human-notes.txt"), "preserve these notes\n");
      expect((await dispose(arranged, thread.workspaceId)).status).toBe(200);
      const instruction = await waitDisposal(arranged.wire, thread.workspaceId);
      arranged.wire.send(await Effect.runPromise(world.manager.dispose(instruction)));
      const retained = await waitStatus(arranged, thread.workspaceId, "ready");
      expect(retained.message).toMatch(/tracked|untracked|ignored|files/i);
      expect(retained.keptUntil).toBeNull();
      const inspect = async () => {
        const before = listFramesTagged(arranged.wire, "workspaceInspect").length;
        const response = post(
          arranged.harness.base,
          `/api/v1/workspaces/${thread.workspaceId}/inspect`,
          undefined,
          arranged.token,
        );
        const request = await waitUntil(
          "received public inspection",
          () => listFramesTagged(arranged.wire, "workspaceInspect")[before],
        );
        arranged.wire.send({
          _tag: "workspaceInspection",
          requestId: String(request["requestId"]),
          report: await Effect.runPromise(world.manager.inspect(thread.workspaceId)),
        });
        const answered = await response;
        expect(answered.status, await answered.clone().text()).toBe(200);
        return (await answered.json()) as Workspace;
      };
      expect((await inspect()).message).toBe(retained.message);
      const moved = join(world.storageDir, "temporarily-moved-human-worktree");
      renameSync(root, moved);
      try {
        const missing = await inspect();
        expect(missing.status).toBe("failed");
        expect(missing.message).toMatch(/missing|unavailable|restore/i);
        expect(missing.message).not.toBe(retained.message);
      } finally {
        renameSync(moved, root);
      }
      const recovered = await inspect();
      expect(recovered.status).toBe("ready");
      expect(recovered.message).toBe(retained.message);
      expect(recovered.keptUntil).toBeNull();
      expect(readFileSync(join(root, "human-notes.txt"), "utf8")).toBe("preserve these notes\n");
    });
  });
});

describe("failed managed preparation attempts", () => {
  it("opens a fresh main without claiming deletion of the failed attempt or rerunning its setup", async () => {
    await withFleet(async (arranged) => {
      const world = await makeWorld(arranged);
      const resourceId = world.repositories[0]!.resourceId;
      const configured = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/resources/${resourceId}`,
        {
          token: arranged.token,
          body: {
            setupCommand:
              "printf 'setup ran\\n' >> setup-count.txt; printf 'preserve failed setup work\\n' > unfinished.txt; exit 7",
          },
        },
      );
      expect(configured.status, await configured.clone().text()).toBe(200);
      const open = async () => {
        const response = await post(
          arranged.harness.base,
          "/api/v1/workspaces",
          { runnerId: arranged.runnerId, resourceId },
          arranged.token,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        const workspace = (await response.json()) as Workspace;
        const frame = await waitUntil(
          "received fresh main preparation",
          () =>
            listFramesTagged(arranged.wire, "workspaceProvision").find(
              (item) => item["workspaceId"] === workspace.id,
            ) as WorkspaceProvision | undefined,
        );
        return { workspace, frame };
      };
      const first = await open();
      const failed = await Effect.runPromise(world.manager.provision(first.frame));
      expect(failed.status, failed.message).toBe("failed");
      arranged.wire.send(failed);
      const recorded = await waitStatus(arranged, first.workspace.id, "failed");
      const firstRoot = join(world.storageDir, "primaries", first.workspace.id);
      expect(readFileSync(join(firstRoot, "setup-count.txt"), "utf8")).toBe("setup ran\n");
      const before = hashContents(firstRoot);
      const changed = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/resources/${resourceId}`,
        { token: arranged.token, body: { setupCommand: null } },
      );
      expect(changed.status, await changed.clone().text()).toBe(200);
      const second = await open();
      expect(second.workspace.id).not.toBe(first.workspace.id);
      const ready = await Effect.runPromise(world.manager.provision(second.frame));
      expect(ready.status, ready.message).toBe("ready");
      arranged.wire.send(ready);
      await waitStatus(arranged, second.workspace.id, "ready");
      expect(Effect.runSync(world.manager.resolve(second.workspace.id))!.root).not.toBe(firstRoot);
      const preserved = await readWorkspace(arranged, first.workspace.id);
      expect(preserved.status).toBe("failed");
      expect(preserved.message).toBe(recorded.message);
      expect(preserved.disposedAt).toBeNull();
      expect(preserved.provisionedAt).toBeNull();
      expect(hashContents(firstRoot)).toBe(before);
      expect(await Effect.runPromise(world.manager.provision(first.frame))).toEqual(failed);
      expect(readFileSync(join(firstRoot, "setup-count.txt"), "utf8")).toBe("setup ran\n");
      expect(hashContents(firstRoot)).toBe(before);
    });
  });
});
