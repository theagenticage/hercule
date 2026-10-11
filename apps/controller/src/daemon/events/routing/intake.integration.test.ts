/**
 * Tests how a plugin's signals are raised from its events and ended, through
 * the whole event pipeline of a running controller (spec 10 §9.2). An event
 * is emitted over HTTP through a Connection of the `desk` plugin below, the
 * intake routing table runs the signal kind's rule and ends, and the signal
 * raise delivery calls the plugin's `build` and writes the signal. Every
 * assertion reads what the API returns: the signals and the notifications.
 *
 * The `desk` plugin declares one signal kind, `desk/asked`. Its rule returns:
 *
 * - `no` for an event whose `state` is `ignored`;
 * - `yes` for a question asked of the user (`toYou`);
 * - `undecided` for any other question.
 *
 * An answer on the thread ends the signal as decided, and a closed thread
 * withdraws it. What `build` returns is set per test with `desk.build`.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Notification, Signal } from "@hercule/contract";
import {
  HOST_API,
  PluginError,
  registerConnectionType,
  registerEventSource,
  registerWorkflowAction,
  type Plugin,
  type SignalDraft,
} from "@hercule/plugin-host";
import { get, post } from "../../../http/testing";
import { IDLE_FEEDS, IDLE_INGEST_OPEN } from "../../../plugins/testing";
import { waitUntil, WAIT_DEADLINE_MS } from "../../../sessions/testing";
import {
  createConnection,
  withSetUpController,
  type SetUpController,
} from "../../../workflows/testing";
import { waitUntilRouted } from "../../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const ASKED_KIND = "desk/asked";

/** What the `desk` plugin's `build` does: return a draft, fail, or return one with a core action's id. */
type BuildMode = "draft" | "fail" | "collide";

/**
 * Builds the `desk` plugin. `mode.build` decides what each `build` call
 * does, and a test may change it between events.
 */
const buildDeskPlugin = (mode: { build: BuildMode }): Plugin => ({
  manifest: {
    id: "desk",
    displayName: "Desk",
    hostApi: HOST_API,
    capabilities: ["connections", "event-sources", "events", "workflow-actions"],
    configSchema: Schema.Struct({}),
  },
  register: (host) =>
    Effect.all([
      registerConnectionType(host, {
        type: "desk",
        displayName: "Desk",
        setup: [{ kind: "credentials", fields: [{ name: "token", label: "Token" }] }],
        validate: () => Effect.succeed({ displayName: "me", accountId: "1" }),
      }),
      registerWorkflowAction(host, {
        id: "answer",
        displayName: "Answer a question",
        description: "Posts an answer on a Desk thread.",
        connection: { type: "desk/desk" },
        input: Schema.Struct({ thread: Schema.String, text: Schema.String }),
        output: Schema.Struct({}),
        usableIn: ["signal.answer"],
        describe: () => [{ kind: "text", text: "Answer on Desk" }],
        execute: () => Effect.succeed({}),
      }),
      registerEventSource(host, {
        id: "desk",
        connectionType: "desk/desk",
        feeds: IDLE_FEEDS,
        kinds: {
          "desk.asked": {
            description: "Someone asked a question on a thread.",
            availableToTriage: true,
            schema: Schema.Struct({
              thread: Schema.String,
              by: Schema.String,
              toYou: Schema.Boolean,
              state: Schema.optionalKey(Schema.String),
            }),
          },
          "desk.answered": {
            description: "Someone answered on a thread.",
            availableToTriage: true,
            schema: Schema.Struct({ thread: Schema.String, by: Schema.String }),
          },
          "desk.closed": {
            description: "A thread was closed.",
            availableToTriage: true,
            schema: Schema.Struct({ thread: Schema.String }),
          },
        },
        signalKinds: [
          {
            word: "asked",
            label: "Question for you",
            description: "Someone asked you a question on Desk.",
            from: ["desk.asked"],
            rule: 'has(event.payload.state) && event.payload.state == "ignored" ? "no" : (event.payload.toYou ? "yes" : "undecided")',
            guidance: "Raise it when the question needs the user's answer.",
            threadRef: "event.payload.thread",
            namesYou: true,
            priority: "high",
            matchFields: [{ name: "by", label: "Asked by", path: "event.payload.by" }],
            ends: [
              {
                eventKind: "desk.answered",
                resolution: "decided",
                outcome: '"Answered by " + event.payload.by',
                actionId: "answer",
              },
              { eventKind: "desk.closed", resolution: "withdrawn", outcome: '"Closed"' },
            ],
            build: (event): Effect.Effect<SignalDraft, PluginError> => {
              const payload = event.payload as { readonly thread: string; readonly by: string };
              if (mode.build === "fail") {
                return Effect.fail(new PluginError({ message: "Desk is down" }));
              }
              return Effect.succeed({
                title: `${payload.by} asks on ${payload.thread}`,
                asker: payload.by,
                place: payload.thread,
                blocks: [{ type: "text", markdown: "Can you look?" }],
                actions: [
                  {
                    id: mode.build === "collide" ? "done" : "answer",
                    label: "Answer",
                    action: "answer",
                    input: { thread: payload.thread },
                    primary: true,
                    field: { name: "text", placeholder: "Your answer" },
                  },
                ],
              });
            },
          },
        ],
        open: IDLE_INGEST_OPEN,
      }),
    ]),
  activate: () => Effect.succeed(Effect.void),
});

/**
 * Starts a set-up controller with the `desk` plugin and one Desk
 * Connection, and an event pipeline that ticks every 10 ms.
 */
const withDeskController = (
  mode: { build: BuildMode },
  body: (controller: SetUpController, connectionId: string) => Promise<void>,
) =>
  withSetUpController(
    async (controller) => {
      const connectionId = await createConnection(controller.base, controller.token, "desk/desk", {
        token: "t",
      });
      await body(controller, connectionId);
    },
    [buildDeskPlugin(mode)],
    { eventRoutingInterval: Duration.millis(10) },
  );

/** Emits one Desk event through the Connection, and returns its id. */
const emitDeskEvent = async (
  { base, token }: SetUpController,
  connectionId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<number> => {
  const response = await post(base, "/api/v1/events/emit", { kind, payload, connectionId }, token);
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { readonly eventId: number }).eventId;
};

/** Returns the open signals as the user reads them. */
const queryOpenSignals = async ({
  base,
  token,
}: SetUpController): Promise<ReadonlyArray<Signal>> => {
  const response = await get(base, `/api/v1/signals?kind=${ASKED_KIND}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as ReadonlyArray<Signal>;
};

/** Reads one signal as the user. */
const readSignal = async ({ base, token }: SetUpController, id: string): Promise<Signal> => {
  const response = await get(base, `/api/v1/signals/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Signal;
};

/** Waits until the open signal raised from the event exists, and returns it. */
const waitForSignalFrom = (controller: SetUpController, eventId: number): Promise<Signal> =>
  waitUntil(`raised a signal from the event ${eventId}`, async () =>
    (await queryOpenSignals(controller)).find(
      (signal) => signal.origin.type === "event" && signal.origin.eventId === eventId,
    ),
  );

/** Waits until the signal is resolved, and returns it. */
const waitForResolved = (controller: SetUpController, id: string): Promise<Signal> =>
  waitUntil(`resolved the signal ${id}`, async () => {
    const signal = await readSignal(controller, id);
    return signal.status === "open" ? undefined : signal;
  });

/** Returns every build-failed notification, newest first. */
const queryBuildFailedNotifications = async ({
  base,
  token,
}: SetUpController): Promise<ReadonlyArray<Notification>> => {
  const response = await get(base, "/api/v1/notifications?kind=core.signal-build-failed", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { readonly items: ReadonlyArray<Notification> }).items;
};

describe("raising a plugin's signals from its events", () => {
  it("raises a signal from the plugin's draft, and ends it when the user answers on the source", async () => {
    await withDeskController({ build: "draft" }, async (controller, connectionId) => {
      const ignored = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-1",
        by: "marta",
        toYou: true,
        state: "ignored",
      });
      const asked = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-1",
        by: "marta",
        toYou: true,
      });

      const signal = await waitForSignalFrom(controller, asked);
      await waitUntilRouted(controller.harness, asked);

      // The rule said `no` to the ignored event, so only one signal exists.
      expect((await queryOpenSignals(controller)).map((open) => open.id)).toEqual([signal.id]);
      expect(ignored).toBeLessThan(asked);
      expect(signal).toMatchObject({
        kind: ASKED_KIND,
        origin: { type: "event", eventId: asked, connectionId, threadRef: "t-1" },
        title: "marta asks on t-1",
        asker: "marta",
        place: "t-1",
        priority: "high",
        blocks: [{ type: "text", markdown: "Can you look?" }],
        match: { by: "marta" },
      });
      expect(signal.origin).not.toHaveProperty("notScreened");
      expect(signal).not.toHaveProperty("buildError");
      expect(signal.actions.map((action) => [action.id, action.operation])).toEqual([
        ["answer", { op: "desk/answer", connectionId, input: { thread: "t-1" } }],
        ["done", null],
      ]);
      expect(signal.actions[1]!.describeLine).toEqual([
        { kind: "text", text: "Takes it off your list. Desk is not told" },
      ]);

      await emitDeskEvent(controller, connectionId, "desk.answered", { thread: "t-1", by: "me" });

      expect(await waitForResolved(controller, signal.id)).toMatchObject({
        status: "resolved",
        resolution: {
          kind: "decided",
          actionId: "answer",
          outcome: "Answered by me",
          actor: "system",
          origin: "core",
        },
      });
    });
  });

  it("raises an undecided signal as not screened, replaces it with a newer one, and withdraws that one when the thread closes", async () => {
    await withDeskController({ build: "draft" }, async (controller, connectionId) => {
      const first = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-2",
        by: "marta",
        toYou: false,
      });
      const older = await waitForSignalFrom(controller, first);
      expect(older.origin).toMatchObject({ notScreened: { reason: "no-screener" } });

      const second = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-2",
        by: "marta",
        toYou: true,
      });
      const newer = await waitForSignalFrom(controller, second);

      expect(newer.origin).not.toHaveProperty("notScreened");
      expect(await readSignal(controller, older.id)).toMatchObject({
        status: "resolved",
        replacedBy: newer.id,
        resolution: { kind: "withdrawn", outcome: "Replaced by a newer one", origin: "core" },
      });

      await emitDeskEvent(controller, connectionId, "desk.closed", { thread: "t-2" });

      expect(await waitForResolved(controller, newer.id)).toMatchObject({
        status: "resolved",
        resolution: { kind: "withdrawn", outcome: "Closed" },
      });
    });
  });

  it("writes the signal from its event when build fails, tells the user once, and withdraws that once a build works", async () => {
    const mode: { build: BuildMode } = { build: "fail" };
    await withDeskController(mode, async (controller, connectionId) => {
      const first = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-3",
        by: "marta",
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, first);

      expect(signal).toMatchObject({
        title: "Question for you",
        priority: "high",
        blocks: [],
        match: { by: "marta" },
        buildError: { message: "build failed: Desk is down" },
      });
      expect(signal.actions.map((action) => action.id)).toEqual(["done"]);

      const second = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-4",
        by: "marta",
        toYou: true,
      });
      await waitForSignalFrom(controller, second);

      const [failed, ...others] = await queryBuildFailedNotifications(controller);
      expect(others).toEqual([]);
      expect(failed).toMatchObject({
        kind: "core.signal-build-failed",
        status: "open",
        subject: [
          { kind: "plugin", id: "desk" },
          { kind: "signalKind", id: ASKED_KIND },
        ],
        failedBuildCount: 2,
      });

      mode.build = "draft";
      const third = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-5",
        by: "marta",
        toYou: true,
      });
      await waitForSignalFrom(controller, third);

      expect(await queryBuildFailedNotifications(controller)).toMatchObject([
        { id: failed!.id, status: "resolved", resolution: { kind: "withdrawn" } },
      ]);
    });
  });

  it("writes the signal from its event when the draft gives an action the id of a core action", async () => {
    await withDeskController({ build: "collide" }, async (controller, connectionId) => {
      const asked = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-6",
        by: "marta",
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, asked);

      expect(signal.title).toBe("Question for you");
      expect(signal.buildError?.message).toContain('The core adds its own "Done" action');
      expect(signal.actions.map((action) => action.id)).toEqual(["done"]);
    });
  });
});
