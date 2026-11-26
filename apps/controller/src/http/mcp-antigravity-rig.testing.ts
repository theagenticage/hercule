/**
 * The controller side of the test that runs the real `agy` against the real MCP
 * Gateway (`mcp-antigravity.integration.test.ts`). It adds two things to the
 * rig of `mcp-gateway-rig.testing.ts`:
 *
 * - a recorder in front of the recording proxy that keeps the `Authorization`
 *   header of every request, which the recording proxy does not keep, and that
 *   can answer one request with 404 without forwarding it;
 * - a way to end the Thread's session and resume it, which makes the
 *   controller mint a new session token, as a real resume does.
 */
import { expect } from "vitest";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import {
  at,
  createProfile,
  readSessionToken,
  reportEvent,
  spawnThreadUnder,
  waitForSession,
  waitForStartFrames,
} from "../sessions/testing";
import {
  createServers,
  eventually,
  readServer,
  requestCheck,
  type FakeTool,
  type FakeUpstream,
} from "../mcp-servers/testing";
import { withFleet } from "../workspaces/testing";
import { startRecordingProxy, type RecordingProxy } from "./mcp-recording-proxy.testing";
import { post, send } from "./testing";

/** One request that reached the recorder, from the harness. */
export interface RecordedBearerRequest {
  readonly httpMethod: string;
  /** The JSON-RPC method of a POST, and `-` for a request with no body. */
  readonly rpcMethod: string;
  /** The tool a `tools/call` names, and `null` for every other request. */
  readonly tool: string | null;
  /** The whole `Authorization` header, or `null` when the request had none. */
  readonly authorization: string | null;
  /** The status the request was answered with, or `undefined` while it is open. */
  status: number | undefined;
}

/** A server in front of the recording proxy that keeps the `Authorization` header of each request. */
export interface BearerRecorder {
  readonly url: string;
  readonly seen: ReadonlyArray<RecordedBearerRequest>;
  /** Answers the next POST with this JSON-RPC method with 404, as a gateway does for an MCP session it forgot, and never forwards it. */
  readonly refuseNext: (rpcMethod: string) => void;
  readonly stop: () => Promise<void>;
}

/** Starts a recorder that forwards every request to `target` and keeps what it saw. */
export const startBearerRecorder = (target: string): BearerRecorder => {
  const seen: Array<RecordedBearerRequest> = [];
  const refusals = new Set<string>();
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    idleTimeout: 0,
    async fetch(request) {
      const address = new URL(request.url);
      const text = request.method === "POST" ? await request.text() : undefined;
      const message =
        text === undefined
          ? undefined
          : (JSON.parse(text) as { method?: string; params?: { name?: string } });
      const rpcMethod = message === undefined ? "-" : (message.method ?? "?");
      const recorded: RecordedBearerRequest = {
        httpMethod: request.method,
        rpcMethod,
        tool: rpcMethod === "tools/call" ? (message?.params?.name ?? null) : null,
        authorization: request.headers.get("authorization"),
        status: undefined,
      };
      seen.push(recorded);
      if (request.method === "POST" && refusals.delete(rpcMethod)) {
        recorded.status = 404;
        return Response.json(
          { jsonrpc: "2.0", id: null, error: { code: -32001, message: "Session not found" } },
          { status: 404 },
        );
      }
      const headers = new Headers(request.headers);
      headers.delete("host");
      headers.delete("content-length");
      const answer = await fetch(`${target}${address.pathname}${address.search}`, {
        method: request.method,
        headers,
        ...(text === undefined ? {} : { body: text }),
        signal: request.signal,
      });
      recorded.status = answer.status;
      return new Response(answer.body, { status: answer.status, headers: answer.headers });
    },
  });
  return {
    url: `http://127.0.0.1:${String(server.port)}`,
    seen,
    refuseNext: (rpcMethod) => {
      refusals.add(rpcMethod);
    },
    stop: async () => {
      await server.stop(true);
    },
  };
};

/** What a test needs to reach the gateway as the real `agy` does. */
export interface AntigravityGatewayRig {
  /** The recording proxy between the recorder and the controller. */
  readonly proxy: RecordingProxy;
  readonly recorder: BearerRecorder;
  /** The address `agy` is given: the recorder. */
  readonly gatewayUrl: string;
  /** The token of the session's current process. A resume replaces it. */
  readonly sessionToken: () => string;
  /** Replaces the Thread's list with the servers called `names`. */
  readonly setList: (names: ReadonlyArray<string>) => Promise<void>;
  /**
   * Makes the fake MCP server list `tools` from now on, and returns once the
   * controller's stored list follows. The gateway then sends `list_changed`.
   */
  readonly replaceTools: (tools: ReadonlyArray<FakeTool>) => Promise<void>;
  /**
   * Ends the session and resumes it with an input, the way the controller
   * resumes a session: the same session, started again with a new token.
   * Returns the new token, which `sessionToken` returns from now on.
   */
  readonly resumeSession: () => Promise<string>;
}

/**
 * Runs `body` against a controller whose desk plugin serves `upstream`, with a
 * ready MCP Server for each of `serverNames` and a live Thread whose list
 * holds the servers called `listed`. The recording proxy and the recorder
 * stand in front of the controller.
 */
export const withAntigravityGatewayRig = (
  options: {
    readonly upstream: FakeUpstream;
    readonly serverNames: ReadonlyArray<string>;
    readonly listed: ReadonlyArray<string>;
  },
  body: (rig: AntigravityGatewayRig) => Promise<void>,
): Promise<void> =>
  withFleet(
    async (arranged) => {
      const controller = {
        harness: arranged.harness,
        base: arranged.harness.base,
        token: arranged.token,
      };
      const servers = await createServers(controller, options.serverNames);
      for (const server of servers) {
        await eventually(
          () => readServer(controller, server.id),
          (record) => record.status === "ready",
        );
      }
      const idsByName = Object.fromEntries(servers.map((server) => [server.name, server.id]));
      const profile = await createProfile(arranged, "antigravity-gateway", ["mcp.use"]);
      const thread = await spawnThreadUnder(arranged, profile, {
        mcpServerIds: options.listed.map((name) => idsByName[name]!),
      });
      const proxy = startRecordingProxy(arranged.harness.base, {
        answerDiscoverLikeOlderServer: false,
      });
      const recorder = startBearerRecorder(proxy.url);
      let token = thread.token;
      try {
        await body({
          proxy,
          recorder,
          gatewayUrl: recorder.url,
          sessionToken: () => token,
          setList: async (names) => {
            const response = await send(
              "PATCH",
              arranged.harness.base,
              `/api/v1/sessions/${thread.session.id}`,
              {
                body: { mcpServerIds: names.map((name) => idsByName[name]) },
                token: arranged.token,
              },
            );
            expect(response.status).toBe(200);
          },
          replaceTools: async (tools) => {
            await options.upstream.configure({ tools });
            for (const server of servers) {
              expect((await requestCheck(controller, server.id)).status).toBe(200);
              await eventually(
                async () => (await readServer(controller, server.id)).tools.length,
                (count) => count === tools.length,
              );
            }
          },
          resumeSession: async () => {
            const sessionId = thread.session.id;
            reportEvent(arranged.wire, 2, {
              eventId: crypto.randomUUID(),
              sessionId,
              at,
              _tag: "session.exited",
              reason: "stopped",
            });
            await waitForSession(arranged, sessionId, (one) => one.status === "exited");
            const resumed = await post(
              arranged.harness.base,
              `/api/v1/sessions/${sessionId}/input`,
              { text: "carry on" },
              arranged.token,
            );
            expect(resumed.status, await resumed.clone().text()).toBe(200);
            const frames = await waitForStartFrames(arranged, sessionId, 2);
            token = readSessionToken(frames[1]!);
            reportEvent(arranged.wire, 1, {
              eventId: crypto.randomUUID(),
              sessionId,
              at,
              _tag: "session.started",
              harnessRefs: { nativeSessionId: "native-1" },
            });
            await waitForSession(arranged, sessionId, (one) => one.status === "busy");
            return token;
          },
        });
      } finally {
        await recorder.stop();
        await proxy.stop();
      }
    },
    {
      plugins: [
        buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", options.upstream) }),
      ],
    },
  );
