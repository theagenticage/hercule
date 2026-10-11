/**
 * Tests how a plugin's signals are raised from its events and ended, through
 * the whole event pipeline of a running controller (spec 10 §9.2). An event
 * is written to the log as the `desk` plugin below ingests it through its
 * Connection, the intake routing table runs the signal kind's rule and ends,
 * and the signal raise delivery calls the plugin's `build` and writes the
 * signal. The assertions read what the API returns: the signals and the
 * notifications.
 *
 * The `desk` plugin declares one signal kind, `desk/asked`. Its rule returns:
 *
 * - `no` for an event whose `state` is `ignored`;
 * - `yes` for a question asked of the user (`toYou`);
 * - `undecided` for any other question.
 *
 * An answer on the thread ends the signal as decided, and a closed thread
 * withdraws it. What `build` does is set per test with `mode.build`, and a
 * test can hold `build` until it releases it with `mode.beforeBuild`.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Schema from "effect/Schema";
import type { Notification } from "@hercule/contract";
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
import { WAIT_DEADLINE_MS, waitUntil } from "../../../sessions/testing";
import {
  listOpenSignals,
  readSignal,
  waitForResolved,
  waitForSignalFrom,
} from "../../../signals/testing";
import {
  createConnection,
  withSetUpController,
  type SetUpController,
} from "../../../workflows/testing";
import { ingestEvent, runEffect, waitOutSeveralTicks, waitUntilRouted } from "../../testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

const ASKED_KIND = "desk/asked";

/**
 * What the `desk` plugin's `build` does:
 *
 * - `draft`: returns a draft with one answer;
 * - `fail`: fails with a `PluginError`;
 * - `throw`: throws, which is a defect rather than a failure;
 * - `collide`: returns an answer with the id of the core's Done;
 * - `twice`: returns two answers with the same label.
 */
type BuildMode = "draft" | "fail" | "throw" | "collide" | "twice";

/**
 * What a test sets to steer the `desk` plugin's `build`. `beforeBuild`, when
 * set, runs first, and `build` waits for the promise it returns.
 */
interface DeskMode {
  build: BuildMode;
  beforeBuild?: (() => Promise<void>) | undefined;
}

/**
 * Builds the `desk` plugin. `mode` decides what each `build` call does, and
 * a test may change it between events.
 */
const buildDeskPlugin = (mode: DeskMode): Plugin => ({
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
              const before = mode.beforeBuild;
              const waited = before === undefined ? Effect.void : Effect.promise(() => before());
              if (mode.build === "fail") {
                return Effect.andThen(
                  waited,
                  Effect.fail(new PluginError({ message: "Desk is down" })),
                );
              }
              if (mode.build === "throw") {
                throw new Error("Desk's build has a bug");
              }
              const answer = {
                label: "Answer",
                action: "answer",
                input: { thread: payload.thread },
                field: { name: "text", placeholder: "Your answer" },
              };
              return Effect.as(waited, {
                title: `${payload.by} asks on ${payload.thread}`,
                asker: payload.by,
                place: payload.thread,
                blocks: [{ type: "text", markdown: "Can you look?" }],
                actions: [
                  { id: mode.build === "collide" ? "done" : "answer", primary: true, ...answer },
                  ...(mode.build === "twice" ? [{ id: "answer-again", ...answer }] : []),
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
  mode: DeskMode,
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

/** The title every Desk event in these tests has. */
const DESK_TITLE = "A Desk thread";

/** Writes one Desk event to the log as the plugin ingests it through the Connection, and returns its id. */
const emitDeskEvent = (
  { harness }: SetUpController,
  connectionId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<number> =>
  ingestEvent(harness, { pluginId: "desk", connectionId, kind, title: DESK_TITLE, payload });

/** Emits one Desk event over HTTP, as a manual event, and returns its id. */
const emitManualDeskEvent = async (
  { base, token }: SetUpController,
  connectionId: string,
  kind: string,
  payload: Record<string, unknown>,
): Promise<number> => {
  const response = await post(base, "/api/v1/events/emit", { kind, payload, connectionId }, token);
  expect(response.ok, await response.clone().text()).toBe(true);
  return ((await response.json()) as { readonly eventId: number }).eventId;
};

/** Returns the pending raises left in the database, as event id and kind. */
const listPendingRaises = ({ harness }: SetUpController) =>
  runEffect(
    harness.sql<{ readonly event_id: number; readonly kind: string }>`
      SELECT event_id, kind FROM signal_raises
    `,
  );

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

      const signal = await waitForSignalFrom(controller, ASKED_KIND, asked);
      await waitUntilRouted(controller.harness, asked);

      // The rule said `no` to the ignored event, so only one signal exists.
      expect((await listOpenSignals(controller, ASKED_KIND)).map((open) => open.id)).toEqual([
        signal.id,
      ]);
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
      const older = await waitForSignalFrom(controller, ASKED_KIND, first);
      expect(older.origin).toMatchObject({ notScreened: { reason: "no-screener" } });

      const second = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-2",
        by: "marta",
        toYou: true,
      });
      const newer = await waitForSignalFrom(controller, ASKED_KIND, second);

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
    const mode: DeskMode = { build: "fail" };
    await withDeskController(mode, async (controller, connectionId) => {
      const first = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-3",
        by: "marta",
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, ASKED_KIND, first);

      expect(signal).toMatchObject({
        title: DESK_TITLE,
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
      await waitForSignalFrom(controller, ASKED_KIND, second);

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
      await waitForSignalFrom(controller, ASKED_KIND, third);

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
      const signal = await waitForSignalFrom(controller, ASKED_KIND, asked);

      expect(signal.title).toBe(DESK_TITLE);
      expect(signal.buildError?.message).toContain('The core adds its own "Done" action');
      expect(signal.actions.map((action) => action.id)).toEqual(["done"]);
    });
  });

  it("writes the signal from its event when build throws", async () => {
    await withDeskController({ build: "throw" }, async (controller, connectionId) => {
      const asked = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-7",
        by: "marta",
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, ASKED_KIND, asked);

      expect(signal.buildError?.message).toBe("build failed: Desk's build has a bug");
      expect(signal.actions.map((action) => action.id)).toEqual(["done"]);
    });
  });

  it("writes the signal from its event when the draft gives two answers the same label", async () => {
    await withDeskController({ build: "twice" }, async (controller, connectionId) => {
      const asked = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-8",
        by: "marta",
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, ASKED_KIND, asked);

      expect(signal.buildError?.message).toContain('the label "Answer"');
      expect(signal.actions.map((action) => action.id)).toEqual(["done"]);
    });
  });

  it("leaves out a match value that is too long, so the signal still fits", async () => {
    await withDeskController({ build: "fail" }, async (controller, connectionId) => {
      const asked = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-9",
        by: "m".repeat(150_000),
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, ASKED_KIND, asked);

      expect(signal.match).toEqual({});
      expect(signal.buildError?.message).toBe("build failed: Desk is down");
    });
  });

  it("neither ends nor raises a signal from a manual event of the plugin's kinds", async () => {
    await withDeskController({ build: "draft" }, async (controller, connectionId) => {
      const asked = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-10",
        by: "marta",
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, ASKED_KIND, asked);

      const answered = await emitManualDeskEvent(controller, connectionId, "desk.answered", {
        thread: "t-10",
        by: "me",
      });
      const manualAsk = await emitManualDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-11",
        by: "marta",
        toYou: true,
      });
      await waitUntilRouted(controller.harness, Math.max(answered, manualAsk));
      await waitOutSeveralTicks();

      expect((await readSignal(controller, signal.id)).status).toBe("open");
      expect((await listOpenSignals(controller, ASKED_KIND)).map((open) => open.id)).toEqual([
        signal.id,
      ]);
    });
  });

  it("drops a raise for an older event when a newer signal is open on the thread", async () => {
    await withDeskController({ build: "draft" }, async (controller, connectionId) => {
      // The rule says `no` to this event, so it raises nothing by itself.
      const older = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-12",
        by: "marta",
        toYou: true,
        state: "ignored",
      });
      const newer = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-12",
        by: "marta",
        toYou: true,
      });
      const signal = await waitForSignalFrom(controller, ASKED_KIND, newer);

      // A raise for the older event, as one left over from before a restart
      // would be.
      await runEffect(controller.harness.sql`
        INSERT INTO signal_raises (event_id, kind, decision, connection_id, thread_ref)
        SELECT id, ${ASKED_KIND}, 'yes', connection_id, 't-12' FROM events WHERE id = ${older}
      `);
      await waitUntil("dropped the raise of the older event", async () =>
        (await listPendingRaises(controller)).length === 0 ? true : undefined,
      );

      expect((await readSignal(controller, signal.id)).status).toBe("open");
      expect((await listOpenSignals(controller, ASKED_KIND)).map((open) => open.id)).toEqual([
        signal.id,
      ]);
    });
  });

  it("does not raise a signal for a question answered while its build ran, even when the question is enriched later", async () => {
    let releaseBuild!: () => void;
    const buildReleased = new Promise<void>((resolve) => (releaseBuild = resolve));
    let markBuildStarted!: () => void;
    const buildStarted = new Promise<void>((resolve) => (markBuildStarted = resolve));
    const mode: DeskMode = {
      build: "draft",
      beforeBuild: () => {
        markBuildStarted();
        return buildReleased;
      },
    };
    await withDeskController(mode, async (controller, connectionId) => {
      const asked = await emitDeskEvent(controller, connectionId, "desk.asked", {
        thread: "t-13",
        by: "marta",
        toYou: true,
      });
      await buildStarted;

      // The build is held, and the answer is still routed: the raises run on
      // a loop of their own.
      const answered = await emitDeskEvent(controller, connectionId, "desk.answered", {
        thread: "t-13",
        by: "me",
      });
      await waitUntilRouted(controller.harness, answered);
      mode.beforeBuild = undefined;
      releaseBuild();
      await waitUntil("finished the held raise", async () =>
        (await listPendingRaises(controller)).length === 0 ? true : undefined,
      );

      const enriched = await post(
        controller.base,
        `/api/v1/events/${String(asked)}/enrich`,
        { refs: ["desk:thread:t-13"] },
        controller.token,
      );
      expect(enriched.status, await enriched.clone().text()).toBe(200);
      await waitOutSeveralTicks();

      expect(await listPendingRaises(controller)).toEqual([]);
      expect(await listOpenSignals(controller, ASKED_KIND)).toEqual([]);
    });
  });
});
