/**
 * Tests the workflow and trigger operations over a real HTTP server and live
 * socket:
 * - what a create stores and what an update changes
 * - what the workflow list and the trigger list return
 * - which trigger rows a save leaves behind
 * - which actors may call each operation, and which actor each write is stamped with
 * - which pushes a live subscription receives
 *
 * Every test goes through the public API, because the tests check that the
 * YAML source a person wrote comes back byte for byte, and only a real HTTP
 * round trip can show that.
 *
 * Every source that a test expects to be saved passes all of the controller's
 * validation, not only the schema: its agents and its Connection exist, the
 * controller knows its actions and event kinds, and every step can be reached
 * from the start of a run.
 */
import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import * as Fiber from "effect/Fiber";
import {
  isSchedule,
  renderWorkflowSource,
  type Trigger,
  type Workflow,
  type WorkflowDefinition,
  type WorkflowSummary,
} from "@hercule/contract";
import { nestInLists } from "@hercule/protocol/testing";
import {
  collectMessages,
  del,
  expectHeld,
  get,
  onSocket,
  readErrorBody,
  fetchTicket,
  waitWithin,
} from "../http/testing";
import {
  buildForgePlugin,
  FORGE_CONNECTION_TYPE,
  FORGE_REVIEW_ACTION_ID,
} from "../plugins/testing";
import {
  createProfile,
  spawnThreadUnder,
  readProfileNamed,
  WAIT_DEADLINE_MS,
  waitUntil,
  withAgentFleet,
} from "../sessions/testing";
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
  pauseTrigger,
  queryTriggers,
  queryWorkflows,
  readIssues,
  resumeTrigger,
  SYNTAX_ERROR_SOURCE,
  updateWorkflow,
  withSetUpController,
  WRONG_KIND_SOURCE,
} from "./testing";

/**
 * Allows three wait deadlines: a test that uses session tokens waits once for
 * the agent fleet to be probed, then once for each session it starts (at most
 * two).
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
 * Returns a YAML source that contains everything a formatter would change:
 * comments, blank lines, keys out of canonical order, a block prompt with an
 * extra-indented line, trailing whitespace, a non-ASCII character, and two
 * newlines at the end. If the store reformats, trims or re-encodes anything,
 * the bytes read back differ from the bytes sent.
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

/** A definition object with its keys out of canonical order and a two-line description. */
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
    on:
      schedule: "0 2 * * *"
  - id: on_create
    kind: start
    on:
      kind: task.created
  - id: nightly
    kind: signal
    on:
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
 * A step that reuses a trigger's id. The YAML lists the steps before the
 * triggers, but the error must still point at the step: a duplicate id is
 * reported at the later node in definition order, and triggers come before
 * steps in that order.
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
    on:
      schedule: "0 2 * * *"
`;

const KEBAB_CASE_TRIGGER_ID_SOURCE = `name: kebab trigger
triggers:
  - id: checks-failed
    kind: start
    on:
      kind: task.created
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: One
      description: The first.
`;

/** The filter of start trigger `a`, as written in the source. */
const LABEL_FILTER = '"triage" in event.payload.added';

/** The YAML of start trigger `b`: a weekday schedule in a named timezone. */
const CRON_TRIGGER_B_SOURCE = `  - id: b
    kind: start
    on:
      schedule: "0 9 * * 1-5"
      timezone: Europe/Amsterdam
`;

/** The YAML of start trigger `c`, which an update puts in place of `b`. */
const TASK_TRIGGER_C_SOURCE = `  - id: c
    kind: start
    on:
      kind: task.created
`;

/**
 * Returns the source of the Label triage workflow, with these triggers:
 * - start trigger `a`, on a labelled pull request from the Connection `connectionId`
 * - `secondStartTrigger`, inserted as written
 * - signal trigger `s`, which fires when the filed task changes and leads to
 *   the terminal step
 */
const buildLabelTriageSource = (connectionId: string, secondStartTrigger: string): string =>
  `name: Label triage
triggers:
  - id: a
    kind: start
    on:
      kind: github.pr.labeled
      connectionId: ${connectionId}
      filter: '${LABEL_FILTER}'
${secondStartTrigger}  - id: s
    kind: signal
    on:
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
 * A second workflow, so that the trigger list holds the triggers of two
 * workflows. Its cron trigger has no timezone.
 */
const NIGHTLY_SWEEP_SOURCE = `name: Nightly sweep
triggers:
  - id: nightly
    kind: start
    on:
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
  it("returns exactly the five workflow fields, with the source byte for byte as sent", async () => {
    await withSetUpController(async ({ base, token }) => {
      const source = buildHandWrittenSource(await createAgent(base, token));

      const response = await createWorkflow(base, token, { source });
      expect([200, 201], await response.clone().text()).toContain(response.status);
      const responseBody = (await response.json()) as Record<string, unknown>;
      // The response holds the workflow and the save's warnings as separate fields.
      expect(Object.keys(responseBody).sort()).toEqual(["warnings", "workflow"]);
      expect(responseBody["warnings"]).toEqual([]);
      const workflow = responseBody["workflow"] as Workflow;

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
  it("stores the definition rendered as canonical YAML", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, {
        definition: FILE_TASK_DEFINITION,
      });

      expect((await readWorkflow(base, token, workflow.id)).source).toBe(
        renderWorkflowSource(FILE_TASK_DEFINITION as WorkflowDefinition),
      );
    });
  });

  it("fails with a validation error and stores nothing when both source and definition are sent, or neither", async () => {
    await withSetUpController(async ({ base, token }) => {
      for (const body of [
        { source: buildFileTaskSource("Both"), definition: FILE_TASK_DEFINITION },
        {},
      ]) {
        const response = await createWorkflow(base, token, body);
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
      }
      await expectNothingStored(base, token);
    });
  });
});

describe("workflow.create with an invalid source", () => {
  it("reports a YAML syntax error as one issue with an empty path, and gives its line and column", async () => {
    await withSetUpController(async ({ base, token }) => {
      const response = await createWorkflow(base, token, { source: SYNTAX_ERROR_SOURCE });
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toEqual([[]]);
      // The error has only this one issue, so the body contains its line (9) and column (20).
      expect(refusal.text).toMatch(/\b9\b/);
      expect(refusal.text).toMatch(/\b20\b/);
      await expectNothingStored(base, token);
    });
  });

  it("reports a schema error at the path of the invalid field", async () => {
    await withSetUpController(async ({ base, token }) => {
      const response = await createWorkflow(base, token, { source: WRONG_KIND_SOURCE });
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toEqual([["steps", "0", "kind"]]);
      await expectNothingStored(base, token);
    });
  });

  it("reports a duplicate id at the later node, with triggers ordered before steps", async () => {
    await withSetUpController(async ({ base, token }) => {
      for (const [source, path] of [
        [DUPLICATE_STEP_ID_SOURCE, ["steps", "1", "id"]],
        [DUPLICATE_TRIGGER_ID_SOURCE, ["triggers", "2", "id"]],
        [STEP_REUSING_TRIGGER_ID_SOURCE, ["steps", "1", "id"]],
      ] as const) {
        const response = await createWorkflow(base, token, { source });
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
        expect(refusal.issues).toEqual([path]);
      }
      await expectNothingStored(base, token);
    });
  });

  it("reports an id that is not snake_case at that id, and suggests the snake_case spelling", async () => {
    await withSetUpController(async ({ base, token }) => {
      const stepResponse = await createWorkflow(base, token, {
        source: KEBAB_CASE_STEP_ID_SOURCE,
      });
      const stepRefusal = await readErrorBody(stepResponse);
      expect(stepResponse.status, stepRefusal.text).toBe(400);
      expect(stepRefusal.code).toBe("validation");
      expect(stepRefusal.issues).toEqual([["steps", "0", "id"]]);
      expect(stepRefusal.text).toContain("open_pr");

      const triggerResponse = await createWorkflow(base, token, {
        source: KEBAB_CASE_TRIGGER_ID_SOURCE,
      });
      const triggerRefusal = await readErrorBody(triggerResponse);
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

  it("stores a new definition rendered as canonical YAML", async () => {
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

  it("changes only enabled, and leaves the source byte for byte the same", async () => {
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

  // The workflow list is sorted by updatedAt. If toggling enabled changed
  // updatedAt, the Workflows screen would move the row to the top when its
  // switch is clicked, and a second click at the same spot would toggle a
  // different workflow.
  it("changes updatedAt only when the source changes, so toggling enabled keeps the workflow's place in the list", async () => {
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
      // The event log still records the toggle, although updatedAt did not change.
      const toggleEntry = (await readLog(base, token))[entriesBefore];
      expect(toggleEntry?.kind).toBe("workflow.updated");
      expect(toggleEntry?.payload).toEqual({ workflowId: older.id, changed: ["enabled"] });
      // Saving the same source also writes one entry, with an empty changed list.
      const sameSourceEntry = (await readLog(base, token))[entriesBefore + 1];
      expect(sameSourceEntry?.kind).toBe("workflow.updated");
      expect(sameSourceEntry?.payload).toEqual({ workflowId: older.id, changed: [] });

      await waitForNextMillisecond();
      const rewritten = await updateWorkflowOrFail(base, token, older.id, {
        source: buildFileTaskSource("Rewritten"),
      });
      expect(rewritten.updatedAt > older.updatedAt).toBe(true);
      expect(await listIds()).toEqual([older.id, newer.id]);
    });
  });

  it("leaves the stored workflow unchanged when an update fails validation", async () => {
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
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.code).toBe("validation");
        expect(await readWorkflow(base, token, workflow.id)).toEqual(storedBefore);
      }
    });
  });

  it("fails with not_found for an id that matches no workflow", async () => {
    await withSetUpController(async ({ base, token }) => {
      // Another workflow exists, so the not_found is about this id and not about an empty table.
      await createWorkflowOrFail(base, token, { source: buildFileTaskSource("Present") });

      const response = await updateWorkflow(base, token, ABSENT_ID, { enabled: true });
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(404);
      expect(refusal.code).toBe("not_found");
    });
  });
});

describe("the enabled flag", () => {
  it("is false after a create from a source or from a definition", async () => {
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

  it("is set to true only by an update with enabled: true, and a new source does not change it", async () => {
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

  it("fails with a validation error when set in the source, because it is not part of the workflow YAML", async () => {
    await withSetUpController(async ({ base, token }) => {
      const response = await createWorkflow(base, token, {
        source: `enabled: true\n${buildFileTaskSource("Switched on in the text")}`,
      });
      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.code).toBe("validation");
      expect(refusal.issues).toContainEqual(["enabled"]);
      await expectNothingStored(base, token);
    });
  });
});

describe("workflow.query", () => {
  it("returns every workflow once across pages, each with its id, name, description, enabled and updatedAt", async () => {
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

  it("returns the name and description of the latest saved source", async () => {
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
  it("deletes the workflow and all its trigger rows, and a later read fails with not_found", async () => {
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
      const refusal = await readErrorBody(readResponse);
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
  it("lists the triggers of every workflow with all fields, newest first, and filters by each query parameter", async () => {
    await withSetUpController(async ({ base, token }) => {
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

      // The Scheduler computes a cron trigger's next scheduled time on its
      // first pass after the save. Waiting for it keeps the listing below
      // from depending on whether that pass has run yet.
      const allTriggers = await waitUntil("scheduled both cron triggers", async () => {
        const items = await queryTriggers(base, token);
        const cron = items.filter((item) => isSchedule(item.on));
        return cron.every((item) => item.nextFireAt !== undefined) ? items : undefined;
      });
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
      const scheduleMatchers: Record<"nextFireAt", unknown> = { nextFireAt: expect.any(String) };
      const triggerA = findTrigger(allTriggers, "a");
      expect(triggerA).toEqual({
        workflowId: labelTriage.id,
        workflowName: "Label triage",
        triggerId: "a",
        kind: "start",
        on: { kind: "github.pr.labeled", connectionId, filter: LABEL_FILTER },
        status: "active",
        health: { state: "ok" },
        ...timestampMatchers,
      });
      expect(findTrigger(allTriggers, "b")).toEqual({
        workflowId: labelTriage.id,
        workflowName: "Label triage",
        triggerId: "b",
        kind: "start",
        on: { schedule: "0 9 * * 1-5", timezone: "Europe/Amsterdam" },
        status: "active",
        health: { state: "ok" },
        ...scheduleMatchers,
        ...timestampMatchers,
      });
      // A signal trigger has no status, because it cannot be paused.
      expect(findTrigger(allTriggers, "s")).toEqual({
        workflowId: labelTriage.id,
        workflowName: "Label triage",
        triggerId: "s",
        kind: "signal",
        on: { kind: "task.updated" },
        ...timestampMatchers,
      });
      // The row copies the trigger from the source, and this source has no
      // timezone. The user's timezone setting is applied when the cron tick
      // fires, not when the trigger is saved.
      expect(findTrigger(allTriggers, "nightly")).toEqual({
        workflowId: nightlySweep.id,
        workflowName: "Nightly sweep",
        triggerId: "nightly",
        kind: "start",
        on: { schedule: "0 2 * * *" },
        status: "active",
        health: { state: "ok" },
        ...scheduleMatchers,
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
      expect(sortTriggerIds(await queryTriggers(base, token, "?on=schedule"))).toEqual([
        "b",
        "nightly",
      ]);
      expect(sortTriggerIds(await queryTriggers(base, token, "?on=event"))).toEqual(["a", "s"]);
      expect(sortTriggerIds(await queryTriggers(base, token, "?eventKind=task.updated"))).toEqual([
        "s",
      ]);
      // A cron trigger accepts no events, so filtering on its stored event kind is refused.
      const cronTickResponse = await get(base, "/api/v1/triggers?eventKind=cron.tick", token);
      const cronTickRefusal = await readErrorBody(cronTickResponse);
      expect(cronTickResponse.status, cronTickRefusal.text).toBe(400);
      expect(cronTickRefusal.code).toBe("validation");
      expect(cronTickRefusal.issues).toEqual([["eventKind"]]);
      expect(cronTickRefusal.text).toContain("filter with on set to schedule");
      expect(sortTriggerIds(await queryTriggers(base, token, "?status=active"))).toEqual([
        "a",
        "b",
        "nightly",
      ]);

      const paused = await pauseTrigger(base, token, labelTriage.id, "a");
      expect(paused.status, await paused.clone().text()).toBe(200);
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
        on: { kind: "task.created" },
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

/**
 * A workflow with one start trigger `c` on a core event kind, so it needs no
 * Connection and can be saved on a controller without the GitHub plugin.
 */
const TASK_TRIGGER_SOURCE = `name: Follow up on tasks
triggers:
${TASK_TRIGGER_C_SOURCE}steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: Follow up
      description: Filed when a task is created.
`;

describe("trigger.pause and trigger.resume", () => {
  it("pauses a start trigger, lists it as paused, and writes one audit entry however often it is paused", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { source: TASK_TRIGGER_SOURCE });

      for (const attempt of ["first", "second"]) {
        const response = await pauseTrigger(base, token, workflow.id, "c");
        expect(response.status, `${attempt}: ${await response.clone().text()}`).toBe(200);
        expect(((await response.json()) as Trigger).status).toBe("paused");
      }

      expect(sortTriggerIds(await queryTriggers(base, token, "?status=paused"))).toEqual(["c"]);
      expect(await queryTriggers(base, token, "?status=active")).toEqual([]);
      // The second pause changed nothing, so it wrote nothing.
      const entries = await harness.audit("trigger.paused");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor: "user",
        payload: { workflowId: workflow.id, triggerId: "c" },
      });
    });
  });

  it("resumes a paused trigger, and resuming an active trigger changes nothing", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { source: TASK_TRIGGER_SOURCE });
      const paused = await pauseTrigger(base, token, workflow.id, "c");
      expect(paused.status, await paused.clone().text()).toBe(200);

      for (const attempt of ["first", "second"]) {
        const response = await resumeTrigger(base, token, workflow.id, "c");
        expect(response.status, `${attempt}: ${await response.clone().text()}`).toBe(200);
        expect(((await response.json()) as Trigger).status).toBe("active");
      }

      expect(sortTriggerIds(await queryTriggers(base, token, "?status=active"))).toEqual(["c"]);
      const entries = await harness.audit("trigger.resumed");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({
        actor: "user",
        payload: { workflowId: workflow.id, triggerId: "c" },
      });
    });
  });

  it("returns not_found for a workflow or a trigger that does not exist", async () => {
    await withSetUpController(async ({ base, token }) => {
      const workflow = await createWorkflowOrFail(base, token, { source: TASK_TRIGGER_SOURCE });

      for (const [workflowId, triggerId] of [
        [ABSENT_ID, "c"],
        [workflow.id, "absent"],
      ] as const) {
        for (const send of [pauseTrigger, resumeTrigger]) {
          const response = await send(base, token, workflowId, triggerId);
          const refusal = await readErrorBody(response);
          expect(response.status, `${workflowId}/${triggerId}: ${refusal.text}`).toBe(404);
          expect(refusal.code).toBe("not_found");
        }
      }
    });
  });

  it("returns invalid_state for a signal trigger, which has no status", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      const workflow = await createWorkflowOrFail(base, token, {
        source: buildLabelTriageSource(connectionId, ""),
      });

      for (const send of [pauseTrigger, resumeTrigger]) {
        const response = await send(base, token, workflow.id, "s");
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(409);
        expect(refusal.code).toBe("invalid_state");
        expect(refusal.message).toContain("signal trigger");
      }
      const signal = (await queryTriggers(base, token, "?kind=signal"))[0];
      expect(signal).not.toHaveProperty("status");
      expect(await harness.audit("trigger.paused")).toEqual([]);
      expect(await harness.audit("trigger.resumed")).toEqual([]);
    });
  });

  it("fails with forbidden and names the grant when the session's profile lacks workflow.write, and changes nothing", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const workflow = await createWorkflowOrFail(base, arranged.token, {
        source: TASK_TRIGGER_SOURCE,
      });
      // The shipped assistant profile has workflow.read but not workflow.write.
      const assistantSession = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );

      for (const send of [pauseTrigger, resumeTrigger]) {
        const response = await send(base, assistantSession.token, workflow.id, "c");
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(403);
        expect(refusal.code).toBe("forbidden");
        expect(refusal.grant).toBe("workflow.write");
      }

      expect(sortTriggerIds(await queryTriggers(base, arranged.token, "?status=active"))).toEqual([
        "c",
      ]);
      expect(await arranged.harness.audit("trigger.paused")).toEqual([]);
    });
  });
});

/** The fields of an event log entry that these tests read. */
interface LogEntry {
  readonly id: number;
  readonly kind: string;
  readonly actor: string | null;
  readonly payload: unknown;
}

/** Returns the whole event log, oldest first, read with the user's token. */
const readLog = async (base: string, token: string): Promise<ReadonlyArray<LogEntry>> => {
  const response = await get(base, "/api/v1/events?sort=id:asc&limit=500", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<LogEntry> }).items;
};

/** Returns the event log entries about workflows, oldest first. */
const readWorkflowEntries = async (base: string, token: string): Promise<ReadonlyArray<LogEntry>> =>
  (await readLog(base, token)).filter((entry) => entry.kind.startsWith("workflow."));

describe("the actor stamped on workflow writes", () => {
  it("writes one event log entry per create, update and delete, stamped with the user", async () => {
    await withSetUpController(async ({ base, token }) => {
      // Nothing else runs on this controller, so every entry appended during a
      // write comes from that write.
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
      const unrestrictedSession = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "unrestricted"),
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

  it("fails with forbidden and names the grant when the session's profile lacks workflow.write, and writes nothing", async () => {
    await withAgentFleet(async (arranged) => {
      const base = arranged.harness.base;
      const userWorkflow = await createWorkflowOrFail(base, arranged.token, {
        source: buildFileTaskSource("The user's"),
      });
      const storedBefore = await readWorkflow(base, arranged.token, userWorkflow.id);
      const workflowEntriesBefore = await readWorkflowEntries(base, arranged.token);
      // The shipped assistant profile has workflow.read but not workflow.write.
      const assistantSession = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );

      for (const response of [
        await createWorkflow(base, assistantSession.token, {
          source: buildFileTaskSource("Not allowed"),
        }),
        await updateWorkflow(base, assistantSession.token, userWorkflow.id, { enabled: true }),
        await deleteWorkflow(base, assistantSession.token, userWorkflow.id),
      ]) {
        const refusal = await readErrorBody(response);
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

describe("saving a workflow whose step acts through a Connection", () => {
  /** The message of the refusal for a caller without the connection.use grant. */
  const SAVE_REFUSAL =
    "This workflow has a step that acts through a Connection, and choosing that Connection needs the connection.use grant, which this session lacks. Ask the user to save the workflow, or to grant connection.use.";

  /** Builds a workflow whose review step acts through the Connection its `connection` param names. */
  const buildReviewDefinition = (connection: string) => ({
    name: "Review a pull request",
    inputs: [{ name: "account", connection: { type: FORGE_CONNECTION_TYPE }, required: false }],
    steps: [
      {
        id: "review",
        kind: "action",
        action: FORGE_REVIEW_ACTION_ID,
        params: { connection, verdict: "approve" },
      },
    ],
  });

  it("is refused to a session without connection.use, whether the step names the Connection by its id or through an input, and changes nothing", async () => {
    await withAgentFleet(
      async (arranged) => {
        const base = arranged.harness.base;
        const connectionId = await createConnection(base, arranged.token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const profile = await createProfile(arranged, "Writes workflows", [
          "workflow.write",
          "workflow.read",
        ]);
        const session = await spawnThreadUnder(arranged, profile);
        // A workflow with no such step needs no connection.use, to save or to edit.
        const stored = await createWorkflowOrFail(base, session.token, {
          source: buildFileTaskSource("No Connection"),
        });
        const storedBefore = await readWorkflow(base, arranged.token, stored.id);
        const entriesBefore = await readWorkflowEntries(base, arranged.token);

        for (const connection of [connectionId, "{{ inputs.account }}"]) {
          const definition = buildReviewDefinition(connection);
          for (const response of [
            await createWorkflow(base, session.token, { definition }),
            await updateWorkflow(base, session.token, stored.id, { definition }),
          ]) {
            const refusal = await readErrorBody(response);
            expect(response.status, refusal.text).toBe(403);
            expect(refusal).toMatchObject({
              code: "forbidden",
              grant: "connection.use",
              message: SAVE_REFUSAL,
            });
          }
        }

        expect(await readWorkflow(base, arranged.token, stored.id)).toEqual(storedBefore);
        expect((await queryWorkflows(base, arranged.token)).items.map((item) => item.id)).toEqual([
          stored.id,
        ]);
        expect(await readWorkflowEntries(base, arranged.token)).toEqual(entriesBefore);
      },
      { plugins: [buildForgePlugin().plugin] },
    );
  });

  it("is allowed to the user, and to a session whose profile holds connection.use", async () => {
    await withAgentFleet(
      async (arranged) => {
        const base = arranged.harness.base;
        const connectionId = await createConnection(base, arranged.token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const profile = await createProfile(arranged, "Writes workflows with Connections", [
          "workflow.write",
          "workflow.read",
          "connection.use",
        ]);
        const session = await spawnThreadUnder(arranged, profile);

        for (const caller of [arranged.token, session.token]) {
          const workflow = await createWorkflowOrFail(base, caller, {
            definition: buildReviewDefinition(connectionId),
          });
          await updateWorkflowOrFail(base, caller, workflow.id, {
            definition: buildReviewDefinition("{{ inputs.account }}"),
          });
        }
      },
      { plugins: [buildForgePlugin().plugin] },
    );
  });
});

describe("reading workflows and triggers", () => {
  it("requires workflow.read for the workflow list, a single workflow and the trigger list", async () => {
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

      // The shipped worker profile has no workflow grant.
      const workerSession = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "worker"),
      );
      for (const path of readPaths) {
        const response = await get(base, path, workerSession.token);
        const refusal = await readErrorBody(response);
        expect(response.status, `${path}: ${refusal.text}`).toBe(403);
        expect(refusal.code).toBe("forbidden");
        expect(refusal.grant).toBe("workflow.read");
      }

      // The shipped assistant profile has workflow.read.
      const assistantSession = await spawnThreadUnder(
        arranged,
        await readProfileNamed(arranged, "assistant"),
      );
      for (const path of readPaths) {
        const response = await get(base, path, assistantSession.token);
        expect(response.status, `${path}: ${await response.clone().text()}`).toBe(200);
      }
    });
  });
});

describe("a workflow subscription", () => {
  it("receives one push with the workflow id per committed create, update and delete, and none for a failed write", async () => {
    await withSetUpController(async ({ harness, base, token }) => {
      const ticket = await fetchTicket(base, token);

      await onSocket(base, (client) =>
        Effect.gen(function* () {
          yield* client.hello({ v: 1, ticket });
          const workflowPushes = yield* collectMessages(client, { topic: "workflow" });
          yield* Effect.promise(() => expectHeld(harness.live, 1, "workflow"));

          /**
           * Waits for push number `count`, checks that no later push arrives
           * within 300 ms, and returns push number `count`.
           */
          const awaitPush = (count: number) =>
            Effect.promise(async () => {
              expect(await waitWithin(1000, () => workflowPushes.received.length >= count)).toBe(
                true,
              );
              expect(await waitWithin(300, () => workflowPushes.received.length > count)).toBe(
                false,
              );
              return workflowPushes.received[count - 1];
            });
          const expectNoPushAfter = (count: number) =>
            Effect.promise(async () => {
              expect(await waitWithin(300, () => workflowPushes.received.length > count)).toBe(
                false,
              );
            });

          const workflow = yield* Effect.promise(() =>
            createWorkflowOrFail(base, token, { source: buildFileTaskSource("Watched") }),
          );
          expect(yield* awaitPush(1)).toEqual({
            _tag: "invalidate",
            ids: [workflow.id],
            kind: "created",
          });

          const failedUpdate = yield* Effect.promise(() =>
            updateWorkflow(base, token, workflow.id, { source: SYNTAX_ERROR_SOURCE }),
          );
          expect(failedUpdate.status).toBe(400);
          const failedCreate = yield* Effect.promise(() =>
            createWorkflow(base, token, { source: KEBAB_CASE_STEP_ID_SOURCE }),
          );
          expect(failedCreate.status).toBe(400);
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

describe("saves that fail with a validation error instead of an internal error", () => {
  it("fails on a YAML alias, a lone surrogate, and a value nested thousands of levels deep", async () => {
    await withSetUpController(async ({ base, token }) => {
      const aliasedResponse = await createWorkflow(base, token, {
        source: "name: dangling alias\nsteps: *nowhere\n",
      });
      const aliased = await readErrorBody(aliasedResponse);
      expect(aliasedResponse.status, aliased.text).toBe(400);
      expect(aliased.code).toBe("validation");
      expect(aliased.issues).toEqual([["steps"]]);

      // The lone surrogate is in the description of an otherwise valid source,
      // so only the surrogate check can reject it.
      const loneSurrogate = String.fromCharCode(0xd800);
      const surrogateIssues = await readIssues(
        await createWorkflow(base, token, {
          source: buildFileTaskSource("Half a pair", `a${loneSurrogate}b`),
        }),
      );
      expect(surrogateIssues).toEqual([
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
      const deep = await readErrorBody(deepResponse);
      expect(deepResponse.status, deep.text).toBe(400);
      expect(deep.code).toBe("validation");
      expect(deep.issues).toEqual([["steps", "0", "params"]]);

      await expectNothingStored(base, token);
    });
  });

  it("fails on an unknown key, on a create and on an update", async () => {
    await withSetUpController(async ({ base, token }) => {
      const onCreateResponse = await createWorkflow(base, token, {
        source: buildFileTaskSource("On"),
        enabled: true,
      });
      const onCreate = await readErrorBody(onCreateResponse);
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
      const onUpdate = await readErrorBody(onUpdateResponse);
      expect(onUpdateResponse.status, onUpdate.text).toBe(400);
      expect(onUpdate.code).toBe("validation");
      expect(onUpdate.issues).toEqual([["sorce"]]);
    });
  });

  it("fails on a definition whose canonical YAML is longer than the maximum source length, with the issue at the root path", async () => {
    await withSetUpController(async ({ base, token }) => {
      const issues = await readIssues(
        await createWorkflow(base, token, {
          definition: { ...FILE_TASK_DEFINITION, description: "long ".repeat(60_000) },
        }),
      );
      expect(issues).toEqual([
        { path: [], message: expect.stringContaining("A workflow can be at most") as unknown },
      ]);
      await expectNothingStored(base, token);
    });
  });
});

describe("an invalid definition object", () => {
  it("gets the same issue paths and messages as the same mistakes sent as YAML source", async () => {
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

describe("a stored source", () => {
  it("keeps the exact bytes sent, including a leading byte order mark, CRLF, tabs, trailing spaces and a character outside the BMP", async () => {
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

  it("keeps the exact bytes of a maximum-length source made mostly of characters that JSON escapes as six bytes", async () => {
    await withSetUpController(async ({ base, token }) => {
      const fileTask = buildFileTaskSource("Escaped");
      // A comment of control characters fills the source to the maximum length.
      const comment = String.fromCharCode(1).repeat(256 * 1024 - fileTask.length - 1);
      const source = `${fileTask}#${comment}`;
      const workflow = await createWorkflowOrFail(base, token, { source });
      expect((await readWorkflow(base, token, workflow.id)).source === source).toBe(true);
    });
  });
});
