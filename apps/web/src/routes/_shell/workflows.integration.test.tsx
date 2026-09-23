/**
 * Tests for the Workflows screens: the list, the editor page, the problems
 * panel below the editor, and the view control.
 *
 * The stub controller keeps the workflows that a test gives it, and updates
 * them on each write like the real controller. So a screen that refetches its
 * list after a write sees the result.
 *
 * The editor renders only the lines near the cursor, so the DOM does not
 * always hold the full text. Tests therefore read the text the way a user
 * copies it (select all, copy), and write it the way a user pastes it (select
 * all, paste). A paste adds no indentation, so the text that the page sends
 * must match the pasted text byte for byte.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { ageOf, queryKeys, parseWorkflowSourceWithRanges } from "@hercule/client-core";
import type {
  DeclaredEventKind,
  Issue,
  Workflow,
  WorkflowAction,
  WorkflowIssues,
  WorkflowSummary,
} from "@hercule/contract";
import {
  envelope,
  expectInDocumentOrder,
  reading,
  renderApp,
  stubApi,
  type Answer,
  type Call,
  type Handler,
} from "../../app/testing";

type User = ReturnType<typeof userEvent.setup>;
type AppRouter = Awaited<ReturnType<typeof renderApp>>["router"];

/**
 * How long a test waits for the editor to appear. The first editor page also
 * loads the editor's libraries, which can take a few seconds under jsdom.
 */
const EDITOR_LOAD_TIMEOUT_MS = 5_000;

/** The timeout of a test that opens the editor, including the first editor load. */
const EDITOR_TEST_TIMEOUT_MS = 20_000;

/** How long a test waits for the validation result. Validation starts only after typing stops. */
const VALIDATION_TIMEOUT_MS = 3_000;

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/** Returns the ISO timestamp of `minutes` minutes ago. */
const buildTimestampMinutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * MINUTE_MS).toISOString();

/** Returns the 1-based number of the line in `source` that equals `line`. Throws when none does. */
const findLineNumber = (source: string, line: string): number => {
  const index = source.split("\n").indexOf(line);
  if (index === -1) throw new Error(`no line of the source is ${JSON.stringify(line)}`);
  return index + 1;
};

/* ------------------------------------------------------------------------ */
/* The workflows the stub controller holds.                                  */
/* ------------------------------------------------------------------------ */

const TRIAGE_NAME = "Triage labelled PRs";
const TRIAGE_DESCRIPTION = "Files a task when a pull request is labelled.";

/**
 * A source that reformatting would change: comments, blank lines, trailing
 * spaces, a `|` block, and keys in a different order than the definition's.
 */
const TRIAGE_SOURCE = [
  "# Files a task for each pull request labelled needs-triage.",
  `name: ${TRIAGE_NAME}`,
  `description: ${TRIAGE_DESCRIPTION}`,
  "",
  "steps:   # one step for now",
  "  - kind: action",
  "    id: file_task",
  "    action: task.create",
  "    params:",
  "      title: Triage the pull request   ",
  "      description: |",
  "        Filed by a workflow.",
  "        Read the diff first.",
  "triggers:",
  "  - id: labeled",
  "    kind: start",
  "    source:",
  "      kind: github.pr.labeled",
  "      connectionId: any",
  "",
].join("\n");

/** The same workflow with an edit that the user has not saved yet. */
const EDITED_TRIAGE_SOURCE = TRIAGE_SOURCE.replace(
  "Read the diff first.",
  "Read the diff and the tests first.",
);

const NIGHTLY_NAME = "Nightly sweep";

/** A workflow with no description. */
const NIGHTLY_SOURCE = `name: ${NIGHTLY_NAME}
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

const WEEKLY_NAME = "Weekly digest";
const WEEKLY_DESCRIPTION = "Sums up the tasks of the week.";

const WEEKLY_SOURCE = `# Runs on Mondays.
name: ${WEEKLY_NAME}
description: ${WEEKLY_DESCRIPTION}
steps:
  - id: digest
    kind: action
    action: task.query
`;

/** The source that a user writes on the page for a new workflow. */
const CREATED_SOURCE = `# Files a task each morning.
name: Morning task
steps:
  - id: morning
    kind: action
    action: task.create
    params:
      title: Plan the day
      description: Filed every morning.
`;

/**
 * A source that parses, but has two problems that only the controller can
 * find: an event kind and an action that do not exist.
 */
const PROBLEM_SOURCE = `name: ${TRIAGE_NAME}
triggers:
  - id: labeled
    kind: start
    source:
      kind: github.pr.labelled
      connectionId: any
steps:
  - id: file_task
    kind: action
    action: task.create
    params:
      title: Triage the pull request
      description: Filed by a workflow.
  - id: comment
    kind: action
    action: task.creat
edges:
  - from: file_task
    to: comment
`;

const UNKNOWN_KIND_LINE_TEXT = "      kind: github.pr.labelled";
const UNKNOWN_ACTION_LINE_TEXT = "    action: task.creat";
const UNKNOWN_KIND_LINE = findLineNumber(PROBLEM_SOURCE, UNKNOWN_KIND_LINE_TEXT);
const UNKNOWN_ACTION_LINE = findLineNumber(PROBLEM_SOURCE, UNKNOWN_ACTION_LINE_TEXT);
const SECOND_STEP_LINE = findLineNumber(PROBLEM_SOURCE, "  - id: comment");

const UNKNOWN_KIND: Issue = {
  path: ["triggers", "0", "source", "kind"],
  message:
    '"github.pr.labelled" is not a known event kind. ' +
    "A trigger can listen for a core event kind or an event kind of an active plugin. " +
    "The known event kinds are: cron.tick, task.created, github.pr.labeled.",
};

const UNKNOWN_ACTION: Issue = {
  path: ["steps", "1", "action"],
  message:
    '"task.creat" is not a known action. ' +
    "A step can use a built-in action or an action of an active plugin. " +
    "The known actions are: task.create, task.update, task.query.",
};

const NO_TERMINAL_STEP: Issue = {
  path: ["steps", "1"],
  message: "No step is terminal, so a run can end only by cancellation.",
};

const TRIAGE: Workflow = {
  id: "0199c0ff-1111-7000-8000-000000000001",
  enabled: false,
  source: TRIAGE_SOURCE,
  createdAt: buildTimestampMinutesAgo(6 * WEEK_MINUTES),
  updatedAt: buildTimestampMinutesAgo(2 * DAY_MINUTES + 30),
};

const NIGHTLY: Workflow = {
  id: "0199c0ff-1111-7000-8000-000000000002",
  enabled: true,
  source: NIGHTLY_SOURCE,
  createdAt: buildTimestampMinutesAgo(4 * WEEK_MINUTES),
  updatedAt: buildTimestampMinutesAgo(3 * HOUR_MINUTES + 5),
};

const WEEKLY: Workflow = {
  id: "0199c0ff-1111-7000-8000-000000000003",
  enabled: false,
  source: WEEKLY_SOURCE,
  createdAt: buildTimestampMinutesAgo(8 * WEEK_MINUTES),
  updatedAt: buildTimestampMinutesAgo(5 * WEEK_MINUTES + 1),
};

/**
 * The order in which the stub controller lists the workflows. It matches
 * neither name order nor age order, so a screen that sorted the list itself
 * would show a different order.
 */
const LISTED_WORKFLOWS: readonly Workflow[] = [TRIAGE, NIGHTLY, WEEKLY];

/** The id that the stub controller gives to the workflow that a test creates. */
const CREATED_ID = "0199c0ff-1111-7000-8000-0000000000aa";

/** The actions that a step can use, as `workflowAction.query` returns them. */
const WORKFLOW_ACTIONS: readonly WorkflowAction[] = [
  {
    id: "task.create",
    displayName: "Create a task",
    description: "Files a task.",
    inputSchema: {
      type: "object",
      properties: { title: { type: "string" }, description: { type: "string" } },
      required: ["title", "description"],
    },
  },
  {
    id: "task.update",
    displayName: "Update a task",
    description: "Changes a task.",
    inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] },
  },
  {
    id: "task.query",
    displayName: "Find tasks",
    description: "Lists tasks.",
    inputSchema: { type: "object", properties: {}, required: [] },
  },
];

/** The event kinds that a trigger can use, as `eventKind.query` returns them. */
const EVENT_KINDS: readonly DeclaredEventKind[] = [
  { kind: "cron.tick", description: "A schedule came due.", connectionRequired: false },
  { kind: "task.created", description: "A task was created.", connectionRequired: false },
  {
    kind: "github.pr.labeled",
    description: "The labels on a pull request changed.",
    connectionRequired: true,
  },
];

/* ------------------------------------------------------------------------ */
/* The stub controller.                                                      */
/* ------------------------------------------------------------------------ */

const NO_PROBLEMS: WorkflowIssues = { errors: [], warnings: [] };

/** Returns a validate function that finds `issues` in `source`, and nothing in any other source. */
const buildValidation =
  (source: string, issues: WorkflowIssues) =>
  (validated: string): WorkflowIssues =>
    validated === source ? issues : NO_PROBLEMS;

/** Returns the response to a save rejected with `issues`, in the API's error envelope. */
const buildRefusal = (issues: readonly Issue[]) => ({
  status: 400,
  body: {
    error: { code: "validation", message: "The workflow is not valid.", details: { issues } },
  },
});

const WORKFLOW_NOT_FOUND = { status: 404, body: envelope("not_found", "No workflow has that id.") };

/** Returns the value of the top-level `key` in `source`, or `undefined` when the source does not set it. */
const readTopLevelValue = (source: string, key: string): string | undefined =>
  new RegExp(`^${key}: (.+)$`, "m").exec(source)?.[1];

/**
 * Converts a stored workflow to a `workflow.query` item. The real controller
 * reads the name and the description from the parsed definition. Every
 * source in this file writes both unindented at the start of a line, so the
 * stub can read them from the text.
 */
const buildSummary = (workflow: Workflow): WorkflowSummary => {
  const description = readTopLevelValue(workflow.source, "description");
  return {
    id: workflow.id,
    name: readTopLevelValue(workflow.source, "name") ?? "",
    ...(description === undefined ? {} : { description }),
    enabled: workflow.enabled,
    updatedAt: workflow.updatedAt,
  };
};

/**
 * Builds a stub controller that has finished setup and holds `workflows`,
 * listed in the given order. Each write updates the workflows it holds.
 * - `validate` handles `workflow.validate`.
 * - `overrides` replaces the handler of a route, or adds a route.
 *
 * Returns the routes, and `changeElsewhere` and `deleteElsewhere`, which
 * change the stored workflows the way another client would.
 */
const buildController = ({
  workflows,
  validate,
  overrides,
}: {
  readonly workflows: readonly Workflow[];
  readonly validate: (source: string) => WorkflowIssues;
  readonly overrides: Readonly<Record<string, Handler>>;
}) => {
  const heldWorkflows = [...workflows];
  const findHeldWorkflow = (id: string): Workflow | undefined =>
    heldWorkflows.find((workflow) => workflow.id === id);
  const replaceHeldWorkflow = (changed: Workflow): void => {
    const workflow = findHeldWorkflow(changed.id);
    if (workflow === undefined) throw new Error(`the controller holds no workflow ${changed.id}`);
    heldWorkflows.splice(heldWorkflows.indexOf(workflow), 1, changed);
  };

  const buildWorkflowRoutes = (id: string): Record<string, Handler> => ({
    [`GET /api/v1/workflows/${id}`]: () => {
      const workflow = findHeldWorkflow(id);
      return workflow === undefined ? WORKFLOW_NOT_FOUND : { body: workflow };
    },
    [`PATCH /api/v1/workflows/${id}`]: (call) => {
      const workflow = findHeldWorkflow(id);
      if (workflow === undefined) return WORKFLOW_NOT_FOUND;
      const change = call.body as { readonly source?: string; readonly enabled?: boolean };
      const changed: Workflow = {
        ...workflow,
        source: change.source ?? workflow.source,
        enabled: change.enabled ?? workflow.enabled,
        // `updatedAt` tracks changes to the source only, so turning a
        // workflow on or off does not change it.
        updatedAt:
          change.source === undefined || change.source === workflow.source
            ? workflow.updatedAt
            : new Date().toISOString(),
      };
      replaceHeldWorkflow(changed);
      return { body: { workflow: changed, warnings: [] } };
    },
    [`DELETE /api/v1/workflows/${id}`]: () => {
      const workflow = findHeldWorkflow(id);
      if (workflow === undefined) return WORKFLOW_NOT_FOUND;
      heldWorkflows.splice(heldWorkflows.indexOf(workflow), 1);
      return { body: {} };
    },
  });

  const ids = [...workflows.map((workflow) => workflow.id), CREATED_ID];
  const routes: Readonly<Record<string, Handler>> = {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
      },
    },
    "GET /api/v1/workflows": () => ({ body: { items: heldWorkflows.map(buildSummary) } }),
    "POST /api/v1/workflows": (call) => {
      const { source } = call.body as { readonly source: string };
      const now = new Date().toISOString();
      const created: Workflow = {
        id: CREATED_ID,
        enabled: false,
        source,
        createdAt: now,
        updatedAt: now,
      };
      heldWorkflows.push(created);
      return { body: { workflow: created, warnings: [] } };
    },
    "POST /api/v1/workflows/validate": (call) => ({
      body: validate((call.body as { readonly source: string }).source),
    }),
    "GET /api/v1/workflow-actions": { body: WORKFLOW_ACTIONS },
    "GET /api/v1/event-kinds": { body: EVENT_KINDS },
    "GET /api/v1/agents": { body: { items: [] } },
    ...Object.fromEntries(ids.flatMap((id) => Object.entries(buildWorkflowRoutes(id)))),
    ...overrides,
  };
  return {
    routes,
    changeElsewhere: (id: string, source: string): void => {
      const workflow = findHeldWorkflow(id);
      if (workflow === undefined) throw new Error(`the controller holds no workflow ${id}`);
      replaceHeldWorkflow({ ...workflow, source, updatedAt: new Date().toISOString() });
    },
    deleteElsewhere: (id: string): void => {
      const workflow = findHeldWorkflow(id);
      if (workflow === undefined) throw new Error(`the controller holds no workflow ${id}`);
      heldWorkflows.splice(heldWorkflows.indexOf(workflow), 1);
    },
  };
};

/** Renders the app at `path` against a stub controller that holds `workflows`. */
const openApp = async ({
  path,
  workflows = LISTED_WORKFLOWS,
  validate = () => NO_PROBLEMS,
  overrides = {},
}: {
  readonly path: string;
  readonly workflows?: readonly Workflow[];
  readonly validate?: (source: string) => WorkflowIssues;
  readonly overrides?: Readonly<Record<string, Handler>>;
}) => {
  const { routes, changeElsewhere, deleteElsewhere } = buildController({
    workflows,
    validate,
    overrides,
  });
  const api = stubApi(routes);
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return { ...app, api, changeElsewhere, deleteElsewhere };
};

/**
 * Returns the writes that the screen made, in order. The live connection
 * requests a ticket on every screen, and a validation stores nothing, so
 * neither counts as a write.
 */
const listWrites = (api: { readonly calls: readonly Call[] }): readonly Call[] =>
  api.calls.filter(
    (call) =>
      call.method !== "GET" &&
      !call.path.endsWith("/auth/ws-ticket") &&
      call.path !== "/api/v1/workflows/validate",
  );

/** Returns a write as its route and its body. */
const describeWrite = (call: Call): readonly [string, unknown] => [
  `${call.method} ${call.path}`,
  call.body,
];

/**
 * Waits until the app has no read or write in flight. A save is a React Query
 * mutation, so once no mutation is running, the page has the save's result.
 */
const waitForIdleRequests = (queryClient: QueryClient): Promise<void> =>
  waitFor(() => {
    expect(queryClient.isMutating()).toBe(0);
    expect(queryClient.isFetching()).toBe(0);
  });

/* ------------------------------------------------------------------------ */
/* Helpers that read and use the page the way a user does.                  */
/* ------------------------------------------------------------------------ */

/** Returns the requests that read the stored workflow with `id`. */
const listWorkflowReads = (api: { readonly calls: readonly Call[] }, id: string): readonly Call[] =>
  api.calls.filter((call) => call.method === "GET" && call.path === `/api/v1/workflows/${id}`);

/** Waits for the editor to appear and returns it. */
const findEditor = (): Promise<HTMLElement> =>
  screen.findByRole("textbox", { name: "Workflow source" }, { timeout: EDITOR_LOAD_TIMEOUT_MS });

/** Replaces all of the editor's text with `source`, by selecting all and pasting. */
const replaceEditorSource = async (user: User, source: string): Promise<void> => {
  await user.click(await findEditor());
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(source);
};

/** Returns all of the editor's text, by selecting all and copying. */
const readEditorSource = async (user: User): Promise<string | undefined> => {
  await user.click(await findEditor());
  await user.keyboard("{Control>}a{/Control}");
  const copied = await user.copy();
  return copied?.getData("text/plain");
};

/**
 * Returns the text of the line that holds the cursor. The editor renders each
 * line as one child element of the text box, so the line with the cursor is
 * the child that contains the selection's anchor.
 */
const readCaretLine = (editor: HTMLElement): string | undefined => {
  const selection = document.getSelection();
  let node: Node | null = selection?.anchorNode ?? null;
  if (node === editor) node = editor.childNodes.item(selection?.anchorOffset ?? 0);
  while (node !== null && node.parentNode !== editor) node = node.parentNode;
  return node?.textContent ?? undefined;
};

const findProblemsPanel = (): Promise<HTMLElement> =>
  screen.findByRole("region", { name: "Problems" });

/** Waits for the problems panel entry at `line` with `message`, and returns it. */
const findProblem = (panel: HTMLElement, line: number, message: string): Promise<HTMLElement> =>
  within(panel).findByRole(
    "button",
    {
      name: (name) => new RegExp(`\\bLine ${String(line)}\\b`).test(name) && name.includes(message),
    },
    { timeout: VALIDATION_TIMEOUT_MS },
  );

/** Returns a sidebar link, which is how a user moves to another screen. */
const getNavLink = (name: string): HTMLElement =>
  within(screen.getByRole("navigation", { name: "Hercule" })).getByRole("link", { name });

/**
 * Returns one option of the view control. The view control is a segmented
 * control, and its options have the radio role.
 */
const getViewOption = (name: "YAML" | "Graph" | "Split"): HTMLElement =>
  screen.getByRole("radio", { name });

/** Returns the `view` search param of the current URL, or `null` when there is none. */
const readViewParam = (router: AppRouter): string | null =>
  new URLSearchParams(router.state.location.searchStr).get("view");

/** Returns the workflow list, which is the only list on the screen. */
const getWorkflowList = (): HTMLElement => within(screen.getByRole("main")).getByRole("list");

/** Returns the list item whose link is named `name`. */
const getWorkflowRow = (name: string): HTMLElement => {
  const row = within(getWorkflowList())
    .getAllByRole("listitem")
    .find((item) => within(item).queryByRole("link", { name }) !== null);
  if (row === undefined) throw new Error(`no row of the list links to ${name}`);
  return row;
};

const getEnabledSwitch = (name: string): HTMLElement =>
  within(getWorkflowRow(name)).getByRole("switch", { name: "Enabled" });

/** Returns the header of a workflow's page, which holds its title. */
const getPageHeader = (): HTMLElement => {
  const header = screen.getByRole("heading", { level: 1 }).closest("header");
  if (header === null) throw new Error("the page's title is not in a header");
  return header;
};

/** Returns the status text beside Save in the page header, or `undefined` when there is none. */
const readHeaderStatus = (): string | undefined => {
  const header = getPageHeader();
  const statusLine = within(header).queryByRole("alert") ?? within(header).queryByRole("status");
  return statusLine?.textContent ?? undefined;
};

/**
 * Returns a handler that responds only after the test calls `release`, so the
 * test can inspect the page while the request is in flight.
 */
const holdAnswer = (answer: (call: Call) => Answer) => {
  let release = (): void => {};
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  const handler: Handler = async (call) => {
    await released;
    return answer(call);
  };
  return { handler, release };
};

/** Sends a live push saying that the workflow with `id` was updated or deleted elsewhere. */
const pushWorkflowChange = (
  live: Awaited<ReturnType<typeof openApp>>["live"],
  id: string,
  kind: "updated" | "deleted",
): void => {
  act(() => {
    live.push("workflow", { _tag: "invalidate", ids: [id], kind });
  });
};

/** Waits until the page subscribes to live changes of workflows. */
const waitForWorkflowSubscription = (live: Awaited<ReturnType<typeof openApp>>["live"]) =>
  waitFor(() => {
    expect(live.topics()).toContain("workflow");
  });

/** Returns the sources that the page sent for validation, in order. */
const listValidatedSources = (api: { readonly calls: readonly Call[] }): readonly string[] =>
  api.calls
    .filter((call) => call.path === "/api/v1/workflows/validate")
    .map((call) => (call.body as { readonly source: string }).source);

/**
 * Pastes `text` at the editor's cursor with a plain DOM event. user-event
 * waits on a timer after each action, and a fake clock never fires that
 * timer, so tests that use a fake clock paste without user-event.
 */
const pasteUnderFakeClock = (editor: HTMLElement, text: string): void => {
  fireEvent.paste(editor, { clipboardData: { getData: () => text } });
};

/** Advances the fake clock, and lets React and the promises it resolves catch up. */
const advanceClock = (milliseconds: number) =>
  act(async () => {
    await vi.advanceTimersByTimeAsync(milliseconds);
  });

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------ */
/* The tests.                                                                */
/* ------------------------------------------------------------------------ */

describe("Workflows > the list", () => {
  it("lists each workflow in the controller's order, with its name, description, switch and age", async () => {
    await openApp({ path: "/workflows" });

    await screen.findByRole("link", { name: TRIAGE_NAME });
    const rows = within(getWorkflowList()).getAllByRole("listitem");
    expect(rows.map((row) => reading(within(row).getByRole("link")))).toEqual([
      TRIAGE_NAME,
      NIGHTLY_NAME,
      WEEKLY_NAME,
    ]);

    const expected = [
      { workflow: TRIAGE, name: TRIAGE_NAME, description: TRIAGE_DESCRIPTION },
      { workflow: NIGHTLY, name: NIGHTLY_NAME, description: undefined },
      { workflow: WEEKLY, name: WEEKLY_NAME, description: WEEKLY_DESCRIPTION },
    ];
    for (const { workflow, name, description } of expected) {
      const row = getWorkflowRow(name);
      expect(within(row).getByRole("link", { name }).getAttribute("href")).toBe(
        `/workflows/${workflow.id}`,
      );
      if (description !== undefined) expect(reading(row)).toContain(description);
      expect(getEnabledSwitch(name).getAttribute("aria-checked")).toBe(String(workflow.enabled));
      // The expected age uses the same function as the app. Its smallest unit
      // is a minute, so the two agree unless a minute boundary falls between
      // them.
      expect(reading(row)).toContain(ageOf(workflow.updatedAt, new Date()));
    }
  });

  it("turns a workflow on and off with its switch, sending only `enabled`", async () => {
    const user = userEvent.setup();
    const { api } = await openApp({ path: "/workflows" });
    await screen.findByRole("link", { name: TRIAGE_NAME });

    await user.click(getEnabledSwitch(TRIAGE_NAME));
    await waitFor(() => {
      expect(getEnabledSwitch(TRIAGE_NAME).getAttribute("aria-checked")).toBe("true");
    });

    await user.click(getEnabledSwitch(NIGHTLY_NAME));
    await waitFor(() => {
      expect(getEnabledSwitch(NIGHTLY_NAME).getAttribute("aria-checked")).toBe("false");
    });

    expect(listWrites(api).map(describeWrite)).toEqual([
      [`PATCH /api/v1/workflows/${TRIAGE.id}`, { enabled: true }],
      [`PATCH /api/v1/workflows/${NIGHTLY.id}`, { enabled: false }],
    ]);
  });

  it("opens a workflow when its name is clicked", { timeout: EDITOR_TEST_TIMEOUT_MS }, async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: "/workflows" });

    await user.click(await screen.findByRole("link", { name: NIGHTLY_NAME }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${NIGHTLY.id}`);
    });
    await findEditor();
  });

  it(
    "offers New workflow, which opens the editor on /workflows/new",
    { timeout: EDITOR_TEST_TIMEOUT_MS },
    async () => {
      const user = userEvent.setup();
      const { router } = await openApp({ path: "/workflows" });

      const create = await screen.findByRole("link", { name: "New workflow" });
      expect(create.getAttribute("href")).toBe("/workflows/new");
      await user.click(create);

      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/workflows/new");
      });
      await findEditor();
    },
  );

  it("shows an empty state with New workflow when there are no workflows", async () => {
    await openApp({ path: "/workflows", workflows: [] });

    expect(await screen.findByRole("heading", { name: "No workflows yet." })).toBeDefined();
    const offers = await screen.findAllByRole("link", { name: "New workflow" });
    for (const offer of offers) expect(offer.getAttribute("href")).toBe("/workflows/new");
    expect(within(screen.getByRole("main")).queryAllByRole("listitem")).toEqual([]);
  });
});

describe("Workflows > a new workflow", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("opens the editor on a starter source that starts with a comment and parses as a workflow", async () => {
    const user = userEvent.setup();
    await openApp({ path: "/workflows/new" });

    const starter = (await readEditorSource(user)) ?? "";

    expect(starter.split("\n")[0]).toMatch(/^\s*#/);
    expect(parseWorkflowSourceWithRanges(starter).definition).toBeDefined();
  });

  it("creates the workflow from the text as typed, then opens it", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({ path: "/workflows/new" });

    await replaceEditorSource(user, CREATED_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    expect(listWrites(api).map(describeWrite)).toEqual([
      ["POST /api/v1/workflows", { source: CREATED_SOURCE }],
    ]);
    // The new workflow's page replaces the draft's page only once the
    // navigation finishes.
    await waitFor(() => {
      expect(router.state.status).toBe("idle");
    });
    expect(await readEditorSource(user)).toBe(CREATED_SOURCE);
  });

  // The validation finds only a warning, but the save is still rejected. This
  // happens when something changes on the controller between the validation
  // and the save, for example when an Agent is deleted. The test waits for
  // the warning before it saves, so the validation result cannot arrive after
  // the rejection and replace its errors.
  it("keeps the text and lists the errors when the create is rejected", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({
      path: "/workflows/new",
      validate: buildValidation(PROBLEM_SOURCE, { errors: [], warnings: [NO_TERMINAL_STEP] }),
      overrides: { "POST /api/v1/workflows": buildRefusal([UNKNOWN_ACTION]) },
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    await findProblem(panel, SECOND_STEP_LINE, NO_TERMINAL_STEP.message);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await findProblem(await findProblemsPanel(), UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    expect(router.state.location.pathname).toBe("/workflows/new");
    expect(await readEditorSource(user)).toBe(PROBLEM_SOURCE);
  });
});

describe("Workflows > a stored workflow", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("opens the editor on the source exactly as it is stored", async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });

    expect(await readEditorSource(user)).toBe(TRIAGE_SOURCE);
  });

  it("saves the text as typed with workflow.update, and sends only the source", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api).map(describeWrite)).toEqual([
        [`PATCH /api/v1/workflows/${TRIAGE.id}`, { source: EDITED_TRIAGE_SOURCE }],
      ]);
    });
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
  });

  // As in the create test, the validation finds only a warning and the test
  // waits for it, so only the rejection can add the error. A rejection
  // returns errors only, so the warning from the validation stays.
  it("keeps the text and lists the errors when the update is rejected, next to the validation's warnings", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      validate: buildValidation(PROBLEM_SOURCE, { errors: [], warnings: [NO_TERMINAL_STEP] }),
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: buildRefusal([UNKNOWN_ACTION]) },
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    await findProblem(panel, SECOND_STEP_LINE, NO_TERMINAL_STEP.message);
    await user.click(screen.getByRole("button", { name: "Save" }));

    const refused = await findProblem(
      await findProblemsPanel(),
      UNKNOWN_ACTION_LINE,
      UNKNOWN_ACTION.message,
    );
    const warned = await findProblem(
      await findProblemsPanel(),
      SECOND_STEP_LINE,
      NO_TERMINAL_STEP.message,
    );
    expectInDocumentOrder([refused, warned]);
    expect(reading(await findProblemsPanel())).toContain("2 problems");
    expect(listWrites(api).map(describeWrite)).toEqual([
      [`PATCH /api/v1/workflows/${TRIAGE.id}`, { source: PROBLEM_SOURCE }],
    ]);
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
    expect(await readEditorSource(user)).toBe(PROBLEM_SOURCE);
  });

  it("asks for confirmation on the page, not in a browser dialog, then deletes and returns to the list", async () => {
    const user = userEvent.setup();
    const browserDialog = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { api, router } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    expect(await screen.findByText(/Delete this workflow\?/)).toBeDefined();
    expect(listWrites(api)).toEqual([]);

    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/workflows");
    });
    expect(listWrites(api).map((call) => `${call.method} ${call.path}`)).toEqual([
      `DELETE /api/v1/workflows/${TRIAGE.id}`,
    ]);
    // The list is refetched and no longer has the deleted workflow.
    expect(await screen.findByRole("link", { name: NIGHTLY_NAME })).toBeDefined();
    expect(screen.queryByRole("link", { name: TRIAGE_NAME })).toBeNull();
    expect(browserDialog).not.toHaveBeenCalled();
  });

  it("deletes nothing when the question is cancelled", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await screen.findByText(/Delete this workflow\?/);
    await user.click(screen.getByRole("button", { name: "Cancel" }));

    await waitFor(() => {
      expect(screen.queryByText(/Delete this workflow\?/)).toBeNull();
    });
    expect(listWrites(api)).toEqual([]);
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
  });
});

describe("Workflows > leaving with unsaved changes", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("asks for confirmation on the page before leaving, and Stay keeps the page and the text", async () => {
    const user = userEvent.setup();
    const browserDialog = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { router } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    await user.click(getNavLink("Runs"));

    expect(await screen.findByText(/Leave without saving\?/)).toBeDefined();
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);

    await user.click(screen.getByRole("button", { name: "Stay" }));

    await waitFor(() => {
      expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
    });
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
    expect(await readEditorSource(user)).toBe(EDITED_TRIAGE_SOURCE);
    expect(browserDialog).not.toHaveBeenCalled();
  });

  it("leaves when Leave is chosen", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    await user.click(getNavLink("Runs"));
    await screen.findByText(/Leave without saving\?/);
    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });
  });

  it("does not ask when nothing changed", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    await user.click(getNavLink("Runs"));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });
    expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
  });

  it("does not ask while a save of the current text is in flight", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, source }, warnings: [] } };
    });
    const { api, router, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);

    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(getNavLink("Runs"));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });
    expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
    held.release();
    await waitForIdleRequests(queryClient);
    expect(listWrites(api).map(describeWrite)).toEqual([
      [`PATCH /api/v1/workflows/${TRIAGE.id}`, { source: EDITED_TRIAGE_SOURCE }],
    ]);
  });

  // The link is clicked before the page re-renders with the pending save, so
  // the navigation is blocked at first. Once the page sees the save, the
  // blocked navigation continues.
  it("lets a blocked navigation continue once a save of the text is in flight", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, source }, warnings: [] } };
    });
    const { router, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    const save = screen.getByRole("button", { name: "Save" });
    const runs = getNavLink("Runs");

    act(() => {
      save.click();
      runs.click();
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });
    expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
    held.release();
    await waitForIdleRequests(queryClient);
  });

  it("does not ask once the changes are saved", async () => {
    const user = userEvent.setup();
    const { api, router, queryClient } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(listWrites(api)).toHaveLength(1);
    });
    await waitForIdleRequests(queryClient);
    await user.click(getNavLink("Runs"));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });
    expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
  });
});

describe("Workflows > the problems panel", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  /** Two errors and one warning. The warning is on a line above one of the errors. */
  const PROBLEM_SOURCE_ISSUES: WorkflowIssues = {
    errors: [UNKNOWN_KIND, UNKNOWN_ACTION],
    warnings: [NO_TERMINAL_STEP],
  };

  it("lists the errors, then the warnings, each with its line and message, under a count", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      validate: buildValidation(PROBLEM_SOURCE, PROBLEM_SOURCE_ISSUES),
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    const unknownKind = await findProblem(panel, UNKNOWN_KIND_LINE, UNKNOWN_KIND.message);
    const unknownAction = await findProblem(panel, UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    const noTerminalStep = await findProblem(panel, SECOND_STEP_LINE, NO_TERMINAL_STEP.message);

    // The warning's line is above the second error's line, so sorting by line
    // would put the warning between the two errors.
    expect(SECOND_STEP_LINE).toBeLessThan(UNKNOWN_ACTION_LINE);
    expectInDocumentOrder([unknownKind, unknownAction, noTerminalStep]);
    expect(reading(panel)).toContain("3 problems");
  });

  it("uses the singular for one problem", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      validate: buildValidation(PROBLEM_SOURCE, { errors: [UNKNOWN_ACTION], warnings: [] }),
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    await findProblem(panel, UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);

    expect(reading(panel)).toMatch(/\b1 problem\b/);
  });

  it('shows "No problems." when there are none', async () => {
    await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    const panel = await findProblemsPanel();

    // Until the validation returns, the panel may show "Checking…". "No
    // problems." appears only after the result arrives.
    await waitFor(
      () => {
        expect(reading(panel)).toContain("No problems.");
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );
    expect(reading(panel)).not.toMatch(/\d+ problems?/);
    expect(within(panel).queryAllByRole("button", { name: /\bLine \d+/ })).toEqual([]);
  });

  it("moves the cursor to the line of a clicked problem", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      validate: buildValidation(PROBLEM_SOURCE, PROBLEM_SOURCE_ISSUES),
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();

    await user.click(await findProblem(panel, UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message));
    const editor = await findEditor();
    await waitFor(() => {
      expect(document.activeElement).toBe(editor);
    });
    expect(readCaretLine(editor)).toBe(UNKNOWN_ACTION_LINE_TEXT);

    await user.click(
      await findProblem(await findProblemsPanel(), UNKNOWN_KIND_LINE, UNKNOWN_KIND.message),
    );
    await waitFor(() => {
      expect(readCaretLine(editor)).toBe(UNKNOWN_KIND_LINE_TEXT);
    });
    expect(document.activeElement).toBe(editor);
  });

  it("switches the graph-only view to split before it moves the cursor", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      validate: buildValidation(PROBLEM_SOURCE, PROBLEM_SOURCE_ISSUES),
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    await findProblem(await findProblemsPanel(), UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    await user.click(getViewOption("Graph"));
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Workflow source" })).toBeNull();
    });

    const panel = await findProblemsPanel();
    await user.click(await findProblem(panel, UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message));

    await waitFor(() => {
      expect(readViewParam(router)).toBe("split");
    });
    const editor = await findEditor();
    expect(screen.getByRole("region", { name: "Workflow graph" })).toBeDefined();
    await waitFor(() => {
      expect(document.activeElement).toBe(editor);
    });
    expect(readCaretLine(editor)).toBe(UNKNOWN_ACTION_LINE_TEXT);
  });
});

describe("Workflows > the view control", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("shows the text and the graph side by side when the URL has no view", async () => {
    await openApp({ path: `/workflows/${TRIAGE.id}` });

    await findEditor();
    expect(await screen.findByRole("region", { name: "Workflow graph" })).toBeDefined();
    expect(screen.getByRole("region", { name: "Problems" })).toBeDefined();
    expect(getViewOption("Split").getAttribute("aria-checked")).toBe("true");
  });

  it.each([
    { view: "yaml", option: "YAML", showsText: true, showsGraph: false },
    { view: "graph", option: "Graph", showsText: false, showsGraph: true },
    { view: "split", option: "Split", showsText: true, showsGraph: true },
  ] as const)(
    "opens view=$view with the matching panes and the problems panel",
    async ({ view, option, showsText, showsGraph }) => {
      await openApp({ path: `/workflows/${TRIAGE.id}?view=${view}` });

      // Wait for what the view shows first, so the page is fully rendered
      // before the test checks what the view hides.
      if (showsText) await findEditor();
      if (showsGraph) {
        await screen.findByRole(
          "region",
          { name: "Workflow graph" },
          { timeout: EDITOR_LOAD_TIMEOUT_MS },
        );
      }
      if (!showsText) {
        expect(screen.queryByRole("textbox", { name: "Workflow source" })).toBeNull();
      }
      if (!showsGraph) {
        expect(screen.queryByRole("region", { name: "Workflow graph" })).toBeNull();
      }
      expect(screen.getByRole("region", { name: "Problems" })).toBeDefined();
      expect(getViewOption(option).getAttribute("aria-checked")).toBe("true");
    },
  );

  it("writes the chosen view to the URL, and a reload keeps it", async () => {
    const user = userEvent.setup();
    const { router, unmount } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    await user.click(getViewOption("YAML"));
    await waitFor(() => {
      expect(readViewParam(router)).toBe("yaml");
    });
    await waitFor(() => {
      expect(screen.queryByRole("region", { name: "Workflow graph" })).toBeNull();
    });
    expect(screen.getByRole("textbox", { name: "Workflow source" })).toBeDefined();

    await user.click(getViewOption("Split"));
    await waitFor(() => {
      expect(readViewParam(router)).toBe("split");
    });
    expect(await screen.findByRole("region", { name: "Workflow graph" })).toBeDefined();
    expect(screen.getByRole("textbox", { name: "Workflow source" })).toBeDefined();

    await user.click(getViewOption("Graph"));
    await waitFor(() => {
      expect(readViewParam(router)).toBe("graph");
    });
    await waitFor(() => {
      expect(screen.queryByRole("textbox", { name: "Workflow source" })).toBeNull();
    });
    expect(screen.getByRole("region", { name: "Workflow graph" })).toBeDefined();

    // Simulates a reload by rendering the same URL again.
    const address = router.state.location.href;
    unmount();
    await openApp({ path: address });

    expect(
      await screen.findByRole(
        "region",
        { name: "Workflow graph" },
        { timeout: EDITOR_LOAD_TIMEOUT_MS },
      ),
    ).toBeDefined();
    expect(screen.queryByRole("textbox", { name: "Workflow source" })).toBeNull();
    expect(getViewOption("Graph").getAttribute("aria-checked")).toBe("true");
  });
});

describe("Workflows > the switch in the list", () => {
  it("shows the new state while the request is in flight, and ignores clicks until it finishes", async () => {
    const user = userEvent.setup();
    const held = holdAnswer(() => ({
      body: { workflow: { ...TRIAGE, enabled: true }, warnings: [] },
    }));
    const { api, queryClient } = await openApp({
      path: "/workflows",
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await screen.findByRole("link", { name: TRIAGE_NAME });

    await user.click(getEnabledSwitch(TRIAGE_NAME));
    await waitFor(() => {
      expect(getEnabledSwitch(TRIAGE_NAME).getAttribute("aria-checked")).toBe("true");
    });
    // While the request is in flight, the switch ignores clicks and keeps the focus.
    expect(getEnabledSwitch(TRIAGE_NAME).getAttribute("aria-disabled")).toBe("true");
    expect(document.activeElement).toBe(getEnabledSwitch(TRIAGE_NAME));
    await user.click(getEnabledSwitch(TRIAGE_NAME));
    await user.keyboard(" ");

    held.release();
    await waitForIdleRequests(queryClient);
    expect(listWrites(api).map(describeWrite)).toEqual([
      [`PATCH /api/v1/workflows/${TRIAGE.id}`, { enabled: true }],
    ]);
    expect(document.activeElement).toBe(getEnabledSwitch(TRIAGE_NAME));
  });

  it("shows under the row why the update failed, and keeps the stored state", async () => {
    const user = userEvent.setup();
    const { queryClient } = await openApp({
      path: "/workflows",
      overrides: {
        [`PATCH /api/v1/workflows/${TRIAGE.id}`]: {
          status: 500,
          body: envelope("internal", "The controller could not store the change."),
        },
      },
    });
    await screen.findByRole("link", { name: TRIAGE_NAME });

    await user.click(getEnabledSwitch(TRIAGE_NAME));
    await waitForIdleRequests(queryClient);

    expect(within(getWorkflowRow(TRIAGE_NAME)).getByRole("alert").textContent).toBe(
      "The controller could not store the change.",
    );
    expect(getEnabledSwitch(TRIAGE_NAME).getAttribute("aria-checked")).toBe("false");
  });
});

describe("Workflows > the page header", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  // Save uses `aria-disabled` instead of `disabled`, so it keeps the focus
  // after a save finishes.
  it("disables Save while the text matches the stored text", async () => {
    const user = userEvent.setup();
    const { api } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.click(save);

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    expect(save.getAttribute("aria-disabled")).toBe("false");

    await replaceEditorSource(user, TRIAGE_SOURCE);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.click(save);
    expect(listWrites(api)).toEqual([]);
  });

  it("keeps the focus on Save while the save is in flight and after it finishes", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, source }, warnings: [] } };
    });
    const { api, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    const save = screen.getByRole("button", { name: "Save" });

    await user.click(save);
    await waitFor(() => {
      expect(save.getAttribute("aria-disabled")).toBe("true");
    });
    expect(document.activeElement).toBe(save);
    await user.keyboard("{Enter}");

    held.release();
    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Saved.");
    });
    await waitForIdleRequests(queryClient);
    expect(document.activeElement).toBe(save);
    expect(listWrites(api)).toHaveLength(1);
  });

  it('shows "Saved." after a save, and clears it when the text changes again', async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    expect(readHeaderStatus()).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Saved.");
    });

    await replaceEditorSource(user, TRIAGE_SOURCE);
    expect(readHeaderStatus()).toBeUndefined();
  });

  it("shows why a save failed, and keeps the text", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: {
        [`PATCH /api/v1/workflows/${TRIAGE.id}`]: {
          status: 500,
          body: envelope("internal", "The disk is full."),
        },
      },
    });

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Not saved: The disk is full.");
    });
    expect(await readEditorSource(user)).toBe(EDITED_TRIAGE_SOURCE);
  });

  it("shows that a rejected text has problems, until the text changes", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: buildRefusal([UNKNOWN_ACTION]) },
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Not saved: the text has problems.");
    });

    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    expect(readHeaderStatus()).toBeUndefined();
  });

  it("shows why a delete failed, and stays on the page", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: {
        [`DELETE /api/v1/workflows/${TRIAGE.id}`]: {
          status: 500,
          body: envelope("internal", "The database is locked."),
        },
      },
    });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));

    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Not deleted: The database is locked.");
    });
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
  });

  it("titles the page with the name in the text, and keeps the last name while the text does not parse", async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();
    const readTitle = () => screen.getByRole("heading", { level: 1 }).textContent;
    expect(readTitle()).toBe(TRIAGE_NAME);
    // The link back to the list is not marked as the current page.
    const back = within(getPageHeader()).getByRole("link", { name: "Workflows" });
    expect(back.getAttribute("href")).toBe("/workflows");
    expect(back.getAttribute("aria-current")).toBeNull();

    await replaceEditorSource(user, NIGHTLY_SOURCE);
    expect(readTitle()).toBe(NIGHTLY_NAME);

    await replaceEditorSource(user, `${NIGHTLY_SOURCE}steps: [`);
    expect(readTitle()).toBe(NIGHTLY_NAME);
  });

  it('titles a new workflow with the starter\'s name, and a stored source that never parsed "Workflow"', async () => {
    const { unmount } = await openApp({ path: "/workflows/new" });
    await findEditor();
    const starterName = screen.getByRole("heading", { level: 1 }).textContent;
    expect(starterName).not.toBe("");
    // The title comes from the starter source, not from the "New workflow" button label.
    expect(starterName).not.toBe("New workflow");
    unmount();

    // A source that was stored before a contract change made it invalid.
    const unreadable: Workflow = { ...TRIAGE, source: "name: [Triage\n" };
    await openApp({ path: `/workflows/${TRIAGE.id}`, workflows: [unreadable] });
    await findEditor();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workflow");
  });

  it('shows "Checking…" until the validation returns, then why it could not run', async () => {
    const held = holdAnswer(() => ({
      status: 500,
      body: envelope("internal", "The validation timed out."),
    }));
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { "POST /api/v1/workflows/validate": held.handler },
    });
    await findEditor();
    const panel = await findProblemsPanel();
    expect(reading(panel)).toContain("Checking…");
    expect(reading(panel)).not.toContain("No problems.");

    held.release();

    await waitFor(
      () => {
        expect(reading(panel)).toContain("Not checked: The validation timed out.");
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );
    expect(reading(panel)).not.toContain("Checking…");
    expect(reading(panel)).not.toContain("No problems.");
  });
});

describe("Workflows > the validation of the source", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("validates the source about 400 ms after it stops changing", async () => {
    const { api } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    const editor = await findEditor();
    // The stored source is validated as the page opens.
    await waitFor(
      () => {
        expect(listValidatedSources(api)).toEqual([TRIAGE_SOURCE]);
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );

    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    try {
      // The cursor is at the start of the text.
      pasteUnderFakeClock(editor, "# A\n");
      await advanceClock(200);
      pasteUnderFakeClock(editor, "# B\n");
      await advanceClock(200);

      // The last change was 200 ms ago, so the user may still be typing.
      expect(listValidatedSources(api)).toEqual([TRIAGE_SOURCE]);

      await advanceClock(800);

      // The source in between, unchanged for only 200 ms, is never validated.
      expect(listValidatedSources(api)).toEqual([TRIAGE_SOURCE, `# A\n# B\n${TRIAGE_SOURCE}`]);
    } finally {
      vi.useRealTimers();
    }
  });

  it("ignores a validation result for a source that the page no longer shows", async () => {
    const user = userEvent.setup();
    const held = holdAnswer(() => ({ body: { errors: [UNKNOWN_ACTION], warnings: [] } }));
    const { api, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: {
        "POST /api/v1/workflows/validate": (call) =>
          (call.body as { readonly source: string }).source === PROBLEM_SOURCE
            ? held.handler(call)
            : { body: NO_PROBLEMS },
      },
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    await waitFor(
      () => {
        expect(listValidatedSources(api)).toContain(PROBLEM_SOURCE);
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );
    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    const panel = await findProblemsPanel();
    await waitFor(
      () => {
        expect(reading(panel)).toContain("No problems.");
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );
    held.release();
    await waitForIdleRequests(queryClient);

    expect(reading(panel)).toContain("No problems.");
    expect(within(panel).queryAllByRole("button", { name: /\bLine \d+/ })).toEqual([]);
  });

  it("ignores a save rejection for a source that the page no longer shows", async () => {
    const user = userEvent.setup();
    const held = holdAnswer(() => buildRefusal([UNKNOWN_ACTION]));
    const { queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });

    await replaceEditorSource(user, PROBLEM_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    const panel = await findProblemsPanel();
    await waitFor(
      () => {
        expect(reading(panel)).toContain("No problems.");
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );
    held.release();
    await waitForIdleRequests(queryClient);

    expect(reading(panel)).toContain("No problems.");
    expect(within(panel).queryAllByRole("button", { name: /\bLine \d+/ })).toEqual([]);
    expect(readHeaderStatus()).toBeUndefined();
  });

  it("shows the cached result at once for a source that was validated before", async () => {
    const user = userEvent.setup();
    let isAnswering = true;
    const held = holdAnswer(() => ({ body: { errors: [UNKNOWN_ACTION], warnings: [] } }));
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: {
        "POST /api/v1/workflows/validate": (call) => {
          const { source } = call.body as { readonly source: string };
          if (source !== PROBLEM_SOURCE) return { body: NO_PROBLEMS };
          return isAnswering
            ? { body: { errors: [UNKNOWN_ACTION], warnings: [] } }
            : held.handler(call);
        },
      },
    });
    await replaceEditorSource(user, PROBLEM_SOURCE);
    await findProblem(await findProblemsPanel(), UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
    const panel = await findProblemsPanel();
    await waitFor(
      () => {
        expect(reading(panel)).toContain("No problems.");
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );

    // From here on the controller never responds for this source, so the
    // result can only come from the cache.
    isAnswering = false;
    await replaceEditorSource(user, PROBLEM_SOURCE);

    await findProblem(await findProblemsPanel(), UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    held.release();
  });

  // The live connection reconnects when the controller is reachable again,
  // so that is when a failed validation runs again. A successful result is
  // not requested again.
  it("retries a failed validation when the live connection reconnects, but not a successful one", async () => {
    let isReachable = false;
    const held = holdAnswer(() => ({ body: NO_PROBLEMS }));
    const { api, live, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: {
        "POST /api/v1/workflows/validate": (call) =>
          isReachable
            ? held.handler(call)
            : { status: 500, body: envelope("internal", "The controller is restarting.") },
      },
    });
    await findEditor();
    const panel = await findProblemsPanel();
    await waitForWorkflowSubscription(live);
    await waitForIdleRequests(queryClient);
    await waitFor(
      () => {
        expect(reading(panel)).toContain("Not checked: The controller is restarting.");
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );

    isReachable = true;
    act(() => {
      live.drop();
    });

    // The live connection waits about a second before it reconnects.
    await waitFor(
      () => {
        expect(reading(panel)).toContain("Checking…");
      },
      { timeout: 3 * VALIDATION_TIMEOUT_MS },
    );
    expect(reading(panel)).not.toContain("Not checked");
    held.release();
    await waitFor(
      () => {
        expect(reading(panel)).toContain("No problems.");
      },
      { timeout: VALIDATION_TIMEOUT_MS },
    );
    const validationCount = listValidatedSources(api).length;

    act(() => {
      live.drop();
    });
    await waitFor(
      () => {
        expect(live.connected()).toBe(true);
        expect(live.topics()).toContain("workflow");
      },
      { timeout: 3 * VALIDATION_TIMEOUT_MS },
    );
    await waitForIdleRequests(queryClient);

    expect(listValidatedSources(api)).toHaveLength(validationCount);
    expect(reading(panel)).toContain("No problems.");
  });
});

describe(
  "Workflows > a workflow that changes elsewhere",
  { timeout: EDITOR_TEST_TIMEOUT_MS },
  () => {
    const CHANGED_ELSEWHERE_SOURCE = TRIAGE_SOURCE.replace(
      "Filed by a workflow.",
      "Filed by a workflow that another client changed.",
    );

    it("shows the new stored text when the page has no changes", async () => {
      const user = userEvent.setup();
      const { live, changeElsewhere } = await openApp({ path: `/workflows/${TRIAGE.id}` });
      const editor = await findEditor();
      await waitForWorkflowSubscription(live);

      changeElsewhere(TRIAGE.id, CHANGED_ELSEWHERE_SOURCE);
      pushWorkflowChange(live, TRIAGE.id, "updated");

      await waitFor(() => {
        expect(reading(editor)).toContain("another client changed");
      });
      expect(await readEditorSource(user)).toBe(CHANGED_ELSEWHERE_SOURCE);
      expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect(readHeaderStatus()).toBeUndefined();
    });

    it("keeps the user's changes, warns beside Save that saving replaces the other change, and saves them", async () => {
      const user = userEvent.setup();
      const { api, live, changeElsewhere } = await openApp({ path: `/workflows/${TRIAGE.id}` });
      await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
      await waitForWorkflowSubscription(live);

      changeElsewhere(TRIAGE.id, CHANGED_ELSEWHERE_SOURCE);
      pushWorkflowChange(live, TRIAGE.id, "updated");

      await waitFor(() => {
        expect(readHeaderStatus()).toBe("Changed elsewhere. Saving replaces that change.");
      });
      expect(await readEditorSource(user)).toBe(EDITED_TRIAGE_SOURCE);

      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(readHeaderStatus()).toBe("Saved.");
      });
      expect(listWrites(api).map(describeWrite)).toEqual([
        [`PATCH /api/v1/workflows/${TRIAGE.id}`, { source: EDITED_TRIAGE_SOURCE }],
      ]);
    });

    it("shows that the workflow was deleted elsewhere, keeps the text, and creates a new workflow on Save", async () => {
      const user = userEvent.setup();
      const { api, live, router, deleteElsewhere } = await openApp({
        path: `/workflows/${TRIAGE.id}`,
      });
      await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
      await waitForWorkflowSubscription(live);

      deleteElsewhere(TRIAGE.id);
      pushWorkflowChange(live, TRIAGE.id, "deleted");

      await waitFor(() => {
        expect(readHeaderStatus()).toBe(
          "Deleted elsewhere. Saving creates a new workflow, turned off.",
        );
      });
      // There is nothing left to delete.
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      expect(await readEditorSource(user)).toBe(EDITED_TRIAGE_SOURCE);

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
      });
      expect(listWrites(api).map(describeWrite)).toEqual([
        ["POST /api/v1/workflows", { source: EDITED_TRIAGE_SOURCE }],
      ]);
    });

    // The new workflow gets a new id. The deleted workflow's page would offer
    // to create the workflow again, so Back must not return to that page.
    it("replaces the deleted workflow's page in the history, and shows that the new one was created", async () => {
      const user = userEvent.setup();
      const { live, router, queryClient, deleteElsewhere } = await openApp({ path: "/workflows" });
      await user.click(await screen.findByRole("link", { name: TRIAGE_NAME }));
      await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
      await waitForWorkflowSubscription(live);
      deleteElsewhere(TRIAGE.id);
      pushWorkflowChange(live, TRIAGE.id, "deleted");
      await waitFor(() => {
        expect(readHeaderStatus()).toBe(
          "Deleted elsewhere. Saving creates a new workflow, turned off.",
        );
      });

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(readHeaderStatus()).toBe("Created, turned off.");
      });
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
      await waitFor(() => {
        expect(queryClient.getQueryState(queryKeys.workflow(TRIAGE.id))).toBeUndefined();
      });

      act(() => {
        router.history.back();
      });
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/workflows");
      });
    });

    // The source of a workflow deleted elsewhere exists only on this page.
    it("asks before leaving a workflow deleted elsewhere, even without changes", async () => {
      const user = userEvent.setup();
      const { live, router, deleteElsewhere } = await openApp({ path: `/workflows/${TRIAGE.id}` });
      await findEditor();
      await waitForWorkflowSubscription(live);
      deleteElsewhere(TRIAGE.id);
      pushWorkflowChange(live, TRIAGE.id, "deleted");
      await waitFor(() => {
        expect(readHeaderStatus()).toBe(
          "Deleted elsewhere. Saving creates a new workflow, turned off.",
        );
      });

      await user.click(getNavLink("Runs"));

      expect(await screen.findByText(/Leave without saving\?/)).toBeDefined();
      expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
    });

    // The live push that the workflow is gone arrives before the delete
    // request returns.
    it("does not report its own delete as a delete made elsewhere", async () => {
      const user = userEvent.setup();
      const held = holdAnswer(() => ({ body: {} }));
      const { api, live, router, queryClient, deleteElsewhere } = await openApp({
        path: `/workflows/${TRIAGE.id}`,
        overrides: { [`DELETE /api/v1/workflows/${TRIAGE.id}`]: held.handler },
      });
      await findEditor();
      await waitForWorkflowSubscription(live);

      await user.click(screen.getByRole("button", { name: "Delete" }));
      await user.click(screen.getByRole("button", { name: "Confirm" }));
      deleteElsewhere(TRIAGE.id);
      pushWorkflowChange(live, TRIAGE.id, "deleted");
      await waitFor(() => {
        expect(listWorkflowReads(api, TRIAGE.id)).toHaveLength(2);
      });
      await waitFor(() => {
        expect(queryClient.isFetching()).toBe(0);
      });
      expect(readHeaderStatus()).toBeUndefined();

      held.release();
      await waitFor(() => {
        expect(router.state.location.pathname).toBe("/workflows");
      });
    });

    it("shows that the workflow is gone when a save finds it deleted before any live push", async () => {
      const user = userEvent.setup();
      const { deleteElsewhere } = await openApp({ path: `/workflows/${TRIAGE.id}` });
      await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);

      deleteElsewhere(TRIAGE.id);
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(readHeaderStatus()).toBe(
          "Deleted elsewhere. Saving creates a new workflow, turned off.",
        );
      });
      expect(await readEditorSource(user)).toBe(EDITED_TRIAGE_SOURCE);
    });
  },
);

describe("Workflows > a create or a delete", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("keeps the view when it navigates to the new workflow's page", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: "/workflows/new?view=yaml" });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    expect(readViewParam(router)).toBe("yaml");
  });

  // The user can choose another view while the create is in flight.
  it("uses the view in the URL at the time the create returns", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, id: CREATED_ID, source }, warnings: [] } };
    });
    const { router } = await openApp({
      path: "/workflows/new?view=yaml",
      overrides: { "POST /api/v1/workflows": held.handler },
    });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(getViewOption("Graph"));
    await waitFor(() => {
      expect(readViewParam(router)).toBe("graph");
    });
    held.release();

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    expect(readViewParam(router)).toBe("graph");
  });

  it("shows that the workflow was created on its new page, and focuses its text", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: "/workflows/new" });
    await replaceEditorSource(user, CREATED_SOURCE);

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Created, turned off.");
    });
    await waitFor(() => {
      expect(document.activeElement).toBe(screen.getByRole("textbox", { name: "Workflow source" }));
    });

    // The "Created" status stays until the text changes.
    await replaceEditorSource(user, `${CREATED_SOURCE}# One more line.\n`);
    expect(readHeaderStatus()).toBeUndefined();
  });

  // The new workflow's page starts from the stored text, so text typed while
  // the create is in flight would be lost in the navigation.
  it("blocks typing while the create is in flight", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      const created: Workflow = { ...TRIAGE, id: CREATED_ID, source };
      return { body: { workflow: created, warnings: [] } };
    });
    const { router } = await openApp({
      path: "/workflows/new",
      overrides: { "POST /api/v1/workflows": held.handler },
    });
    await replaceEditorSource(user, CREATED_SOURCE);

    await user.click(screen.getByRole("button", { name: "Save" }));
    expect((await findEditor()).closest("[inert]")).not.toBeNull();

    held.release();
    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    await waitFor(() => {
      expect(router.state.status).toBe("idle");
    });
    expect((await findEditor()).closest("[inert]")).toBeNull();
    expect(await readEditorSource(user)).toBe(CREATED_SOURCE);
  });

  it("stays on the page the user moved to when the create returns after the user left", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, id: CREATED_ID, source }, warnings: [] } };
    });
    const { router, queryClient } = await openApp({
      path: "/workflows/new",
      overrides: { "POST /api/v1/workflows": held.handler },
    });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Save" }));
    await user.click(getNavLink("Runs"));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });

    held.release();
    await waitForIdleRequests(queryClient);
    expect(router.state.location.pathname).toBe("/runs");
  });

  it("stays on the page the user moved to when the delete returns after the user left", async () => {
    const user = userEvent.setup();
    const held = holdAnswer(() => ({ body: {} }));
    const { router, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`DELETE /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Delete" }));
    await user.click(screen.getByRole("button", { name: "Confirm" }));
    await user.click(getNavLink("Runs"));
    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });

    held.release();
    await waitForIdleRequests(queryClient);
    expect(router.state.location.pathname).toBe("/runs");
  });

  it("sends one create for two clicks that land before the page re-renders", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({ path: "/workflows/new" });
    await replaceEditorSource(user, CREATED_SOURCE);
    const save = screen.getByRole("button", { name: "Save" });

    act(() => {
      save.click();
      save.click();
    });

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    expect(listWrites(api).map(describeWrite)).toEqual([
      ["POST /api/v1/workflows", { source: CREATED_SOURCE }],
    ]);
  });
});

describe(
  "Workflows > the confirmation questions in the header",
  { timeout: EDITOR_TEST_TIMEOUT_MS },
  () => {
    it("puts the focus on Cancel when it asks to delete, and back on Delete after Cancel", async () => {
      const user = userEvent.setup();
      await openApp({ path: `/workflows/${TRIAGE.id}` });
      await findEditor();

      await user.click(screen.getByRole("button", { name: "Delete" }));

      const cancel = screen.getByRole("button", { name: "Cancel" });
      expect(document.activeElement).toBe(cancel);
      // Cancel comes before Confirm.
      expectInDocumentOrder([cancel, screen.getByRole("button", { name: "Confirm" })]);

      await user.click(cancel);
      expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
    });

    it("puts the focus on Stay when it asks to leave, and back on the clicked link after Stay", async () => {
      const user = userEvent.setup();
      await openApp({ path: `/workflows/${TRIAGE.id}` });
      await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);

      await user.click(getNavLink("Runs"));

      const stay = await screen.findByRole("button", { name: "Stay" });
      expect(document.activeElement).toBe(stay);
      expectInDocumentOrder([stay, screen.getByRole("button", { name: "Leave" })]);

      await user.click(stay);
      expect(document.activeElement).toBe(getNavLink("Runs"));
    });
  },
);

describe(
  "Workflows > one confirmation question at a time",
  { timeout: EDITOR_TEST_TIMEOUT_MS },
  () => {
    it("closes the delete question when the leave question opens, and does not reopen it after Stay", async () => {
      const user = userEvent.setup();
      await openApp({ path: `/workflows/${TRIAGE.id}` });
      await replaceEditorSource(user, EDITED_TRIAGE_SOURCE);
      await user.click(screen.getByRole("button", { name: "Delete" }));
      await screen.findByText(/Delete this workflow\?/);

      await user.click(getNavLink("Runs"));

      const stay = await screen.findByRole("button", { name: "Stay" });
      expect(screen.queryByText(/Delete this workflow\?/)).toBeNull();
      expect(document.activeElement).toBe(stay);

      await user.click(stay);
      expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
      expect(screen.queryByText(/Delete this workflow\?/)).toBeNull();
      expect(document.activeElement).toBe(getNavLink("Runs"));
    });
  },
);

describe("Workflows > a link to a workflow that was deleted", () => {
  it("shows that the workflow was deleted, with a link to the list", async () => {
    await openApp({ path: `/workflows/${TRIAGE.id}`, workflows: [] });

    expect(
      await screen.findByRole("heading", { name: "This workflow was deleted." }),
    ).toBeDefined();
    const back = screen.getByRole("link", { name: "Go to Workflows" });
    expect(back.getAttribute("href")).toBe("/workflows");
    // The page's own header is not rendered, so the shell's top bar shows the title.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workflow");
    expect(screen.queryByText("This screen did not load")).toBeNull();
  });
});

describe("Workflows > an unknown view", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("opens the text and the graph side by side, with Split chosen", async () => {
    await openApp({ path: `/workflows/${TRIAGE.id}?view=sideways` });

    await findEditor();
    expect(await screen.findByRole("region", { name: "Workflow graph" })).toBeDefined();
    expect(getViewOption("Split").getAttribute("aria-checked")).toBe("true");
    for (const option of ["YAML", "Graph"] as const) {
      expect(getViewOption(option).getAttribute("aria-checked")).toBe("false");
    }
  });
});
