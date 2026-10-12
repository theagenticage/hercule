/**
 * Tests the invalid mark of a stored workflow over HTTP, on a set-up
 * controller. A workflow validated when it was saved, but it stops validating
 * when a plugin it uses is disabled or an Agent or Connection it names is
 * deleted. The controller then validates every stored workflow again, marks
 * the ones that fail as invalid, and raises one `core.workflow-invalid`
 * notification for each. While a workflow is marked invalid its start
 * triggers start no runs and `run.start` refuses it. The mark clears when the
 * workflow validates again, after the change is undone or the workflow is
 * fixed and saved.
 */
import { describe, expect, it, vi } from "vitest";
import * as Duration from "effect/Duration";
import type { Notification, Workflow } from "@hercule/contract";
import { waitUntilRouted } from "../daemon/testing";
import { del, get, post, readErrorBody } from "../http/testing";
import { NOTE_APPEND_ACTION_ID, notesPlugin } from "../plugins/testing";
import { queryRuns, requestRun } from "../runs/testing";
import { waitUntil, WAIT_DEADLINE_MS } from "../sessions/testing";
import {
  ACCEPTED_GITHUB_TOKEN,
  buildTaskStep,
  createAgent,
  createConnection,
  createWorkflowOrFail,
  disablePlugin,
  emitLabeledEvent,
  enableWorkflow,
  updateWorkflow,
  withSetUpController,
  type SetUpController,
} from "./testing";

vi.setConfig({ testTimeout: WAIT_DEADLINE_MS * 2 + 10_000 });

/** The name of the workflow every test saves. */
const WORKFLOW_NAME = "Note labelled pull requests";

/**
 * Returns the source of a workflow with one start trigger on any labelled
 * pull request, and `step` as its only step.
 */
const buildLabeledSource = (step: string): string =>
  [
    `name: ${WORKFLOW_NAME}`,
    "triggers:",
    "  - id: labeled",
    "    kind: start",
    "    on:",
    "      kind: github.pr.labeled",
    "      connectionId: any",
    "steps:",
    step,
    "",
  ].join("\n");

/** A step that calls the action of the `notes` plugin, so disabling that plugin breaks it. */
const NOTE_STEP = [
  "  - id: note",
  "    kind: action",
  `    action: ${NOTE_APPEND_ACTION_ID}`,
  "    params:",
  "      text: A pull request was labelled.",
].join("\n");

/** The source of a workflow that needs the `notes` plugin. */
const NOTE_SOURCE = buildLabeledSource(NOTE_STEP);

/** The same workflow fixed to need no plugin: its step creates a task instead. */
const FIXED_SOURCE = buildLabeledSource(buildTaskStep("file_task"));

/** Starts a set-up controller with the `notes` plugin installed. */
const withNotesController = (body: (controller: SetUpController) => Promise<void>) =>
  withSetUpController(body, [notesPlugin], { eventRoutingInterval: Duration.millis(10) });

/** Saves `source` as a workflow, enables it, and returns its id. */
const saveEnabledWorkflow = async (
  { base, token }: SetUpController,
  source: string,
): Promise<string> => {
  const workflow = await createWorkflowOrFail(base, token, { source });
  await enableWorkflow(base, token, workflow.id);
  return workflow.id;
};

const readWorkflow = async ({ base, token }: SetUpController, id: string): Promise<Workflow> => {
  const response = await get(base, `/api/v1/workflows/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Workflow;
};

/** Returns the `core.workflow-invalid` notifications about the workflow, newest first. */
const listInvalidNotifications = async (
  { base, token }: SetUpController,
  workflowId: string,
): Promise<ReadonlyArray<Notification>> => {
  const response = await get(
    base,
    "/api/v1/notifications?kind=core.workflow-invalid&limit=100",
    token,
  );
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as { readonly items: ReadonlyArray<Notification> };
  return items.filter((notification) =>
    notification.subject.some(
      (subject) => subject.kind === "workflow" && subject.id === workflowId,
    ),
  );
};

/** Returns the kinds and actors of the event log entries that mark or clear the invalid mark. */
const listValidityEntries = async ({
  base,
  token,
}: SetUpController): Promise<ReadonlyArray<{ kind: string; actor: string | null }>> => {
  const response = await get(base, "/api/v1/events?sort=id:asc&limit=500", token);
  expect(response.status, await response.clone().text()).toBe(200);
  const { items } = (await response.json()) as {
    readonly items: ReadonlyArray<{ readonly kind: string; readonly actor: string | null }>;
  };
  return items
    .filter(
      (entry) => entry.kind === "workflow.invalidated" || entry.kind === "workflow.revalidated",
    )
    .map(({ kind, actor }) => ({ kind, actor }));
};

const enablePlugin = async ({ base, token }: SetUpController, id: string): Promise<void> => {
  const response = await post(base, `/api/v1/plugins/${id}/enable`, {}, token);
  expect(response.status, await response.clone().text()).toBe(200);
};

const deleteOrFail = async ({ base, token }: SetUpController, path: string): Promise<void> => {
  const response = await del(base, path, token);
  expect(response.ok, await response.clone().text()).toBe(true);
};

describe("a workflow whose plugin is disabled", () => {
  it("is marked invalid and raises one notification that names the error", async () => {
    await withNotesController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, NOTE_SOURCE);
      expect((await readWorkflow(controller, workflowId)).invalidSince).toBeUndefined();

      await disablePlugin(base, token, "notes");

      const workflow = await readWorkflow(controller, workflowId);
      expect(workflow.invalidSince).toEqual(expect.any(String));
      // The workflow stays enabled: the mark is separate from the user's switch.
      expect(workflow.enabled).toBe(true);
      const summary = (await (await get(base, "/api/v1/workflows", token)).json()) as {
        items: ReadonlyArray<{ id: string; invalidSince?: string }>;
      };
      expect(summary.items.find((item) => item.id === workflowId)?.invalidSince).toBe(
        workflow.invalidSince,
      );

      const [notification, ...others] = await listInvalidNotifications(controller, workflowId);
      expect(others).toEqual([]);
      expect(notification!.title).toBe(`The workflow ${WORKFLOW_NAME} no longer validates`);
      expect(notification!.body).toContain("its triggers start no runs and `run.start` refuses it");
      expect(notification!.body).toContain(NOTE_APPEND_ACTION_ID);
      expect(notification!.actions).toEqual([]);
      expect(await listValidityEntries(controller)).toEqual([
        { kind: "workflow.invalidated", actor: "system" },
      ]);

      // Another change validates every workflow again. This one is still
      // invalid, so it keeps its mark and raises no second notification.
      await deleteOrFail(controller, `/api/v1/agents/${await createAgent(base, token)}`);
      expect((await readWorkflow(controller, workflowId)).invalidSince).toBe(workflow.invalidSince);
      expect(await listInvalidNotifications(controller, workflowId)).toHaveLength(1);
    });
  });

  it("loses the mark when the plugin is enabled again, and raises a new notification only after that", async () => {
    await withNotesController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, NOTE_SOURCE);

      await disablePlugin(base, token, "notes");
      expect(await listInvalidNotifications(controller, workflowId)).toHaveLength(1);

      await enablePlugin(controller, "notes");
      expect((await readWorkflow(controller, workflowId)).invalidSince).toBeUndefined();
      // The first notification stays: it reported what happened.
      expect(await listInvalidNotifications(controller, workflowId)).toHaveLength(1);

      await disablePlugin(base, token, "notes");
      expect((await readWorkflow(controller, workflowId)).invalidSince).toEqual(expect.any(String));
      expect(await listInvalidNotifications(controller, workflowId)).toHaveLength(2);
      expect(await listValidityEntries(controller)).toEqual([
        { kind: "workflow.invalidated", actor: "system" },
        { kind: "workflow.revalidated", actor: "system" },
        { kind: "workflow.invalidated", actor: "system" },
      ]);
    });
  });

  it("starts no run from its trigger and refuses run.start until the plugin is enabled again", async () => {
    await withNotesController(async (controller) => {
      const { harness, base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, NOTE_SOURCE);
      await disablePlugin(base, token, "notes");

      const whileInvalid = await emitLabeledEvent(base, token, { added: ["triage"] });
      await waitUntilRouted(harness, whileInvalid);
      expect((await queryRuns(base, token, `workflowId=${workflowId}`)).items).toEqual([]);
      // The router skipped the trigger. Had it matched, the run start would
      // have been refused and reported as a trigger error.
      const triggerErrors = await get(base, "/api/v1/notifications?kind=core.trigger-error", token);
      expect(triggerErrors.status, await triggerErrors.clone().text()).toBe(200);
      expect(((await triggerErrors.json()) as { items: ReadonlyArray<unknown> }).items).toEqual([]);

      const refused = await requestRun(base, token, workflowId);
      const refusal = await readErrorBody(refused);
      expect(refused.status, refusal.text).toBe(400);
      expect(refusal.message).toContain("this workflow cannot run as it is saved now");
      expect(refusal.text).toContain(NOTE_APPEND_ACTION_ID);

      // The trigger was stopped only while the workflow was invalid.
      await enablePlugin(controller, "notes");
      const afterEnable = await emitLabeledEvent(base, token, { added: ["triage"] });
      const runs = await waitUntil(`a run started by the event ${afterEnable}`, async () => {
        const { items } = await queryRuns(base, token, `workflowId=${workflowId}`);
        return items.length > 0 ? items : undefined;
      });
      expect(runs.map((run) => run.origin)).toEqual([
        expect.objectContaining({ kind: "trigger", eventId: afterEnable }),
      ]);
    });
  });

  it("loses the mark when a fixed source is saved", async () => {
    await withNotesController(async (controller) => {
      const { base, token } = controller;
      const workflowId = await saveEnabledWorkflow(controller, NOTE_SOURCE);
      await disablePlugin(base, token, "notes");

      const response = await updateWorkflow(base, token, workflowId, { source: FIXED_SOURCE });
      expect(response.status, await response.clone().text()).toBe(200);
      const { workflow } = (await response.json()) as { workflow: Workflow };

      expect(workflow.invalidSince).toBeUndefined();
      expect((await readWorkflow(controller, workflowId)).invalidSince).toBeUndefined();
    });
  });
});

describe("a workflow whose Agent is deleted", () => {
  it("is marked invalid and raises one notification", async () => {
    await withNotesController(async (controller) => {
      const { base, token } = controller;
      const agentId = await createAgent(base, token);
      const workflowId = await saveEnabledWorkflow(
        controller,
        buildLabeledSource(
          [
            "  - id: review",
            "    kind: agent",
            `    agent: ${agentId}`,
            "    prompt: Review the pull request.",
          ].join("\n"),
        ),
      );

      await deleteOrFail(controller, `/api/v1/agents/${agentId}`);

      expect((await readWorkflow(controller, workflowId)).invalidSince).toEqual(expect.any(String));
      const notifications = await listInvalidNotifications(controller, workflowId);
      expect(notifications).toHaveLength(1);
      expect(notifications[0]!.body).toContain("steps.0.agent: No Agent has this id.");
    });
  });
});

describe("a workflow whose default Connection is deleted", () => {
  it("is marked invalid and raises one notification", async () => {
    await withNotesController(async (controller) => {
      const { base, token } = controller;
      const connectionId = await createConnection(base, token, "github/github", {
        pat: ACCEPTED_GITHUB_TOKEN,
      });
      // A Connection input's default does not hold the Connection in place,
      // so the delete succeeds and the workflow stops validating.
      const workflowId = await saveEnabledWorkflow(
        controller,
        [
          `name: ${WORKFLOW_NAME}`,
          "inputs:",
          "  - name: account",
          "    connection:",
          "      type: github/github",
          "    required: false",
          `    default: ${connectionId}`,
          "steps:",
          buildTaskStep("file_task"),
          "",
        ].join("\n"),
      );

      await deleteOrFail(controller, `/api/v1/connections/${connectionId}`);

      expect((await readWorkflow(controller, workflowId)).invalidSince).toEqual(expect.any(String));
      expect(await listInvalidNotifications(controller, workflowId)).toHaveLength(1);
    });
  });
});
