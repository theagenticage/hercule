/**
 * Workflows: the list, the page on which a workflow is written, the problems
 * panel under the editor, and the control that chooses what the page shows.
 *
 * The stub controller keeps the workflows that a test gives it, and it changes
 * them on each write as the real controller does. Thus a screen that reads its
 * list again after a write sees the result of the write.
 *
 * The editor draws only the lines near the caret, so the text on the page is
 * not always the full text. Thus a test reads the text as a user copies it:
 * it selects all of the text and copies the selection. A test writes text as a
 * user pastes it: it selects all of the text and pastes over the selection. A
 * paste adds no indentation, so the text that the page sends must be equal to
 * the pasted text, byte for byte.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { QueryClient } from "@tanstack/react-query";
import { ageOf, queryKeys, readWorkflowSource } from "@hercule/client-core";
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
 * How long a test waits for the editor to show. The first page with an editor
 * also loads the libraries of the editor, and under jsdom that load can take
 * some seconds.
 */
const EDITOR_LOAD_TIMEOUT_MS = 5_000;

/** How long a test that opens the editor can run. The first load of the editor is included. */
const EDITOR_TEST_TIMEOUT_MS = 20_000;

/** How long a test waits for the check of the text. The check starts after typing stops. */
const CHECK_TIMEOUT_MS = 3_000;

const MINUTE_MS = 60_000;
const HOUR_MINUTES = 60;
const DAY_MINUTES = 24 * HOUR_MINUTES;
const WEEK_MINUTES = 7 * DAY_MINUTES;

/** The instant `minutes` minutes before now, written as the wire writes an instant. */
const buildTimestampMinutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * MINUTE_MS).toISOString();

/** The number of the line of `text` that is equal to `line`, counted from one. */
const findLineNumber = (text: string, line: string): number => {
  const index = text.split("\n").indexOf(line);
  if (index === -1) throw new Error(`no line of the text is ${JSON.stringify(line)}`);
  return index + 1;
};

/* ------------------------------------------------------------------------ */
/* The workflows the stub controller holds.                                  */
/* ------------------------------------------------------------------------ */

const TRIAGE_NAME = "Triage labelled PRs";
const TRIAGE_DESCRIPTION = "Files a task when a pull request is labelled.";

/**
 * A text that a reformat changes: comments, blank lines, trailing spaces, a
 * `|` block, and keys in an order that is not the order of the definition.
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

/** The same workflow after an edit that the user did not save yet. */
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

/** What a user writes on the page for a new workflow. */
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
 * A text that parses, with two problems that only the controller can find:
 * an event kind and an action that do not exist.
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
  message: "github.pr.labelled is not an event kind that a trigger can name.",
};

const UNKNOWN_ACTION: Issue = {
  path: ["steps", "1", "action"],
  message: "task.creat is not an action. The actions are task.create, task.update and task.query.",
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
 * The order in which the stub controller lists the workflows. It is not the
 * order of the names and not the order of the ages. Thus a screen that sorts
 * the list again shows a different order.
 */
const LISTED_WORKFLOWS: readonly Workflow[] = [TRIAGE, NIGHTLY, WEEKLY];

/** The id that the stub controller gives to the workflow that a test creates. */
const CREATED_ID = "0199c0ff-1111-7000-8000-0000000000aa";

/** The actions that a step can name, as `workflowAction.query` answers them. */
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

/** The event kinds that a trigger can name, as `eventKind.query` answers them. */
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

/** A check of the text that finds `issues` in `source`, and nothing in a different text. */
const buildCheck =
  (source: string, issues: WorkflowIssues) =>
  (checked: string): WorkflowIssues =>
    checked === source ? issues : NO_PROBLEMS;

/** A save refused with `issues`, in the envelope the API sends. */
const buildRefusal = (issues: readonly Issue[]) => ({
  status: 400,
  body: {
    error: { code: "validation", message: "The workflow is not valid.", details: { issues } },
  },
});

const WORKFLOW_NOT_FOUND = { status: 404, body: envelope("not_found", "No workflow has that id.") };

/** The value that the top-level `key` of a source has, where the source writes one. */
const readTopLevelValue = (source: string, key: string): string | undefined =>
  new RegExp(`^${key}: (.+)$`, "m").exec(source)?.[1];

/**
 * A stored workflow as one `workflow.query` item. The controller reads the
 * name and the description from the definition. Each source in this file
 * writes both at the start of a line with no indentation, so the stub reads
 * them from the text.
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
 * A controller past setup that holds `workflows`, and lists them in the order
 * given. Each write changes what the controller holds. `check` answers
 * `workflow.validate`. `overrides` replaces the answer of a route, or adds a
 * route. `changeElsewhere` and `deleteElsewhere` change what the controller
 * holds as another client does.
 */
const buildController = ({
  workflows,
  check,
  overrides,
}: {
  readonly workflows: readonly Workflow[];
  readonly check: (source: string) => WorkflowIssues;
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
        // A workflow's time is when its text last changed, so turning it on
        // or off does not move it.
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
      body: check((call.body as { readonly source: string }).source),
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
  check = () => NO_PROBLEMS,
  overrides = {},
}: {
  readonly path: string;
  readonly workflows?: readonly Workflow[];
  readonly check?: (source: string) => WorkflowIssues;
  readonly overrides?: Readonly<Record<string, Handler>>;
}) => {
  const { routes, changeElsewhere, deleteElsewhere } = buildController({
    workflows,
    check,
    overrides,
  });
  const api = stubApi(routes);
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return { ...app, api, changeElsewhere, deleteElsewhere };
};

/**
 * The writes that the screen made, in order. The live connection asks for a
 * ticket on every screen, and the editor checks its text without storing it,
 * so neither of the two is a write.
 */
const listWrites = (api: { readonly calls: readonly Call[] }): readonly Call[] =>
  api.calls.filter(
    (call) =>
      call.method !== "GET" &&
      !call.path.endsWith("/auth/ws-ticket") &&
      call.path !== "/api/v1/workflows/validate",
  );

/** One write as its route and its body. */
const describeWrite = (call: Call): readonly [string, unknown] => [
  `${call.method} ${call.path}`,
  call.body,
];

/**
 * Waits until the app has no read and no write in flight. A save is a
 * mutation of the query client of the app, so when all mutations are done, the
 * page knows the result of the save.
 */
const waitForIdleRequests = (queryClient: QueryClient): Promise<void> =>
  waitFor(() => {
    expect(queryClient.isMutating()).toBe(0);
    expect(queryClient.isFetching()).toBe(0);
  });

/* ------------------------------------------------------------------------ */
/* The page, as a user reads it and works on it.                             */
/* ------------------------------------------------------------------------ */

/** The requests that read the stored workflow with `id`. */
const listWorkflowReads = (api: { readonly calls: readonly Call[] }, id: string): readonly Call[] =>
  api.calls.filter((call) => call.method === "GET" && call.path === `/api/v1/workflows/${id}`);

/** The editor, when it shows. */
const findEditor = (): Promise<HTMLElement> =>
  screen.findByRole("textbox", { name: "Workflow source" }, { timeout: EDITOR_LOAD_TIMEOUT_MS });

/** Replaces all of the text of the editor with `text`: select all, then paste. */
const replaceEditorText = async (user: User, text: string): Promise<void> => {
  await user.click(await findEditor());
  await user.keyboard("{Control>}a{/Control}");
  await user.paste(text);
};

/** All of the text of the editor: select all, then copy. */
const readEditorText = async (user: User): Promise<string | undefined> => {
  await user.click(await findEditor());
  await user.keyboard("{Control>}a{/Control}");
  const copied = await user.copy();
  return copied?.getData("text/plain");
};

/**
 * The text of the line that holds the caret. The editor draws each line of
 * the text as one element in the text box, so the line with the caret is the
 * element around the anchor of the selection.
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

/** The entry of the problems panel for the problem at `line` that says `message`. */
const findProblem = (panel: HTMLElement, line: number, message: string): Promise<HTMLElement> =>
  within(panel).findByRole(
    "button",
    {
      name: (name) => new RegExp(`\\bLine ${String(line)}\\b`).test(name) && name.includes(message),
    },
    { timeout: CHECK_TIMEOUT_MS },
  );

/** A link of the sidebar, which is how a user goes to another screen. */
const getNavLink = (name: string): HTMLElement =>
  within(screen.getByRole("navigation", { name: "Hercule" })).getByRole("link", { name });

/**
 * One option of the view control. The control is the segmented control of the
 * app, and each option of a segmented control is a radio button.
 */
const getViewOption = (name: "YAML" | "Graph" | "Split"): HTMLElement =>
  screen.getByRole("radio", { name });

/** The `view` search parameter of the current address, or `null` when it has none. */
const readViewParam = (router: AppRouter): string | null =>
  new URLSearchParams(router.state.location.searchStr).get("view");

/** The list of workflows: the one list on the screen. */
const getWorkflowList = (): HTMLElement => within(screen.getByRole("main")).getByRole("list");

/** The list item of the workflow whose link is named `name`. */
const getWorkflowRow = (name: string): HTMLElement => {
  const row = within(getWorkflowList())
    .getAllByRole("listitem")
    .find((item) => within(item).queryByRole("link", { name }) !== null);
  if (row === undefined) throw new Error(`no row of the list links to ${name}`);
  return row;
};

const getEnabledSwitch = (name: string): HTMLElement =>
  within(getWorkflowRow(name)).getByRole("switch", { name: "Enabled" });

/** The header of a workflow's page, which holds its title. */
const getPageHeader = (): HTMLElement => {
  const header = screen.getByRole("heading", { level: 1 }).closest("header");
  if (header === null) throw new Error("the page's title is not in a header");
  return header;
};

/** What the page's header says beside Save, or `undefined` when it says nothing. */
const readHeaderStatus = (): string | undefined => {
  const header = getPageHeader();
  const statusLine = within(header).queryByRole("alert") ?? within(header).queryByRole("status");
  return statusLine?.textContent ?? undefined;
};

/**
 * A handler that answers only once the test releases it, so that a test can
 * look at the page while a request is in flight.
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

/** A push that says that the workflow with `id` changed elsewhere. */
const pushWorkflowChange = (
  live: Awaited<ReturnType<typeof openApp>>["live"],
  id: string,
  kind: "updated" | "deleted",
): void => {
  act(() => {
    live.push("workflow", { _tag: "invalidate", ids: [id], kind });
  });
};

/** Waits until the page follows the changes of its workflow that are made elsewhere. */
const waitForLiveWorkflow = (live: Awaited<ReturnType<typeof openApp>>["live"]) =>
  waitFor(() => {
    expect(live.topics()).toContain("workflow");
  });

afterEach(() => {
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------------ */
/* The tests.                                                                */
/* ------------------------------------------------------------------------ */

describe("Workflows > the list", () => {
  it("lists each workflow in the order the controller answers, with its name, description, switch and age", async () => {
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
      // The age is read with the same function as every other age in the app.
      // Its smallest unit is a minute, so this read and the read of the row
      // agree unless the two fall on each side of a minute boundary.
      expect(reading(row)).toContain(ageOf(workflow.updatedAt, new Date()));
    }
  });

  it("turns a workflow on and off with its switch, and sends only enabled", async () => {
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

  it("opens a workflow from its name", { timeout: EDITOR_TEST_TIMEOUT_MS }, async () => {
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

  it("keeps the empty state when there are no workflows, and offers New workflow in it", async () => {
    await openApp({ path: "/workflows", workflows: [] });

    expect(await screen.findByRole("heading", { name: "No workflows yet." })).toBeDefined();
    const offers = await screen.findAllByRole("link", { name: "New workflow" });
    for (const offer of offers) expect(offer.getAttribute("href")).toBe("/workflows/new");
    expect(within(screen.getByRole("main")).queryAllByRole("listitem")).toEqual([]);
  });
});

describe("Workflows > a new workflow", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("opens the editor on a starter whose first line is a comment and which parses to a definition", async () => {
    const user = userEvent.setup();
    await openApp({ path: "/workflows/new" });

    const starter = (await readEditorText(user)) ?? "";

    expect(starter.split("\n")[0]).toMatch(/^\s*#/);
    expect(readWorkflowSource(starter).definition).toBeDefined();
  });

  it("creates the workflow from the text as typed, then opens it", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({ path: "/workflows/new" });

    await replaceEditorText(user, CREATED_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    expect(listWrites(api).map(describeWrite)).toEqual([
      ["POST /api/v1/workflows", { source: CREATED_SOURCE }],
    ]);
    // The page of the new workflow replaces the page of the draft only when
    // the navigation is complete.
    await waitFor(() => {
      expect(router.state.status).toBe("idle");
    });
    expect(await readEditorText(user)).toBe(CREATED_SOURCE);
  });

  // The check of the text finds only a warning. The save is refused all the
  // same, as when something changed on the controller between the check and
  // the save, for example an Agent that was deleted. The test waits for the
  // warning before it saves, so the answer of the check cannot arrive after
  // the refusal and replace the issues of the refusal.
  it("keeps the text as typed and lists the issues when the create is refused", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({
      path: "/workflows/new",
      check: buildCheck(PROBLEM_SOURCE, { errors: [], warnings: [NO_TERMINAL_STEP] }),
      overrides: { "POST /api/v1/workflows": buildRefusal([UNKNOWN_ACTION]) },
    });

    await replaceEditorText(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    await findProblem(panel, SECOND_STEP_LINE, NO_TERMINAL_STEP.message);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await findProblem(await findProblemsPanel(), UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    expect(router.state.location.pathname).toBe("/workflows/new");
    expect(await readEditorText(user)).toBe(PROBLEM_SOURCE);
  });
});

describe("Workflows > a stored workflow", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("opens the editor on the source exactly as it is stored", async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });

    expect(await readEditorText(user)).toBe(TRIAGE_SOURCE);
  });

  it("saves the text as typed with workflow.update, and sends only the source", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(listWrites(api).map(describeWrite)).toEqual([
        [`PATCH /api/v1/workflows/${TRIAGE.id}`, { source: EDITED_TRIAGE_SOURCE }],
      ]);
    });
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
  });

  // As for a create: the check finds only a warning, and the test waits for
  // it, so only the refusal can list the error.
  it("keeps the text as typed and lists the issues when the update is refused", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      check: buildCheck(PROBLEM_SOURCE, { errors: [], warnings: [NO_TERMINAL_STEP] }),
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: buildRefusal([UNKNOWN_ACTION]) },
    });

    await replaceEditorText(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    await findProblem(panel, SECOND_STEP_LINE, NO_TERMINAL_STEP.message);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await findProblem(await findProblemsPanel(), UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    expect(listWrites(api).map(describeWrite)).toEqual([
      [`PATCH /api/v1/workflows/${TRIAGE.id}`, { source: PROBLEM_SOURCE }],
    ]);
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
    expect(await readEditorText(user)).toBe(PROBLEM_SOURCE);
  });

  it("asks in place before it deletes, then deletes the workflow and returns to the list", async () => {
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
    // The list is read again, and the deleted workflow is not in it.
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
  it("asks in place before it leaves, and Stay keeps the page and the text", async () => {
    const user = userEvent.setup();
    const browserDialog = vi.spyOn(window, "confirm").mockReturnValue(true);
    const { router } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
    await user.click(getNavLink("Runs"));

    expect(await screen.findByText(/Leave without saving\?/)).toBeDefined();
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);

    await user.click(screen.getByRole("button", { name: "Stay" }));

    await waitFor(() => {
      expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
    });
    expect(router.state.location.pathname).toBe(`/workflows/${TRIAGE.id}`);
    expect(await readEditorText(user)).toBe(EDITED_TRIAGE_SOURCE);
    expect(browserDialog).not.toHaveBeenCalled();
  });

  it("leaves when Leave is chosen", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
    await user.click(getNavLink("Runs"));
    await screen.findByText(/Leave without saving\?/);
    await user.click(screen.getByRole("button", { name: "Leave" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });
  });

  it("asks nothing when nothing was changed", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    await user.click(getNavLink("Runs"));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe("/runs");
    });
    expect(screen.queryByText(/Leave without saving\?/)).toBeNull();
  });

  it("asks nothing while a save of the text on the page is in flight", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, source }, warnings: [] } };
    });
    const { api, router, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);

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

  // The link is pressed before the page renders the save, so the question
  // can show. Once the page knows that the text is being saved, the held
  // navigation goes on.
  it("goes on with a navigation that it held once a save of the text is in flight", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, source }, warnings: [] } };
    });
    const { router, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
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

  it("asks nothing once the changes are saved", async () => {
    const user = userEvent.setup();
    const { api, router, queryClient } = await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
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
      check: buildCheck(PROBLEM_SOURCE, PROBLEM_SOURCE_ISSUES),
    });

    await replaceEditorText(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    const unknownKind = await findProblem(panel, UNKNOWN_KIND_LINE, UNKNOWN_KIND.message);
    const unknownAction = await findProblem(panel, UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);
    const noTerminalStep = await findProblem(panel, SECOND_STEP_LINE, NO_TERMINAL_STEP.message);

    // The warning is on a line above the second error, so an order by line
    // puts the warning between the two errors.
    expect(SECOND_STEP_LINE).toBeLessThan(UNKNOWN_ACTION_LINE);
    expectInDocumentOrder([unknownKind, unknownAction, noTerminalStep]);
    expect(reading(panel)).toContain("3 problems");
  });

  it("counts one problem in the singular", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      check: buildCheck(PROBLEM_SOURCE, { errors: [UNKNOWN_ACTION], warnings: [] }),
    });

    await replaceEditorText(user, PROBLEM_SOURCE);
    const panel = await findProblemsPanel();
    await findProblem(panel, UNKNOWN_ACTION_LINE, UNKNOWN_ACTION.message);

    expect(reading(panel)).toMatch(/\b1 problem\b/);
  });

  it("says in one line that there are no problems when there are none", async () => {
    await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    const panel = await findProblemsPanel();

    // Until the controller answers the check of the text, the panel can show a
    // note that the check runs. "No problems." is true only after the answer.
    await waitFor(
      () => {
        expect(reading(panel)).toContain("No problems.");
      },
      { timeout: CHECK_TIMEOUT_MS },
    );
    expect(reading(panel)).not.toMatch(/\d+ problems?/);
    expect(within(panel).queryAllByRole("button", { name: /\bLine \d+/ })).toEqual([]);
  });

  it("moves the cursor to the line of the problem that is clicked", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      check: buildCheck(PROBLEM_SOURCE, PROBLEM_SOURCE_ISSUES),
    });

    await replaceEditorText(user, PROBLEM_SOURCE);
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
      check: buildCheck(PROBLEM_SOURCE, PROBLEM_SOURCE_ISSUES),
    });

    await replaceEditorText(user, PROBLEM_SOURCE);
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
  it("shows the text and the graph side by side when the address names no view", async () => {
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
    "shows what view=$view chooses when the address is opened, and the problems panel",
    async ({ view, option, showsText, showsGraph }) => {
      await openApp({ path: `/workflows/${TRIAGE.id}?view=${view}` });

      // What the view shows is found first, so the page is complete before
      // the test looks for what the view does not show.
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

  it("puts the chosen view in the address, and a reload keeps it", async () => {
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

    // A reload opens the same address again in a new page.
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
  it("shows the new state while the write is in flight, and takes no second press until it lands", async () => {
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
    // It ignores presses while the write is in flight, and keeps the focus.
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

  it("says under the row why a write was refused, and shows the state that is stored", async () => {
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

describe("Workflows > what the page says", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  // Save is `aria-disabled` rather than `disabled`, so that it keeps the
  // focus after a save lands.
  it("keeps Save off while the text is the stored text", async () => {
    const user = userEvent.setup();
    const { api } = await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();
    const save = screen.getByRole("button", { name: "Save" });
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.click(save);

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
    expect(save.getAttribute("aria-disabled")).toBe("false");

    await replaceEditorText(user, TRIAGE_SOURCE);
    expect(save.getAttribute("aria-disabled")).toBe("true");
    await user.click(save);
    expect(listWrites(api)).toEqual([]);
  });

  it("keeps the focus on Save while the save is in flight and after it lands", async () => {
    const user = userEvent.setup();
    const held = holdAnswer((call) => {
      const { source } = call.body as { readonly source: string };
      return { body: { workflow: { ...TRIAGE, source }, warnings: [] } };
    });
    const { api, queryClient } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: held.handler },
    });
    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
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

  it("says Saved. once the text is saved, and nothing once the text changes again", async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
    expect(readHeaderStatus()).toBeUndefined();
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Saved.");
    });

    await replaceEditorText(user, TRIAGE_SOURCE);
    expect(readHeaderStatus()).toBeUndefined();
  });

  it("says why a save failed when the controller did not take it, and keeps the text", async () => {
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

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Not saved: The disk is full.");
    });
    expect(await readEditorText(user)).toBe(EDITED_TRIAGE_SOURCE);
  });

  it("says that a refused text has problems, until the text changes", async () => {
    const user = userEvent.setup();
    await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: { [`PATCH /api/v1/workflows/${TRIAGE.id}`]: buildRefusal([UNKNOWN_ACTION]) },
    });

    await replaceEditorText(user, PROBLEM_SOURCE);
    await user.click(screen.getByRole("button", { name: "Save" }));
    await waitFor(() => {
      expect(readHeaderStatus()).toBe("Not saved: the text has problems.");
    });

    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
    expect(readHeaderStatus()).toBeUndefined();
  });

  it("says why a delete failed, and stays on the page", async () => {
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

  it("names the page after the name in the text, and keeps it while the text does not parse", async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();
    const readTitle = () => screen.getByRole("heading", { level: 1 }).textContent;
    expect(readTitle()).toBe(TRIAGE_NAME);
    // The way back to the list is a link out of the page, not the page itself.
    const back = within(getPageHeader()).getByRole("link", { name: "Workflows" });
    expect(back.getAttribute("href")).toBe("/workflows");
    expect(back.getAttribute("aria-current")).toBeNull();

    await replaceEditorText(user, NIGHTLY_SOURCE);
    expect(readTitle()).toBe(NIGHTLY_NAME);

    await replaceEditorText(user, `${NIGHTLY_SOURCE}steps: [`);
    expect(readTitle()).toBe(NIGHTLY_NAME);
  });

  it("names a new workflow after the starter's name, and a stored text that never parsed Workflow", async () => {
    const { unmount } = await openApp({ path: "/workflows/new" });
    await findEditor();
    const starterName = screen.getByRole("heading", { level: 1 }).textContent;
    expect(starterName).not.toBe("");
    // The starter's name is the author's to change, so it is not the name of a control.
    expect(starterName).not.toBe("New workflow");
    unmount();

    // A text stored before the contract refused something in it.
    const unreadable: Workflow = { ...TRIAGE, source: "name: [Triage\n" };
    await openApp({ path: `/workflows/${TRIAGE.id}`, workflows: [unreadable] });
    await findEditor();
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workflow");
  });

  it("says Checking… until the check answers, and why a check could not run", async () => {
    const held = holdAnswer(() => ({
      status: 500,
      body: envelope("internal", "The check timed out."),
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
        expect(reading(panel)).toContain("Not checked: The check timed out.");
      },
      { timeout: CHECK_TIMEOUT_MS },
    );
    expect(reading(panel)).not.toContain("Checking…");
    expect(reading(panel)).not.toContain("No problems.");
  });

  // The live connection comes back when the controller can be reached again,
  // so that is when a check that could not reach it runs again.
  it("checks the text again when the live connection comes back", async () => {
    let isReachable = false;
    const { live } = await openApp({
      path: `/workflows/${TRIAGE.id}`,
      overrides: {
        "POST /api/v1/workflows/validate": () =>
          isReachable
            ? { body: NO_PROBLEMS }
            : { status: 500, body: envelope("internal", "The controller is restarting.") },
      },
    });
    await findEditor();
    const panel = await findProblemsPanel();
    await waitFor(
      () => {
        expect(reading(panel)).toContain("Not checked: The controller is restarting.");
      },
      { timeout: CHECK_TIMEOUT_MS },
    );
    await waitFor(() => {
      expect(live.connected()).toBe(true);
    });

    isReachable = true;
    act(() => {
      live.drop();
    });

    // The live connection waits about a second before it connects again.
    await waitFor(
      () => {
        expect(reading(panel)).toContain("No problems.");
      },
      { timeout: 3 * CHECK_TIMEOUT_MS },
    );
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
      await waitForLiveWorkflow(live);

      changeElsewhere(TRIAGE.id, CHANGED_ELSEWHERE_SOURCE);
      pushWorkflowChange(live, TRIAGE.id, "updated");

      await waitFor(() => {
        expect(reading(editor)).toContain("another client changed");
      });
      expect(await readEditorText(user)).toBe(CHANGED_ELSEWHERE_SOURCE);
      expect(screen.getByRole("button", { name: "Save" }).getAttribute("aria-disabled")).toBe(
        "true",
      );
      expect(readHeaderStatus()).toBeUndefined();
    });

    it("keeps the author's changes, says beside Save that a save replaces the other change, and saves them", async () => {
      const user = userEvent.setup();
      const { api, live, changeElsewhere } = await openApp({ path: `/workflows/${TRIAGE.id}` });
      await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
      await waitForLiveWorkflow(live);

      changeElsewhere(TRIAGE.id, CHANGED_ELSEWHERE_SOURCE);
      pushWorkflowChange(live, TRIAGE.id, "updated");

      await waitFor(() => {
        expect(readHeaderStatus()).toBe("Changed elsewhere. Saving replaces that change.");
      });
      expect(await readEditorText(user)).toBe(EDITED_TRIAGE_SOURCE);

      await user.click(screen.getByRole("button", { name: "Save" }));
      await waitFor(() => {
        expect(readHeaderStatus()).toBe("Saved.");
      });
      expect(listWrites(api).map(describeWrite)).toEqual([
        [`PATCH /api/v1/workflows/${TRIAGE.id}`, { source: EDITED_TRIAGE_SOURCE }],
      ]);
    });

    it("says that a workflow deleted elsewhere is gone, keeps the text, and creates a new workflow on Save", async () => {
      const user = userEvent.setup();
      const { api, live, router, deleteElsewhere } = await openApp({
        path: `/workflows/${TRIAGE.id}`,
      });
      await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
      await waitForLiveWorkflow(live);

      deleteElsewhere(TRIAGE.id);
      pushWorkflowChange(live, TRIAGE.id, "deleted");

      await waitFor(() => {
        expect(readHeaderStatus()).toBe(
          "Deleted elsewhere. Saving creates a new workflow, turned off.",
        );
      });
      // There is nothing left to delete.
      expect(screen.queryByRole("button", { name: "Delete" })).toBeNull();
      expect(await readEditorText(user)).toBe(EDITED_TRIAGE_SOURCE);

      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
      });
      expect(listWrites(api).map(describeWrite)).toEqual([
        ["POST /api/v1/workflows", { source: EDITED_TRIAGE_SOURCE }],
      ]);
    });

    // The new workflow has a new id. The page of the deleted one offers to
    // create it, so Back must not lead to that page again.
    it("puts the new workflow's page in the place of the deleted one's, and says that it was created", async () => {
      const user = userEvent.setup();
      const { live, router, queryClient, deleteElsewhere } = await openApp({ path: "/workflows" });
      await user.click(await screen.findByRole("link", { name: TRIAGE_NAME }));
      await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
      await waitForLiveWorkflow(live);
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

    // The text of a workflow deleted elsewhere is on this page only.
    it("asks before it leaves a workflow deleted elsewhere, also with no changes", async () => {
      const user = userEvent.setup();
      const { live, router, deleteElsewhere } = await openApp({ path: `/workflows/${TRIAGE.id}` });
      await findEditor();
      await waitForLiveWorkflow(live);
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

    // The controller says on the live connection that the workflow is gone
    // before the delete itself answers.
    it("never says that its own delete happened elsewhere", async () => {
      const user = userEvent.setup();
      const held = holdAnswer(() => ({ body: {} }));
      const { api, live, router, queryClient, deleteElsewhere } = await openApp({
        path: `/workflows/${TRIAGE.id}`,
        overrides: { [`DELETE /api/v1/workflows/${TRIAGE.id}`]: held.handler },
      });
      await findEditor();
      await waitForLiveWorkflow(live);

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

    it("says that the workflow is gone when a save finds it deleted before the page heard of it", async () => {
      const user = userEvent.setup();
      const { deleteElsewhere } = await openApp({ path: `/workflows/${TRIAGE.id}` });
      await replaceEditorText(user, EDITED_TRIAGE_SOURCE);

      deleteElsewhere(TRIAGE.id);
      await user.click(screen.getByRole("button", { name: "Save" }));

      await waitFor(() => {
        expect(readHeaderStatus()).toBe(
          "Deleted elsewhere. Saving creates a new workflow, turned off.",
        );
      });
      expect(await readEditorText(user)).toBe(EDITED_TRIAGE_SOURCE);
    });
  },
);

describe("Workflows > a create or a delete", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("keeps the view when it moves to the new workflow's page", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: "/workflows/new?view=yaml" });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Save" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/workflows/${CREATED_ID}`);
    });
    expect(readViewParam(router)).toBe("yaml");
  });

  // The author can choose another view while the create is in flight.
  it("moves to the view that the address holds when the create answers", async () => {
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

  it("says on the new workflow's page that it was created, and puts the focus in its text", async () => {
    const user = userEvent.setup();
    const { router } = await openApp({ path: "/workflows/new" });
    await replaceEditorText(user, CREATED_SOURCE);

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

    // What the create did is said until the text changes.
    await replaceEditorText(user, `${CREATED_SOURCE}# One more line.\n`);
    expect(readHeaderStatus()).toBeUndefined();
  });

  // The new workflow's page starts from the stored text, so text typed while
  // the create is in flight would be lost in the move.
  it("takes no text while the create is in flight", async () => {
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
    await replaceEditorText(user, CREATED_SOURCE);

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
    expect(await readEditorText(user)).toBe(CREATED_SOURCE);
  });

  it("stays where the author went when the author leaves before the create answers", async () => {
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

  it("stays where the author went when the author leaves before a delete answers", async () => {
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

  it("sends one create for two clicks that come before the page shows the save", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp({ path: "/workflows/new" });
    await replaceEditorText(user, CREATED_SOURCE);
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

describe("Workflows > the questions in the header", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
  it("puts the focus on Cancel when it asks to delete, and back on Delete after Cancel", async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });
    await findEditor();

    await user.click(screen.getByRole("button", { name: "Delete" }));

    const cancel = screen.getByRole("button", { name: "Cancel" });
    expect(document.activeElement).toBe(cancel);
    // The answer that declines comes first, and the answer that accepts comes last.
    expectInDocumentOrder([cancel, screen.getByRole("button", { name: "Confirm" })]);

    await user.click(cancel);
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Delete" }));
  });

  it("puts the focus on Stay when it asks to leave, and back on the link that asked after Stay", async () => {
    const user = userEvent.setup();
    await openApp({ path: `/workflows/${TRIAGE.id}` });
    await replaceEditorText(user, EDITED_TRIAGE_SOURCE);

    await user.click(getNavLink("Runs"));

    const stay = await screen.findByRole("button", { name: "Stay" });
    expect(document.activeElement).toBe(stay);
    expectInDocumentOrder([stay, screen.getByRole("button", { name: "Leave" })]);

    await user.click(stay);
    expect(document.activeElement).toBe(getNavLink("Runs"));
  });
});

describe(
  "Workflows > the questions in the header, one at a time",
  { timeout: EDITOR_TEST_TIMEOUT_MS },
  () => {
    it("closes the question to delete when it asks to leave, and does not bring it back after Stay", async () => {
      const user = userEvent.setup();
      await openApp({ path: `/workflows/${TRIAGE.id}` });
      await replaceEditorText(user, EDITED_TRIAGE_SOURCE);
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
  it("says that the workflow was deleted, and leads to the list", async () => {
    await openApp({ path: `/workflows/${TRIAGE.id}`, workflows: [] });

    expect(
      await screen.findByRole("heading", { name: "This workflow was deleted." }),
    ).toBeDefined();
    const back = screen.getByRole("link", { name: "Go to Workflows" });
    expect(back.getAttribute("href")).toBe("/workflows");
    // The shell's bar names the screen, because the page's own header is not there.
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Workflow");
    expect(screen.queryByText("This screen did not load")).toBeNull();
  });
});

describe("Workflows > a view that does not exist", { timeout: EDITOR_TEST_TIMEOUT_MS }, () => {
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
