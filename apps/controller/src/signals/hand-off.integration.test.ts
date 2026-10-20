/**
 * Tests handing a signal to a workflow over HTTP, against the real controller
 * and the real `BoundOperations` port (spec 11, `signal.handOff`):
 *
 * - the Task the handoff creates or continues, the provenance entry it
 *   appends, the run it links to the Task, and the signal's resolution, both
 *   through `signal.handOff` and through `signal.act` with the Hand to an
 *   agent answer;
 * - which open Task a later signal on the same thread continues;
 * - a signal with no thread, and a signal written before `signal.handOff`
 *   existed, whose Hand to an agent answer still binds `run.start`;
 * - the describe line of the answer, worked out when the signal is read;
 * - a refusal, and a run that cannot start, leave nothing written.
 *
 * The rules that need no real operation are tested in `service.test.ts`.
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import { SqlClient } from "effect/unstable/sql";
import type { Run, Signal, Task, TaskPriority } from "@hercule/contract";
import { mintUuid, uuidFromString, uuidToString, withTransaction } from "../db";
import {
  completeSetup,
  get,
  post,
  readErrorBody,
  send,
  withServer,
  type ServerHarness,
} from "../http/testing";
import { buildTaskStep, createWorkflowOrFail, updateWorkflow } from "../workflows/testing";
import { signalRepository } from "./repository";

const CONNECTION_ID = "0199e0e7-0000-7000-8000-00000000c001";

/** The kind of every plugin signal below; a workflow's signal input may list any qualified kind. */
const KIND = "forge/assigned";

const ISSUE_REF = "forge:issue:acme/api#7";
const OTHER_ISSUE_REF = "forge:issue:acme/api#8";

/** A signal as the Hand to an agent answer binds it. */
type Binding = "signal.handOff" | "run.start";

interface WorkflowToOffer {
  readonly id: string;
  readonly name: string;
}

interface PluginSignalFields {
  readonly threadRef: string;
  readonly eventId: number;
  readonly title: string;
  readonly place: string;
  readonly priority: TaskPriority;
  readonly workflows: ReadonlyArray<WorkflowToOffer>;
  /** What the Hand to an agent answers bind. A signal from before `signal.handOff` binds `run.start`. */
  readonly binds?: Binding;
}

/**
 * Writes an open signal of a plugin's kind, raised from one event on a
 * thread, with a Hand to an agent answer for each workflow, and returns its
 * id. No operation raises a plugin's signal without a running plugin, so the
 * row is written through the repository the event pipeline uses.
 */
const insertPluginSignal = async (
  { sql }: ServerHarness,
  fields: PluginSignalFields,
): Promise<string> => {
  const id = uuidToString(mintUuid());
  const binds = fields.binds ?? "signal.handOff";
  await Effect.runPromise(
    Effect.orDie(
      withTransaction(
        sql,
        Effect.gen(function* () {
          const signals = yield* signalRepository;
          yield* signals.insert(
            {
              id,
              kind: KIND,
              origin: {
                type: "event",
                eventId: fields.eventId,
                connectionId: CONNECTION_ID,
                threadRef: fields.threadRef,
              },
              title: fields.title,
              place: fields.place,
              priority: fields.priority,
              blocks: [],
              actions: fields.workflows.map((workflow) => ({
                id: `hand-to-${workflow.id}`,
                label: `Hand to ${workflow.name}`,
                operation:
                  binds === "signal.handOff"
                    ? { op: "signal.handOff", input: { signalId: id, workflowId: workflow.id } }
                    : {
                        op: "run.start",
                        input: { workflowId: workflow.id, inputs: { signal: id } },
                      },
              })),
              match: {},
              status: "open",
              createdAt: "2026-10-20T10:00:00.000Z",
            },
            [],
          );
        }).pipe(Effect.provideService(SqlClient.SqlClient, sql)),
      ),
    ),
  );
  return id;
};

/** Returns the source of a workflow with one signal input, `signal`, that takes these kinds. */
const buildSignalInputSource = (name: string, kinds: ReadonlyArray<string>): string =>
  [
    `name: ${name}`,
    "inputs:",
    "  - name: signal",
    "    signal:",
    `      kinds: [${kinds.join(", ")}]`,
    "    required: true",
    "steps:",
    buildTaskStep("file_task"),
    "",
  ].join("\n");

/** Creates an enabled workflow that takes the plugin's kind, and returns what a signal offers of it. */
const createWorkflowToOffer = async (
  base: string,
  token: string,
  name: string,
): Promise<WorkflowToOffer> => {
  const workflow = await createWorkflowOrFail(base, token, {
    source: buildSignalInputSource(name, [KIND, "offer"]),
  });
  const response = await updateWorkflow(base, token, workflow.id, { enabled: true });
  expect(response.status, await response.clone().text()).toBe(200);
  return { id: workflow.id, name };
};

const readSignal = async (base: string, token: string, id: string): Promise<Signal> => {
  const response = await get(base, `/api/v1/signals/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Signal;
};

const requestHandOff = (base: string, token: string, signalId: string, workflowId: string) =>
  post(base, `/api/v1/signals/${signalId}/hand-off`, { workflowId }, token);

const requestAct = (base: string, token: string, signalId: string, actionId: string) =>
  post(base, `/api/v1/signals/${signalId}/act`, { actionId }, token);

/** Hands a signal off, or takes its Hand to an agent answer, and returns the resolved signal. */
const handOff = async (
  how: "hand-off" | "act",
  base: string,
  token: string,
  signalId: string,
  workflowId: string,
): Promise<Signal> => {
  const response =
    how === "hand-off"
      ? await requestHandOff(base, token, signalId, workflowId)
      : await requestAct(base, token, signalId, `hand-to-${workflowId}`);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Signal;
};

/** Lists the Tasks that carry a handoff entry. The workflow's own steps file other Tasks. */
const listHandedOffTasks = async (base: string, token: string): Promise<ReadonlyArray<Task>> => {
  const response = await get(base, "/api/v1/tasks?handedOff=true", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Task> }).items;
};

const readTask = async (base: string, token: string, id: string): Promise<Task> => {
  const response = await get(base, `/api/v1/tasks/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

const readRun = async (base: string, token: string, id: string): Promise<Run> => {
  const response = await get(base, `/api/v1/runs/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Run;
};

const countRuns = async (base: string, token: string): Promise<number> => {
  const response = await get(base, "/api/v1/runs", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Run> }).items.length;
};

/** Files an open Task that carries `ref`, as the triage of an earlier event would have. */
const createTaskWithRef = async (
  base: string,
  token: string,
  title: string,
  ref: string,
): Promise<Task> => {
  const response = await post(
    base,
    "/api/v1/tasks",
    { title, description: "", provenance: [{ ref }] },
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Task;
};

const updateTask = async (base: string, token: string, id: string, body: object): Promise<void> => {
  const response = await send("PATCH", base, `/api/v1/tasks/${id}`, { body, token });
  expect(response.status, await response.clone().text()).toBe(200);
};

/** Waits a few milliseconds, so two writes never land on the same instant. */
const tick = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, 5));

/** Joins the parts of the describe line of one action into the text a screen shows. */
const joinLine = (signal: Signal, actionId: string): string =>
  (signal.actions.find((action) => action.id === actionId)?.describeLine ?? [])
    .map((part) => part.text)
    .join("");

describe.each(["hand-off", "act"] as const)("handing a plugin signal off with %s", (how) => {
  it("creates an in-progress Task, links the run to it, records the handoff and resolves the signal", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowToOffer(base, token, "Implement");
      const signalId = await insertPluginSignal(harness, {
        threadRef: ISSUE_REF,
        eventId: 41,
        title: "Retry failed webhooks",
        place: "acme/api#7",
        priority: "high",
        workflows: [workflow],
      });

      const resolved = await handOff(how, base, token, signalId, workflow.id);

      const tasks = await listHandedOffTasks(base, token);
      expect(tasks).toHaveLength(1);
      const [task] = tasks;
      expect(task).toMatchObject({
        title: "Retry failed webhooks",
        priority: "high",
        status: "in-progress",
      });
      expect(resolved.resolution).toMatchObject({
        kind: "decided",
        actionId: `hand-to-${workflow.id}`,
        outcome: "Handed to Implement",
        actor: "user",
      });
      const runId = resolved.resolution?.runId;
      expect(runId).toBeDefined();
      expect(task!.provenance).toEqual([
        {
          signalId,
          runId,
          ref: ISSUE_REF,
          eventId: 41,
          at: expect.any(String) as unknown,
          actor: "user",
        },
      ]);
      expect(await readRun(base, token, runId!)).toMatchObject({
        taskId: task!.id,
        inputs: { signal: signalId },
      });
      expect((await readSignal(base, token, signalId)).status).toBe("resolved");
    });
  });

  it("continues the open Task that carries the thread, for a second signal on it", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const implement = await createWorkflowToOffer(base, token, "Implement");
      const review = await createWorkflowToOffer(base, token, "Review");
      const fields = {
        threadRef: ISSUE_REF,
        place: "acme/api#7",
        priority: "normal",
        workflows: [implement, review],
      } as const;
      const first = await insertPluginSignal(harness, {
        ...fields,
        eventId: 41,
        title: "Retry failed webhooks",
      });
      const second = await insertPluginSignal(harness, {
        ...fields,
        eventId: 42,
        title: "Checks failed on #7",
      });
      const firstRunId = (await handOff(how, base, token, first, implement.id)).resolution?.runId;
      await tick();

      const open = await readSignal(base, token, second);
      expect(joinLine(open, `hand-to-${review.id}`)).toBe(
        "Starts Review on acme/api#7, continues Retry failed webhooks",
      );
      const resolved = await handOff(how, base, token, second, review.id);

      const tasks = await listHandedOffTasks(base, token);
      expect(tasks).toHaveLength(1);
      expect(tasks[0]).toMatchObject({ title: "Retry failed webhooks", status: "in-progress" });
      expect(
        tasks[0]!.provenance.map((entry) => [entry.signalId, entry.runId, entry.eventId]),
      ).toEqual([
        [first, firstRunId, 41],
        [second, resolved.resolution?.runId, 42],
      ]);
      expect(await readRun(base, token, resolved.resolution!.runId!)).toMatchObject({
        taskId: tasks[0]!.id,
      });
    });
  });

  it("always gives a signal with no thread a new Task", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowToOffer(base, token, "Implement");
      const raise = async () => {
        const response = await post(
          base,
          "/api/v1/signals/raise",
          { kind: "offer", title: "Review the dependency bump", reason: "Small.", eventIds: [] },
          token,
        );
        expect(response.status, await response.clone().text()).toBe(200);
        return ((await response.json()) as { signalId: string }).signalId;
      };
      const first = await raise();
      const second = await raise();

      await handOff(how, base, token, first, workflow.id);
      await handOff(how, base, token, second, workflow.id);

      const tasks = await listHandedOffTasks(base, token);
      expect(tasks.map((task) => task.title)).toEqual([
        "Review the dependency bump",
        "Review the dependency bump",
      ]);
      expect(tasks.map((task) => task.provenance.map((entry) => entry.ref))).toEqual([
        [undefined],
        [undefined],
      ]);
    });
  });
});

describe("which Task a handoff continues", () => {
  it("continues the most recently updated open Task of the thread, sets it in-progress, and passes over done and other threads", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowToOffer(base, token, "Implement");
      const older = await createTaskWithRef(base, token, "Older open Task", ISSUE_REF);
      await tick();
      const newer = await createTaskWithRef(base, token, "Newer open Task", ISSUE_REF);
      await tick();
      const done = await createTaskWithRef(base, token, "Finished Task", ISSUE_REF);
      await updateTask(base, token, done.id, { status: "done" });
      await createTaskWithRef(base, token, "Other thread", OTHER_ISSUE_REF);
      await tick();
      // Touching the older Task makes it the most recently updated open one.
      await updateTask(base, token, older.id, { title: "Older open Task, edited" });
      await tick();
      const signalId = await insertPluginSignal(harness, {
        threadRef: ISSUE_REF,
        eventId: 43,
        title: "Checks failed",
        place: "acme/api#7",
        priority: "normal",
        workflows: [workflow],
      });
      const open = await readSignal(base, token, signalId);
      expect(joinLine(open, `hand-to-${workflow.id}`)).toBe(
        "Starts Implement on acme/api#7, continues Older open Task, edited",
      );

      await handOff("hand-off", base, token, signalId, workflow.id);

      expect((await readTask(base, token, older.id)).status).toBe("in-progress");
      expect((await readTask(base, token, older.id)).provenance.at(-1)?.signalId).toBe(signalId);
      expect(await readTask(base, token, newer.id)).toMatchObject({
        status: "open",
        provenance: [{ ref: ISSUE_REF }],
      });
      expect((await readTask(base, token, done.id)).status).toBe("done");
      expect(await listHandedOffTasks(base, token)).toHaveLength(1);
    });
  });
});

describe("the describe line", () => {
  it("names the signal by its place, or by its title when it has none, and says a new Task is made", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowToOffer(base, token, "Implement");
      const withPlace = await insertPluginSignal(harness, {
        threadRef: ISSUE_REF,
        eventId: 41,
        title: "Retry failed webhooks",
        place: "acme/api#7",
        priority: "normal",
        workflows: [workflow],
      });
      const response = await post(
        base,
        "/api/v1/signals/raise",
        { kind: "offer", title: "Review the bump", reason: "Small.", eventIds: [] },
        token,
      );
      const { signalId: withoutPlace } = (await response.json()) as { signalId: string };

      const [placed, titled] = await Promise.all([
        readSignal(base, token, withPlace),
        readSignal(base, token, withoutPlace),
      ]);

      expect(joinLine(placed, `hand-to-${workflow.id}`)).toBe(
        "Starts Implement on acme/api#7, tracked as a new Task",
      );
      expect(joinLine(titled, `hand-to-${workflow.id}`)).toBe(
        "Starts Implement on Review the bump, tracked as a new Task",
      );
    });
  });
});

describe("a signal written before handoffs were tracked", () => {
  it("hands off untracked through run.start, with no Task, and still records the run", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowToOffer(base, token, "Implement");
      const signalId = await insertPluginSignal(harness, {
        threadRef: ISSUE_REF,
        eventId: 41,
        title: "Retry failed webhooks",
        place: "acme/api#7",
        priority: "normal",
        workflows: [workflow],
        binds: "run.start",
      });

      const resolved = await handOff("hand-off", base, token, signalId, workflow.id);

      expect(await listHandedOffTasks(base, token)).toEqual([]);
      const runId = resolved.resolution?.runId;
      expect(runId).toBeDefined();
      expect((await readRun(base, token, runId!)).taskId).toBeUndefined();
      expect(resolved.resolution).toMatchObject({ outcome: "Handed to Implement" });
    });
  });
});

describe("a handoff that cannot go through", () => {
  it("refuses a workflow the signal does not offer, and says which it offers", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const offered = await createWorkflowToOffer(base, token, "Implement");
      const other = await createWorkflowToOffer(base, token, "Review");
      const signalId = await insertPluginSignal(harness, {
        threadRef: ISSUE_REF,
        eventId: 41,
        title: "Retry failed webhooks",
        place: "acme/api#7",
        priority: "normal",
        workflows: [offered],
      });

      const response = await requestHandOff(base, token, signalId, other.id);

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.message).toContain(other.id);
      expect(refusal.message).toContain(offered.id);
      expect((await readSignal(base, token, signalId)).status).toBe("open");
      expect(await listHandedOffTasks(base, token)).toEqual([]);
    });
  });

  it("refuses a signal that is already resolved", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowToOffer(base, token, "Implement");
      const signalId = await insertPluginSignal(harness, {
        threadRef: ISSUE_REF,
        eventId: 41,
        title: "Retry failed webhooks",
        place: "acme/api#7",
        priority: "normal",
        workflows: [workflow],
      });
      await handOff("hand-off", base, token, signalId, workflow.id);

      const again = await requestHandOff(base, token, signalId, workflow.id);

      const refusal = await readErrorBody(again);
      expect(again.status, refusal.text).toBe(409);
      expect(refusal.code).toBe("invalid_state");
      expect(await listHandedOffTasks(base, token)).toHaveLength(1);
    });
  });

  it("writes no Task and leaves the signal open when the run cannot start", async () => {
    await withServer(async (harness) => {
      const { base, sql } = harness;
      const token = await completeSetup(base);
      const workflow = await createWorkflowToOffer(base, token, "Implement");
      const signalId = await insertPluginSignal(harness, {
        threadRef: ISSUE_REF,
        eventId: 41,
        title: "Retry failed webhooks",
        place: "acme/api#7",
        priority: "normal",
        workflows: [workflow],
      });
      // The workflow's step names an action that does not exist, as after a
      // plugin that provided it was removed, so `run.start` refuses it after
      // the Task was written.
      await Effect.runPromise(
        Effect.orDie(
          withTransaction(
            sql,
            sql`UPDATE workflows SET definition = json_set(definition, '$.steps[0].action', 'gone.action')
                WHERE id = ${uuidFromString(workflow.id)}`,
          ),
        ),
      );
      const tasksBefore = (await get(base, "/api/v1/tasks", token).then((r) => r.json())) as {
        items: ReadonlyArray<Task>;
      };

      for (const how of ["hand-off", "act"] as const) {
        const response =
          how === "hand-off"
            ? await requestHandOff(base, token, signalId, workflow.id)
            : await requestAct(base, token, signalId, `hand-to-${workflow.id}`);
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
      }

      expect((await readSignal(base, token, signalId)).status).toBe("open");
      const tasksAfter = (await get(base, "/api/v1/tasks", token).then((r) => r.json())) as {
        items: ReadonlyArray<Task>;
      };
      expect(tasksAfter.items).toEqual(tasksBefore.items);
      expect(await countRuns(base, token)).toBe(0);
    });
  });
});
