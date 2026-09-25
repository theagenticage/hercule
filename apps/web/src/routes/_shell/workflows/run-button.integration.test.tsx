/**
 * Tests for the **Run** button in a workflow page's header, and the run form
 * it opens.
 *
 * A run uses the saved workflow, so the button is disabled while the editor
 * holds unsaved changes. The editor renders only the lines near the cursor, so
 * a test changes the text the way a user pastes it (select all, paste).
 */
import { describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Run, Workflow, WorkflowSummary } from "@hercule/contract";
import { renderApp, stubApi, type Call } from "../../../app/testing";

type User = ReturnType<typeof userEvent.setup>;

/**
 * How long a test waits for the editor to appear. The first editor page also
 * loads the editor's libraries, which can take a few seconds under jsdom.
 */
const EDITOR_LOAD_TIMEOUT_MS = 5_000;

/** The timeout of a test that opens the editor, including the first editor load. */
const EDITOR_TEST_TIMEOUT_MS = 20_000;

const NIGHTLY_NAME = "Nightly sweep";

/** A workflow that declares no inputs. */
const NIGHTLY_SOURCE = `name: ${NIGHTLY_NAME}
steps:
  - id: sweep
    kind: action
    action: task.query
`;

const NIGHTLY: Workflow = {
  id: "0199c0ff-1111-7000-8000-000000000002",
  enabled: true,
  source: NIGHTLY_SOURCE,
  createdAt: "2026-09-01T08:00:00.000Z",
  updatedAt: "2026-09-02T08:00:00.000Z",
};

const NIGHTLY_SUMMARY: WorkflowSummary = {
  id: NIGHTLY.id,
  name: NIGHTLY_NAME,
  enabled: NIGHTLY.enabled,
  updatedAt: NIGHTLY.updatedAt,
};

/** The id the stub controller gives to the run the form starts. */
const STARTED_RUN_ID = "0199c0ff-2222-7000-8000-0000000000aa";

const STARTED_RUN: Run = {
  id: STARTED_RUN_ID,
  workflowId: NIGHTLY.id,
  plan: {
    name: NIGHTLY_NAME,
    steps: [{ id: "sweep", kind: "action", action: "task.query" }],
  },
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  status: "pending",
  steps: [{ stepId: "sweep", iteration: 1, status: "pending" }],
  edgeTraversals: [],
  createdAt: "2026-09-24T08:00:00.000Z",
};

/** Renders the page of the workflow above against a stub controller that holds it. */
const openWorkflowPage = async () => {
  const api = stubApi({
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: {
          "onboarding.completedSteps": ["timezone", "assistant"],
          timezone: "Europe/Amsterdam",
        },
      },
    },
    "GET /api/v1/workflows": { body: { items: [NIGHTLY_SUMMARY] } },
    [`GET /api/v1/workflows/${NIGHTLY.id}`]: { body: NIGHTLY },
    "POST /api/v1/workflows/validate": { body: { errors: [], warnings: [] } },
    "GET /api/v1/workflow-actions": {
      body: [
        {
          id: "task.query",
          displayName: "Find tasks",
          description: "Lists tasks.",
          runsIn: "controller",
          inputSchema: { type: "object", properties: {}, required: [] },
        },
      ],
    },
    "GET /api/v1/event-kinds": { body: [] },
    "GET /api/v1/agents": { body: { items: [] } },
    "GET /api/v1/connections": { body: { items: [] } },
    "POST /api/v1/runs/start": { body: { runId: STARTED_RUN_ID } },
    [`GET /api/v1/runs/${STARTED_RUN_ID}`]: { body: STARTED_RUN },
    "GET /api/v1/runs": { body: { items: [] } },
  });
  const app = await renderApp({
    path: `/workflows/${NIGHTLY.id}`,
    api: api.fetch,
    token: "held",
  });
  return { ...app, api };
};

/** Waits for the editor to appear and returns it. */
const findEditor = (): Promise<HTMLElement> =>
  screen.findByRole("textbox", { name: "Workflow source" }, { timeout: EDITOR_LOAD_TIMEOUT_MS });

/** Replaces all of the editor's text with `source`, by selecting all and pasting. */
const replaceEditorSource = async (user: User, source: string): Promise<void> => {
  await user.click(await findEditor());
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(source);
};

/** Returns the Run button in the page's header. */
const getRunButton = (): HTMLElement => {
  const header = screen.getByRole("heading", { level: 1 }).closest("header");
  if (header === null) throw new Error("the page's title is not in a header");
  return within(header).getByRole("button", { name: "Run" });
};

/** Checks whether a button cannot be pressed, whether by `disabled` or `aria-disabled`. */
const isUnpressable = (button: HTMLElement): boolean =>
  (button as HTMLButtonElement).disabled || button.getAttribute("aria-disabled") === "true";

/** Returns the `run.start` requests the page made. */
const listRunStarts = (api: { readonly calls: readonly Call[] }): readonly Call[] =>
  api.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/runs/start");

describe("Workflows > the Run button", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("opens the run form, which for a workflow with no inputs holds only Start, and starts the run", async () => {
    const user = userEvent.setup();
    const { api, router } = await openWorkflowPage();
    await findEditor();

    expect(isUnpressable(getRunButton())).toBe(false);
    await user.click(getRunButton());

    const form = await screen.findByRole("form", { name: /^Run\b/ });
    for (const role of ["textbox", "spinbutton", "checkbox", "combobox"] as const) {
      expect(within(form).queryAllByRole(role)).toEqual([]);
    }
    await user.click(within(form).getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${STARTED_RUN_ID}`);
    });
    const starts = listRunStarts(api);
    expect(starts).toHaveLength(1);
    const body = starts[0]?.body as { workflowId?: unknown; inputs?: unknown } | undefined;
    expect(body?.workflowId).toBe(NIGHTLY.id);
    // A workflow with no inputs starts with none.
    expect(body?.inputs ?? {}).toEqual({});
  });

  it("is disabled while the editor holds unsaved changes, and opens no form then", async () => {
    const user = userEvent.setup();
    const { api } = await openWorkflowPage();
    await findEditor();

    await replaceEditorSource(user, NIGHTLY_SOURCE.replace("task.query", "task.create"));

    await waitFor(() => {
      expect(isUnpressable(getRunButton())).toBe(true);
    });
    await user.click(getRunButton());

    expect(screen.queryByRole("form", { name: /^Run\b/ })).toBeNull();
    expect(screen.queryByRole("button", { name: "Start" })).toBeNull();
    expect(listRunStarts(api)).toEqual([]);
  });
});
