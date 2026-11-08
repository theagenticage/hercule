/**
 * Tests handing an External Entity to a workflow, over HTTP against a real
 * controller, on real rows (spec 11, `externalEntity.handOff` and
 * `externalEntity.undoHandOff`; spec 20):
 *
 * - the Task and run a handoff makes or continues, and its refusals, each of
 *   which writes nothing;
 * - which signals a handoff ends, and the claims that keep a second writer
 *   out while it works;
 * - what the Undo of a handoff takes back, and what it leaves alone;
 * - handing the same thing off from a card and from Intake.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/sql";
import type { HandOffUndo, Task, TaskStage } from "@hercule/contract";
import { uuidFromString, withTransaction } from "../db";
import { get, post, readErrorBody, send } from "../http/testing";
import {
  listTasks,
  queryRuns,
  readRun,
  readTask,
  requestCancel,
  waitForRunToFinish,
} from "../runs/testing";
import { signalRepository } from "../signals/repository";
import { ABSENT_ID, setConnectionStatus, type SetUpController } from "../workflows/testing";
import {
  arrangeSignal,
  arrangeThing,
  CHANGE_KIND,
  countRows,
  createAccount,
  createHandoffWorkflow,
  handOff,
  insertSignal,
  insertThread,
  MENTIONED,
  requestHandOff,
  requestUndoHandOff,
  REVIEW_REQUESTED,
  rewindRunToPending,
  readSignal,
  waitForStepToRun,
  withNorthwind,
  type Thing,
} from "./testing";

/** What a refused request answered: the status and the words. */
const readRefusal = async (response: Response) => {
  const refusal = await readErrorBody(response);
  return { status: response.status, text: refusal.text };
};

/** Creates a Task that links the thing, at a stage, as an earlier take-on would have. */
const createTaskFor = async (
  { base, token }: SetUpController,
  thing: Thing,
  stage: TaskStage,
): Promise<Task> => {
  const response = await post(
    base,
    "/api/v1/tasks",
    { title: "Earlier work", description: "", stage, provenance: [{ ref: thing.ref }] },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

/** One thing with one account and one workflow that takes it, which most tests need. */
const arrangeOneThing = async (
  controller: SetUpController,
  options: { readonly withAccount?: boolean; readonly answers?: ReadonlyArray<string> } = {},
) => {
  const account = await createAccount(controller, "bot");
  const thing = await arrangeThing(controller, {
    kind: CHANGE_KIND,
    key: "northwind/web#7",
    title: "Retry failed webhooks",
    accounts: [account],
  });
  const workflowId = await createHandoffWorkflow(controller, { name: "Review", ...options });
  return { account, thing, workflowId };
};

describe("handOff", () => {
  it("makes a building Task with the thing's title, and a run on it that has the ref and the account as inputs", async () => {
    await withNorthwind(async (controller) => {
      const { account, thing, workflowId } = await arrangeOneThing(controller, {
        withAccount: true,
      });

      const result = await handOff(controller, thing, { workflowId });

      const task = await readTask(controller.base, controller.token, result.taskId);
      expect(task).toMatchObject({ title: "Retry failed webhooks", stage: "building" });
      expect(task.provenance).toEqual([
        expect.objectContaining({ ref: thing.ref, runId: result.runId, actor: "user" }),
      ]);
      const run = await readRun(controller.base, controller.token, result.runId);
      expect(run).toMatchObject({
        taskId: result.taskId,
        inputs: { item: thing.ref, account },
      });
      expect(await countRows(controller, "entity_handoffs")).toBe(1);
    });
  });

  it.each([
    ["planned", "building"],
    ["exploring", "building"],
    ["building", "building"],
    ["in-review", "in-review"],
  ] as const)("continues the active Task at %s, which is then at %s", async (before, after) => {
    await withNorthwind(async (controller) => {
      const { thing, workflowId } = await arrangeOneThing(controller);
      const earlier = await createTaskFor(controller, thing, before);

      const result = await handOff(controller, thing, { workflowId });

      expect(result.taskId).toBe(earlier.id);
      const task = await readTask(controller.base, controller.token, earlier.id);
      expect(task.stage).toBe(after);
      expect(task.provenance.at(-1)).toMatchObject({ ref: thing.ref, runId: result.runId });
      expect(await countRows(controller, "tasks")).toBe(1);
    });
  });

  it("acts as the oldest account unless the user picks another, and refuses an account that cannot act", async () => {
    await withNorthwind(async (controller) => {
      const first = await createAccount(controller, "first");
      const second = await createAccount(controller, "second");
      const outsider = await createAccount(controller, "outsider");
      const thing = await arrangeThing(controller, {
        kind: CHANGE_KIND,
        key: "northwind/web#8",
        title: "Add a retry button",
        accounts: [first, second],
      });
      const workflowId = await createHandoffWorkflow(controller, {
        name: "Review",
        withAccount: true,
      });
      const accountOf = async (connectionId?: string) => {
        const result = await handOff(controller, thing, {
          workflowId,
          ...(connectionId === undefined ? {} : { connectionId }),
        });
        await requestUndoHandOff(controller, result.runId);
        return (await readRun(controller.base, controller.token, result.runId)).inputs["account"];
      };

      expect(await accountOf()).toBe(first);
      expect(await accountOf(second)).toBe(second);
      const refused = await requestHandOff(controller, thing, {
        workflowId,
        connectionId: outsider,
      });
      expect(await readRefusal(refused)).toEqual({
        status: 409,
        text: expect.stringContaining("That account cannot act on this") as unknown,
      });
    });
  });

  it("refuses a second run of the same workflow on the Task, and allows a second workflow", async () => {
    await withNorthwind(async (controller) => {
      const { thing, workflowId } = await arrangeOneThing(controller);
      const other = await createHandoffWorkflow(controller, { name: "Fix bug" });
      const first = await handOff(controller, thing, { workflowId });

      const again = await requestHandOff(controller, thing, { workflowId });
      const second = await handOff(controller, thing, { workflowId: other });

      expect(await readRefusal(again)).toEqual({
        status: 409,
        text: expect.stringContaining("Review is already working on this") as unknown,
      });
      expect(second.taskId).toBe(first.taskId);
      expect(await countRows(controller, "runs")).toBe(2);
      expect(await countRows(controller, "tasks")).toBe(1);
    });
  });

  it.each([
    ["a place that groups work", "context"],
    ["a record that is not fully read yet", "partial"],
  ] as const)("refuses %s, and writes nothing", async (_name, change) => {
    await withNorthwind(async (controller) => {
      const { thing, workflowId } = await arrangeOneThing(controller);
      const { sql } = controller.harness;
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            sql,
            change === "context"
              ? sql`UPDATE external_entities SET pace = 'context' WHERE ref = ${thing.ref}`
              : sql`UPDATE external_entities SET completeness = 'partial' WHERE ref = ${thing.ref}`,
          ),
        ),
      );

      const response = await requestHandOff(controller, thing, { workflowId });

      expect(await readRefusal(response)).toEqual({
        status: 409,
        text: expect.stringContaining("not a piece of work that can be handed off") as unknown,
      });
      for (const table of ["tasks", "runs", "entity_handoffs"] as const) {
        expect(await countRows(controller, table), table).toBe(0);
      }
    });
  });

  it("writes nothing when the run cannot start", async () => {
    await withNorthwind(async (controller) => {
      const account = await createAccount(controller, "bot");
      const thing = await arrangeThing(controller, {
        kind: CHANGE_KIND,
        key: "northwind/web#9",
        title: "Commit the fix",
        accounts: [account],
      });
      const signalId = await arrangeSignal(controller, {
        thing,
        kind: REVIEW_REQUESTED,
        connectionId: account,
      });
      // A git step needs a runner, and this controller has none.
      const repository = await post(
        controller.base,
        "/api/v1/resources",
        { kind: "repo", remote: "https://github.com/northwind/web.git" },
        controller.token,
      );
      const { id: resourceId } = (await repository.json()) as { id: string };
      const workflowId = await createHandoffWorkflow(controller, {
        name: "Commit",
        answers: [REVIEW_REQUESTED],
        workspace: { kind: "ephemeral", checkouts: [{ resourceId }] },
        steps: [{ id: "commit", kind: "action", action: "git.commit", params: { message: "Fix" } }],
      });

      const response = await requestHandOff(controller, thing, { workflowId });

      expect(await readRefusal(response)).toEqual({
        status: 400,
        text: expect.stringContaining("no runner can run this workflow") as unknown,
      });
      expect((await readSignal(controller, signalId)).status).toBe("open");
      for (const table of ["tasks", "runs", "entity_handoffs"] as const) {
        expect(await countRows(controller, table), table).toBe(0);
      }
    });
  });

  it.each([
    [
      "the workflow was disabled",
      async (controller: SetUpController, _account: string, workflowId: string) => {
        const response = await send("PATCH", controller.base, `/api/v1/workflows/${workflowId}`, {
          body: { enabled: false },
          token: controller.token,
        });
        expect(response.status).toBe(200);
      },
      "Review cannot take this",
    ],
    [
      "the account was disabled",
      async (controller: SetUpController, account: string) =>
        setConnectionStatus(controller.harness, account, "disabled"),
      "No connected account can act on this",
    ],
  ])(
    "refuses when %s since the card was drawn, and writes nothing",
    async (_name, change, words) => {
      await withNorthwind(async (controller) => {
        const { account, thing, workflowId } = await arrangeOneThing(controller);
        await change(controller, account, workflowId);

        const response = await requestHandOff(controller, thing, { workflowId });

        expect(await readRefusal(response)).toEqual({
          status: 409,
          text: expect.stringContaining(words) as unknown,
        });
        expect(await countRows(controller, "runs")).toBe(0);
        expect(await countRows(controller, "tasks")).toBe(0);
      });
    },
  );
});

/**
 * Starts a handoff while the test holds the controller's writer, and returns
 * its response once `meanwhile` has run inside the held transaction.
 *
 * The handoff reads its boundary and takes its claims without the writer, and
 * then waits for it. That wait is the window in which, in real use, a source
 * ends a signal, a new one arrives, or someone edits the workflow. The test
 * knows the handoff is waiting when it sees the claim on `claimedSignalId`: an
 * action that names no real action on a signal is refused as busy only while
 * a claim is held, and does nothing otherwise.
 */
const handOffWhileWriterHeld = async (
  controller: SetUpController,
  thing: Thing,
  body: { readonly workflowId: string },
  claimedSignalId: string,
  meanwhile: Effect.Effect<unknown, unknown, SqlClient.SqlClient>,
): Promise<Response> => {
  const { harness, base, token } = controller;
  const writing = Promise.withResolvers<void>();
  const holding = Promise.withResolvers<void>();
  const transaction = Effect.runPromise(
    Effect.orDie(
      withTransaction(
        harness.sql,
        Effect.gen(function* () {
          holding.resolve();
          yield* Effect.promise(() => writing.promise);
          yield* meanwhile;
        }).pipe(Effect.provideService(SqlClient.SqlClient, harness.sql)),
      ),
    ),
  );
  await holding.promise;
  const response = requestHandOff(controller, thing, body);
  await expect
    .poll(
      async () =>
        (await post(base, `/api/v1/signals/${claimedSignalId}/act`, { actionId: "none" }, token))
          .status,
    )
    .toBe(409);
  writing.resolve();
  await transaction;
  return response;
};

describe("the signals a handoff ends", () => {
  it("ends the open signals of the kinds the workflow answers, snoozed ones too, and leaves the rest open", async () => {
    await withNorthwind(async (controller, northwind) => {
      const account = await createAccount(controller, "bot");
      const thing = await arrangeThing(controller, {
        kind: CHANGE_KIND,
        key: "northwind/web#7",
        title: "Retry failed webhooks",
        accounts: [account],
      });
      const elsewhere = await arrangeThing(controller, {
        kind: CHANGE_KIND,
        key: "northwind/web#8",
        title: "Another change",
        accounts: [account],
      });
      const workflowId = await createHandoffWorkflow(controller, {
        name: "Review",
        answers: [REVIEW_REQUESTED],
      });
      const arrange = (target: Thing, kind: string) =>
        arrangeSignal(controller, { thing: target, kind, connectionId: account, replyBody: "Hi" });
      const request = await arrange(thing, REVIEW_REQUESTED);
      const snoozed = await arrange(thing, REVIEW_REQUESTED);
      const mention = await arrange(thing, MENTIONED);
      const onOther = await arrange(elsewhere, REVIEW_REQUESTED);
      const snooze = await post(
        controller.base,
        "/api/v1/signals/snooze",
        { signalIds: [snoozed], until: "2099-01-01T00:00:00.000Z" },
        controller.token,
      );
      expect(snooze.status).toBe(200);

      const result = await handOff(controller, thing, { workflowId });

      for (const id of [request, snoozed]) {
        expect((await readSignal(controller, id)).resolution, id).toMatchObject({
          kind: "decided",
          actionId: `hand-to-${workflowId}`,
          outcome: "Handed to Review",
          runId: result.runId,
          actor: "user",
          origin: "web",
        });
      }
      expect((await readSignal(controller, mention)).status).toBe("open");
      expect((await readSignal(controller, onOther)).status).toBe("open");
      expect((await controller.harness.audit("signal.decided")).length).toBe(2);
      // Ending a signal this way tells its source nothing.
      expect(northwind.replies).toEqual([]);
    });
  });

  it("suggests no Ignore Rule, however many signals of one group it ends", async () => {
    await withNorthwind(async (controller) => {
      const { account, thing, workflowId } = await arrangeOneThing(controller, {
        answers: [REVIEW_REQUESTED],
      });
      for (let count = 0; count < 6; count += 1) {
        await arrangeSignal(controller, {
          thing,
          kind: REVIEW_REQUESTED,
          connectionId: account,
          match: { author: "dependabot" },
        });
      }

      await handOff(controller, thing, { workflowId });

      // The ended signals are not marked Done, so none counts toward the streak that
      // raises an Ignore Rule offer, which would be a signal of its own.
      expect(await countRows(controller, "signals")).toBe(6);
    });
  });

  it("is refused whole, with nothing written, while a plugin answer is still running on one of them", async () => {
    const release = Promise.withResolvers<void>();
    await withNorthwind(async (controller, northwind) => {
      const { account, thing, workflowId } = await arrangeOneThing(controller, {
        answers: [REVIEW_REQUESTED],
      });
      const answered = await arrangeSignal(controller, {
        thing,
        kind: REVIEW_REQUESTED,
        connectionId: account,
        replyBody: "Looks good",
      });
      const other = await arrangeSignal(controller, {
        thing,
        kind: REVIEW_REQUESTED,
        connectionId: account,
      });
      const reply = post(
        controller.base,
        `/api/v1/signals/${answered}/act`,
        { actionId: "reply" },
        controller.token,
      );
      await expect.poll(() => northwind.replies.length).toBe(1);

      const refused = await requestHandOff(controller, thing, { workflowId });

      expect(await readRefusal(refused)).toEqual({
        status: 409,
        text: expect.stringContaining("A reply to this is still running") as unknown,
      });
      expect((await readSignal(controller, other)).status).toBe("open");
      expect(await countRows(controller, "runs")).toBe(0);
      expect(await countRows(controller, "tasks")).toBe(0);

      release.resolve();
      expect((await reply).status).toBe(200);
      expect((await readSignal(controller, answered)).resolution?.actionId).toBe("reply");
    }, release.promise);
  });

  describe("while the handoff waits for the writer", () => {
    /** What the table below needs of the world: a thing with two signals the workflow answers. */
    interface Arranged {
      readonly account: string;
      readonly thing: Thing;
      readonly workflowId: string;
      readonly first: string;
      readonly second: string;
    }

    /** What lands while the handoff waits, and what the handoff must then have done. */
    interface Race {
      readonly meanwhile: Effect.Effect<unknown, unknown, SqlClient.SqlClient>;
      readonly verify: (response: Response) => Promise<void>;
    }

    const RACES: ReadonlyArray<
      readonly [string, (controller: SetUpController, arranged: Arranged) => Race]
    > = [
      [
        "a workflow edited to answer other signals is refused, with nothing written",
        (controller, { workflowId, first, second }) => ({
          meanwhile: Effect.flatMap(
            SqlClient.SqlClient,
            (sql) =>
              sql`UPDATE workflows
                  SET definition = json_set(definition, '$.inputs[0].entity.answers', json(${JSON.stringify([MENTIONED])}))
                  WHERE id = ${uuidFromString(workflowId)}`,
          ),
          verify: async (response) => {
            expect(await readRefusal(response)).toEqual({
              status: 409,
              text: expect.stringContaining("This workflow changed") as unknown,
            });
            for (const id of [first, second]) {
              expect((await readSignal(controller, id)).status, id).toBe("open");
            }
            expect(await countRows(controller, "runs")).toBe(0);
            expect(await countRows(controller, "entity_handoffs")).toBe(0);
          },
        }),
      ],
      [
        "a signal raised after the boundary stays open",
        (controller, { account, thing, first, second }) => {
          let late = "";
          return {
            meanwhile: Effect.map(
              insertSignal({ thing, kind: REVIEW_REQUESTED, connectionId: account }),
              (id) => {
                late = id;
              },
            ),
            verify: async (response) => {
              expect(response.status).toBe(200);
              for (const id of [first, second]) {
                expect((await readSignal(controller, id)).status, id).toBe("resolved");
              }
              expect((await readSignal(controller, late)).status).toBe("open");
            },
          };
        },
      ],
      [
        "a signal its source ended is skipped, and keeps the source's ending",
        (controller, { first, second }) => ({
          meanwhile: Effect.flatMap(signalRepository, (signals) =>
            signals.resolve(second, {
              kind: "withdrawn",
              outcome: "Ended at the source",
              actor: "system",
              origin: "core",
              at: new Date().toISOString(),
            }),
          ),
          verify: async (response) => {
            expect(response.status).toBe(200);
            expect((await readSignal(controller, first)).resolution?.kind).toBe("decided");
            expect((await readSignal(controller, second)).resolution).toMatchObject({
              kind: "withdrawn",
              outcome: "Ended at the source",
            });
          },
        }),
      ],
    ];

    it.each(RACES)("%s", async (_name, buildRace) => {
      await withNorthwind(async (controller) => {
        const { account, thing, workflowId } = await arrangeOneThing(controller, {
          answers: [REVIEW_REQUESTED],
        });
        const raise = () =>
          arrangeSignal(controller, { thing, kind: REVIEW_REQUESTED, connectionId: account });
        const arranged = {
          account,
          thing,
          workflowId,
          first: await raise(),
          second: await raise(),
        };
        const race = buildRace(controller, arranged);

        const response = await handOffWhileWriterHeld(
          controller,
          thing,
          { workflowId },
          arranged.first,
          race.meanwhile,
        );

        await race.verify(response);
      });
    });
  });
});

/** Takes a handoff back and returns the answer, or fails the test. */
const undoHandOff = async (controller: SetUpController, runId: string): Promise<HandOffUndo> => {
  const response = await requestUndoHandOff(controller, runId);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as HandOffUndo;
};

/** Returns the status code a read of the Task answers with. */
const readTaskStatus = async ({ base, token }: SetUpController, id: string): Promise<number> =>
  (await get(base, `/api/v1/tasks/${id}`, token)).status;

describe("undoHandOff", () => {
  /** What an Undo case can reach: the world after the handoff, before the Undo. */
  interface Handed {
    readonly thing: Thing;
    readonly account: string;
    readonly workflowId: string;
    readonly runId: string;
    readonly taskId: string;
    /** The signal the handoff ended. */
    readonly signalId: string;
  }

  interface UndoCase {
    /** The stage of a Task that exists before the handoff, or none when the handoff makes it. */
    readonly earlier?: TaskStage;
    /** True when the run's first step has started by the time of the Undo. Otherwise the run is rewound. */
    readonly started?: boolean;
    /** Happens after the handoff, before the Undo. */
    readonly meanwhile?: (controller: SetUpController, handed: Handed) => Promise<void>;
    readonly answer: Omit<HandOffUndo, "stopRequested">;
    readonly stopRequested?: boolean;
    /** What else must hold afterwards. */
    readonly verify?: (controller: SetUpController, handed: Handed) => Promise<void>;
  }

  const STOPPED = {
    outcome: "stopped",
    taskRemoved: false,
    stageRestored: false,
    failureRestored: false,
  } as const;

  const expectTaskStage = async (controller: SetUpController, id: string, stage: TaskStage) =>
    expect((await readTask(controller.base, controller.token, id)).stage).toBe(stage);

  const CASES: ReadonlyArray<readonly [string, UndoCase]> = [
    [
      "deletes the Task the handoff made, when nothing had started",
      {
        answer: {
          outcome: "undone",
          taskRemoved: true,
          stageRestored: false,
          failureRestored: false,
        },
        verify: async (controller, { taskId }) =>
          expect(await readTaskStatus(controller, taskId)).toBe(404),
      },
    ],
    [
      "puts the Task the handoff continued back at its stage, when nothing had started",
      {
        earlier: "planned",
        answer: {
          outcome: "undone",
          taskRemoved: false,
          stageRestored: true,
          failureRestored: false,
        },
        verify: async (controller, { taskId }) => expectTaskStage(controller, taskId, "planned"),
      },
    ],
    [
      "only stops a run whose first step has started, and keeps the Task",
      {
        started: true,
        answer: { ...STOPPED, reason: "Its first step had started." },
        verify: async (controller, { taskId }) => expectTaskStage(controller, taskId, "building"),
      },
    ],
    [
      "only stops a run that opened a session",
      {
        meanwhile: (controller, { runId, taskId }) => insertThread(controller, taskId, runId),
        answer: { ...STOPPED, reason: "Its first step had started." },
      },
    ],
    [
      "only stops when a second workflow joined the Task, and leaves the second run alone",
      {
        meanwhile: async (controller, { thing }) => {
          const second = await createHandoffWorkflow(controller, { name: "Fix bug" });
          await handOff(controller, thing, { workflowId: second });
        },
        answer: { ...STOPPED, reason: "Another run or thread joined the Task since." },
        verify: async ({ base, token }, { runId }) => {
          const others = (await queryRuns(base, token)).items.filter((run) => run.id !== runId);
          expect(others.map((run) => run.status)).toEqual(["running"]);
        },
      },
    ],
    [
      "only stops when a Thread joined the Task",
      {
        meanwhile: (controller, { taskId }) => insertThread(controller, taskId),
        answer: { ...STOPPED, reason: "Another run or thread joined the Task since." },
      },
    ],
    [
      "only stops when the Task was merged, and never deletes the survivor",
      {
        meanwhile: async ({ base, token }, { taskId }) => {
          const created = await post(
            base,
            "/api/v1/tasks",
            { title: "Survivor", description: "" },
            token,
          );
          const survivor = (await created.json()) as Task;
          const merged = await post(
            base,
            `/api/v1/tasks/${taskId}/merge`,
            { intoTaskId: survivor.id },
            token,
          );
          expect(merged.status, await merged.clone().text()).toBe(200);
        },
        answer: { ...STOPPED, reason: "The Task was merged into another Task since." },
        verify: async (controller) => {
          const [survivor] = (await listTasks(controller.base, controller.token)).filter(
            (task) => task.title === "Survivor",
          );
          expect(survivor).toBeDefined();
          expect(await readTaskStatus(controller, survivor!.id)).toBe(200);
        },
      },
    ],
    [
      "only stops when the card was dragged since",
      {
        meanwhile: async ({ base, token }, { taskId }) => {
          const moved = await post(
            base,
            `/api/v1/tasks/${taskId}/move`,
            { stage: "in-review" },
            token,
          );
          expect(moved.status, await moved.clone().text()).toBe(200);
        },
        answer: { ...STOPPED, reason: "The Task was moved or its stage was set since." },
        verify: async (controller, { taskId }) => expectTaskStage(controller, taskId, "in-review"),
      },
    ],
    [
      "only stops when the stage was set again, even to the stage it has",
      {
        meanwhile: async ({ base, token }, { taskId }) => {
          const updated = await send("PATCH", base, `/api/v1/tasks/${taskId}`, {
            body: { stage: "building" },
            token,
          });
          expect(updated.status, await updated.clone().text()).toBe(200);
        },
        answer: { ...STOPPED, reason: "The Task was moved or its stage was set since." },
      },
    ],
    [
      "changes nothing when the run had already ended",
      {
        started: true,
        meanwhile: async ({ base, token }, { runId }) => {
          expect((await requestCancel(base, token, runId)).status).toBe(200);
        },
        answer: { ...STOPPED, outcome: "too-late" },
        stopRequested: false,
        verify: async (controller, { taskId }) => expectTaskStage(controller, taskId, "building"),
      },
    ],
  ];

  it.each(CASES)("%s", async (_name, undoCase) => {
    await withNorthwind(async (controller) => {
      const { account, thing, workflowId } = await arrangeOneThing(controller, {
        answers: [REVIEW_REQUESTED],
      });
      const signalId = await arrangeSignal(controller, {
        thing,
        kind: REVIEW_REQUESTED,
        connectionId: account,
      });
      if (undoCase.earlier !== undefined) await createTaskFor(controller, thing, undoCase.earlier);
      const result = await handOff(controller, thing, { workflowId });
      const handed = { thing, account, workflowId, signalId, ...result };
      if (undoCase.started === true) await waitForStepToRun(controller, result.runId);
      else await rewindRunToPending(controller, result.runId);
      await undoCase.meanwhile?.(controller, handed);

      const answer = await undoHandOff(controller, result.runId);

      expect(answer).toEqual({ ...undoCase.answer, stopRequested: undoCase.stopRequested ?? true });
      expect((await readRun(controller.base, controller.token, result.runId)).status).toBe(
        "cancelled",
      );
      // An Undo never brings an ended signal back.
      expect((await readSignal(controller, signalId)).status).toBe("resolved");
      await undoCase.verify?.(controller, handed);
    });
  });

  it("returns the first answer to a repeat, and changes nothing the second time", async () => {
    await withNorthwind(async (controller) => {
      const { thing, workflowId } = await arrangeOneThing(controller);
      const result = await handOff(controller, thing, { workflowId });
      await rewindRunToPending(controller, result.runId);

      const first = await undoHandOff(controller, result.runId);
      // A new handoff of the same thing makes a new Task; a repeat must not take that back.
      await handOff(controller, thing, { workflowId });
      const second = await undoHandOff(controller, result.runId);

      expect(first.outcome).toBe("undone");
      expect(second).toEqual(first);
      expect(await listTasks(controller.base, controller.token)).toHaveLength(1);
    });
  });

  it("answers not found for a run no handoff of an entity started", async () => {
    await withNorthwind(async (controller) => {
      const response = await requestUndoHandOff(controller, ABSENT_ID);

      expect(await readRefusal(response)).toEqual({
        status: 404,
        text: expect.stringContaining("no handoff of an entity has this run") as unknown,
      });
    });
  });

  describe("on a Task that shows a failure", () => {
    /** Hands the thing to a workflow whose only step fails, so its Task shows a failure. */
    const arrangeFailedTask = async (controller: SetUpController) => {
      const { thing, workflowId } = await arrangeOneThing(controller);
      const failing = await createHandoffWorkflow(controller, {
        name: "Investigate",
        steps: [
          {
            id: "fail",
            kind: "action",
            action: "task.update",
            params: { taskId: ABSENT_ID, title: "Gone" },
          },
        ],
      });
      const failed = await handOff(controller, thing, { workflowId: failing });
      await waitForRunToFinish(controller.base, controller.token, failed.runId);
      return { thing, workflowId };
    };

    const hasFailure = async ({ base, token }: SetUpController): Promise<boolean> =>
      (
        (await (await get(base, "/api/v1/tasks/attention", token)).json()) as {
          anyFailure: boolean;
        }
      ).anyFailure;

    it("brings the failure back when the whole handoff is taken back", async () => {
      await withNorthwind(async (controller) => {
        const { thing, workflowId } = await arrangeFailedTask(controller);
        expect(await hasFailure(controller)).toBe(true);
        const retry = await handOff(controller, thing, { workflowId });
        expect(await hasFailure(controller)).toBe(false);
        await rewindRunToPending(controller, retry.runId);

        const answer = await undoHandOff(controller, retry.runId);

        expect(answer).toMatchObject({
          outcome: "undone",
          stageRestored: true,
          failureRestored: true,
        });
        expect(await hasFailure(controller)).toBe(true);
      });
    });

    it("brings no failure back when the run had started, because it may have done work", async () => {
      await withNorthwind(async (controller) => {
        const { thing, workflowId } = await arrangeFailedTask(controller);
        const retry = await handOff(controller, thing, { workflowId });
        await waitForStepToRun(controller, retry.runId);

        const answer = await undoHandOff(controller, retry.runId);

        expect(answer).toMatchObject({ outcome: "stopped", failureRestored: false });
        expect(await hasFailure(controller)).toBe(false);
      });
    });
  });
});

describe("handing the same thing off from a card and from Intake", () => {
  const arrangeBothWays = async (controller: SetUpController) => {
    const account = await createAccount(controller, "bot");
    const thing = await arrangeThing(controller, {
      kind: CHANGE_KIND,
      key: "northwind/web#7",
      title: "Retry failed webhooks",
      accounts: [account],
    });
    const review = await createHandoffWorkflow(controller, {
      name: "Review",
      answers: [REVIEW_REQUESTED],
      signalKinds: [REVIEW_REQUESTED],
    });
    const fixBug = await createHandoffWorkflow(controller, {
      name: "Fix bug",
      signalKinds: [REVIEW_REQUESTED],
    });
    const ways = {
      card: (workflowId: string) => requestHandOff(controller, thing, { workflowId }),
      intake: async (workflowId: string) => {
        const signalId = await arrangeSignal(controller, {
          thing,
          kind: REVIEW_REQUESTED,
          connectionId: account,
          handOffTo: [workflowId],
        });
        return post(
          controller.base,
          `/api/v1/signals/${signalId}/hand-off`,
          { workflowId },
          controller.token,
        );
      },
    };
    return { thing, review, fixBug, ways };
  };

  it.each([
    ["card", "intake"],
    ["intake", "card"],
  ] as const)(
    "%s then %s starts one run on one Task, and a second workflow is still allowed",
    async (first, second) => {
      await withNorthwind(async (controller) => {
        const { review, fixBug, ways } = await arrangeBothWays(controller);

        expect((await ways[first](review)).status).toBe(200);
        const again = await ways[second](review);
        const other = await ways[second](fixBug);

        expect(await readRefusal(again)).toEqual({
          status: 409,
          text: expect.stringContaining("Review is already working on this") as unknown,
        });
        expect(other.status).toBe(200);
        expect(await countRows(controller, "runs")).toBe(2);
        expect(await countRows(controller, "tasks")).toBe(1);
      });
    },
  );

  it("continues the Task of the oldest link when two Tasks carry the ref", async () => {
    await withNorthwind(async (controller) => {
      const { thing, review, fixBug, ways } = await arrangeBothWays(controller);
      const oldest = await createTaskFor(controller, thing, "planned");
      await new Promise((resolve) => setTimeout(resolve, 5));
      await createTaskFor(controller, thing, "planned");

      const fromCard = await handOff(controller, thing, { workflowId: review });
      const fromIntake = await ways.intake(fixBug);

      expect(fromCard.taskId).toBe(oldest.id);
      expect(fromIntake.status).toBe(200);
      const runId = ((await fromIntake.json()) as { resolution: { runId: string } }).resolution
        .runId;
      expect((await readRun(controller.base, controller.token, runId)).taskId).toBe(oldest.id);
    });
  });
});
