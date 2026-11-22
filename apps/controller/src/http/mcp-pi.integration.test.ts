/**
 * Runs the real pi against the real MCP Gateway, to check what the spec could
 * only assume (spec 21 section 3.11): that pi works on the older wire era,
 * finds a gateway tool with `tool_search` and calls it, hears
 * `notifications/tools/list_changed` and lists again, opens a new MCP session
 * when the gateway answers 404 for the one it holds and then meets the refusal
 * the gateway gives a call on a reopened session, and never shows the model a
 * tool name of more than 64 characters. What a user sees of approvals and
 * items is checked beside the adapter, in
 * `apps/runner/src/harnesses/pi/adapter-mcp.integration.test.ts`.
 *
 * Nothing here is billed and no login is used. pi starts the way the pi
 * adapter starts it: the adapter's own `buildArgv` and `decideMcpLaunch`
 * give the command line and the gateway's address, the adapter's own
 * extension (`EXTENSION_SOURCE`) registers the gateway, and the session token
 * is in `HERCULE_TOKEN`. The environment is built from nothing (a throwaway
 * `HOME` and agent directory). The model is the local stand-in of
 * `apps/runner/src/harnesses/pi/upstream.ts`, scripted to find a tool with
 * `tool_search` and call it, so no real model is reached.
 *
 * A recording proxy sits between pi and the controller and keeps what the
 * gateway receives, as in `mcp-codex.integration.test.ts`.
 *
 * What this file does not assert:
 *
 * - **A real cold gateway.** The test controller cannot restart over the same
 *   database: `withServer` makes a new Hercule Home and a new gateway for
 *   each run, and its `reboot` repeats only the boot steps inside the same
 *   process, so the gateway keeps the names it has sent. The 404 test drops
 *   pi's MCP session at the gateway, which is what a restart does to the
 *   session, but the gateway still knows every name it sent. The refusal it
 *   gives is the one for a reopened session (spec 21 section 3.4), not the
 *   one for an unknown name after a restart.
 * - **A real model.** The stand-in calls the tool the search returned. What a
 *   real model chooses to search for is not checked.
 * - **pi's text for a refused call.** The test asserts the words the gateway
 *   gives the agent, "list the tools again", reach the model, and not how pi
 *   words an error of its own.
 *
 * Skipped when no `pi` binary is found. `HERCULE_PI_TEST_BINARY` selects one
 * without changing `PATH`. No CI job installs pi, so this file runs on a
 * developer's machine only.
 */
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { MCP_GATEWAY_ENTRY_NAME } from "@hercule/protocol";
import { SESSION_TOKEN_VARIABLE } from "../../../runner/src/credentials/helper";
import { buildArgv } from "../../../runner/src/harnesses/pi/adapter";
import {
  ACCESS_MODE_VARIABLE,
  AGENT_FILE_VARIABLE,
  EXTENSION_SOURCE,
} from "../../../runner/src/harnesses/pi/extension";
import { decideMcpLaunch } from "../../../runner/src/harnesses/pi/mcp";
import {
  buildMcpCallScript,
  TOOL_SEARCH_TOOL,
} from "../../../runner/src/harnesses/pi/mcp-model.testing";
import {
  buildPiTestPath,
  findPiTestBinary,
} from "../../../runner/src/harnesses/pi/pi-binary.testing";
import { makeRpc, STARTUP_DEADLINE } from "../../../runner/src/harnesses/pi/rpc";
import { buildContext, SPEC } from "../../../runner/src/harnesses/pi/testing";
import {
  pointAtFakeModel,
  readRequestMessageText,
  startScriptedModelServer,
  type FakeModelReply,
  type FakeModelRequest,
  type FakeModelScript,
  type FakeModelServer,
} from "../../../runner/src/harnesses/pi/upstream";
import { spawnPi, stopChild } from "../../../runner/src/harnesses/process";
import { startFakeUpstream, type FakeTool, type FakeUpstream } from "../mcp-servers/testing";
import {
  OLDER_ERA_REVISIONS,
  WHOAMI_TOOL,
  readUpstreamCalls,
  withGatewayRig,
  type GatewayRig,
} from "./mcp-gateway-rig.testing";
import {
  countListChanged,
  describeRequest,
  requestsOf,
  waitUntilQuiet,
  type ObservedRequest,
} from "./mcp-recording-proxy.testing";
import { waitWithin } from "./testing";

const piBinary = findPiTestBinary();

/** The most one step of these tests waits for pi, which is a separate process that starts slowly. */
const STEP_MS = 30_000;

/** The test's own limit, with room for pi to start and for several turns. */
const TEST_MS = 120_000;

/** The name of the one MCP Server the tests give the Thread. */
const SERVER_NAME = "sentry";

/** The tool the model is shown for `sentry`'s `whoami`: pi's `mcp__tools__` prefix and the gateway's `<server>__<tool>`. */
const WHOAMI = `mcp__${MCP_GATEWAY_ENTRY_NAME}__${SERVER_NAME}__whoami`;

/** The longest tool name a model may be shown: pi's own limit. */
const MAX_TOOL_NAME_LENGTH = 64;

// -- The real pi --------------------------------------------------------------

/** A running pi, and the questions a test can put to it. */
interface RunningPi {
  /** Sends a prompt and waits until pi has nothing left to run. */
  readonly runTurn: (prompt: string) => Promise<void>;
}

/** What `withPiHome` makes: starts one pi on the home. */
interface PiHome {
  readonly start: () => RunningPi;
}

/**
 * Prepares a throwaway home that points pi at the stand-in model, calls `body`
 * with a way to start a pi on it, then stops every pi it started and removes
 * the folders. A pi is registered for the stop when it is spawned, so one that
 * fails to start up is stopped too.
 *
 * pi is started with the runner's own parts: the adapter's command line, its
 * extension, `spawnPi` and the RPC client `makeRpc`. The adapter's
 * `startSession` is not used, because this file checks the gateway against
 * the real pi without the adapter in between.
 */
const withPiHome = async (
  options: {
    readonly gatewayUrl: string;
    readonly sessionToken: string;
    readonly model: FakeModelServer;
  },
  body: (home: PiHome) => Promise<void>,
): Promise<void> => {
  const root = mkdtempSync(join(tmpdir(), "hercule-pi-gateway-"));
  const userHome = join(root, "user");
  const agentFolder = join(root, "agent");
  const harnessHome = join(root, "harness-home");
  const cwd = join(root, "cwd");
  for (const folder of [userHome, agentFolder, harnessHome, cwd]) mkdirSync(folder);
  pointAtFakeModel(agentFolder, options.model.baseUrl);
  const extensionFile = join(agentFolder, "extension.ts");
  writeFileSync(extensionFile, EXTENSION_SOURCE);
  const spawned: Array<ReturnType<typeof spawnPi>> = [];

  const start = (): RunningPi => {
    const context = {
      ...buildContext(harnessHome, cwd),
      mcpServers: [{ name: MCP_GATEWAY_ENTRY_NAME, url: `${options.gatewayUrl}/mcp` }],
    };
    const command = [
      piBinary!,
      ...buildArgv(
        {
          ...SPEC,
          modelSelection: { model: "fake-model", options: { thinking: "low" } },
          accessMode: "full-access",
        },
        context,
        { model: "fake-model", options: { thinking: "low" } },
        {
          kind: "session",
          sessionId: crypto.randomUUID(),
          transcript: undefined,
          systemPromptFile: undefined,
        },
        extensionFile,
      ),
    ];
    const child = spawnPi(
      command,
      {
        PATH: buildPiTestPath(piBinary!),
        HOME: userHome,
        PI_CODING_AGENT_DIR: agentFolder,
        PI_SKIP_VERSION_CHECK: "1",
        [SESSION_TOKEN_VARIABLE]: options.sessionToken,
        [ACCESS_MODE_VARIABLE]: "full-access",
        [AGENT_FILE_VARIABLE]: extensionFile,
        ...decideMcpLaunch(context.mcpServers).env,
      },
      cwd,
    );
    spawned.push(child);
    // Read to the end, so a full pipe never holds pi up.
    void Array.fromAsync(child.stderr);

    let settledTurns = 0;
    const rpc = makeRpc(child, (_line, frame) => {
      if ((frame as { readonly type?: string } | undefined)?.type === "agent_settled") {
        settledTurns += 1;
      }
    });
    Effect.runFork(rpc.pump);
    return {
      runTurn: async (prompt) => {
        const before = settledTurns;
        await Effect.runPromise(rpc.send({ type: "prompt", message: prompt }, STARTUP_DEADLINE));
        expect(
          await waitWithin(STEP_MS, () => settledTurns > before),
          `the turn of "${prompt}" ended`,
        ).toBe(true);
      },
    };
  };

  try {
    await body({ start });
  } finally {
    for (const child of spawned) await Effect.runPromise(stopChild(child));
    rmSync(root, { recursive: true, force: true });
  }
};

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
 * Builds a script that calls one gateway tool by the gateway's own name. pi
 * shows the model a tool under its own spelling, which is not the gateway's
 * name: it turns `-` into `_` and adds a suffix of its own to names that are
 * alike after that. So the tools of such a test carry their gateway name at
 * the end of their description, in square brackets, and the script finds a
 * tool by that.
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
interface Gateway extends GatewayRig {
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

/**
 * Runs `body` with a started pi on a gateway whose session lists `sentry` when
 * `listed` is true. The pi has opened its MCP session and listed the tools
 * before `body` starts: a person types for longer than pi needs to connect,
 * and `tool_search` finds nothing before the list has arrived.
 */
const withPiOnGateway = (
  options: {
    readonly listed: boolean;
    readonly tools?: ReadonlyArray<FakeTool>;
    readonly script?: FakeModelScript;
  },
  body: (gateway: Gateway, running: RunningPi) => Promise<void>,
): Promise<void> =>
  withGateway(options, (gateway) =>
    withPiHome(
      {
        gatewayUrl: gateway.gatewayUrl,
        sessionToken: gateway.sessionToken,
        model: gateway.model,
      },
      async (home) => {
        const running = home.start();
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
      },
    ),
  );

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
    "opens a new MCP session after a 404, is refused once on the resent call, lists again and then runs the next call",
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

        // The list came before the refusal, so it does not end it: the gateway refuses the resent
        // call, asks the agent to list again, and nothing reaches the server.
        expect(readToolResults(rig.model).at(-1)).toContain("List the tools again");
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual(["whoami"]);

        // The refusal sent list_changed to pi's new stream, so pi lists again.
        const listedAfterRefusal = (): ReadonlyArray<ObservedRequest> =>
          rig.proxy.seen
            .slice(mark + after.indexOf(resent) + 1)
            .filter((one) => one.rpcMethod === "tools/list" && one.sessionId === newSession);
        expect(
          await waitWithin(STEP_MS, () => listedAfterRefusal().length > 0),
          "pi listed again after the refusal",
        ).toBe(true);

        // The next call on that session is judged as any other, and runs.
        await running.runTurn("find whoami");
        expect(readUpstreamCalls(rig.upstream).map((one) => one.tool)).toEqual([
          "whoami",
          "whoami",
        ]);
        expect(readToolResults(rig.model).at(-1)).toContain("hello");
        // The refusal came once: no later call was told to list again.
        expect(
          readToolResults(rig.model).filter((text) => text.includes("List the tools again")),
        ).toHaveLength(1);
      });
    },
    TEST_MS,
  );

  it(
    "calls a tool whose name has a hyphen and one whose name carries a hash, each reaching its own upstream tool beside a tool that reads alike",
    async () => {
      const owners: ReadonlyArray<readonly [string, string]> = [
        [`${SERVER_NAME}__search_pages`, "search_pages"],
        [`${SERVER_NAME}__search-pages`, "search-pages"],
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
