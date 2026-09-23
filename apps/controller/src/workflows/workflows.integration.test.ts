/**
 * Stored workflows over a real socket: what a create keeps, what an update
 * changes, what the listings answer, the trigger rows a save leaves behind,
 * who may do each of these, and what the live socket is told.
 *
 * Every case goes through the public API, because the text a person wrote is
 * the thing under test, and only the wire can say whether it came back byte
 * for byte. One step is arranged behind the API: a start trigger's status is
 * set in the database, because no operation pauses a trigger yet.
 *
 * Every source a case expects to be saved is a workflow the controller would
 * also accept once it checks meaning and not only shape: its agents and its
 * Connection exist, its actions and event kinds are ones the controller knows,
 * and every step is reached from where a run begins.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as Fiber from "effect/Fiber";
import {
  renderWorkflowSource,
  type Trigger,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowSummary,
} from "@hercule/contract";
import { nestInLists } from "@hercule/protocol/testing";
import {
  collecting,
  del,
  expectHeld,
  get,
  onSocket,
  readRefusal,
  ticketFor,
  within,
} from "../http/testing";
import { agentOn, profileNamed, WAIT_DEADLINE_MS, withAgentFleet } from "../sessions/testing";
import {
  ABSENT_ID,
  ACCEPTED_GITHUB_TOKEN,
  buildFileTaskSource,
  createAgent,
  createConnection,
  createWorkflow,
  createWorkflowOrFail,
  DUPLICATE_STEP_ID_SOURCE,
  expectNothingStored,
  KEBAB_CASE_STEP_ID_SOURCE,
  queryTriggers,
  queryWorkflows,
  readIssues,
  SYNTAX_ERROR_SOURCE,
  updateWorkflow,
  withSetUpController,
  WRONG_KIND_SOURCE,
} from "./testing";

/**
 * Three, because a case about a session token waits for the fleet to be
 * probed and then for each session it starts.
 */
vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 3 + 10_000 });

const updateWorkflowOrFail = async (
  base: string,
  token: string,
  id: string,
  body: unknown,
): Promise<Workflow> => {
  const response = await updateWorkflow(base, token, id, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { workflow: Workflow }).workflow;
};

const deleteWorkflow = (base: string, token: string, id: string): Promise<Response> =>
  del(base, `/api/v1/workflows/${id}`, token);

const readWorkflow = async (base: string, token: string, id: string): Promise<Workflow> => {
  const response = await get(base, `/api/v1/workflows/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Workflow;
};

const sortTriggerIds = (items: ReadonlyArray<Trigger>): ReadonlyArray<string> =>
  items.map((item) => item.triggerId).sort();

/** Waits long enough that the next write lands in a later millisecond. */
const waitForNextMillisecond = (): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, 10));

/**
 * Everything a formatter would change: comments, blank lines, keys out of
 * contract order, a block prompt that keeps an indented line, trailing
 * whitespace, a character outside ASCII, and two newlines at the end. A store
 * that reformats, trims or re-encodes anything gives back other bytes.
 */
const buildHandWrittenSource = (agentId: string): string =>
  [
    "# Reviews a pull request when someone asks for it.   ",
    "",
    "steps:",
    "  # One agent step, written before the name on purpose.",
    "  - kind: agent",
    "    id: review",
    "",
    `    agent: ${agentId}`,
    "    prompt: |",
    "      Review the pull request.",
    "        Keep this indented line as it is.",
    "      Say what you would change, café included.   ",
    "",
    "name: Review on request   ",
    "description: One agent step.",
    "",
    "",
  ].join("\n");

/** A definition with its keys out of contract order and a description on two lines. */
const FILE_TASK_DEFINITION = {
  steps: [
    {
      params: { title: "Look at the overnight failures", description: "Filed by a workflow." },
      action: "task.create",
      kind: "action",
      id: "file_task",
    },
  ],
  description: "Files one task.\nWritten as an object, not as text.",
  name: "File a task",
};

const DUPLICATE_TRIGGER_ID_SOURCE = `name: three triggers, two ids
triggers:
  - id: nightly
    kind: start
    source:
      kind: cron.tick
    schedule: "0 2 * * *"
  - id: on_create
    kind: start
    source:
      kind: task.created
  - id: nightly
    kind: signal
    source:
      kind: task.updated
    correlation:
      event: event.payload.id
      run: steps.file_task.output.id
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: One
      description: The first.
    terminal: true
`;

/**
 * A step that reuses a trigger's id. The text writes the steps first, and the
 * step is still the later node: triggers come before steps in the definition.
 */
const STEP_REUSING_TRIGGER_ID_SOURCE = `name: a step that reuses a trigger id
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: One
      description: The first.
  - id: nightly
    kind: action
    action: task.create
    params:
      title: Two
      description: The second.
triggers:
  - id: nightly
    kind: start
    source:
      kind: cron.tick
    schedule: "0 2 * * *"
`;

const KEBAB_CASE_TRIGGER_ID_SOURCE = `name: kebab trigger
triggers:
  - id: checks-failed
    kind: start
    source:
      kind: task.created
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: One
      description: The first.
`;

/** The filter start trigger `a` carries, as it is written in the source. */
const LABEL_FILTER = '"triage" in event.payload.added';

/** The source of start trigger `b`: a weekday schedule in a named zone. */
const CRON_TRIGGER_B_SOURCE = `  - id: b
    kind: start
    source:
      kind: cron.tick
    schedule: "0 9 * * 1-5"
    timezone: Europe/Amsterdam
`;

/** The source of start trigger `c`, which an update adds in place of `b`. */
const TASK_TRIGGER_C_SOURCE = `  - id: c
    kind: start
    source:
      kind: task.created
`;

/**
 * The Label triage workflow: start trigger `a` on a labelled pull request
 * through a named Connection, a second start trigger, and signal trigger `s`
 * that fires when the filed task changes and leads to the terminal step.
 */
const buildLabelTriageSource = (connectionId: string, secondStartTrigger: string): string =>
  `name: Label triage
triggers:
  - id: a
    kind: start
    source:
      kind: github.pr.labeled
      connectionId: ${connectionId}
      filter: '${LABEL_FILTER}'
${secondStartTrigger}  - id: s
    kind: signal
    source:
      kind: task.updated
    correlation:
      event: event.payload.id
      run: steps.file_task.output.id
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: Triage the labelled pull request
      description: Filed by the Label triage workflow.
  - id: close_out
    kind: action
    action: task.create
    terminal: true
    params:
      title: Close out the triage
      description: The triage task changed.
edges:
  - from: s
    to: close_out
`;

/**
 * Another workflow's trigger, for the listing to stand beside. Its cron
 * trigger names no timezone.
 */
const NIGHTLY_SWEEP_SOURCE = `name: Nightly sweep
triggers:
  - id: nightly
    kind: start
    source:
      kind: cron.tick
    schedule: "0 2 * * *"
steps:
  - id: sweep
    kind: action
    action: task.create
    params:
      title: Sweep the stale tasks
      description: Filed every night.
`;

describe("workflow.create with a source", () => {
  it("reads back the five fields and nothing else, with the source byte for byte as it was sent", async () => {
    await withSetUpController(async ({ base, token }) => {
      const source = buildHandWrittenSource(await createAgent(base, token));

      const response = await createWorkflow(base, token, { source });
      expect([200, 201], await response.clone().text()).toContain(response.status);
      const saveAnswer = (await response.json()) as Record<string, unknown>;
      // The save answers with the record and the warnings of the save, apart.
      expect(Object.keys(saveAnswer).sort()).toEqual(["warnings", "workflow"]);
      expect(saveAnswer["warnings"]).toEqual([]);
      const workflow = saveAnswer["workflow"] as Workflow;

      const stored = await readWorkflow(base, token, workflow.id);
      expect(Object.keys(stored).sort()).toEqual([
        "createdAt",
        "enabled",
        "id",
        "source",
        "updatedAt",
      ]);
      expect(stored.id).toBe(workflow.id);
      expect(Buffer.from(stored.source, "utf8").equals(Buffer.from(source, "utf8"))).toBe(true);
      expect(stored).toEqual(workflow);
    });
  });
});

describe("workflow.create with a definition", () => {
  it("stores the canonical render of the definition", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_TASK_DEFINITION,
      });

      expect((await readWorkflow(base, token, workflow.id)).source).toBe(
        renderWorkflowSource(FILE_TASK_DEFINITION as WorkflowDefinition),
      );
    });
  });

  it("refuses a create that sends both a source and a definition, or neither, and stores nothing", async () => {
    await withSetUpController(async ({ base, token }) => {
      for (const body of [
        { source: buildFileTaskSource("Both"), definition: FILE_TASK_DEFINITION },
        {},
      ]) {
        const response = await createWorkflow(base, token, body);
        const refusal = await readRefusal(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
      }
      await expectNothingStored(base, token);
    });
  });
});

describe("a source that is refused", () => {
  it("names a YAML syntax error once, with no path, by its line and column", async () => {
    await withSetUpController(async ({ base, token }) => {
      const response = await createWorkflow(base, token, { source: SYNTAX_ERROR_SOURCE });
      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toEqual([[]]);
      // The refusal holds this one issue, so its message is where the numbers are.
      expect(refusal.text).toMatch(/\b9\b/);
      expect(refusal.text).toMatch(/\b20\b/);
      await expectNothingStored(base, token);
    });
  });

  it("points a field of the wrong shape at that field", async () => {
    await withSetUpController(async ({ base, token }) => {
      const response = await createWorkflow(base, token, { source: WRONG_KIND_SOURCE });
      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toEqual([["steps", "0", "kind"]]);
      await expectNothingStored(base, token);
    });
  });

  it("points two nodes that share an id at the later one in definition order: triggers, then steps", async () => {
    await withSetUpController(async ({ base, token }) => {
      for (const [source, path] of [
        [DUPLICATE_STEP_ID_SOURCE, ["steps", "1", "id"]],
        [DUPLICATE_TRIGGER_ID_SOURCE, ["triggers", "2", "id"]],
        [STEP_REUSING_TRIGGER_ID_SOURCE, ["steps", "1", "id"]],
      ] as const) {
        const response = await createWorkflow(base, token, { source });
        const refusal = await readRefusal(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
        expect(refusal.issues).toEqual([path]);
      }
      await expectNothingStored(base, token);
    });
  });

  it("points an id that is not snake_case at that id and suggests the snake_case spelling", async () => {
    await withSetUpController(async ({ base, token }) => {
      const stepResponse = await createWorkflow(base, token, {
        source: KEBAB_CASE_STEP_ID_SOURCE,
      });
      const stepRefusal = await readRefusal(stepResponse);
      expect(stepResponse.status, stepRefusal.text).toBe(400);
      expect(stepRefusal.code).toBe("validation");
      expect(stepRefusal.issues).toEqual([["steps", "0", "id"]]);
      expect(stepRefusal.text).toContain("open_pr");

      const triggerResponse = await createWorkflow(base, token, {
        source: KEBAB_CASE_TRIGGER_ID_SOURCE,
      });
      const triggerRefusal = await readRefusal(triggerResponse);
      expect(triggerResponse.status, triggerRefusal.text).toBe(400);
      expect(triggerRefusal.code).toBe("validation");
      expect(triggerRefusal.issues).toEqual([["triggers", "0", "id"]]);
      expect(triggerRefusal.text).toContain("checks_failed");

      await expectNothingStored(base, token);
    });
  });
});

describe("workflow.update", () => {
  it("stores the bytes of a new source exactly", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("First"),
      });
      const nextSource = `# Renamed, with a comment the store must keep.  \n\n${buildFileTaskSource("Second")}\n`;

      const updated = await updateWorkflowOrFail(base, token, workflow.id, { source: nextSource });
      expect(updated.source).toBe(nextSource);
      expect((await readWorkflow(base, token, workflow.id)).source).toBe(nextSource);
    });
  });

  it("stores the canonical render of a new definition", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("First"),
      });

      await updateWorkflowOrFail(base, token, workflow.id, { definition: FILE_TASK_DEFINITION });
      expect((await readWorkflow(base, token, workflow.id)).source).toBe(
        renderWorkflowSource(FILE_TASK_DEFINITION as WorkflowDefinition),
      );
    });
  });

  it("flips enabled alone and leaves the source byte-equal", async () => {
    await withSetUpController(async ({ base, token }) => {
      const source = `# Kept as written.   \n${buildFileTaskSource("Toggled")}\n`;
      const workflow = await createWorkflowOrFail(base, token, { source });

      const updated = await updateWorkflowOrFail(base, token, workflow.id, { enabled: true });
      expect(updated.enabled).toBe(true);
      const stored = await readWorkflow(base, token, workflow.id);
      expect(stored.enabled).toBe(true);
      expect(stored.source).toBe(source);
    });
  });

  // The listing sorts by updatedAt. If a toggle moved it, the Workflows
  // screen would move a row to the top when its switch is pressed, and a
  // second press at the same place would reach another workflow.
  it("moves updatedAt only when the text changes, so a toggle keeps the workflow's place in the list", async () => {
    await withSetUpController(async ({ base, token }) => {
      const older = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Older"),
      });
      await waitForNextMillisecond();
      const newer = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Newer"),
      });
      const listIds = async () => (await queryWorkflows(base, token)).items.map((item) => item.id);
      expect(await listIds()).toEqual([newer.id, older.id]);
      const entriesBefore = (await readLog(base, token)).length;

      await waitForNextMillisecond();
      expect((await updateWorkflowOrFail(base, token, older.id, { enabled: true })).updatedAt).toBe(
        older.updatedAt,
      );
      await waitForNextMillisecond();
      expect(
        (
          await updateWorkflowOrFail(base, token, older.id, {
            source: buildFileTaskSource("Older"),
          })
        ).updatedAt,
      ).toBe(older.updatedAt);
      expect((await readWorkflow(base, token, older.id)).updatedAt).toBe(older.updatedAt);
      expect(await listIds()).toEqual([newer.id, older.id]);
      // The audit log records the toggle, although the workflow's own time does not move.
      const toggleEntry = (await readLog(base, token))[entriesBefore];
      expect(toggleEntry?.kind).toBe("workflow.updated");
      expect(toggleEntry?.payload).toEqual({ workflowId: older.id, changed: ["enabled"] });
      // A save of the same text is one entry too, and it names no change.
      const sameTextEntry = (await readLog(base, token))[entriesBefore + 1];
      expect(sameTextEntry?.kind).toBe("workflow.updated");
      expect(sameTextEntry?.payload).toEqual({ workflowId: older.id, changed: [] });

      await waitForNextMillisecond();
      const rewritten = await updateWorkflowOrFail(base, token, older.id, {
        source: buildFileTaskSource("Rewritten"),
      });
      expect(rewritten.updatedAt > older.updatedAt).toBe(true);
      expect(await listIds()).toEqual([older.id, newer.id]);
    });
  });

  it("leaves the stored workflow unchanged when an update is refused", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Kept"),
      });
      const storedBefore = await readWorkflow(base, token, workflow.id);
      await waitForNextMillisecond();

      for (const body of [
        { source: SYNTAX_ERROR_SOURCE },
        { source: KEBAB_CASE_STEP_ID_SOURCE, enabled: true },
        { source: buildFileTaskSource("Both"), definition: FILE_TASK_DEFINITION },
      ]) {
        const response = await updateWorkflow(base, token, workflow.id, body);
        const refusal = await readRefusal(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
        expect(await readWorkflow(base, token, workflow.id)).toEqual(storedBefore);
      }
    });
  });

  it("answers not_found for an id that names no workflow", async () => {
    await withSetUpController(async ({ base, token }) => {
      // One workflow stands beside it, so not found is an answer about this id.
      await createWorkflowOrFail(base, token, { source: buildFileTaskSource("Present") });

      const response = await updateWorkflow(base, token, ABSENT_ID, { enabled: true });
      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
    });
  });
});

describe("whether a workflow is enabled", () => {
  it("reads false after a create, whether a source or a definition was sent", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflowFromSource = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Text"),
      });
      const workflowFromDefinition = await createWorkflowOrFail(base, token, {
        definition: FILE_TASK_DEFINITION,
      });

      expect(workflowFromSource.enabled).toBe(false);
      expect(workflowFromDefinition.enabled).toBe(false);
      expect((await readWorkflow(base, token, workflowFromSource.id)).enabled).toBe(false);
      expect((await readWorkflow(base, token, workflowFromDefinition.id)).enabled).toBe(false);
    });
  });

  it("turns on only through an update that says enabled: true, and a new source leaves it as it is", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Off"),
      });

      await updateWorkflowOrFail(base, token, workflow.id, {
        source: buildFileTaskSource("Still off"),
      });
      expect((await readWorkflow(base, token, workflow.id)).enabled).toBe(false);

      await updateWorkflowOrFail(base, token, workflow.id, { enabled: true });
      expect((await readWorkflow(base, token, workflow.id)).enabled).toBe(true);

      await updateWorkflowOrFail(base, token, workflow.id, {
        source: buildFileTaskSource("Still on"),
      });
      expect((await readWorkflow(base, token, workflow.id)).enabled).toBe(true);
    });
  });

  it("refuses a source that says enabled, because enabled is not part of the text", async () => {
    await withSetUpController(async ({ base, token }) => {
      const response = await createWorkflow(base, token, {
        source: `enabled: true\n${buildFileTaskSource("Switched on in the text")}`,
      });
      const refusal = await readRefusal(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toContainEqual(["enabled"]);
      await expectNothingStored(base, token);
    });
  });
});

describe("workflow.query", () => {
  it("pages through every workflow once, each item the five fields its definition gives", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflows: Array<Workflow> = [];
      for (let index = 0; index < 5; index++) {
        const description = index % 2 === 0 ? `Workflow number ${String(index)}.` : undefined;
        workflows.push(
          await createWorkflowOrFail(base, token, {
            source: buildFileTaskSource(`Workflow ${String(index)}`, description),
          }),
        );
        await waitForNextMillisecond();
      }

      const listedItems: Array<WorkflowSummary> = [];
      let cursor: string | undefined;
      for (let pageCount = 0; pageCount < 10; pageCount++) {
        const cursorParameter = cursor === undefined ? "" : `&cursor=${encodeURIComponent(cursor)}`;
        const page = await queryWorkflows(base, token, `?limit=2${cursorParameter}`);
        expect(page.items.length).toBeLessThanOrEqual(2);
        listedItems.push(...page.items);
        cursor = page.nextCursor;
        if (cursor === undefined) break;
      }
      expect(cursor, "the listing ended").toBeUndefined();
      expect(listedItems.map((item) => item.id).sort()).toEqual(
        workflows.map((workflow) => workflow.id).sort(),
      );

      for (const [index, workflow] of workflows.entries()) {
        const item = listedItems.find((listed) => listed.id === workflow.id);
        expect(item).toEqual({
          id: workflow.id,
          name: `Workflow ${String(index)}`,
          ...(index % 2 === 0 ? { description: `Workflow number ${String(index)}.` } : {}),
          enabled: false,
          updatedAt: workflow.updatedAt,
        });
        // Absent, not null, when the source has no description.
        if (index % 2 === 1) expect(Object.keys(item!)).not.toContain("description");
      }
    });
  });

  it("answers the name and description of the definition stored last", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Before", "Said before."),
      });
      await updateWorkflowOrFail(base, token, workflow.id, {
        source: buildFileTaskSource("After"),
      });

      const items = (await queryWorkflows(base, token)).items;
      expect(items).toHaveLength(1);
      expect(items[0]!.name).toBe("After");
      expect(Object.keys(items[0]!)).not.toContain("description");
    });
  });

  it("filters by enabled", async () => {
    await withSetUpController(async ({ base, token }) => {
      const enabledWorkflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("On"),
      });
      const disabledWorkflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Off"),
      });
      const otherDisabledWorkflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Also off"),
      });
      await updateWorkflowOrFail(base, token, enabledWorkflow.id, { enabled: true });

      const enabledItems = (await queryWorkflows(base, token, "?enabled=true")).items;
      expect(enabledItems.map((item) => item.id)).toEqual([enabledWorkflow.id]);
      const disabledItems = (await queryWorkflows(base, token, "?enabled=false")).items;
      expect(disabledItems.map((item) => item.id).sort()).toEqual(
        [disabledWorkflow.id, otherDisabledWorkflow.id].sort(),
      );
    });
  });
});

describe("workflow.delete", () => {
  it("removes the workflow and every trigger row of it, and a read afterwards is not found", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflowToDelete = await createWorkflowOrFail(base, token, {
        source: NIGHTLY_SWEEP_SOURCE,
      });
      const workflowToKeep = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Kept"),
      });
      expect(
        sortTriggerIds(await queryTriggers(base, token, `?workflowId=${workflowToDelete.id}`)),
      ).toEqual(["nightly"]);

      const deleteResponse = await deleteWorkflow(base, token, workflowToDelete.id);
      expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200);

      const readResponse = await get(base, `/api/v1/workflows/${workflowToDelete.id}`, token);
      const refusal = await readRefusal(readResponse);
      expect(readResponse.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
      expect(await queryTriggers(base, token, `?workflowId=${workflowToDelete.id}`)).toEqual([]);
      expect((await queryWorkflows(base, token)).items.map((item) => item.id)).toEqual([
        workflowToKeep.id,
      ]);
    });
  });
});

describe("trigger.query", () => {
  it("lists every workflow's triggers with every field, newest first, filtered by each field it takes", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const labelTriage = await createWorkflowOrFail(base, token, {
        source: buildLabelTriageSource(connectionId, CRON_TRIGGER_B_SOURCE),
      });
      await waitForNextMillisecond();
      const nightlySweep = await createWorkflowOrFail(base, token, {
        source: NIGHTLY_SWEEP_SOURCE,
      });

      const allTriggers = await queryTriggers(base, token);
      expect(allTriggers).toHaveLength(4);
      // The Nightly sweep was created last, so its trigger is the newest.
      expect([allTriggers[0]!.workflowId, allTriggers[0]!.triggerId]).toEqual([
        nightlySweep.id,
        "nightly",
      ]);
      expect(sortTriggerIds(allTriggers.slice(1))).toEqual(["a", "b", "s"]);
      for (const [index, item] of allTriggers.entries()) {
        if (index > 0) expect(item.createdAt <= allTriggers[index - 1]!.createdAt).toBe(true);
      }

      const findTrigger = (items: ReadonlyArray<Trigger>, triggerId: string): Trigger => {
        const found = items.find((item) => item.triggerId === triggerId);
        expect(found, triggerId).toBeDefined();
        return found!;
      };
      const timestampMatchers: Record<"createdAt" | "updatedAt", unknown> = {
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      };
      const triggerA = findTrigger(allTriggers, "a");
      expect(triggerA).toEqual({
        workflowId: labelTriage.id,
        workflowName: "Label triage",
        triggerId: "a",
        kind: "start",
        eventKind: "github.pr.labeled",
        connectionId,
        filter: LABEL_FILTER,
        status: "active",
        ...timestampMatchers,
      });
      expect(findTrigger(allTriggers, "b")).toEqual({
        workflowId: labelTriage.id,
        workflowName: "Label triage",
        triggerId: "b",
        kind: "start",
        eventKind: "cron.tick",
        schedule: "0 9 * * 1-5",
        timezone: "Europe/Amsterdam",
        status: "active",
        ...timestampMatchers,
      });
      // A signal trigger has no status: it is not a thing that can be paused.
      expect(findTrigger(allTriggers, "s")).toEqual({
        workflowId: labelTriage.id,
        workflowName: "Label triage",
        triggerId: "s",
        kind: "signal",
        eventKind: "task.updated",
        ...timestampMatchers,
      });
      // The row repeats what the source says, and this source names no
      // timezone. The user's timezone setting applies when the tick fires,
      // not when the trigger is saved.
      expect(findTrigger(allTriggers, "nightly")).toEqual({
        workflowId: nightlySweep.id,
        workflowName: "Nightly sweep",
        triggerId: "nightly",
        kind: "start",
        eventKind: "cron.tick",
        schedule: "0 2 * * *",
        status: "active",
        ...timestampMatchers,
      });

      expect(
        sortTriggerIds(await queryTriggers(base, token, `?workflowId=${labelTriage.id}`)),
      ).toEqual(["a", "b", "s"]);
      expect(sortTriggerIds(await queryTriggers(base, token, "?kind=signal"))).toEqual(["s"]);
      expect(sortTriggerIds(await queryTriggers(base, token, "?kind=start"))).toEqual([
        "a",
        "b",
        "nightly",
      ]);
      expect(sortTriggerIds(await queryTriggers(base, token, "?eventKind=cron.tick"))).toEqual([
        "b",
        "nightly",
      ]);
      expect(sortTriggerIds(await queryTriggers(base, token, "?status=active"))).toEqual([
        "a",
        "b",
        "nightly",
      ]);

      // No operation pauses a trigger yet, so the row is paused where it lives.
      await Effect.runPromise(
        Effect.orDie(harness.sql`UPDATE triggers SET status = 'paused' WHERE trigger_id = 'a'`),
      );
      expect(sortTriggerIds(await queryTriggers(base, token, "?status=paused"))).toEqual(["a"]);

      await waitForNextMillisecond();
      await updateWorkflowOrFail(base, token, labelTriage.id, {
        source: buildLabelTriageSource(connectionId, TASK_TRIGGER_C_SOURCE),
      });
      const triggersAfterUpdate = await queryTriggers(base, token, `?workflowId=${labelTriage.id}`);
      expect(sortTriggerIds(triggersAfterUpdate)).toEqual(["a", "c", "s"]);
      expect(findTrigger(triggersAfterUpdate, "a").status).toBe("paused");
      expect(findTrigger(triggersAfterUpdate, "a").createdAt).toBe(triggerA.createdAt);
      expect(findTrigger(triggersAfterUpdate, "c")).toMatchObject({
        kind: "start",
        eventKind: "task.created",
        status: "active",
      });
      // The trigger the update added is the newest of all.
      expect((await queryTriggers(base, token))[0]!.triggerId).toBe("c");

      const deleteResponse = await deleteWorkflow(base, token, labelTriage.id);
      expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200);
      expect(await queryTriggers(base, token, `?workflowId=${labelTriage.id}`)).toEqual([]);
      expect(sortTriggerIds(await queryTriggers(base, token))).toEqual(["nightly"]);
    });
  });
});

/** One entry of the event log, as much of it as these cases read. */
interface LogEntry {
  readonly id: number;
  readonly kind: string;
  readonly actor: string | null;
  readonly payload: unknown;
}

/** The whole log, oldest first, read by the user. */
const readLog = async (base: string, token: string): Promise<ReadonlyArray<LogEntry>> => {
  const response = await get(base, "/api/v1/events?sort=id:asc&limit=500", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<LogEntry> }).items;
};

/** The entries about workflows, oldest first. */
const readWorkflowEntries = async (base: string, token: string): Promise<ReadonlyArray<LogEntry>> =>
  (await readLog(base, token)).filter((entry) => entry.kind.startsWith("workflow."));

describe("who a workflow write is stamped with", () => {
  it("writes one audit entry for each create, update and delete, stamped with the user", async () => {
    await withSetUpController(async ({ base, token }) => {
      // Nothing else runs on this controller, so every entry a write appends
      // is that write's.
      const collectEntriesAppendedBy = async (
        write: () => Promise<void>,
      ): Promise<ReadonlyArray<LogEntry>> => {
        const entriesBefore = await readLog(base, token);
        await write();
        return (await readLog(base, token)).slice(entriesBefore.length);
      };

      let workflowId = "";
      const writes: ReadonlyArray<() => Promise<void>> = [
        async () => {
          workflowId = (
            await createWorkflowOrFail(base, token, { source: buildFileTaskSource("Audited") })
          ).id;
        },
        async () => {
          await updateWorkflowOrFail(base, token, workflowId, {
            source: buildFileTaskSource("Audited again"),
          });
        },
        async () => {
          await updateWorkflowOrFail(base, token, workflowId, { enabled: true });
        },
        async () => {
          const response = await deleteWorkflow(base, token, workflowId);
          expect(response.status, await response.clone().text()).toBe(200);
        },
      ];
      for (const write of writes) {
        const appendedEntries = await collectEntriesAppendedBy(write);
        expect(appendedEntries).toHaveLength(1);
        expect(appendedEntries[0]!.kind).toMatch(/^workflow\./);
        expect(appendedEntries[0]!.actor).toBe("user");
      }
    });
  });

  it("stamps each write a session makes with that session", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const unrestrictedSession = await agentOn(
        arranged,
        await profileNamed(arranged, "unrestricted"),
      );
      const sessionActor = `session:${unrestrictedSession.session.id}`;

      const workflow = await createWorkflowOrFail(base, unrestrictedSession.token, {
        source: buildFileTaskSource("Written by a session"),
      });
      await updateWorkflowOrFail(base, unrestrictedSession.token, workflow.id, { enabled: true });
      const deleteResponse = await deleteWorkflow(base, unrestrictedSession.token, workflow.id);
      expect(deleteResponse.status, await deleteResponse.clone().text()).toBe(200);

      const workflowEntries = await readWorkflowEntries(base, arranged.token);
      expect(workflowEntries.map((entry) => entry.actor)).toEqual([
        sessionActor,
        sessionActor,
        sessionActor,
      ]);
    });
  });

  it("refuses a session whose profile lacks workflow.write by the grant's name, and writes nothing", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const userWorkflow = await createWorkflowOrFail(base, arranged.token, {
        source: buildFileTaskSource("The user's"),
      });
      const storedBefore = await readWorkflow(base, arranged.token, userWorkflow.id);
      const workflowEntriesBefore = await readWorkflowEntries(base, arranged.token);
      // The shipped assistant profile reads workflows and does not write them.
      const assistantSession = await agentOn(arranged, await profileNamed(arranged, "assistant"));

      for (const response of [
        await createWorkflow(base, assistantSession.token, {
          source: buildFileTaskSource("Not allowed"),
        }),
        await updateWorkflow(base, assistantSession.token, userWorkflow.id, { enabled: true }),
        await deleteWorkflow(base, assistantSession.token, userWorkflow.id),
      ]) {
        const refusal = await readRefusal(response);
        expect(response.status, refusal.text).toBe(403);
        expect(refusal.code).toBe("forbidden");
        expect(refusal.grant).toBe("workflow.write");
      }

      expect(await readWorkflow(base, arranged.token, userWorkflow.id)).toEqual(storedBefore);
      expect((await queryWorkflows(base, arranged.token)).items.map((item) => item.id)).toEqual([
        userWorkflow.id,
      ]);
      expect(await readWorkflowEntries(base, arranged.token)).toEqual(workflowEntriesBefore);
    });
  });
});

describe("what reading workflows and triggers needs", () => {
  it("needs workflow.read for the listing, the read and the trigger listing", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const userWorkflow = await createWorkflowOrFail(base, arranged.token, {
        source: buildFileTaskSource("Readable"),
      });
      const readPaths = [
        "/api/v1/workflows",
        `/api/v1/workflows/${userWorkflow.id}`,
        "/api/v1/triggers",
      ];

      // The shipped worker profile holds no workflow grant at all.
      const workerSession = await agentOn(arranged, await profileNamed(arranged, "worker"));
      for (const path of readPaths) {
        const response = await get(base, path, workerSession.token);
        const refusal = await readRefusal(response);
        expect(response.status, `${path}: ${refusal.text}`).toBe(403);
        expect(refusal.code).toBe("forbidden");
        expect(refusal.grant).toBe("workflow.read");
      }

      // The shipped assistant profile holds workflow.read.
      const assistantSession = await agentOn(arranged, await profileNamed(arranged, "assistant"));
      for (const path of readPaths) {
        const response = await get(base, path, assistantSession.token);
        expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      }
    });
  });
});

describe("what a workflow subscription is told", () => {
  it("names the workflow once for each committed create, update and delete, and hears nothing of a refused write", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const ticket = await ticketFor(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const workflowPushes = yield* collecting(client, { topic: "workflow" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "workflow"));

          /** Waits for push number `count`, then out-waits one more that must not come. */
          const awaitPush = (count: number) =>
            Effect.promise(async () => {
              expect(await within(1000, () => workflowPushes.received.length >= count)).toBe(true);
              expect(await within(300, () => workflowPushes.received.length > count)).toBe(false);
              return workflowPushes.received[count - 1];
            });
          const expectNoPushAfter = (count: number) =>
            Effect.promise(async () => {
              expect(await within(300, () => workflowPushes.received.length > count)).toBe(false);
            });

          const workflow = yield* Effect.promise(() =>
            createWorkflowOrFail(base, token, { source: buildFileTaskSource("Watched") }),
          );
          expect(yield* awaitPush(1)).toEqual({
            _tag: "invalidate",
            ids: [workflow.id],
            kind: "created",
          });

          const refusedUpdate = yield* Effect.promise(() =>
            updateWorkflow(base, token, workflow.id, { source: SYNTAX_ERROR_SOURCE }),
          );
          expect(refusedUpdate.status).toBe(400);
          const refusedCreate = yield* Effect.promise(() =>
            createWorkflow(base, token, { source: KEBAB_CASE_STEP_ID_SOURCE }),
          );
          expect(refusedCreate.status).toBe(400);
          yield* expectNoPushAfter(1);

          yield* Effect.promise(() =>
            updateWorkflowOrFail(base, token, workflow.id, {
              source: buildFileTaskSource("Watched again"),
            }),
          );
          expect(yield* awaitPush(2)).toEqual({
            _tag: "invalidate",
            ids: [workflow.id],
            kind: "updated",
          });

          const deleteResponse = yield* Effect.promise(() =>
            deleteWorkflow(base, token, workflow.id),
          );
          expect(deleteResponse.status).toBe(200);
          expect(yield* awaitPush(3)).toEqual({
            _tag: "invalidate",
            ids: [workflow.id],
            kind: "deleted",
          });

          yield* Fiber.interrupt(workflowPushes.fiber);
        }),
      );
    });
  });
});

describe("a save the controller refuses with a validation error, never an internal one", () => {
  it("refuses an alias, half of a surrogate pair, and a value nested thousands of levels deep", async () => {
    await withSetUpController(async ({ base, token }) => {
      const aliasedResponse = await createWorkflow(base, token, {
        source: "name: dangling alias\nsteps: *nowhere\n",
      });
      const aliased = await readRefusal(aliasedResponse);
      expect(aliasedResponse.status, aliased.text).toBe(400);
      expect(aliased.code).toBe("validation");
      expect(aliased.issues).toEqual([["steps"]]);

      // The half pair is in the description of a source that is valid
      // otherwise, so only the check for half pairs can refuse it.
      const halfPair = String.fromCharCode(0xd800);
      const surrogate = await readIssues(
        await createWorkflow(base, token, {
          source: buildFileTaskSource("Half a pair", `a${halfPair}b`),
        }),
      );
      expect(surrogate).toEqual([
        { path: [], message: expect.stringContaining("line 2, column 15") as unknown },
      ]);

      const deepResponse = await createWorkflow(base, token, {
        definition: {
          name: "deep",
          steps: [
            {
              id: "file_task",
              kind: "action",
              action: "task.create",
              params: { title: nestInLists(5_000) },
            },
          ],
        },
      });
      const deep = await readRefusal(deepResponse);
      expect(deepResponse.status, deep.text).toBe(400);
      expect(deep.code).toBe("validation");
      expect(deep.issues).toEqual([["steps", "0", "params"]]);

      await expectNothingStored(base, token);
    });
  });

  it("refuses a key the save does not take, on a create and on an update", async () => {
    await withSetUpController(async ({ base, token }) => {
      const onCreateResponse = await createWorkflow(base, token, {
        source: buildFileTaskSource("On"),
        enabled: true,
      });
      const onCreate = await readRefusal(onCreateResponse);
      expect(onCreateResponse.status, onCreate.text).toBe(400);
      expect(onCreate.code).toBe("validation");
      expect(onCreate.issues).toEqual([["enabled"]]);
      await expectNothingStored(base, token);

      const workflow = await createWorkflowOrFail(base, token, {
        source: buildFileTaskSource("Kept"),
      });
      const onUpdateResponse = await updateWorkflow(base, token, workflow.id, {
        sorce: buildFileTaskSource("Typo"),
      });
      const onUpdate = await readRefusal(onUpdateResponse);
      expect(onUpdateResponse.status, onUpdate.text).toBe(400);
      expect(onUpdate.code).toBe("validation");
      expect(onUpdate.issues).toEqual([["sorce"]]);
    });
  });

  it("refuses a definition whose canonical text is longer than the longest source, saying so of the workflow", async () => {
    await withSetUpController(async ({ base, token }) => {
      const issues = await readIssues(
        await createWorkflow(base, token, {
          definition: { ...FILE_TASK_DEFINITION, description: "long ".repeat(60_000) },
        }),
      );
      expect(issues).toEqual([
        { path: [], message: expect.stringContaining("A workflow is at most") as unknown },
      ]);
      await expectNothingStored(base, token);
    });
  });
});

describe("a definition object that is refused", () => {
  it("is refused at the same paths, with the same messages, as the same mistakes sent as text", async () => {
    await withSetUpController(async ({ base, token }) => {
      const definitionIssues = await readIssues(
        await createWorkflow(base, token, {
          definition: {
            name: "one of each",
            enabled: true,
            steps: [
              { id: "open-pr", kind: "script" },
              { id: "open-pr", kind: "agent", prompt: 3 },
            ],
          },
        }),
      );
      const sourceIssues = await readIssues(
        await createWorkflow(base, token, {
          source: `name: one of each
enabled: true
steps:
  - id: open-pr
    kind: script
  - id: open-pr
    kind: agent
    prompt: 3
`,
        }),
      );
      expect(definitionIssues).toEqual(sourceIssues);
      expect(definitionIssues.map((issue) => issue.path)).toContainEqual(["steps", "0", "kind"]);
      expect(definitionIssues.length).toBeGreaterThan(3);
    });
  });
});

describe("the bytes of a stored source", () => {
  it("are the bytes sent: a leading byte order mark, CRLF, tabs, trailing spaces and a character outside the BMP", async () => {
    await withSetUpController(async ({ base, token }) => {
      const fileTask = buildFileTaskSource("Exact");
      const sources = [
        `\uFEFF${fileTask}`,
        fileTask.replaceAll("\n", "\r\n"),
        `# A comment\twith a tab.\n${fileTask}`,
        `# Trailing spaces.   \n${fileTask}`,
        `# A character outside the BMP: \u{1F600}\n${fileTask}`,
        `\uFEFF# All of them\t\u{1F600}   \r\n${fileTask.replaceAll("\n", "\r\n")}`,
      ];
      for (const source of sources) {
        const workflow = await createWorkflowOrFail(base, token, { source });
        expect((await readWorkflow(base, token, workflow.id)).source, JSON.stringify(source)).toBe(
          source,
        );
        await updateWorkflowOrFail(base, token, workflow.id, { source: `${source}\n` });
        expect((await readWorkflow(base, token, workflow.id)).source, JSON.stringify(source)).toBe(
          `${source}\n`,
        );
      }
    });
  });

  it("are the bytes sent for a source of the longest length, most of it characters that JSON writes as six bytes", async () => {
    await withSetUpController(async ({ base, token }) => {
      const fileTask = buildFileTaskSource("Escaped");
      // A comment of control characters fills the source to the longest length.
      const comment = String.fromCharCode(1).repeat(256 * 1024 - fileTask.length - 1);
      const source = `${fileTask}#${comment}`;
      const workflow = await createWorkflowOrFail(base, token, { source });
      expect((await readWorkflow(base, token, workflow.id)).source === source).toBe(true);
    });
  });
});
