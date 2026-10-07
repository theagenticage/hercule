import {
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmdirSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { Workspace } from "@hercule/contract";
import type { SessionStart, WorkspaceProvision } from "@hercule/protocol";
import { makeWorkspaces } from "../../../runner/src/workspaces";
import {
  cleanTemporaries,
  createTemporaryDir,
  hashContents,
  makeRemote,
  runGitOrThrow,
} from "../../../runner/src/workspaces/testing";
import { get, post, send } from "../http/testing";
import { startSentWorkflow } from "../runs/testing";
import { buildProviderDefinition, createPluginFixture } from "../plugins/testing";
import {
  spawnSessionOrFail,
  waitForFrames,
  waitForRunnerGone,
  waitUntil,
  type Arranged,
  withFleet as withRunnerFleet,
} from "../sessions/testing";
import {
  FACTS,
  MODELS,
  listFramesTagged,
  provisionWorkspaceOrFail,
  readWorkspace,
  withFleet,
} from "./testing";

afterAll(cleanTemporaries);

const createCheckout = () => {
  const remote = makeRemote();
  const world = createTemporaryDir("hercule-controller-attachment-");
  const source = join(world, "existing checkout with spaces");
  runGitOrThrow(world, "clone", remote.url, source);
  const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
  runGitOrThrow(source, "remote", "set-url", "origin", remoteUrl);
  runGitOrThrow(source, "checkout", "-b", "local-only");
  writeFileSync(join(source, "local-only.txt"), "unpushed\n");
  runGitOrThrow(source, "add", ".");
  runGitOrThrow(source, "commit", "-m", "local work");
  writeFileSync(join(source, "README.md"), "dirty tracked\n");
  writeFileSync(join(source, "untracked.txt"), "keep\n");
  writeFileSync(join(source, ".gitignore"), "ignored.env\n");
  writeFileSync(join(source, "ignored.env"), "private fixture content\n");
  mkdirSync(join(source, "nested"));
  runGitOrThrow(source, "config", "alias.my-status", "status --short");
  writeFileSync(join(source, ".git", "hooks", "pre-commit"), "#!/bin/sh\nexit 0\n", {
    mode: 0o700,
  });
  return {
    remote,
    remoteUrl,
    world,
    path: realpathSync(source),
    gitEnv: {
      GIT_CONFIG_GLOBAL: "/dev/null",
      GIT_CONFIG_SYSTEM: "/dev/null",
      GIT_CONFIG_COUNT: "1",
      GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
      GIT_CONFIG_VALUE_0: remoteUrl,
    },
  };
};

const createResource = async (arranged: Arranged, remote: string): Promise<string> => {
  const response = await post(
    arranged.harness.base,
    "/api/v1/resources",
    {
      kind: "repo",
      remote,
      setupCommand: "echo must-not-run > attachment-setup-ran",
    },
    arranged.token,
  );
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return ((await response.json()) as { readonly id: string }).id;
};

const attach = (arranged: Arranged, body: unknown, token = arranged.token): Promise<Response> =>
  post(arranged.harness.base, "/api/v1/workspaces/attach", body, token);

const attachOrFail = async (arranged: Arranged, body: unknown): Promise<Workspace> => {
  const response = await attach(arranged, body);
  expect([200, 201], await response.clone().text()).toContain(response.status);
  return (await response.json()) as Workspace;
};

describe("workspace.attach", () => {
  it("keeps a workflow-only managed selection fixed before a main working copy exists", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      await startSentWorkflow(arranged.harness.base, arranged.token, {
        definition: {
          name: "Workflow without a main working copy",
          workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
          steps: [
            { id: "commit", kind: "action", action: "git.commit", params: { message: "Save" } },
          ],
          edges: [],
        },
      });
      const [workflowWorkspace] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      expect(workflowWorkspace!.kind).toBe("ephemeral");
      const workspaces = await get(
        arranged.harness.base,
        `/api/v1/workspaces?resourceId=${resourceId}`,
        arranged.token,
      );
      expect(workspaces.status).toBe(200);
      expect(
        ((await workspaces.json()) as { readonly items: ReadonlyArray<Workspace> }).items.every(
          (workspace) => workspace.kind === "ephemeral",
        ),
      ).toBe(true);

      const refused = await attach(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: fixture.path,
      });

      expect(refused.status).toBe(409);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(1);
      expect(hashContents(fixture.world)).toBe(before);
    });
  });

  it("revalidates the same restored attachment through the public operation without replacing IDs or running setup", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const body = { resourceId, runnerId: arranged.runnerId, path: fixture.path };
      const workspace = await attachOrFail(arranged, body);
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const manager = makeWorkspaces({
        storageDir: createTemporaryDir("hercule-attachment-retry-"),
        gitEnv: fixture.gitEnv,
      });
      arranged.wire.send(await manager.provision(frame!));
      await waitUntil("made the attachment ready", async () =>
        (await readWorkspace(arranged, workspace.id)).status === "ready" ? true : undefined,
      );
      renameSync(fixture.path, `${fixture.path}.saved`);
      arranged.wire.send(await manager.provision(frame!));
      await waitUntil("recorded attachment unavailability", async () =>
        (await readWorkspace(arranged, workspace.id)).status === "failed" ? true : undefined,
      );
      renameSync(`${fixture.path}.saved`, fixture.path);
      const sentBeforeRetry = listFramesTagged(arranged.wire, "workspaceProvision").length;

      const retried = await attachOrFail(arranged, body);

      expect(retried.id).toBe(workspace.id);
      const retries = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        sentBeforeRetry + 1,
      );
      const retry = retries[retries.length - 1]!;
      expect(retry.workspaceId).toBe(workspace.id);
      arranged.wire.send(await manager.provision(retry));
      await waitUntil("recovered the same attachment", async () =>
        (await readWorkspace(arranged, workspace.id)).status === "ready" ? true : undefined,
      );
      expect((await readWorkspace(arranged, workspace.id)).path).toBe(fixture.path);
      expect(hashContents(fixture.world)).toBe(before);
      expect(existsSync(join(fixture.path, "attachment-setup-ran"))).toBe(false);
    });
  });

  it("rejects an older runner visibly before persisting or sending attachment intent", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const older = await arranged.enlist({ capabilities: [] });

      const refused = await attach(arranged, {
        resourceId,
        runnerId: older.runnerId,
        path: fixture.path,
      });

      expect(refused.status).toBe(409);
      expect(await refused.text()).toMatch(/unsupported|capability|upgrade|support/i);
      expect(listFramesTagged(older.wire, "workspaceProvision")).toHaveLength(0);
      const workspaces = await get(
        arranged.harness.base,
        `/api/v1/workspaces?resourceId=${resourceId}&runnerId=${older.runnerId}`,
        arranged.token,
      );
      expect(workspaces.status).toBe(200);
      expect(
        ((await workspaces.json()) as { readonly items: ReadonlyArray<Workspace> }).items,
      ).toEqual([]);
      const supported = await attachOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: fixture.path,
      });
      expect(supported.runnerId).toBe(arranged.runnerId);
      expect(hashContents(fixture.world)).toBe(before);
    });
  });

  it.each(["existing", "managed"] as const)(
    "uses the same public %s semantics for one Resource on the Mac runner and a remote runner",
    async (mode) => {
      const fixture = createCheckout();
      const remotePath = join(fixture.world, "remote runner checkout");
      runGitOrThrow(fixture.world, "clone", fixture.remote.url, remotePath);
      runGitOrThrow(remotePath, "remote", "set-url", "origin", fixture.remoteUrl);
      const before = hashContents(fixture.world);
      await withRunnerFleet(
        async (arranged) => {
          const resourceId = await createResource(arranged, fixture.remoteUrl);
          const remoteRunner = await arranged.enlist();
          for (const { runnerId, wire, path } of [
            { runnerId: arranged.runnerId, wire: arranged.wire, path: fixture.path },
            {
              runnerId: remoteRunner.runnerId,
              wire: remoteRunner.wire,
              path: realpathSync(remotePath),
            },
          ]) {
            const workspace =
              mode === "existing"
                ? await attachOrFail(arranged, { resourceId, runnerId, path })
                : await provisionWorkspaceOrFail(arranged, { resourceId, runnerId });
            const [frame] = await waitForFrames<WorkspaceProvision>(wire, "workspaceProvision", 1);
            if (mode === "existing")
              expect(frame!.attachment).toEqual({ path, remoteName: "origin" });
            else expect(frame!.attachment).toBeUndefined();
            const manager = makeWorkspaces({
              storageDir: createTemporaryDir("hercule-parity-storage-"),
              gitEnv: fixture.gitEnv,
            });
            const report = await manager.provision(frame!);
            expect(report.status, report.message).toBe("ready");
            wire.send(report);
            const ready = await waitUntil("recorded parity readiness", async () => {
              const current = await readWorkspace(arranged, workspace.id);
              return current.status === "ready" ? current : undefined;
            });
            expect(ready.runnerId).toBe(runnerId);
            expect(ready.checkouts[0]!.resourceId).toBe(resourceId);
            expect(ready.ownership).toBe(mode === "existing" ? "adopted" : "managed");
            if (mode === "existing") expect(manager.resolve(workspace.id)?.cwd).toBe(path);
            else expect(manager.resolve(workspace.id)?.cwd).not.toBe(path);
          }
          expect(hashContents(fixture.world)).toBe(before);
        },
        {
          firstRunnerIsLocal: true,
          facts: FACTS,
          models: MODELS,
          plugins: [
            createPluginFixture({
              id: "providers",
              definitions: [buildProviderDefinition("test-provider")],
            }).plugin,
          ],
        },
      );
    },
  );

  it("validates on the selected runner and records its normalized root without changing the checkout", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const workspace = await attachOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: join(fixture.path, "nested"),
      });
      expect(workspace.status).toBe("provisioning");
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      expect(frame!.workspaceId).toBe(workspace.id);
      expect(frame!.attachment).toEqual({
        path: join(fixture.path, "nested"),
        remoteName: "origin",
      });
      const manager = makeWorkspaces({
        storageDir: createTemporaryDir("hercule-runner-storage-"),
        gitEnv: fixture.gitEnv,
      });
      arranged.wire.send(await manager.provision(frame!));

      const ready = await waitUntil("validated the existing checkout", async () => {
        const current = await readWorkspace(arranged, workspace.id);
        return current.status === "ready" ? current : undefined;
      });
      expect(ready.path).toBe(fixture.path);
      expect(ready.ownership).toBe("adopted");
      expect(ready.runnerId).toBe(arranged.runnerId);
      expect(manager.resolve(workspace.id)?.cwd).toBe(fixture.path);
      expect(hashContents(fixture.world)).toBe(before);
      expect(existsSync(join(fixture.path, "attachment-setup-ran"))).toBe(false);
    });
  });

  it("persists attachment intent offline and reuses the same primary after reconnect and duplicate calls", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      arranged.wire.close();
      await waitForRunnerGone(arranged);
      const body = {
        resourceId,
        runnerId: arranged.runnerId,
        path: fixture.path,
        remoteName: "origin",
      };
      const first = await attachOrFail(arranged, body);
      const duplicate = await attachOrFail(arranged, body);
      expect(duplicate.id).toBe(first.id);

      const reconnected = await arranged.reconnect();
      const [frame] = await waitForFrames<WorkspaceProvision>(reconnected, "workspaceProvision", 1);
      expect(frame!.workspaceId).toBe(first.id);
      expect(frame!.attachment).toEqual({ path: fixture.path, remoteName: "origin" });
      const storageDir = createTemporaryDir("hercule-runner-storage-");
      const report = await makeWorkspaces({ storageDir, gitEnv: fixture.gitEnv }).provision(frame!);
      reconnected.send(report);
      await waitUntil("recorded attached readiness", async () =>
        (await readWorkspace(arranged, first.id)).status === "ready" ? true : undefined,
      );
      const restartedReport = await makeWorkspaces({
        storageDir,
        gitEnv: fixture.gitEnv,
      }).provision(frame!);
      expect(restartedReport).toEqual(report);
      const repeated = await attachOrFail(arranged, body);
      expect(repeated.id).toBe(first.id);
      expect(repeated.path).toBe(fixture.path);
      expect(hashContents(fixture.world)).toBe(before);
    });
  });

  it("rejects conflicting concurrent paths before instructions can touch both candidates", async () => {
    const fixture = createCheckout();
    const other = join(fixture.world, "other candidate");
    runGitOrThrow(fixture.world, "clone", fixture.path, other);
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const responses = await Promise.all([
        attach(arranged, { resourceId, runnerId: arranged.runnerId, path: fixture.path }),
        attach(arranged, { resourceId, runnerId: arranged.runnerId, path: other }),
      ]);
      expect(
        responses
          .map((response) => response.status)
          .filter((status) => status >= 200 && status < 300),
      ).toHaveLength(1);
      expect(responses.map((response) => response.status)).toContain(409);
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      expect([fixture.path, other]).toContain(frame!.attachment?.path);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(1);
      expect(hashContents(fixture.world)).toBe(before);
    });
  });

  it("rejects switching an established managed choice to attachment and an attached choice to managed", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const second = await arranged.enlist();
      await provisionWorkspaceOrFail(arranged, { resourceId, runnerId: arranged.runnerId });
      const refusedAttachment = await attach(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: fixture.path,
      });
      expect(refusedAttachment.status).toBe(409);
      await attachOrFail(arranged, { resourceId, runnerId: second.runnerId, path: fixture.path });
      const refusedManaged = await post(
        arranged.harness.base,
        "/api/v1/workspaces",
        { resourceId, runnerId: second.runnerId },
        arranged.token,
      );
      expect(refusedManaged.status).toBe(409);
      expect(hashContents(fixture.world)).toBe(before);
    });
  });

  it("refuses session actors from attaching external directories", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      await spawnSessionOrFail(arranged, { prompt: "hello" });
      const [start] = await waitForFrames<SessionStart>(arranged.wire, "sessionStart", 1);

      const refused = await attach(
        arranged,
        { resourceId, runnerId: arranged.runnerId, path: fixture.path },
        start!.token,
      );

      expect(refused.status).toBe(403);
      expect(listFramesTagged(arranged.wire, "workspaceProvision")).toHaveLength(0);
      expect(hashContents(fixture.world)).toBe(before);
    });
  });

  it("leaves wrong-repository attachment failed and never substitutes managed storage", async () => {
    const fixture = createCheckout();
    runGitOrThrow(
      fixture.path,
      "remote",
      "set-url",
      "origin",
      "https://fixture.invalid/not/the-resource",
    );
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const workspace = await attachOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: fixture.path,
      });
      const [frame] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const storageDir = createTemporaryDir("hercule-runner-storage-");
      const manager = makeWorkspaces({ storageDir, gitEnv: fixture.gitEnv });
      arranged.wire.send(await manager.provision(frame!));

      const failed = await waitUntil("recorded the attachment failure", async () => {
        const current = await readWorkspace(arranged, workspace.id);
        return current.status === "failed" ? current : undefined;
      });
      expect(failed.message).toMatch(/remote|repository/i);
      expect(manager.resolve(workspace.id)).toBeUndefined();
      expect(existsSync(join(storageDir, "cache"))).toBe(false);
      expect(hashContents(fixture.world)).toBe(before);
    });
  });

  it("keeps an attachment and local-only branch on runner A while runner B establishes managed storage", async () => {
    const fixture = createCheckout();
    const before = hashContents(fixture.world);
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const second = await arranged.enlist();
      const attached = await attachOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: fixture.path,
      });
      const [attachment] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const managerA = makeWorkspaces({
        storageDir: createTemporaryDir("hercule-runner-A-"),
        gitEnv: fixture.gitEnv,
      });
      arranged.wire.send(await managerA.provision(attachment!));
      await waitUntil("attached on runner A", async () =>
        (await readWorkspace(arranged, attached.id)).status === "ready" ? true : undefined,
      );

      const managed = await provisionWorkspaceOrFail(arranged, {
        resourceId,
        runnerId: second.runnerId,
      });
      const [instructionB] = await waitForFrames<WorkspaceProvision>(
        second.wire,
        "workspaceProvision",
        1,
      );
      expect(instructionB!.attachment).toBeUndefined();
      expect(JSON.stringify(second.wire.frames)).not.toContain(fixture.path);
      const storageB = createTemporaryDir("hercule-runner-B-");
      const managerB = makeWorkspaces({ storageDir: storageB, gitEnv: fixture.gitEnv });
      const reportB = await managerB.provision(instructionB!);
      second.wire.send(reportB);
      expect(reportB.status, reportB.message).toBe("ready");
      expect(managerB.resolve(managed.id)?.cwd).not.toBe(fixture.path);
      expect(reportB.checkouts?.[0]?.branches).not.toContain("local-only");
      expect(runGitOrThrow(managerB.resolve(managed.id)!.cwd, "rev-parse", "HEAD")).toBe(
        runGitOrThrow(fixture.remote.work, "rev-parse", "HEAD"),
      );
      expect(managerA.resolve(attached.id)?.cwd).toBe(fixture.path);
      expect(hashContents(fixture.world)).toBe(before);
      expect(readFileSync(join(fixture.path, "README.md"), "utf8")).toBe("dirty tracked\n");
    });
  });
});

describe("reattaching a normalized checkout root", () => {
  it("revalidates the same repository after its originally selected subdirectory disappears and preserves frozen setup", async () => {
    const fixture = createCheckout();
    await withFleet(async (arranged) => {
      const resourceId = await createResource(arranged, fixture.remoteUrl);
      const workspace = await attachOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: join(fixture.path, "nested"),
      });
      const [original] = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        1,
      );
      const storageDir = createTemporaryDir("hercule-normalized-attachment-");
      const manager = makeWorkspaces({ storageDir, gitEnv: fixture.gitEnv });
      arranged.wire.send(await manager.provision(original!));
      await waitUntil("recorded normalized checkout root", async () => {
        const current = await readWorkspace(arranged, workspace.id);
        return current.status === "ready" && current.path === fixture.path ? true : undefined;
      });
      rmdirSync(join(fixture.path, "nested"));
      const before = hashContents(fixture.world);
      const changed = await send(
        "PATCH",
        arranged.harness.base,
        `/api/v1/resources/${resourceId}`,
        {
          token: arranged.token,
          body: { setupCommand: "echo changed-must-not-run > changed-setup-ran" },
        },
      );
      expect(changed.status, await changed.clone().text()).toBe(200);

      const repeated = await attachOrFail(arranged, {
        resourceId,
        runnerId: arranged.runnerId,
        path: fixture.path,
      });
      expect(repeated.id).toBe(workspace.id);
      const frames = await waitForFrames<WorkspaceProvision>(
        arranged.wire,
        "workspaceProvision",
        2,
      );
      const replay = frames[1]!;
      expect(replay.attachment).toEqual({ path: fixture.path, remoteName: "origin" });
      expect(replay.checkouts).toEqual(original!.checkouts);
      const report = await makeWorkspaces({ storageDir, gitEnv: fixture.gitEnv }).provision(replay);
      expect(report.status, report.message).toBe("ready");
      expect(report.path).toBe(fixture.path);
      arranged.wire.send(report);
      expect(hashContents(fixture.world)).toBe(before);
      expect(existsSync(join(fixture.path, "attachment-setup-ran"))).toBe(false);
      expect(existsSync(join(fixture.path, "changed-setup-ran"))).toBe(false);
    });
  });
});
