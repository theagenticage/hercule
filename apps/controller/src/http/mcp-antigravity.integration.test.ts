/**
 * Runs the real `agy` against the real MCP Gateway, to check what spec 06
 * section 10.5 ("The MCP entry") and spec 21 section 3.11 could only measure
 * outside the product: that the entry the Antigravity adapter hands to `agy`
 * reaches the gateway with the session's token, on a start and on a resume;
 * what `agy` does when a server is added to the session's list while it runs,
 * and when a 404 comes for a call or for the list; how an
 * approval works for an MCP call; and that the token is in no event.
 *
 * Unlike the tests of Codex and pi, this one is billed. A real model answers,
 * with a real Google login that a person lends, so each test spends a little
 * of that account's quota. The prompts are tiny on purpose. `agy` starts
 * through the Antigravity adapter's own `startSession`
 * (`real-agy-session.testing.ts`), so its command line and its MCP entry are
 * the adapter's. The session token is in `HERCULE_TOKEN`.
 *
 * Between `agy` and the controller sit two recorders: one that keeps the
 * `Authorization` header of each request, and the recording proxy of the other
 * MCP tests, as in `mcp-pi.integration.test.ts`.
 *
 * What this file does not assert:
 *
 * - **What the model says.** A test checks the items and the requests the
 *   adapter reports and what reaches the fake MCP server, never the model's
 *   words.
 * - **A real cold gateway.** As in the tests of pi and Codex, the test
 *   controller cannot restart over one database, so the 404 tests answer 404
 *   in front of the gateway. `agy` holds no MCP session on the era it takes,
 *   so there is none to drop at the gateway.
 * - **The token in files.** `agy` keeps the token it was given in the
 *   conversation database of the Harness Home (spec 06 section 10.5). This
 *   file checks only what the adapter reports.
 *
 * Skipped when there is no `agy` binary (`HERCULE_AGY_TEST_BINARY`, or `agy`
 * on the `PATH`) or no lent login (`HERCULE_AGY_TEST_LOGIN`). No CI job has
 * either, so this file runs on a developer's machine only.
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { HarnessEvent } from "@hercule/protocol";
import {
  findRealAgySkipReason,
  prepareRealAgy,
  REAL_AGY_TEST_MS,
  type OpenedRequest,
  type RealAgyRig,
  type RealAgySession,
  type RealAgyStart,
} from "../../../runner/src/harnesses/antigravity/real-agy-session.testing";
import { startFakeUpstream, type FakeTool, type FakeUpstream } from "../mcp-servers/testing";
import {
  withAntigravityGatewayRig,
  type AntigravityGatewayRig,
} from "./mcp-antigravity-rig.testing";
import { WHOAMI_TOOL, readUpstreamCalls } from "./mcp-gateway-rig.testing";

const skipReason = findRealAgySkipReason();

/** The name of the one MCP Server the tests give the Thread. */
const SERVER_NAME = "sentry";

/** A tool that always fails, which the fake MCP server reports as `isError`. */
const FAILING_TOOL: FakeTool = {
  name: "failing",
  description: "Always fails",
  answer: "tool-error",
};

/** The tool the tests add while `agy` runs. */
const SECOND_TOOL: FakeTool = { name: "second", description: "Returns who the server acts as" };

/** How long a test waits to show that something does not happen. */
const QUIET_MS = 4_000;

let real: RealAgyRig | undefined;

beforeAll(async () => {
  if (skipReason === undefined) real = await prepareRealAgy();
}, 120_000);

afterAll(async () => {
  await real?.dispose();
}, 60_000);

// -- Helpers ------------------------------------------------------------------

/** Names a gateway tool as `agy` shows it to the model: its entry's name, then the gateway's `<server>__<tool>`. */
const buildAgyToolName = (tool: string): string => `mcp_tools_${SERVER_NAME}__${tool}`;

/** The prompt that makes the model call `tool` once. */
const buildCallPrompt = (tool: string): string =>
  `Call the MCP tool ${buildAgyToolName(tool)} once and reply with its result. If the call fails, do not call it again: reply with the error. If you have no such tool, reply NO TOOL and do nothing else: run no command and read no file.`;

/** What a test gets: the controller side, the fake MCP server and a way to start `agy`. */
interface AgyOnGateway {
  readonly rig: AntigravityGatewayRig;
  readonly upstream: FakeUpstream;
  /** Starts `agy` on the gateway with the session's current token, in the same folder as `resumeOf` when given. */
  readonly start: (
    accessMode: RealAgyStart["accessMode"],
    resumeOf?: RealAgySession,
  ) => Promise<RealAgySession>;
}

/**
 * Runs `body` with a controller whose Thread lists `sentry`, a fake MCP server
 * that offers `tools`, and the real `agy`. Every `agy` the body started is
 * stopped before the controller is.
 */
const withAgy = async (
  tools: ReadonlyArray<FakeTool>,
  body: (gateway: AgyOnGateway) => Promise<void>,
  listed: ReadonlyArray<string> = [SERVER_NAME],
): Promise<void> => {
  const upstream = await startFakeUpstream({ tools });
  const started: Array<RealAgySession> = [];
  try {
    await withAntigravityGatewayRig(
      { upstream, serverNames: [SERVER_NAME], listed },
      async (rig) => {
        try {
          await body({
            rig,
            upstream,
            start: async (accessMode, resumeOf) => {
              const session = await real!.startSession({
                accessMode,
                mcpUrl: `${rig.gatewayUrl}/mcp`,
                sessionToken: rig.sessionToken(),
                ...(resumeOf === undefined
                  ? {}
                  : {
                      continue: { nativeSessionId: resumeOf.nativeSessionId, mode: "resume" },
                      cwd: resumeOf.cwd,
                    }),
              });
              started.push(session);
              return session;
            },
          });
        } finally {
          for (const session of started) await session.stop("stopped").catch(() => undefined);
        }
      },
    );
  } finally {
    await upstream.stop();
  }
};

type Completed = Extract<HarnessEvent, { _tag: "item.completed" }>;

/** Returns the completed items of `events` that are MCP tool calls of the gateway. */
const readCompletedMcpCalls = (events: ReadonlyArray<HarnessEvent>): ReadonlyArray<Completed> =>
  events.filter(
    (event): event is Completed =>
      event._tag === "item.completed" &&
      event.kind === "tool_call" &&
      (event.detail as { kind?: string } | undefined)?.kind === "mcp",
  );

/** Counts the requests the recorder saw with this JSON-RPC method, from index `from` on. */
const countRequests = (rig: AntigravityGatewayRig, rpcMethod: string, from = 0): number =>
  rig.recorder.seen.slice(from).filter((one) => one.rpcMethod === rpcMethod).length;

/** Returns the tools of the calls that reached the fake MCP server, in order. */
const readUpstreamTools = (upstream: FakeUpstream): ReadonlyArray<string | undefined> =>
  readUpstreamCalls(upstream).map((one) => one.tool);

/** Lists what the gateway received from `agy`, for a failure message: `METHOD rpc-method [tool] status`, in order. */
const dumpRequests = (rig: AntigravityGatewayRig): string =>
  `What the gateway received:\n  ${rig.recorder.seen
    .map(
      (one) =>
        `${one.httpMethod} ${one.rpcMethod}${one.tool === null ? "" : ` ${one.tool}`} ${String(one.status)}`,
    )
    .join("\n  ")}`;

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** Finds the first approval Request of `events` that is for a tool. */
const findToolApproval = (events: ReadonlyArray<HarnessEvent>): OpenedRequest | undefined =>
  events.find(
    (event): event is Extract<HarnessEvent, { _tag: "request.opened" }> =>
      event._tag === "request.opened" && event.request.kind === "tool_approval",
  )?.request;

// -- The tests ----------------------------------------------------------------

describe.skipIf(skipReason !== undefined)(
  skipReason === undefined
    ? "the real agy on the MCP Gateway"
    : `the real agy on the MCP Gateway (skipped: ${skipReason})`,
  () => {
    it(
      "reaches the gateway with the session's token, and a call of a gateway tool reaches the fake server as an mcp tool_call",
      async () => {
        await withAgy([WHOAMI_TOOL], async ({ rig, upstream, start }) => {
          const token = rig.sessionToken();
          const session = await start("full-access");
          const turn = await session.runTurn(buildCallPrompt("whoami"));
          const why = `${session.describe()}\n${dumpRequests(rig)}`;

          // Every POST of agy carries this session's token, and nothing else.
          const posts = rig.recorder.seen.filter((one) => one.httpMethod === "POST");
          expect(posts.length, why).toBeGreaterThan(0);
          expect(
            [...new Set(posts.map((one) => one.authorization))],
            `every POST carries the session's token.\n${why}`,
          ).toEqual([`Bearer ${token}`]);
          for (const method of ["server/discover", "tools/list", "tools/call"]) {
            expect(countRequests(rig, method), `${method}\n${why}`).toBeGreaterThan(0);
          }

          // The call reached the fake server, once, under the gateway's name.
          expect(
            rig.recorder.seen.filter((one) => one.tool !== null).map((one) => one.tool),
            why,
          ).toEqual([`${SERVER_NAME}__whoami`]);
          expect(readUpstreamTools(upstream), why).toEqual(["whoami"]);

          // The item names the server and the tool apart (spec 06 section 6.3).
          const [call, ...others] = readCompletedMcpCalls(turn.events);
          expect(others, why).toEqual([]);
          expect(call, why).toMatchObject({
            status: "completed",
            detail: { server: SERVER_NAME, name: "whoami", kind: "mcp" },
          });
          expect(turn.end.state, why).toBe("completed");
          // Full access asks for nothing.
          expect(
            turn.events.filter((event) => event._tag === "request.opened"),
            why,
          ).toEqual([]);
        });
      },
      REAL_AGY_TEST_MS,
    );

    it(
      "reaches the gateway again when the session is resumed in a new process, with the resumed session's new token, and a call works",
      async () => {
        await withAgy([WHOAMI_TOOL], async ({ rig, upstream, start }) => {
          const oldToken = rig.sessionToken();
          const first = await start("full-access");
          await first.runTurn(buildCallPrompt("whoami"));
          await first.stop("stopped");
          expect(readUpstreamTools(upstream), first.describe()).toEqual(["whoami"]);

          const newToken = await rig.resumeSession();
          expect(newToken).not.toBe(oldToken);
          const mark = rig.recorder.seen.length;
          const resumed = await start("full-access", first);
          const turn = await resumed.runTurn(buildCallPrompt("whoami"));
          const why = `${resumed.describe()}\n${dumpRequests(rig)}`;

          // A resume does not keep the old entry: agy handshakes again with the new token.
          const after = rig.recorder.seen.slice(mark);
          expect(countRequests(rig, "server/discover", mark), why).toBeGreaterThan(0);
          expect(
            [
              ...new Set(
                after.filter((one) => one.httpMethod === "POST").map((one) => one.authorization),
              ),
            ],
            `every POST of the resumed process carries the new token.\n${why}`,
          ).toEqual([`Bearer ${newToken}`]);
          expect(readUpstreamTools(upstream), why).toEqual(["whoami", "whoami"]);
          expect(readCompletedMcpCalls(turn.events)[0], why).toMatchObject({
            status: "completed",
            detail: { server: SERVER_NAME, name: "whoami", kind: "mcp" },
          });
        });
      },
      REAL_AGY_TEST_MS,
    );

    describe("approval", () => {
      it(
        "in approval-required opens a tool_approval Request, and nothing reaches the fake server until it is allowed",
        async () => {
          await withAgy([WHOAMI_TOOL], async ({ rig, upstream, start }) => {
            const session = await start("approval-required");
            const turnId = await session.sendInput(buildCallPrompt("whoami"));
            const request = await session.waitFor("asked about the call", (events) =>
              findToolApproval(events),
            );
            expect((request.detail as { toolName: string }).toolName, session.describe()).toContain(
              "whoami",
            );

            // While the Request is open the call is held: not at the gateway, not at the server.
            await sleep(QUIET_MS);
            expect(countRequests(rig, "tools/call"), session.describe()).toBe(0);
            expect(readUpstreamTools(upstream), session.describe()).toEqual([]);

            await session.answer(request, "allow");
            const end = await session.waitForTurnEnd(turnId);
            expect(end.state, session.describe()).toBe("completed");
            expect(readUpstreamTools(upstream), session.describe()).toEqual(["whoami"]);
            expect(readCompletedMcpCalls(session.events())[0], session.describe()).toMatchObject({
              status: "completed",
              detail: { server: SERVER_NAME, name: "whoami", kind: "mcp" },
            });
          });
        },
        REAL_AGY_TEST_MS,
      );

      it(
        "in approval-required keeps the fake server untouched when the Request is denied, and the item is declined",
        async () => {
          await withAgy([WHOAMI_TOOL], async ({ rig, upstream, start }) => {
            const session = await start("approval-required");
            const turn = await session.runTurn(buildCallPrompt("whoami"), () => "deny");
            const why = `${session.describe()}\n${dumpRequests(rig)}`;

            expect(findToolApproval(turn.events), why).toBeDefined();
            expect(countRequests(rig, "tools/call"), why).toBe(0);
            expect(readUpstreamTools(upstream), why).toEqual([]);
            expect(readCompletedMcpCalls(turn.events)[0], why).toMatchObject({
              status: "declined",
              detail: { server: SERVER_NAME, name: "whoami", kind: "mcp" },
            });
            expect(turn.end.state, why).toBe("completed");
          });
        },
        REAL_AGY_TEST_MS,
      );

      it(
        "in full-access opens no Request, and the call reaches the fake server",
        async () => {
          await withAgy([WHOAMI_TOOL], async ({ upstream, start }) => {
            const session = await start("full-access");
            const turn = await session.runTurn(buildCallPrompt("whoami"), () => {
              throw new Error("full-access opened a Request");
            });
            expect(
              turn.events.filter((event) => event._tag === "request.opened"),
              session.describe(),
            ).toEqual([]);
            expect(readUpstreamTools(upstream), session.describe()).toEqual(["whoami"]);
          });
        },
        REAL_AGY_TEST_MS,
      );
    });

    it(
      "completes the item as failed when the tool of the fake server fails",
      async () => {
        await withAgy([WHOAMI_TOOL, FAILING_TOOL], async ({ rig, upstream, start }) => {
          const session = await start("full-access");
          const turn = await session.runTurn(buildCallPrompt("failing"));
          const why = `${session.describe()}\n${dumpRequests(rig)}`;

          expect(readUpstreamTools(upstream), why).toEqual(["failing"]);
          expect(readCompletedMcpCalls(turn.events), why).toEqual([
            expect.objectContaining({
              status: "failed",
              detail: { server: SERVER_NAME, name: "failing", kind: "mcp" },
            }),
          ]);
          expect(turn.end.state, why).toBe("completed");
        });
      },
      REAL_AGY_TEST_MS,
    );

    /**
     * What `agy` does when the session's list gains a server while it runs.
     * Measured against a stand-in server that spoke the older era
     * (`initialize` and an MCP session), `agy` listed the tools once per
     * process and never again. The real gateway serves the 2026-07-28 era,
     * which `agy` takes (`server/discover`, no `initialize`, no MCP session),
     * and there `agy` asks for the list again when the server sends
     * `list_changed`, so the new tool is usable at once. This test pins what the real gateway shows, so
     * that a change of `agy` shows up here.
     */
    it(
      "a tool added to the list while agy runs is listed again at the next call and works, with no resume",
      async () => {
        await withAgy([WHOAMI_TOOL], async ({ rig, upstream, start }) => {
          const session = await start("full-access");
          await session.runTurn(buildCallPrompt("whoami"));
          const listsBefore = countRequests(rig, "tools/list");
          expect(listsBefore, session.describe()).toBeGreaterThan(0);

          await rig.replaceTools([WHOAMI_TOOL, SECOND_TOOL]);
          const turn = await session.runTurn(buildCallPrompt("second"));
          const why = `${session.describe()}\n${dumpRequests(rig)}`;

          expect(countRequests(rig, "tools/list"), why).toBeGreaterThan(listsBefore);
          expect(readUpstreamTools(upstream), why).toEqual(["whoami", "second"]);
          expect(readCompletedMcpCalls(turn.events)[0], why).toMatchObject({
            status: "completed",
            detail: { server: SERVER_NAME, name: "second", kind: "mcp" },
          });
        });
      },
      REAL_AGY_TEST_MS,
    );

    it(
      "works in a session that started with an empty list: the model has no tool, and after a server is added its tool is called",
      async () => {
        await withAgy(
          [WHOAMI_TOOL],
          async ({ rig, upstream, start }) => {
            const session = await start("full-access");
            const empty = await session.runTurn(
              "List the MCP tools you have. If you have none, reply NO TOOL and do nothing else: run no command and read no file.",
            );
            expect(readCompletedMcpCalls(empty.events), session.describe()).toEqual([]);
            expect(readUpstreamTools(upstream), session.describe()).toEqual([]);

            await rig.setList([SERVER_NAME]);
            const turn = await session.runTurn(buildCallPrompt("whoami"));
            const why = `${session.describe()}\n${dumpRequests(rig)}`;

            expect(readUpstreamTools(upstream), why).toEqual(["whoami"]);
            expect(readCompletedMcpCalls(turn.events)[0], why).toMatchObject({
              status: "completed",
              detail: { server: SERVER_NAME, name: "whoami", kind: "mcp" },
            });
          },
          [],
        );
      },
      REAL_AGY_TEST_MS,
    );

    describe("a 404 from the gateway", () => {
      /**
       * On the 2026-07-28 era `agy` holds no MCP session, so the gateway has
       * nothing to forget and a restart changes nothing for `agy`. A 404 can
       * still come from something in front of the gateway, so these tests
       * answer 404 in front of it.
       */
      it(
        "on the tools/call itself, the call fails with no retry by agy, and the next call works",
        async () => {
          await withAgy([WHOAMI_TOOL], async ({ rig, upstream, start }) => {
            const session = await start("full-access");
            await session.runTurn(buildCallPrompt("whoami"));
            expect(readUpstreamTools(upstream), session.describe()).toEqual(["whoami"]);

            const mark = rig.recorder.seen.length;
            rig.recorder.refuseNext("tools/call");
            const failed = await session.runTurn(buildCallPrompt("whoami"));
            const why = `${session.describe()}\n${dumpRequests(rig)}`;
            const calls = rig.recorder.seen
              .slice(mark)
              .filter((one) => one.rpcMethod === "tools/call");
            expect(calls[0]?.status, `the first call was not refused.\n${why}`).toBe(404);
            // agy neither sends the call again nor handshakes again.
            expect(calls, why).toHaveLength(1);
            expect(countRequests(rig, "server/discover", mark), why).toBe(0);
            expect(readCompletedMcpCalls(failed.events)[0], why).toMatchObject({
              status: "failed",
              detail: { server: SERVER_NAME, name: "whoami", kind: "mcp" },
            });

            const upstreamBefore = readUpstreamTools(upstream).length;
            const next = await session.runTurn(buildCallPrompt("whoami"));
            expect(readUpstreamTools(upstream).length, session.describe()).toBeGreaterThan(
              upstreamBefore,
            );
            expect(readCompletedMcpCalls(next.events).at(-1), session.describe()).toMatchObject({
              status: "completed",
            });
          });
        },
        REAL_AGY_TEST_MS,
      );

      /**
       * The gateway tells `agy` about a change through the `subscriptions/listen`
       * stream, and `agy` then lists again. When that list is refused, `agy`
       * gets no new tool, and the turn has no call of it. The next call of a
       * tool it knew works, with no new handshake.
       */
      it(
        "on the tools/list that follows a change, the new tool is missing and the old tool still works at the next call",
        async () => {
          await withAgy([WHOAMI_TOOL], async ({ rig, upstream, start }) => {
            const session = await start("full-access");
            await session.runTurn(buildCallPrompt("whoami"));

            rig.recorder.refuseNext("tools/list");
            await rig.replaceTools([WHOAMI_TOOL, SECOND_TOOL]);
            await sleep(QUIET_MS);
            const mark = rig.recorder.seen.length;
            const missing = await session.runTurn(buildCallPrompt("second"));
            const why = `${session.describe()}\n${dumpRequests(rig)}`;
            expect(
              rig.recorder.seen
                .slice(0, mark)
                .filter((one) => one.rpcMethod === "tools/list" && one.status === 404).length,
              `the refused list was not agy's.\n${why}`,
            ).toBe(1);
            expect(readCompletedMcpCalls(missing.events), why).toEqual([]);
            expect(readUpstreamTools(upstream), why).toEqual(["whoami"]);

            const old = await session.runTurn(buildCallPrompt("whoami"));
            expect(readUpstreamTools(upstream), why).toEqual(["whoami", "whoami"]);
            expect(readCompletedMcpCalls(old.events)[0], why).toMatchObject({
              status: "completed",
            });
            expect(countRequests(rig, "server/discover", mark), why).toBe(0);
          });
        },
        REAL_AGY_TEST_MS,
      );
    });

    it(
      "puts the session token in no event of the session, raw ones included",
      async () => {
        await withAgy([WHOAMI_TOOL], async ({ rig, start }) => {
          const token = rig.sessionToken();
          const session = await start("full-access");
          await session.runTurn(buildCallPrompt("whoami"));
          const events = session.events();

          // The test is not empty: the call ran, and the token was given to agy.
          expect(readCompletedMcpCalls(events).length, session.describe()).toBeGreaterThan(0);
          expect(
            rig.recorder.seen.some((one) => one.authorization === `Bearer ${token}`),
            session.describe(),
          ).toBe(true);
          expect(JSON.stringify(events)).not.toContain(token);
        });
      },
      REAL_AGY_TEST_MS,
    );
  },
);
