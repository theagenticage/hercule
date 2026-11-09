/**
 * What the Tracking end-to-end files share (`tracking.test.ts` and
 * `tracking-retry.test.ts`): the workflows made of the `wait` action and of an
 * action that fails, and reading Tracking's rows.
 */
import type { Page } from "playwright";
import type { Task } from "../../packages/contract/src/index";
import type { ArrangedFleet } from "./harness";

/** A Task that does not exist, which makes the step that updates it fail. */
export const MISSING_TASK_ID = "0199c0ff-7777-7000-8000-000000000001";

/**
 * How long the Working run waits before it ends, in seconds. Long enough for
 * a poll to see the Working row on a loaded machine, short enough to wait for
 * the Finished one.
 */
export const WORKING_SECONDS = 6;

/** The one step of a test workflow: an action and its parameters. */
export interface WorkflowStep {
  readonly action: string;
  readonly params: Readonly<Record<string, string | number>>;
}

/** Returns the definition of a workflow named `name` that takes an FYI signal and runs `step`. */
export const buildWorkflowDefinition = (name: string, step: WorkflowStep) => ({
  name,
  inputs: [{ name: "signal", signal: { kinds: ["fyi" as const] }, required: true }],
  steps: [{ id: "work", kind: "action" as const, ...step }],
});

/** Creates an enabled workflow that takes an FYI signal and runs `step`, and returns its id. */
export async function createWorkflow(
  { client }: ArrangedFleet,
  name: string,
  step: WorkflowStep,
): Promise<string> {
  const { workflow } = await client.workflow.create({
    payload: { definition: buildWorkflowDefinition(name, step) },
  });
  await client.workflow.update({ params: { id: workflow.id }, payload: { enabled: true } });
  return workflow.id;
}

/**
 * Raises an FYI signal titled `title` and returns its id. Create the
 * workflows first: a signal offers Hand to an agent for the workflows that
 * exist when it is raised.
 */
export async function raiseSignal({ client }: ArrangedFleet, title: string): Promise<string> {
  const { signalId } = await client.signal.raise({
    payload: { kind: "fyi", title, reason: "Raised by a test", eventIds: [] },
  });
  return signalId;
}

/** Returns the Tasks that carry a handoff entry. */
export async function listHandedOffTasks({ client }: ArrangedFleet): Promise<ReadonlyArray<Task>> {
  return (await client.task.query({ query: { handedOff: true, limit: 10 } })).items;
}

/** Tracking, folded or opened. */
// Not the sheet that is still dropping while Tracking closes: it is inert.
export const tracking = (page: Page) => page.locator(".asks-list > section.tr-tray:not([inert])");

/** Returns the state and the title of each row Tracking draws, top to bottom. */
export const readTrackingRows = (
  page: Page,
): Promise<Array<{ state: string | null; title: string }>> =>
  tracking(page)
    .locator(".tr-run-item")
    .evaluateAll((rows) =>
      rows.map((row) => ({
        state: row.getAttribute("data-state"),
        title: row.querySelector(".tr-run-title")?.textContent ?? "",
      })),
    );
