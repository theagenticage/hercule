import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import type { TranscriptRow } from "@hercule/contract";
import {
  PROTOCOL_VERSION,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  type ControllerToRunner,
  type JoinAnswer,
} from "@hercule/protocol";
import {
  cleanTemporaries,
  createTemporaryDir,
  makeRemote,
} from "../../../../runner/src/workspaces/testing";
import { get, post, send } from "../../http/testing";
import { spawnSessionOrFail, waitUntil, type Arranged } from "../../sessions/testing";
import { FACTS, MODELS, readWorkspace, withFleet } from "../../workspaces/testing";

afterAll(cleanTemporaries);

const quoteShell = (value: string): string => `'${value.replaceAll("'", "'\\''")}'`;

const waitForProcessGone = async (pid: number): Promise<void> => {
  const deadline = Date.now() + 5_000;
  while (Date.now() < deadline) {
    try {
      process.kill(pid, 0);
    } catch {
      return;
    }
    await Bun.sleep(10);
  }
  throw new Error(`proof process ${String(pid)} did not exit`);
};

const stopCapturedProcess = async (pid: number): Promise<void> => {
  try {
    process.kill(pid, "SIGKILL");
  } catch {
    // A captured child can finish before cleanup reaches it.
  }
  await waitForProcessGone(pid);
};

/** Establishes provider facts before the real runner takes over the enrolled identity. */
const bootstrapRunner = async (
  arranged: Arranged,
): Promise<{
  readonly joined: JoinAnswer;
  readonly socket: WebSocket;
}> => {
  const response = await send("POST", arranged.harness.base, "/api/v1/runners/join", {
    body: {},
    token: await arranged.harness.joinToken(),
  });
  expect(response.status, await response.clone().text()).toBe(201);
  const joined = (await response.json()) as JoinAnswer;
  const socket = new WebSocket(
    `${arranged.harness.base.replace(/^http:/, "ws:")}/api/v1/runners/socket`,
    { headers: { authorization: `Bearer ${joined.credential}` } },
  );
  await new Promise<void>((resolveOpened, reject) => {
    socket.onopen = () => {
      socket.send(
        JSON.stringify({
          _tag: "runnerHello",
          protocolVersion: PROTOCOL_VERSION,
          capabilities: [WORKSPACE_LIFECYCLE_CAPABILITY],
          binaryVersion: "0.1.0",
          nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
          facts: FACTS,
        }),
      );
      resolveOpened();
    };
    socket.onerror = () => reject(new Error("the controller rejected the proof runner"));
    socket.onmessage = (event) => {
      const frame = JSON.parse(String(event.data)) as ControllerToRunner;
      if (frame._tag === "controllerHello") {
        socket.send(JSON.stringify({ _tag: "sessionsReport", sessions: [] }));
      } else if (frame._tag === "ping") {
        socket.send(JSON.stringify({ _tag: "pong" }));
      } else if (frame._tag === "probeRequest") {
        socket.send(
          JSON.stringify({
            _tag: "probeReport",
            requestId: frame.requestId,
            instanceId: frame.instanceId,
            result: { harnessVersion: "1.0.0", auth: { status: "ok" }, models: MODELS },
          }),
        );
      }
    };
  });
  try {
    await waitUntil("probed the proof runner", async () => {
      const providers = (await (
        await get(arranged.harness.base, "/api/v1/providers", arranged.token)
      ).json()) as ReadonlyArray<{ readonly snapshots: ReadonlyArray<unknown> }>;
      return providers.every((provider) => provider.snapshots.length === 2) ? true : undefined;
    });
  } catch (error) {
    socket.close();
    throw error;
  }
  return { joined, socket };
};

describe("preparation after a real runner process dies", () => {
  it.each(["creation", "before setup", "during setup"] as const)(
    "keeps a queued session from starting after death %s and replays interruption over the real socket",
    async (stage) => {
      const remote = makeRemote();
      const home = createTemporaryDir("hercule-transport-proof-home-");
      const storageDir = join(home, "runner-storage");
      mkdirSync(storageDir);
      const counter = join(home, "setup-count");
      const capturedChild = join(home, "barrier-pid");
      const barrier = join(home, "preparation-barrier");
      const made = Bun.spawnSync(["mkfifo", barrier]);
      expect(made.exitCode, made.stderr.toString()).toBe(0);
      const executables = join(home, "bin");
      mkdirSync(executables);
      const git = Bun.which("git");
      expect(git).toBeTruthy();
      const block = `echo $$ > ${quoteShell(capturedChild)}; read release < ${quoteShell(barrier)}`;
      const invokeGit = `${quoteShell(git!)} "$@"`;
      writeFileSync(
        join(executables, "git"),
        "#!/bin/sh\ncase \" $* \" in\n*' worktree add '*)\n" +
          (stage === "creation"
            ? `${block}\nexec ${invokeGit}\n`
            : stage === "before setup"
              ? `${invokeGit} || exit $?\n${block}\nexit 0\n`
              : `exec ${invokeGit}\n`) +
          `;;\n*) exec ${invokeGit};;\nesac\n`,
        { mode: 0o700 },
      );
      const remoteUrl = `https://fixture.invalid/acme/${crypto.randomUUID()}`;
      const setupCommand =
        stage === "during setup"
          ? `printf 'called\\n' >> ${quoteShell(counter)}; ${block}`
          : `printf 'called\\n' >> ${quoteShell(counter)}`;
      const moduleRoot = resolve(import.meta.dirname, "../../../../runner/src");
      const optionsPath = join(home, "proof-options.json");
      const childCode = `
        import { Effect } from "effect";
        import { connect } from ${JSON.stringify(join(moduleRoot, "socket.ts"))};
        import { makeCredentialRelay } from ${JSON.stringify(join(moduleRoot, "credentials/index.ts"))};
        import { providerLogins } from ${JSON.stringify(join(moduleRoot, "providers/index.ts"))};
        import { sessions } from ${JSON.stringify(join(moduleRoot, "sessions/index.ts"))};
        import { makeWorkspaceSteps } from ${JSON.stringify(join(moduleRoot, "workspace-steps/index.ts"))};
        import { makeWorkspaces } from ${JSON.stringify(join(moduleRoot, "workspaces/index.ts"))};
        const { pin, facts, storageDir, gitEnv } = await Bun.file(${JSON.stringify(optionsPath)}).json();
        const socketPath = storageDir + "/credential.sock";
        await Effect.runPromise(Effect.scoped(Effect.gen(function* () {
        const workspaces = yield* makeWorkspaces({ storageDir, gitEnv });
        yield* connect({
          pin, facts, probe: Effect.succeed(facts),
          headroom: Effect.succeed({ diskFreeBytes: 200 * 1024 ** 3, availableMemoryBytes: 1024 ** 3 }),
          providersDir: storageDir + "/providers", scratchDir: storageDir + "/scratch",
          workspaces, workspaceSteps: makeWorkspaceSteps({ storageDir, workspaces, socketPath, baseEnv: process.env }),
          socketPath, credentials: makeCredentialRelay(), providerLogins, sessions,
          binDir: storageDir + "/bin", herculeTool: { skill: "# fixture", claudePluginDir: storageDir + "/claude-plugin" }
        });
        })));
      `;
      const children: Array<ReturnType<typeof Bun.spawn>> = [];
      let capturedBarrierPid: number | undefined;
      await withFleet(async (arranged) => {
        const bootstrap = await bootstrapRunner(arranged);
        try {
          const resourceResponse = await post(
            arranged.harness.base,
            "/api/v1/resources",
            {
              kind: "repo",
              remote: remoteUrl,
              setupCommand,
            },
            arranged.token,
          );
          expect([200, 201], await resourceResponse.clone().text()).toContain(
            resourceResponse.status,
          );
          const resourceId = ((await resourceResponse.json()) as { readonly id: string }).id;
          const session = await spawnSessionOrFail(arranged, {
            prompt: "preparation proof",
            runnerId: bootstrap.joined.runnerId,
            workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
          });
          const workspaceId = String(session.workspaceId);
          const readSessionStatus = async (): Promise<string> =>
            (
              (await (
                await get(arranged.harness.base, `/api/v1/sessions/${session.id}`, arranged.token)
              ).json()) as { readonly status: string }
            ).status;
          expect(await readSessionStatus()).toBe("queued");
          bootstrap.socket.close();
          await waitUntil("disconnected the bootstrap socket", async () => {
            const runner = (await (
              await get(
                arranged.harness.base,
                `/api/v1/runners/${bootstrap.joined.runnerId}`,
                arranged.token,
              )
            ).json()) as { readonly connectivity: string };
            return runner.connectivity !== "online" ? true : undefined;
          });
          writeFileSync(
            optionsPath,
            JSON.stringify({
              pin: { ...bootstrap.joined, controllerUrl: arranged.harness.base },
              facts: FACTS,
              storageDir,
              gitEnv: {
                GIT_CONFIG_GLOBAL: "/dev/null",
                GIT_CONFIG_SYSTEM: "/dev/null",
                GIT_CONFIG_COUNT: "1",
                GIT_CONFIG_KEY_0: `url.${remote.url}.insteadOf`,
                GIT_CONFIG_VALUE_0: remoteUrl,
              },
            }),
            { mode: 0o600 },
          );
          const startRunner = () => {
            const child = Bun.spawn([process.execPath, "--eval", childCode], {
              env: {
                ...process.env,
                HERCULE_HOME: home,
                PATH: `${executables}:${process.env["PATH"] ?? "/usr/bin:/bin"}`,
              },
              stdout: "ignore",
              stderr: "pipe",
            });
            children.push(child);
            return child;
          };
          const runner = startRunner();
          const runnerErrors = new Response(runner.stderr).text();
          await waitUntil("paused real runner preparation", () => {
            if (runner.exitCode !== null)
              throw new Error("proof runner exited before its preparation barrier");
            return existsSync(capturedChild) ? true : undefined;
          });
          capturedBarrierPid = Number(readFileSync(capturedChild, "utf8").trim());
          expect(capturedBarrierPid).toBeGreaterThan(0);
          expect(await readSessionStatus()).toBe("queued");
          expect((await readWorkspace(arranged, workspaceId)).status).toBe("provisioning");
          runner.kill("SIGKILL");
          await runner.exited;
          await stopCapturedProcess(capturedBarrierPid);
          capturedBarrierPid = undefined;
          await runnerErrors;

          const restarted = startRunner();
          const restartedErrors = new Response(restarted.stderr).text();
          const failed = await waitUntil("recorded real runner interruption", async () => {
            const workspace = await readWorkspace(arranged, workspaceId);
            return workspace.status === "failed" ? workspace : undefined;
          });
          expect(failed.message).toMatch(/preparation.*interrupted|interrupted.*preparation/i);
          await waitUntil("failed its queued session", async () =>
            (await readSessionStatus()) === "exited" ? true : undefined,
          );
          const transcriptResponse = await get(
            arranged.harness.base,
            `/api/v1/sessions/${session.id}/transcript`,
            arranged.token,
          );
          expect(transcriptResponse.status, await transcriptResponse.clone().text()).toBe(200);
          const transcript = (await transcriptResponse.json()) as {
            readonly items: ReadonlyArray<TranscriptRow>;
          };
          expect(
            transcript.items.find((row) => row.event._tag === "session.exited")?.event,
          ).toMatchObject({
            _tag: "session.exited",
            reason: "workspace_failed",
            message: failed.message,
          });
          expect(transcript.items.some((row) => row.event._tag === "session.started")).toBe(false);
          expect(existsSync(counter) ? readFileSync(counter, "utf8") : "").toBe(
            stage === "during setup" ? "called\n" : "",
          );
          expect(failed.provisionedAt).toBeNull();
          restarted.kill("SIGKILL");
          await restarted.exited;
          await restartedErrors;
        } finally {
          bootstrap.socket.close();
          for (const child of children) {
            if (child.exitCode === null) child.kill("SIGKILL");
            await child.exited;
            await waitForProcessGone(child.pid);
          }
          if (capturedBarrierPid !== undefined) await stopCapturedProcess(capturedBarrierPid);
        }
      });
    },
    30_000,
  );
});
