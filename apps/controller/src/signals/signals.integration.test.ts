/**
 * Tests signals over HTTP, against the real controller and the real
 * `BoundOperations` port:
 *
 * - Accept on a proposal creates its Task, and Dismiss runs nothing;
 * - Hand to an agent is offered for each enabled workflow whose signal input
 *   accepts the kind, is frozen when the signal is raised, and starts a run
 *   with the signal's id;
 * - a run's signal input takes only the id of a signal of a kind it lists;
 * - a plugin action bound as a typed reply runs with the text the user typed,
 *   outside any run, and writes the line the Done list keeps.
 *
 * The rules that need no real operation are tested in `service.test.ts`.
 */
import { describe, expect, it } from "vitest";
import type { Run, Signal, SignalRaiseInput, Task } from "@hercule/contract";
import { completeSetup, get, post, readErrorBody, withServer } from "../http/testing";
import {
  buildForgePlugin,
  FORGE_CONNECTION_TYPE,
  FORGE_REVIEW_ACTION_ID,
  NOTE_APPEND_ACTION_ID,
  notesPlugin,
} from "../plugins/testing";
import {
  buildTaskStep,
  createConnection,
  createWorkflowOrFail,
  updateWorkflow,
} from "../workflows/testing";

const PROPOSAL: SignalRaiseInput = {
  kind: "proposal",
  title: "Fix the flaky login test",
  reason: "Three failures this week on main.",
  eventIds: [],
  task: { title: "Fix the flaky login test", description: "It fails one run in ten." },
};

const OFFER: SignalRaiseInput = {
  kind: "offer",
  title: "Review the dependency bump",
  reason: "A small, green pull request.",
  eventIds: [],
};

/** Raises a signal as the user and returns its id. Fails the test unless the raise succeeds. */
const raiseOrFail = async (base: string, token: string, input: SignalRaiseInput) => {
  const response = await post(base, "/api/v1/signals/raise", input, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { signalId: string }).signalId;
};

const readSignalOrFail = async (base: string, token: string, id: string): Promise<Signal> => {
  const response = await get(base, `/api/v1/signals/${id}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Signal;
};

const requestAct = (base: string, token: string, id: string, body: object) =>
  post(base, `/api/v1/signals/${id}/act`, body, token);

/** Takes an action and returns the signal as `signal.act` returns it. Fails the test unless it succeeds. */
const actOrFail = async (base: string, token: string, id: string, body: object) => {
  const response = await requestAct(base, token, id, body);
  expect(response.status, await response.clone().text()).toBe(200);
  return (await response.json()) as Signal;
};

const listTasks = async (base: string, token: string): Promise<ReadonlyArray<Task>> => {
  const response = await get(base, "/api/v1/tasks", token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Task> }).items;
};

const listRuns = async (base: string, token: string, workflowId: string) => {
  const response = await get(base, `/api/v1/runs?workflowId=${workflowId}`, token);
  expect(response.status, await response.clone().text()).toBe(200);
  return ((await response.json()) as { items: ReadonlyArray<Run> }).items;
};

/** Joins the parts of a describe line into the text a screen shows. */
const joinLine = (signal: Signal, actionId: string): string =>
  (signal.actions.find((action) => action.id === actionId)?.describeLine ?? [])
    .map((part) => part.text)
    .join("");

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

/** Creates an enabled workflow from `source` and returns its id. */
const createEnabledWorkflow = async (base: string, token: string, source: string) => {
  const workflow = await createWorkflowOrFail(base, token, { source });
  const response = await updateWorkflow(base, token, workflow.id, { enabled: true });
  expect(response.status, await response.clone().text()).toBe(200);
  return workflow.id;
};

describe("the core's actions", () => {
  it("creates the proposal's task on Accept, and records the raise and the decision once each", async () => {
    await withServer(async (harness) => {
      const { base } = harness;
      const token = await completeSetup(base);
      const id = await raiseOrFail(base, token, PROPOSAL);

      const open = await readSignalOrFail(base, token, id);
      expect(joinLine(open, "accept")).toContain("Create task Fix the flaky login test");
      expect(joinLine(open, "dismiss")).toBe("Does nothing");

      const acted = await actOrFail(base, token, id, { actionId: "accept" });

      expect(acted.resolution).toMatchObject({
        kind: "decided",
        actionId: "accept",
        outcome: "Accepted Fix the flaky login test",
        actor: "user",
      });
      expect((await listTasks(base, token)).map((task) => task.title)).toEqual([
        "Fix the flaky login test",
      ]);
      expect((await harness.audit("signal.raised")).map((entry) => entry.payload)).toEqual([
        { signalId: id, kind: "proposal" },
      ]);
      expect((await harness.audit("signal.decided")).map((entry) => entry.payload)).toEqual([
        { signalId: id, actionId: "accept", op: "task.create" },
      ]);
    });
  });

  it("runs nothing on Dismiss, and refuses a second action", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const id = await raiseOrFail(base, token, PROPOSAL);

      const acted = await actOrFail(base, token, id, { actionId: "dismiss" });
      const again = await requestAct(base, token, id, { actionId: "accept" });

      expect(acted.resolution).toMatchObject({ actionId: "dismiss", outcome: "Dismissed" });
      expect(await listTasks(base, token)).toEqual([]);
      expect(again.status).toBe(409);
      expect((await readErrorBody(again)).code).toBe("invalid_state");
    });
  });
});

describe("Hand to an agent", () => {
  it("is offered for each enabled workflow that takes the kind, is frozen at raise, and starts a run with the signal", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const workflowId = await createEnabledWorkflow(
        base,
        token,
        buildSignalInputSource("Review bot", ["offer", "fyi"]),
      );
      // Disabled, so not offered.
      await createWorkflowOrFail(base, token, {
        source: buildSignalInputSource("Sleeping bot", ["offer"]),
      });
      const id = await raiseOrFail(base, token, OFFER);
      // Enabled after the raise, so not offered either: the actions are frozen.
      await createEnabledWorkflow(base, token, buildSignalInputSource("Late bot", ["offer"]));

      const open = await readSignalOrFail(base, token, id);
      const handTo = `hand-to-${workflowId}`;
      expect(open.actions.map((action) => action.id)).toEqual([handTo, "dismiss"]);
      expect(open.actions[0]!.label).toBe("Hand to Review bot");
      expect(joinLine(open, handTo)).toContain("Review bot");

      const acted = await actOrFail(base, token, id, { actionId: handTo });

      expect(acted.resolution).toMatchObject({ actionId: handTo, outcome: "Handed to Review bot" });
      const runs = await listRuns(base, token, workflowId);
      expect(runs).toHaveLength(1);
      const response = await get(base, `/api/v1/runs/${runs[0]!.id}`, token);
      expect(response.status, await response.clone().text()).toBe(200);
      expect(((await response.json()) as Run).inputs).toEqual({ signal: id });
    });
  });

  it("refuses a run whose signal input names no signal, or a signal of a kind the input does not take", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);
      const workflowId = await createEnabledWorkflow(
        base,
        token,
        buildSignalInputSource("Review bot", ["offer"]),
      );
      const fyi = await raiseOrFail(base, token, { ...OFFER, kind: "fyi" });

      for (const [value, message] of [
        ["0199e0e7-9999-7000-8000-000000000000", "No signal has this id"],
        [fyi, "This signal is of kind fyi"],
      ] as const) {
        const response = await post(
          base,
          "/api/v1/runs/start",
          { workflowId, inputs: { signal: value } },
          token,
        );
        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.issues).toEqual([["inputs", "signal"]]);
        expect(refusal.text).toContain(message);
      }
      expect(await listRuns(base, token, workflowId)).toEqual([]);
    });
  });

  it("refuses to save a signal input that takes a kind that is neither core nor qualified", async () => {
    await withServer(async ({ base }) => {
      const token = await completeSetup(base);

      const response = await post(
        base,
        "/api/v1/workflows",
        { source: buildSignalInputSource("Review bot", ["offer", "review"]) },
        token,
      );

      const refusal = await readErrorBody(response);
      expect(response.status, refusal.text).toBe(400);
      expect(refusal.text).toContain("review");
      expect(refusal.text).toContain("is not a signal kind");
    });
  });
});

describe("a plugin action as a typed reply", () => {
  it("runs with the typed text outside any run, through its Connection, and keeps its outcome line", async () => {
    const forge = buildForgePlugin();
    await withServer(
      async ({ base }) => {
        const token = await completeSetup(base);
        const connectionId = await createConnection(base, token, FORGE_CONNECTION_TYPE, {
          token: "a-forge-token",
        });
        const id = await raiseOrFail(base, token, {
          ...OFFER,
          actions: [
            {
              id: "review",
              label: "Reply with a review",
              operation: {
                op: FORGE_REVIEW_ACTION_ID,
                connectionId,
                input: { verdict: "comment" },
              },
              field: { name: "body", placeholder: "Write the review" },
            },
          ],
        });

        const open = await readSignalOrFail(base, token, id);
        expect(joinLine(open, "review")).toContain("Submit a comment review");
        expect(joinLine(open, "review")).toContain("Forge");

        const missing = await requestAct(base, token, id, { actionId: "review" });
        expect(missing.status).toBe(400);
        expect((await readErrorBody(missing)).issues).toEqual([["text"]]);

        const acted = await actOrFail(base, token, id, { actionId: "review", text: "Looks good." });

        expect(acted.resolution).toMatchObject({
          actionId: "review",
          outcome: "Reviewed: comment",
        });
        expect(forge.inputs).toEqual([{ verdict: "comment", body: "Looks good." }]);
        expect(forge.contexts[0]!.run).toBeUndefined();
        expect(forge.contexts[0]!.connection?.credentials).toEqual({ token: "a-forge-token" });
      },
      { plugins: [forge.plugin] },
    );
  });

  it("refuses to raise a signal with a plugin action that is not usable as a signal's answer", async () => {
    await withServer(
      async ({ base }) => {
        const token = await completeSetup(base);

        const response = await post(
          base,
          "/api/v1/signals/raise",
          {
            ...OFFER,
            actions: [
              {
                id: "note",
                label: "Add a note",
                operation: { op: NOTE_APPEND_ACTION_ID, input: { text: "Seen" } },
              },
            ],
          },
          token,
        );

        const refusal = await readErrorBody(response);
        expect(response.status, refusal.text).toBe(400);
        expect(refusal.issues[0]?.slice(0, 2)).toEqual(["actions", "0"]);
      },
      { plugins: [notesPlugin] },
    );
  });
});
