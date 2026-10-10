/** Runs the production controller and a protocol fixture over real sockets in throwaway Homes. */
import { resolve, join } from "node:path";
import { expect } from "vitest";
import * as Effect from "effect/Effect";
import { buildCleanEnv } from "../../../../../scripts/controller-process";
import {
  AGENT_STEPS_CAPABILITY,
  PROTOCOL_VERSION,
  WORKSPACE_LIFECYCLE_CAPABILITY,
  type ControllerToRunner,
  type JoinAnswer,
  type RunnerToController,
} from "@hercule/protocol";
import type { Workspaces } from "../../../../runner/src/workspaces";
import { buildRunnerSocketUrl } from "../../runners/testing";
import { waitUntil } from "../../sessions/testing";
import { FACTS, MODELS } from "../../workspaces/testing";

const controllerRoot = resolve(import.meta.dirname, "../..");
// The server binds port 0, and the process prints the port the system gave
// it. A port picked by the test and handed to the process could be taken by
// another process before the server binds it. The configured `bind.port` is
// left at its default: it only sets the origin of the setup URL, and the
// tests read just the token from that URL.
const controllerCode = `
  import { Effect } from "effect";
  import * as HttpServer from "effect/unstable/http/HttpServer";
  import * as BunHttpServer from "@effect/platform-bun/BunHttpServer";
  import { claudeCode } from "@hercule/plugin-claude-code";
  import { bootWith } from ${JSON.stringify(join(controllerRoot, "bootstrap.ts"))};
  import { operationLayers, bodyLimits, serve } from ${JSON.stringify(join(controllerRoot, "http/index.ts"))};
  await Effect.runPromise(bootWith({
    argv: [], env: process.env,
    masterKeyBackend: "file", plugins: [claudeCode]
  }, () => Effect.gen(function* () {
    yield* serve(undefined);
    const { address } = yield* HttpServer.HttpServer;
    if (address._tag !== "TcpAddress") throw new Error("expected a TCP address");
    console.log("proof controller listening on port " + address.port);
    yield* Effect.never;
  }).pipe(Effect.provide(operationLayers),
    Effect.provide(BunHttpServer.layer({ hostname: "127.0.0.1", port: 0, ...bodyLimits })))));
`;

const assertProcessGone = (pid: number): void => {
  expect(() => process.kill(pid, 0)).toThrow();
};

/**
 * Starts the production controller in a child process on the Home `home`,
 * listening on a free loopback port. Returns its base URL, which changes on
 * every start, and a function that kills it. Fails when the process exits or
 * does not answer within the wait deadline.
 */
export const startControllerProcess = async (home: string) => {
  const child = Bun.spawn([process.execPath, "--eval", controllerCode], {
    cwd: controllerRoot,
    env: { ...buildCleanEnv(), HERCULE_HOME: home },
    stdout: "pipe",
    stderr: "pipe",
  });
  const stdout: Array<string> = [];
  const stderr = new Response(child.stderr).text();
  const output = (async () => {
    const reader = child.stdout.getReader();
    const decoder = new TextDecoder();
    for (;;) {
      const item = await reader.read();
      if (item.done) return;
      stdout.push(decoder.decode(item.value));
    }
  })();
  let base = "";
  const stop = async (): Promise<void> => {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
    await Promise.all([output, stderr]);
    assertProcessGone(child.pid);
    if (base !== "") await expect(fetch(`${base}/api/v1/setup`)).rejects.toThrow();
  };
  try {
    await waitUntil("started the file-backed controller process", async () => {
      if (child.exitCode !== null) throw new Error(`Proof controller exited: ${await stderr}`);
      const port = /proof controller listening on port (\d+)/.exec(stdout.join(""))?.[1];
      if (port === undefined) return undefined;
      base = `http://127.0.0.1:${port}`;
      try {
        return (await fetch(`${base}/api/v1/setup`)).ok ? true : undefined;
      } catch {
        return undefined;
      }
    });
  } catch (error) {
    await stop();
    throw error;
  }
  return { base, stop };
};

export const connectProofRunner = async (
  base: string,
  joined: Pick<JoinAnswer, "credential">,
  options: { readonly workspaces?: Workspaces; readonly finishSessions?: boolean } = {},
) => {
  const frames: Array<ControllerToRunner> = [];
  const socket = new WebSocket(buildRunnerSocketUrl(base), {
    headers: { authorization: `Bearer ${joined.credential}` },
  });
  const write = (frame: RunnerToController): void => socket.send(JSON.stringify(frame));
  let sequence = 0;
  socket.onmessage = (event) => {
    const frame = JSON.parse(String(event.data)) as ControllerToRunner;
    frames.push(frame);
    switch (frame._tag) {
      case "controllerHello":
        write({ _tag: "sessionsReport", sessions: [] });
        break;
      case "ping":
        write({ _tag: "pong" });
        break;
      case "probeRequest":
        write({
          _tag: "probeReport",
          requestId: frame.requestId,
          instanceId: frame.instanceId,
          result: { harnessVersion: "1.0.0", auth: { status: "ok" }, models: MODELS },
        });
        break;
      case "workspaceInspect":
        if (options.workspaces !== undefined)
          void Effect.runPromise(options.workspaces.inspect(frame.workspaceId)).then((report) =>
            write({ _tag: "workspaceInspection", requestId: frame.requestId, report }),
          );
        break;
      case "sessionStart":
        if (options.finishSessions === false) break;
        // Filesystem proofs finish the synthetic session without executing a provider or spending tokens.
        write({
          _tag: "sessionInputResult",
          requestId: frame.requestId,
          ok: true,
          delivery: "opened",
        });
        write({
          _tag: "sessionEvent",
          seq: ++sequence,
          event: {
            _tag: "session.exited",
            eventId: crypto.randomUUID(),
            sessionId: frame.sessionId,
            at: new Date().toISOString(),
            reason: "stopped",
          },
        });
        break;
    }
  };
  await new Promise<void>((opened, reject) => {
    socket.onopen = () => {
      write({
        _tag: "runnerHello",
        protocolVersion: PROTOCOL_VERSION,
        capabilities: [WORKSPACE_LIFECYCLE_CAPABILITY, AGENT_STEPS_CAPABILITY],
        binaryVersion: "0.1.0",
        nonce: Buffer.from(crypto.getRandomValues(new Uint8Array(16))).toString("base64"),
        facts: {
          ...FACTS,
          providers: [{ name: "claude", present: true, path: "/fixture/claude" }],
          adapters: ["claude-code"],
        },
      });
      opened();
    };
    socket.onerror = () => reject(new Error("The controller rejected the proof runner socket."));
  });
  return { frames, write, close: () => socket.close() };
};

export type ProofRunner = Awaited<ReturnType<typeof connectProofRunner>>;
