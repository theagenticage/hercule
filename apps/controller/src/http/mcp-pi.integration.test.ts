/**
 * Runs the real pi against the real MCP Gateway, to check what the spec could
 * only assume (spec 21 section 3.11): that pi works on the older wire era,
 * finds a gateway tool with `tool_search` and calls it, hears
 * `notifications/tools/list_changed` and lists again, opens a new MCP session
 * when the gateway answers 404 for the one it holds and then sends its call
 * again, which reaches the right tool, calls a hyphenated tool and a tool whose
 * name has a dot, never shows the model a tool name of more than 64
 * characters, runs a call from a first input that arrives before pi has
 * listed the tools, and never runs the other tool under a name it showed when
 * a twin with `-` or `_` comes or goes. What a user sees of approvals and items is checked beside the
 * adapter, in `apps/runner/src/harnesses/pi/adapter-mcp.integration.test.ts`.
 *
 * Nothing here is billed and no login is used. pi starts through the pi
 * adapter's own `startSession`, as it does in a real session
 * (`startRealPiSession`), so its command line, its extension and the gateway's
 * address are the adapter's. The session token is in `HERCULE_TOKEN`. The
 * environment is built from nothing (a throwaway `HOME` and Harness Home). The
 * model is the local stand-in of `apps/runner/src/harnesses/pi/upstream.ts`,
 * scripted to find a tool with `tool_search` and call it, so no real model is
 * reached.
 *
 * A recording proxy sits between pi and the controller and keeps what the
 * gateway receives, as in `mcp-codex.integration.test.ts`.
 *
 * What this file does not assert:
 *
 * - **A real cold gateway.** The test controller cannot restart over the same
 *   database: `withServer` makes a new Hercule Home and a new gateway for
 *   each run, and its `reboot` repeats only the boot steps inside the same
 *   process, so the gateway keeps the names it has offered. The 404 test drops
 *   pi's MCP session at the gateway, which is what a restart does to the
 *   session, but the gateway still holds every name it offered. After a
 *   restart the gateway would refuse a call before the list once (spec 21
 *   section 3.4). `http/mcp.integration.test.ts` checks that with a token the
 *   gateway has not served.
 * - **A real model.** The stand-in calls the tool the search returned. What a
 *   real model chooses to search for is not checked.
 *
 * Skipped when no `pi` binary is found. `HERCULE_PI_TEST_BINARY` selects one
 * without changing `PATH`. No CI job installs pi, so this file runs on a
 * developer's machine only.
 */
import { afterAll, describe, expect, it } from "vitest";
import {
  MCP_GATEWAY_ENTRY_NAME,
  MCP_GATEWAY_HARNESS_PREFIX,
  MCP_GATEWAY_TOOL_SEPARATOR,
  type SessionSpec,
} from "@hercule/protocol";
import { findPiTestBinary } from "../../../runner/src/harnesses/pi/pi-binary.testing";
import {
  buildMcpCallScript,
  TOOL_SEARCH_TOOL,
} from "../../../runner/src/harnesses/pi/mcp-model.testing";
import {
  startRealPiSession,
  type RealPiSession,
} from "../../../runner/src/harnesses/pi/real-pi-session.testing";
import { cleanupHomes, filterByTag } from "../../../runner/src/harnesses/pi/testing";
import {
  readRequestMessageText,
  startScriptedModelServer,
  type FakeModelReply,
  type FakeModelRequest,
  type FakeModelScript,
  type FakeModelServer,
} from "../../../runner/src/harnesses/pi/upstream";
import { startFakeUpstream, type FakeTool, type FakeUpstream } from "../mcp-servers/testing";
import {
  OLDER_ERA_REVISIONS,
  TWIN_SCENARIOS,
  WHOAMI_TOOL,
  buildTwinTool,
  readUpstreamCalls,
  withGatewayRig,
  type ToolChangingGatewayRig,
} from "./mcp-gateway-rig.testing";
import {
  countListChanged,
  describeRequest,
  requestsOf,
  waitUntilQuiet,
} from "./mcp-recording-proxy.testing";
import { waitWithin } from "./testing";

const piBinary = findPiTestBinary();

/** The most one step of these tests waits for pi, which is a separate process that starts slowly. */
const STEP_MS = 30_000;

/** The test's own limit, with room for pi to start and for several turns. */
const TEST_MS = 120_000;

/** The most a test of the twins takes: each runs one pi process for its scenario. */
const TWIN_TEST_MS = 120_000;

/** How long the gateway holds back its first list in the test of an input that arrives before it. Longer than pi needs to start and ask the model. */
const LATE_LIST_MS = 2_000;

/** The name of the one MCP Server the tests give the Thread. */
const SERVER_NAME = "sentry";

/** The tool the model is shown for `sentry`'s `whoami`: pi's `mcp__tools__` prefix and the gateway's `<server>__<tool>`. */
const WHOAMI = `mcp__${MCP_GATEWAY_ENTRY_NAME}__${SERVER_NAME}__whoami`;

/** The longest tool name a model may be shown: pi's own limit. */
const MAX_TOOL_NAME_LENGTH = 64;

afterAll(cleanupHomes);

// -- What the model was shown -------------------------------------------------

/** Parses the completion requests pi has sent to the stand-in model, oldest first. */
const readModelRequests = (model: FakeModelServer): ReadonlyArray<FakeModelRequest> =>
  model.requests().map((body) => JSON.parse(body) as FakeModelRequest);

/** Returns the names of the gateway's tools pi declared to the model in any request, once each. */
const readDeclaredGatewayTools = (model: FakeModelServer): ReadonlyArray<string> => [
  ...new Set(
    readModelRequests(model).flatMap((request) =>
      (request.tools ?? [])
        .map((tool) => tool.function.name)
        .filter((name) => name.startsWith(`mcp__${MCP_GATEWAY_ENTRY_NAME}__`)),
    ),
  ),
];

/** Returns the text of every tool result the model has been sent, in the order of the conversation. */
const readToolResults = (model: FakeModelServer): ReadonlyArray<string> =>
  (readModelRequests(model).at(-1)?.messages ?? [])
    .filter((message) => message.role === "tool")
    .map(readRequestMessageText);

/**
 * Builds a script that calls one gateway tool by the gateway's own name. The
 * tools of such a test carry their gateway name at the end of their
 * description, in square brackets, and the script finds a tool by that.
 *
 * The prompt `call <name>` makes the model call the tool whose description
 * ends with `[<name>]`: directly when pi has declared it already, and else
 * after a `tool_search` for `pages`, which loads every tool of the server.
 */
const buildCallByDescriptionScript =
  (): FakeModelScript =>
  (request): FakeModelReply => {
    const last = request.messages.at(-1);
    const readWantedName = () =>
      /^call (\S+)$/.exec(
        readRequestMessageText(request.messages.findLast((message) => message.role === "user")!),
      )?.[1];
    if (last?.role === "user") {
      const wanted = /^call (\S+)$/.exec(readRequestMessageText(last))?.[1];
      if (wanted === undefined) return { text: "There is nothing to do." };
      const declared = (
        (request.tools ?? []) as ReadonlyArray<{
          readonly function: { readonly name: string; readonly description?: string };
        }>
      ).find((tool) => tool.function.description?.endsWith(`[${wanted}]`))?.function.name;
      return declared === undefined
        ? { toolCalls: [{ name: TOOL_SEARCH_TOOL, args: { query: "pages" } }] }
        : { toolCalls: [{ name: declared, args: { text: "hello" } }] };
    }
    const calledSearch =
      request.messages.findLast((message) => message.role === "assistant")?.tool_calls?.[0]
        ?.function.name === TOOL_SEARCH_TOOL;
    if (last?.role === "tool" && calledSearch) {
      const found = [...readRequestMessageText(last).matchAll(/^- (mcp__\S+?): (.*)$/gm)];
      const chosen = found.find((one) => one[2]!.endsWith(`[${readWantedName()}]`))?.[1];
      return chosen === undefined
        ? { text: "The search found no tool." }
        : { toolCalls: [{ name: chosen, args: { text: "hello" } }] };
    }
    return { text: "Done." };
  };

// -- The gateway -------------------------------------------------------------

/** What `withGateway` gives a test. */
interface Gateway extends ToolChangingGatewayRig {
  readonly upstream: FakeUpstream;
  readonly model: FakeModelServer;
}

/**
 * Runs `body` against a controller with a live Thread, a recording proxy in
 * front of the controller, a fake MCP server named `sentry` that lists `tools`,
 * and a stand-in model. The Thread's list holds `sentry` when `listed` is true.
 * Each call gets its own fake server, so a test counts calls from zero.
 */
const withGateway = async (
  options: {
    readonly listed: boolean;
    readonly tools?: ReadonlyArray<FakeTool>;
    readonly script?: FakeModelScript;
  },
  body: (gateway: Gateway) => Promise<void>,
): Promise<void> => {
  const upstream = await startFakeUpstream({ tools: options.tools ?? [WHOAMI_TOOL] });
  const model = startScriptedModelServer(options.script ?? buildMcpCallScript());
  try {
    await withGatewayRig(
      {
        upstream,
        profileName: "pi-gateway",
        serverNames: [SERVER_NAME],
        listed: options.listed ? [SERVER_NAME] : [],
        answerDiscoverLikeOlderServer: false,
      },
      (rig) => body({ ...rig, upstream, model }),
    );
  } finally {
    model.stop();
    await upstream.stop();
  }
};

/** Starts a pi session on the gateway of `gateway`. In full-access, the default, no call waits for an approval. */
const startPiOnGateway = (
  gateway: Gateway,
  accessMode: SessionSpec["accessMode"] = "full-access",
): Promise<RealPiSession> =>
  startRealPiSession({
    binary: piBinary!,
    mcpUrl: `${gateway.gatewayUrl}/mcp`,
    sessionToken: gateway.sessionToken,
    model: gateway.model,
    accessMode,
  });

/**
 * Runs `body` with a started pi on a gateway whose session lists `sentry` when
 * `listed` is true. The pi has opened its MCP session and listed the tools
 * before `body` starts: a person types for longer than pi needs to connect,
 * and `tool_search` finds nothing before the list has arrived. The pi is
 * stopped before the gateway is.
 */
const withPiOnGateway = (
  options: {
    readonly listed: boolean;
    readonly tools?: ReadonlyArray<FakeTool>;
    readonly script?: FakeModelScript;
    readonly accessMode?: SessionSpec["accessMode"];
  },
  body: (gateway: Gateway, running: RealPiSession) => Promise<void>,
): Promise<void> =>
  withGateway(options, async (gateway) => {
    const running = await startPiOnGateway(gateway, options.accessMode);
    try {
      expect(
        await waitWithin(STEP_MS, () => requestsOf(gateway.proxy.seen, "tools/list").length > 0),
        "pi listed the tools",
      ).toBe(true);
      expect(
        await waitWithin(STEP_MS, () =>
          requestsOf(gateway.proxy.seen, "GET").some((one) => one.status === 200),
        ),
        "the GET stream is open",
      ).toBe(true);
      await body(gateway, running);
    } finally {
      await running.stop();
    }
  });

describe.skipIf(piBinary === undefined)("the real pi on the MCP Gateway", () => {
  it(
    "initializes on the older era, finds a gateway tool with tool_search and calls it upstream once",
    async () => {
      await withPiOnGateway({ listed: true }, async (rig, running) => {
        await running.runTurn("find whoami");

        // The handshake: initialize, then initialized, the GET stream and the list, each on the MCP session initialize made.
        const [initialize] = requestsOf(rig.proxy.seen, "initialize");
        expect(OLDER_ERA_REVISIONS, "the revision pi asked for").toContain(
          initialize!.initializeRevision,
        );
        expect(describeRequest(initialize!)).toBe("POST initialize no-revision no-session 200");
        const mcpSessionId = initialize!.answeredSessionId!;
        expect(mcpSessionId).not.toBeNull();
        const methods = rig.proxy.seen.map((one) =>
          one.httpMethod === "GET" ? "GET" : one.rpcMethod,
        );
        expect(methods.slice(0, 2)).toEqual(["initialize", "notifications/initialized"]);
        expect(methods.indexOf("GET")).toBeGreaterThan(1);
        for (const method of ["notifications/initialized", "GET", "tools/list", "tools/call"]) {
          const [one] = requestsOf(rig.proxy.seen, method);
          expect(one!.sessionId, method).toBe(mcpSessionId);
          expect(one!.protocolVersion, method).toBe(initialize!.initializeRevision);
        }
        expect(requestsOf(rig.proxy.seen, "server/discover")).toEqual([]);

        // pi declared the tool under the gateway's name only after tool_search loaded it, and the call reaches the server once.
        expect(readDeclaredGatewayTools(rig.model)).toEqual([WHOAMI]);
        expect(requestsOf(rig.proxy.seen, "tools/call").map((one) => one.tool)).toEqual([
          `${SERVER_NAME}__whoami`,
        ]);
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
        expect(readToolResults(rig.model).at(-1)).toContain("hello");
      });
    },
    TEST_MS,
  );

  it(
    "runs a call from a first input that arrives before pi has listed the tools",
    async () => {
      await withGateway({ listed: true }, async (rig) => {
        // The gateway answers the list late, so pi has not got it when the input arrives and `tool_search` runs.
        rig.proxy.delayRequests("tools/list", LATE_LIST_MS);
        const running = await startPiOnGateway(rig);
        try {
          expect(
            requestsOf(rig.proxy.seen, "tools/list").filter((one) => one.status !== undefined),
            "no list was answered when the input was sent",
          ).toEqual([]);

          await running.runTurn("find whoami");

          expect(requestsOf(rig.proxy.seen, "tools/list").map((one) => one.status)).toContain(200);
          expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
          expect(readToolResults(rig.model).at(-1)).toContain("hello");
        } finally {
          await running.stop();
        }
      });
    },
    TEST_MS,
  );

  it(
    "lists again when a server is added to the Thread while pi runs, and calls the new tool once",
    async () => {
      await withPiOnGateway({ listed: false }, async (rig, running) => {
        // The gateway lists no tool yet. Let the notification it sends when the stream opens, and the
        // list that follows it, come first, so that the list counted below is the one the change causes.
        await waitUntilQuiet(rig.proxy, 1_000);
        const [get] = requestsOf(rig.proxy.seen, "GET");
        const changesBefore = countListChanged([get!]);
        const listsBefore = requestsOf(rig.proxy.seen, "tools/list").length;

        await rig.setList([SERVER_NAME]);
        expect(
          await waitWithin(STEP_MS, () => countListChanged([get!]) > changesBefore),
          "list_changed on the GET stream",
        ).toBe(true);
        expect(
          await waitWithin(
            STEP_MS,
            () => requestsOf(rig.proxy.seen, "tools/list").length > listsBefore,
          ),
          "pi listed again",
        ).toBe(true);

        // The first list was empty, so the model finds the tool only if pi listed again.
        await running.runTurn("find whoami");
        expect(readDeclaredGatewayTools(rig.model)).toEqual([WHOAMI]);
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
        // No second pi: one MCP session served the whole run.
        expect(requestsOf(rig.proxy.seen, "initialize")).toHaveLength(1);
      });
    },
    TEST_MS,
  );

  it(
    "opens a new MCP session after a 404, lists, and sends the call again, which runs and reaches the right upstream tool",
    async () => {
      await withPiOnGateway({ listed: true }, async (rig, running) => {
        await running.runTurn("find whoami");
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);
        const forgotten = await rig.forgetMcpSession();

        const mark = rig.proxy.seen.length;
        await running.runTurn("find whoami");
        const after = rig.proxy.seen.slice(mark);

        // The call goes out first on the forgotten session and gets 404. pi handshakes again, lists
        // the tools on the new session, and only then sends the same call again.
        const [refused] = requestsOf(after, "tools/call");
        expect(describeRequest(refused!)).toBe(
          `POST tools/call ${refused!.protocolVersion} session 404`,
        );
        expect(refused!.sessionId).toBe(forgotten);
        const [initialize] = requestsOf(after, "initialize");
        const newSession = initialize!.answeredSessionId!;
        expect(newSession).not.toBe(forgotten);
        const resent = requestsOf(after, "tools/call")[1]!;
        expect(describeRequest(resent)).toBe(
          `POST tools/call ${resent.protocolVersion} session 200`,
        );
        expect(resent.sessionId).toBe(newSession);
        const listedBeforeResend = requestsOf(after, "tools/list").filter(
          (list) => list.sessionId === newSession && after.indexOf(list) < after.indexOf(resent),
        );
        expect(
          listedBeforeResend.length,
          "pi listed on the new session before it resent",
        ).toBeGreaterThan(0);
        expect(after.indexOf(initialize!)).toBeLessThan(after.indexOf(listedBeforeResend[0]!));

        // The name is the same one the gateway offered before, so the resent call runs and reaches
        // the same tool. The model sees no refusal.
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual([
          "whoami",
          "whoami",
        ]);
        expect(readToolResults(rig.model).at(-1)).toContain("hello");
        expect(
          readToolResults(rig.model).filter((text) => text.includes("List the tools again")),
        ).toEqual([]);
      });
    },
    TEST_MS,
  );

  it(
    "calls a tool whose name has a hyphen and one whose name has a dot, each reaching its own upstream tool beside a tool that reads alike",
    async () => {
      const owners: ReadonlyArray<readonly [string, string]> = [
        [`${SERVER_NAME}__search_pages`, "search_pages"],
        [`${SERVER_NAME}__search_pages_f33805`, "search-pages"],
        [`${SERVER_NAME}__search_pages_52ac82`, "search.pages"],
      ];
      await withPiOnGateway(
        {
          listed: true,
          script: buildCallByDescriptionScript(),
          tools: owners.map(([name, tool]) => ({
            name: tool,
            description: `Searches the pages [${name}]`,
          })),
        },
        async (rig, running) => {
          for (const [name, tool] of owners) {
            const before = readUpstreamCalls(rig.upstream).length;
            await running.runTurn(`call ${name}`);
            expect(
              requestsOf(rig.proxy.seen, "tools/call")
                .map((one) => one.tool)
                .at(-1),
              `the gateway was called as ${name}`,
            ).toBe(name);
            expect(
              readUpstreamCalls(rig.upstream)
                .slice(before)
                .map((one) => one.tool),
              name,
            ).toEqual([tool]);
          }
        },
      );
    },
    TEST_MS,
  );

  it(
    "asks about a call on the call's own item, and shows the gateway's name for the call",
    async () => {
      const owners: ReadonlyArray<readonly [string, string]> = [
        [`${SERVER_NAME}__search_pages`, "search_pages"],
        [`${SERVER_NAME}__search_pages_f33805`, "search-pages"],
        [`${SERVER_NAME}__search_pages_52ac82`, "search.pages"],
      ];
      await withPiOnGateway(
        {
          listed: true,
          accessMode: "approval-required",
          script: buildCallByDescriptionScript(),
          tools: owners.map(([name, tool]) => ({
            name: tool,
            description: `Searches the pages [${name}]`,
          })),
        },
        async (rig, running) => {
          for (const [name] of owners) {
            const asked = running.listOpened().length;
            await running.sendInput(`call ${name}`);
            await running.waitReporting(
              `the call of ${name} was asked about`,
              () => running.listOpened().length > asked,
            );
            const opened = running.listOpened().at(-1)!;
            const started = filterByTag(running.seen, "item.started").at(-1)!;
            // The card is on the item of the call it asks about. It names the tool as pi does, which is
            // the gateway's name, because the gateway keeps no character pi would change.
            expect(opened.request.itemId).toBe(started.itemId);
            expect(opened.request.detail).toEqual({
              toolName: `mcp__${MCP_GATEWAY_ENTRY_NAME}__${SERVER_NAME}__${(started.detail as { name: string }).name}`,
            });
            expect(readDeclaredGatewayTools(rig.model)).toContain(
              (opened.request.detail as { toolName: string }).toolName,
            );

            await running.answer(opened, "allow");

            // The item shows the gateway's name, from its start to its end.
            expect(
              filterByTag(running.seen, "item.completed").find(
                (event) => event.itemId === started.itemId,
              ),
            ).toMatchObject({
              status: "completed",
              detail: {
                name: name.slice(SERVER_NAME.length + MCP_GATEWAY_TOOL_SEPARATOR.length),
                server: SERVER_NAME,
                kind: "mcp",
              },
            });
          }
        },
      );
    },
    TEST_MS,
  );

  it(
    "shows the model no tool name of more than 64 characters, and calls the right upstream tool",
    async () => {
      const longTool = `list_deployments_of_one_release_candidate_${"with_a_long_name_".repeat(3)}end`;
      expect(`mcp__${MCP_GATEWAY_ENTRY_NAME}__${SERVER_NAME}__${longTool}`.length).toBeGreaterThan(
        MAX_TOOL_NAME_LENGTH,
      );
      await withPiOnGateway(
        {
          listed: true,
          tools: [
            { name: longTool, description: "Lists the deployments of a release candidate" },
            WHOAMI_TOOL,
          ],
        },
        async (rig, running) => {
          await running.runTurn("find deployments");

          const shown = readDeclaredGatewayTools(rig.model);
          expect(shown).toHaveLength(1);
          expect(shown[0]!.length).toBeLessThanOrEqual(MAX_TOOL_NAME_LENGTH);
          expect(shown[0]).toContain("list_deployments_of_one");
          // The call reaches the tool that was meant, under its own full name.
          expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual([longTool]);
        },
      );
    },
    TEST_MS,
  );
});

// -- A name pi showed, and a twin that comes or goes ----------------------------

/**
 * Builds a script with two prompts:
 *
 * - `look`: the model searches for `pages`, which makes pi show the tools it
 *   found, and then ends the turn.
 * - `call exactly <name>`: the model calls `<name>` as it is, whether or not pi
 *   shows it now.
 */
const buildTwinScript =
  (): FakeModelScript =>
  (request): FakeModelReply => {
    const last = request.messages.at(-1);
    if (last?.role === "user") {
      const prompt = readRequestMessageText(last);
      if (prompt === "look")
        return { toolCalls: [{ name: TOOL_SEARCH_TOOL, args: { query: "pages" } }] };
      const exact = /^call exactly (\S+)$/.exec(prompt)?.[1];
      if (exact !== undefined) return { toolCalls: [{ name: exact, args: { text: "hello" } }] };
    }
    return { text: "Done." };
  };

/** What the model is shown of the twins: each name pi shows, and the tool of the server it stands for. */
type ShownTwins = Readonly<Record<string, string>>;

/** What happened to one call of a name the model chose. */
interface TwinCall {
  /** The name the gateway received. */
  readonly sentToGateway: ReadonlyArray<string>;
  /** The tools of the server that ran. */
  readonly ranUpstream: ReadonlyArray<string>;
  /** What the model was sent back for the call. */
  readonly modelWasTold: string | undefined;
}

/** What one state of the server's tools showed and did. */
interface TwinStep {
  /** The tools of the server in this state, by their original names. */
  readonly listed: ReadonlyArray<string>;
  /** What pi showed the model in the result of its search in this state. */
  readonly shown: ShownTwins;
  /** The gateway tools pi declared to the model in the last request of the search. */
  readonly declared: ReadonlyArray<string>;
  /** The call of the name the model chose in the first state. */
  readonly call: TwinCall;
}

/**
 * Starts pi on a server that lists the tools of the first of `states`, and
 * looks at what the model is shown. The model then calls the name shown for
 * the tool `calledTool`. For each next state, the server's tools are changed,
 * pi lists again, the model is shown what pi shows then, and the model calls
 * the very same name again. Returns one step for each state.
 */
const runTwinScenario = async (options: {
  readonly states: ReadonlyArray<ReadonlyArray<FakeTool>>;
  readonly calledTool: string;
}): Promise<{ readonly name: string; readonly steps: ReadonlyArray<TwinStep> }> => {
  let result: { name: string; steps: Array<TwinStep> } | undefined;
  await withPiOnGateway(
    { listed: true, tools: options.states[0]!, script: buildTwinScript() },
    async (rig, running) => {
      await waitUntilQuiet(rig.proxy, 1_000);

      /** Runs a turn in which the model searches, and returns what pi shows of the twins. */
      const look = async (): Promise<Pick<TwinStep, "shown" | "declared">> => {
        const mark = readModelRequests(rig.model).length;
        await running.runTurn("look");
        const last = readModelRequests(rig.model).slice(mark).at(-1)!;
        const result = readRequestMessageText(
          last.messages.findLast((message) => message.role === "tool")!,
        );
        return {
          shown: Object.fromEntries(
            [...result.matchAll(/^- (mcp__\S+?): (.*)$/gm)].map((found) => [
              found[1]!,
              /\[(.+)\]$/.exec(found[2]!)?.[1] ?? "?",
            ]),
          ),
          declared: (last.tools ?? [])
            .map((tool) => tool.function.name)
            .filter((name) => name.startsWith(`mcp__${MCP_GATEWAY_ENTRY_NAME}__`)),
        };
      };
      const callExactly = async (name: string): Promise<TwinCall> => {
        const gatewayMark = requestsOf(rig.proxy.seen, "tools/call").length;
        const upstreamMark = readUpstreamCalls(rig.upstream).length;
        await running.runTurn(`call exactly ${name}`);
        return {
          sentToGateway: requestsOf(rig.proxy.seen, "tools/call")
            .slice(gatewayMark)
            .map((one) => one.tool!),
          ranUpstream: readUpstreamCalls(rig.upstream)
            .slice(upstreamMark)
            .map((one) => one.tool!),
          modelWasTold: readToolResults(rig.model).at(-1),
        };
      };

      const first = await look();
      const name = Object.keys(first.shown).find(
        (shown) => first.shown[shown] === options.calledTool,
      )!;
      const steps: Array<TwinStep> = [
        {
          listed: options.states[0]!.map((tool) => tool.name),
          ...first,
          call: await callExactly(name),
        },
      ];
      for (const tools of options.states.slice(1)) {
        const [get] = requestsOf(rig.proxy.seen, "GET");
        const changesBefore = countListChanged([get!]);
        const listsBefore = requestsOf(rig.proxy.seen, "tools/list").length;
        await rig.replaceTools(tools);
        expect(
          await waitWithin(STEP_MS, () => countListChanged([get!]) > changesBefore),
          "list_changed on the GET stream",
        ).toBe(true);
        expect(
          await waitWithin(
            STEP_MS,
            () => requestsOf(rig.proxy.seen, "tools/list").length > listsBefore,
          ),
          "pi listed again",
        ).toBe(true);
        await waitUntilQuiet(rig.proxy, 1_000);
        const next = await look();
        steps.push({
          listed: tools.map((tool) => tool.name),
          ...next,
          call: await callExactly(name),
        });
      }
      result = { name, steps };
    },
  );
  return result!;
};

/** The gateway's name for `tool` of `sentry`. */
const buildGatewayName = (tool: string): string =>
  `${SERVER_NAME}${MCP_GATEWAY_TOOL_SEPARATOR}${tool}`;

/** The name pi shows for a gateway tool called `gatewayName`. pi shows the gateway's name as it is, behind its own prefix. */
const buildShownName = (gatewayName: string): string =>
  `${MCP_GATEWAY_HARNESS_PREFIX}${gatewayName}`;

/**
 * The name pi shows for `search_pages`, which the gateway keeps as it is, and
 * for `search-pages`: the hyphen becomes `_`, and the first six hex characters
 * of the SHA-256 of `search-pages` follow. The gateway keeps no hyphen, so pi
 * has no `-` to fold into the name of `search_pages`.
 */
const UNDERSCORE_NAME = buildShownName(buildGatewayName("search_pages"));
const HYPHEN_NAME = buildShownName(buildGatewayName("search_pages_f33805"));

/** The gateway's name, and pi's name, for each of the two tools. */
const GATEWAY_NAMES: Readonly<Record<string, string>> = {
  search_pages: buildGatewayName("search_pages"),
  "search-pages": buildGatewayName("search_pages_f33805"),
};
const SHOWN_NAMES: Readonly<Record<string, string>> = {
  search_pages: UNDERSCORE_NAME,
  "search-pages": HYPHEN_NAME,
};

/** What the fake server's tool answers a call with. */
const RAN_TEXT = '{"text":"hello"}';

/** What a call that reached `tool` through the gateway looks like. */
const ranCall = (tool: string) => ({
  sentToGateway: [GATEWAY_NAMES[tool]!],
  ranUpstream: [tool],
});

/** What a call looks like when pi refuses the name itself: nothing reaches the gateway. */
const REFUSED_BY_PI = { sentToGateway: [], ranUpstream: [] };

/** Returns what each step showed and did, with the text pi told the model for the call. The order in which pi lists tools is its own, so names are sorted. */
const summarizeSteps = (steps: ReadonlyArray<TwinStep>) =>
  steps.map(({ listed, shown, declared, call }) => ({
    listed,
    shown,
    declared: declared.toSorted(),
    sentToGateway: call.sentToGateway,
    ranUpstream: call.ranUpstream,
    modelWasTold: call.modelWasTold,
  }));

/**
 * pi, 1.3.0 and 1.6.0, shows `-` as `_` and gives every tool whose shown name
 * has a twin a suffix of its own. The gateway keeps no `-` in a name, so no two
 * gateway names look alike to pi and pi shows each name as it is. pi also
 * remembers which tool a name was given to, and hides a tool that is no longer
 * listed from the model. So a name the model used runs its own tool while that
 * tool is listed, pi refuses it with "not found" once the tool is gone, and it
 * never runs the sibling tool (spec 21 section 3.4).
 *
 * `shown` is what the model's search for `pages` found, which holds only tools
 * pi has not loaded yet, so it is empty when every listed tool was loaded
 * before. `declared` is every gateway tool pi declared to the model in the
 * request that followed.
 */
describe.skipIf(piBinary === undefined)(
  "a name the model already used never runs the other tool in pi, when a twin with - or _ comes or goes",
  () => {
    for (const { title, states, calledTool } of TWIN_SCENARIOS) {
      it(
        `${title}: the model's name for ${calledTool} runs ${calledTool} while it is listed and is refused after`,
        async () => {
          const run = await runTwinScenario({
            states: states.map((listed) => listed.map(buildTwinTool)),
            calledTool,
          });
          expect(run.name).toBe(SHOWN_NAMES[calledTool]);
          const loaded = new Set<string>();
          expect(summarizeSteps(run.steps)).toEqual(
            states.map((listed) => {
              const found = listed.filter((tool) => !loaded.has(tool));
              for (const tool of listed) loaded.add(tool);
              return {
                listed,
                shown: Object.fromEntries(found.map((tool) => [SHOWN_NAMES[tool]!, tool])),
                declared: listed.map((tool) => SHOWN_NAMES[tool]!).toSorted(),
                ...(listed.includes(calledTool)
                  ? { ...ranCall(calledTool), modelWasTold: RAN_TEXT }
                  : { ...REFUSED_BY_PI, modelWasTold: `Tool ${run.name} not found` }),
              };
            }),
          );
          for (const step of run.steps) {
            expect(
              step.call.ranUpstream.every((tool) => tool === calledTool),
              "no other tool ran",
            ).toBe(true);
          }
        },
        TWIN_TEST_MS,
      );
    }
  },
);
