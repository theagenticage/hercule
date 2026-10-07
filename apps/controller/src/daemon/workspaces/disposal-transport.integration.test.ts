/** Verifies durable disposal through a complete controller process restart and real Git removal. */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Database } from "bun:sqlite";
import { afterAll, describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import type { Session, Workspace } from "@hercule/contract";
import type { JoinAnswer, WorkspaceDispose, WorkspaceProvision } from "@hercule/protocol";
import type { Workspaces } from "../../../../runner/src/workspaces";
import {
  makeTestWorkspaces,
  cleanTemporaries,
  createTemporaryDir,
  makeRemote,
  runGitOrThrow,
} from "../../../../runner/src/workspaces/testing";
import { get, post, send, PASSWORD, USERNAME } from "../../http/testing";
import { waitUntil } from "../../sessions/testing";
import { startControllerProcess, connectProofRunner, type ProofRunner } from "./transport.testing";

afterAll(cleanTemporaries);

const waitForDisposal = (wire: ProofRunner): Promise<WorkspaceDispose> =>
  waitUntil("received durable disposal intent", () =>
    wire.frames.find((frame): frame is WorkspaceDispose => frame._tag === "workspaceDispose"),
  );
const readWorkspace = async (base: string, token: string, id: string): Promise<Workspace> => {
  const response = await get(base, `/api/v1/workspaces/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Workspace;
};

const openProofWorkspace = async (
  base: string,
  token: string,
  joined: JoinAnswer,
  wire: ProofRunner,
  manager: Workspaces,
  remote: string,
): Promise<{ workspaceId: string; cwd: string }> => {
  await waitUntil("probed the production provider on the proof runner", async () => {
    const providers = (await (
      await get(base, "/api/v1/providers", token)
    ).json()) as ReadonlyArray<{ snapshots: ReadonlyArray<unknown> }>;
    return providers.every((provider) => provider.snapshots.length === 1) ? true : undefined;
  });
  const resourceResponse = await post(base, "/api/v1/resources", { kind: "repo", remote }, token);
  expect(resourceResponse.status, await resourceResponse.clone().text()).toBe(200);
  const resourceId = ((await resourceResponse.json()) as { id: string }).id;
  const spawned = await post(
    base,
    "/api/v1/sessions",
    {
      prompt: "Filesystem disposal proof",
      runnerId: joined.runnerId,
      workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
    },
    token,
  );
  expect(spawned.status, await spawned.clone().text()).toBe(200);
  const session = (await spawned.json()) as Session;
  const instruction = await waitUntil("provisioned the proof workspace", () =>
    wire.frames.find((frame): frame is WorkspaceProvision => frame._tag === "workspaceProvision"),
  );
  wire.write(await Effect.runPromise(manager.provision(instruction)));
  await waitUntil("finished the synthetic workspace holder", async () => {
    const response = await get(base, `/api/v1/sessions/${session.id}`, token);
    return ((await response.json()) as Session).status === "exited" ? true : undefined;
  });
  expect((await readWorkspace(base, token, session.workspaceId!)).status).toBe("ready");
  return {
    workspaceId: session.workspaceId!,
    cwd: Effect.runSync(manager.resolve(session.workspaceId!))!.cwd,
  };
};

describe("disposal intent after a complete controller process restart", () => {
  it.each(["ordinary", "forced", "dirty refusal"] as const)(
    "recovers %s disposal after a complete process restart without false deletion",
    async (scenario) => {
      const discardChanges = scenario === "forced";
      const home = createTemporaryDir("hercule-disposal-controller-home-");
      const runnerHome = createTemporaryDir("hercule-disposal-runner-home-");
      const remote = makeRemote();
      const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
      const gitEnv = {
        GIT_CONFIG_COUNT: "1",
        GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
        GIT_CONFIG_VALUE_0: remoteUrl,
      };
      let manager = makeTestWorkspaces({ storageDir: runnerHome, gitEnv });
      const port = 20_000 + Math.floor(Math.random() * 40_000);
      let controller = await startControllerProcess(home, port);
      const wires: Array<ProofRunner> = [];
      try {
        const setupToken = new URL(
          readFileSync(join(home, "setup-url"), "utf8").trim(),
        ).searchParams.get("token")!;
        const setup = await post(
          controller.base,
          "/api/v1/setup/complete",
          {
            username: USERNAME,
            password: PASSWORD,
            timezone: "Europe/Amsterdam",
          },
          setupToken,
        );
        expect(setup.status, await setup.clone().text()).toBe(200);
        const token = ((await setup.json()) as { token: string }).token;
        const minted = await post(controller.base, "/api/v1/runners/join-tokens", {}, token);
        const joinToken = ((await minted.json()) as { token: string }).token;
        const enrollment = await post(controller.base, "/api/v1/runners/join", {}, joinToken);
        expect(enrollment.status, await enrollment.clone().text()).toBe(201);
        const joined = (await enrollment.json()) as JoinAnswer;
        let wire = await connectProofRunner(controller.base, joined);
        wires.push(wire);
        const { workspaceId, cwd } = await openProofWorkspace(
          controller.base,
          token,
          joined,
          wire,
          manager,
          remoteUrl,
        );
        const neighbor = join(runnerHome, "neighbor-sentinel");
        writeFileSync(neighbor, "unrelated files stay\n");
        if (scenario !== "ordinary")
          writeFileSync(join(cwd, "unfinished.txt"), "human work to discard\n");
        const branch = runGitOrThrow(cwd, "branch", "--show-current");
        const common = runGitOrThrow(
          cwd,
          "rev-parse",
          "--path-format=absolute",
          "--git-common-dir",
        );
        const requested = await send(
          "DELETE",
          controller.base,
          `/api/v1/workspaces/${workspaceId}`,
          {
            token,
            body: { discardChanges },
          },
        );
        expect(requested.status, await requested.clone().text()).toBe(200);
        const originalIntent = await waitForDisposal(wire);
        expect((await readWorkspace(controller.base, token, workspaceId)).status).toBe("disposing");
        expect(originalIntent.discardChanges ?? false).toBe(discardChanges);
        expect(originalIntent.requestId).toEqual(expect.any(String));
        expect(existsSync(cwd)).toBe(true);
        await controller.stop();
        wire.close();
        const persisted = new Database(join(home, "data", "hercule.db"), { readonly: true });
        try {
          const durable = persisted
            .query("SELECT status, removal_instruction FROM workspaces WHERE lower(hex(id)) = ?")
            .get(workspaceId.replaceAll("-", "")) as {
            status: string;
            removal_instruction: string;
          };
          expect(durable.status).toBe("disposing");
          expect(JSON.parse(durable.removal_instruction)).toEqual(originalIntent);
        } finally {
          persisted.close();
        }
        controller = await startControllerProcess(home, port);
        expect((await readWorkspace(controller.base, token, workspaceId)).status).toBe("disposing");
        wire = await connectProofRunner(controller.base, joined);
        wires.push(wire);
        const replay = await waitForDisposal(wire);
        expect(replay).toEqual(originalIntent);
        const removed = await Effect.runPromise(manager.dispose(replay));
        if (scenario === "dirty refusal") {
          expect(removed.status).toBe("failed");
          expect(removed.message).toMatch(/changes|files|dirty|discard/i);
          expect((await readWorkspace(controller.base, token, workspaceId)).status).toBe(
            "disposing",
          );
          wire.write(removed);
          const retained = await waitUntil(
            "restored the usable workspace after refusal",
            async () => {
              const current = await readWorkspace(controller.base, token, workspaceId);
              return current.status === "ready" ? current : undefined;
            },
          );
          expect(retained.message).toMatch(/changes|files|dirty|discard/i);
          expect(readFileSync(join(cwd, "unfinished.txt"), "utf8")).toBe("human work to discard\n");
          expect(Effect.runSync(manager.resolve(workspaceId))?.cwd).toBe(cwd);
          const joinedSession = await post(
            controller.base,
            "/api/v1/sessions",
            {
              prompt: "Use retained work",
              runnerId: joined.runnerId,
              workspace: { kind: "existing", workspaceId },
            },
            token,
          );
          expect(joinedSession.status, await joinedSession.clone().text()).toBe(200);
          expect(readFileSync(neighbor, "utf8")).toBe("unrelated files stay\n");
          return;
        }
        expect(removed.status, removed.message).toBe("deleted");
        expect(existsSync(cwd)).toBe(false);
        expect((await readWorkspace(controller.base, token, workspaceId)).status).toBe("disposing");
        await controller.stop();
        wire.close();
        manager = makeTestWorkspaces({ storageDir: runnerHome, gitEnv });
        controller = await startControllerProcess(home, port);
        expect((await readWorkspace(controller.base, token, workspaceId)).status).toBe("disposing");
        wire = await connectProofRunner(controller.base, joined);
        wires.push(wire);
        const afterLostRemovalAck = await waitForDisposal(wire);
        expect(afterLostRemovalAck).toEqual(originalIntent);
        wire.write(await Effect.runPromise(manager.dispose(afterLostRemovalAck)));
        await waitUntil("recorded confirmed deletion", async () =>
          (await readWorkspace(controller.base, token, workspaceId)).status === "deleted"
            ? true
            : undefined,
        );
        expect(readFileSync(neighbor, "utf8")).toBe("unrelated files stay\n");
        expect(runGitOrThrow(common, "show-ref", "--verify", `refs/heads/${branch}`)).toContain(
          branch,
        );
      } finally {
        for (const wire of wires) wire.close();
        await controller.stop();
      }
    },
    30_000,
  );
});
