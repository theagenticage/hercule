/**
 * The controller side of the tests that run a real harness (Claude Code, Codex,
 * pi) against the real MCP Gateway: a Thread whose list holds MCP Servers, with
 * a recording proxy in front of the controller. The harness's own process and
 * its stand-in model stay in each test file, because they differ per harness.
 */
import { expect } from "vitest";
import { buildDeskMcpServer, buildMcpServerPlugin } from "../plugins/testing";
import { createProfile, spawnThreadUnder, type Arranged } from "../sessions/testing";
import {
  createServers,
  eventually,
  readServer,
  requestCheck,
  type FakeTool,
  type FakeUpstream,
} from "../mcp-servers/testing";
import {
  requestsOf,
  startRecordingProxy,
  type RecordingProxy,
} from "./mcp-recording-proxy.testing";
import { send } from "./testing";
import { withFleet } from "../workspaces/testing";

/** The revisions of the older wire era, which Codex and pi ask `initialize` for. */
export const OLDER_ERA_REVISIONS = ["2025-03-26", "2025-06-18", "2025-11-25"];

/** The one tool of the fake MCP server in the tests of Codex and pi. */
export const WHOAMI_TOOL: FakeTool = {
  name: "whoami",
  description: "Returns the user the server acts as",
};

/** A tool of the fake MCP server whose description ends with its own name in square brackets, which is how a test tells which tool a harness shows under a name. */
export const buildTwinTool = (name: string): FakeTool => ({
  name,
  description: `Searches [${name}]`,
});

/**
 * One way the tools of a server change under a harness that has already shown
 * a name to the model: the tools the server lists in each state, in order, and
 * the tool whose name the model used in the first state. `search_pages` and
 * `search-pages` are the twins: a harness that folds `-` into `_` shows them
 * alike.
 */
export interface TwinScenario {
  readonly title: string;
  readonly states: ReadonlyArray<ReadonlyArray<string>>;
  readonly calledTool: string;
}

const UNDERSCORE = "search_pages";
const HYPHEN = "search-pages";
const BOTH = [UNDERSCORE, HYPHEN];

/** The twin comes, the twin goes, the twin comes and goes, and one tool is swapped for the other. */
export const TWIN_SCENARIOS: ReadonlyArray<TwinScenario> = [
  {
    title: "search-pages added to search_pages",
    states: [[UNDERSCORE], BOTH],
    calledTool: UNDERSCORE,
  },
  { title: "search_pages added to search-pages", states: [[HYPHEN], BOTH], calledTool: HYPHEN },
  {
    title: "search-pages removed, search_pages called and stays",
    states: [BOTH, [UNDERSCORE]],
    calledTool: UNDERSCORE,
  },
  {
    title: "search_pages removed, search-pages called and stays",
    states: [BOTH, [HYPHEN]],
    calledTool: HYPHEN,
  },
  { title: "search-pages called and removed", states: [BOTH, [UNDERSCORE]], calledTool: HYPHEN },
  { title: "search_pages called and removed", states: [BOTH, [HYPHEN]], calledTool: UNDERSCORE },
  {
    title: "search_pages, both, search-pages",
    states: [[UNDERSCORE], BOTH, [HYPHEN]],
    calledTool: UNDERSCORE,
  },
  {
    title: "search-pages, both, search_pages",
    states: [[HYPHEN], BOTH, [UNDERSCORE]],
    calledTool: HYPHEN,
  },
  {
    title: "search_pages swapped for search-pages",
    states: [[UNDERSCORE], [HYPHEN]],
    calledTool: UNDERSCORE,
  },
  {
    title: "search-pages swapped for search_pages",
    states: [[HYPHEN], [UNDERSCORE]],
    calledTool: HYPHEN,
  },
];

/** What a test needs to reach the gateway as a harness does. */
export interface GatewayRig {
  readonly proxy: RecordingProxy;
  /** The address the harness is given: the recording proxy in front of the controller. */
  readonly gatewayUrl: string;
  readonly sessionToken: string;
  /** The session whose list the gateway serves. */
  readonly sessionId: string;
  /** Replaces the Thread's list with the servers called `names`. */
  readonly setList: (names: ReadonlyArray<string>) => Promise<void>;
  /**
   * Makes the gateway forget the MCP session that the harness holds, as a
   * restart does for every session, and returns the id of the session that was
   * forgotten. The harness is not told. Needs a recorded `initialize` and
   * `tools/list`.
   */
  readonly forgetMcpSession: () => Promise<string>;
}

/** A `GatewayRig` that can also change what the fake MCP server lists. */
export interface ToolChangingGatewayRig extends GatewayRig {
  /**
   * Makes the fake MCP server list `tools` from now on, checks every server of
   * the rig again so that the controller's stored list follows, and returns once
   * it does. The gateway then sends `list_changed` to the harness's streams.
   */
  readonly replaceTools: (tools: ReadonlyArray<FakeTool>) => Promise<void>;
}

/** Returns the `tools/call` requests the fake MCP server received. */
export const readUpstreamCalls = (upstream: FakeUpstream) =>
  upstream.requests.filter((one) => one.method === "tools/call");

/**
 * Spawns a live Thread whose list holds the servers `serverIds` and puts the
 * recording proxy in front of the controller. Calls `body` with the rig and
 * stops the proxy afterwards. `idsByName` says which server `setList` means by
 * each name.
 */
export const withThreadOnGateway = async (
  arranged: Arranged,
  options: {
    readonly profileName: string;
    readonly serverIds: ReadonlyArray<string>;
    readonly idsByName?: Readonly<Record<string, string>>;
    readonly answerDiscoverLikeOlderServer: boolean;
  },
  body: (rig: GatewayRig) => Promise<void>,
): Promise<void> => {
  const profile = await createProfile(arranged, options.profileName, ["mcp.use"]);
  const thread = await spawnThreadUnder(arranged, profile, {
    mcpServerIds: [...options.serverIds],
  });
  const proxy = startRecordingProxy(arranged.harness.base, {
    answerDiscoverLikeOlderServer: options.answerDiscoverLikeOlderServer,
  });
  try {
    await body({
      proxy,
      gatewayUrl: proxy.url,
      sessionToken: thread.token,
      sessionId: thread.session.id,
      setList: async (names) => {
        const response = await send(
          "PATCH",
          arranged.harness.base,
          `/api/v1/sessions/${thread.session.id}`,
          {
            body: { mcpServerIds: names.map((name) => options.idsByName![name]) },
            token: arranged.token,
          },
        );
        expect(response.status).toBe(200);
      },
      forgetMcpSession: async () => {
        const [initialize] = requestsOf(proxy.seen, "initialize");
        const [list] = requestsOf(proxy.seen, "tools/list");
        const gone = await fetch(`${proxy.url}/mcp`, {
          method: "DELETE",
          headers: {
            authorization: `Bearer ${thread.token}`,
            "mcp-session-id": initialize!.answeredSessionId!,
            "mcp-protocol-version": list!.protocolVersion!,
          },
        });
        expect(gone.status).toBe(204);
        return initialize!.answeredSessionId!;
      },
    });
  } finally {
    await proxy.stop();
  }
};

/**
 * Runs `body` against a controller whose desk plugin serves `upstream`, with
 * one ready MCP Server for each of `serverNames` and a live Thread whose list
 * holds the servers called `listed`, behind a recording proxy.
 */
export const withGatewayRig = (
  options: {
    readonly upstream: FakeUpstream;
    readonly profileName: string;
    readonly serverNames: ReadonlyArray<string>;
    readonly listed: ReadonlyArray<string>;
    readonly answerDiscoverLikeOlderServer: boolean;
  },
  body: (rig: ToolChangingGatewayRig) => Promise<void>,
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
      await withThreadOnGateway(
        arranged,
        {
          profileName: options.profileName,
          serverIds: options.listed.map((name) => idsByName[name]!),
          idsByName,
          answerDiscoverLikeOlderServer: options.answerDiscoverLikeOlderServer,
        },
        (rig) =>
          body({
            ...rig,
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
          }),
      );
    },
    {
      plugins: [
        buildMcpServerPlugin("acme", { server: buildDeskMcpServer("acme", options.upstream) }),
      ],
    },
  );
