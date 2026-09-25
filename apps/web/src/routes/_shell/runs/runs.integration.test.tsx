/**
 * Tests for the Runs screen at `/runs`: the list of runs, its filters, paging
 * and live updates, and the run form that its **Run workflow** button opens.
 *
 * The stub controller serves `run.query` from the runs a test gives it, and
 * applies the filters and the cursor the screen sends, like the real
 * controller. So a test can check both what the screen requested and what it
 * shows.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describeActor, formatAge, toIdTail } from "@hercule/client-core";
import type { Connection, Run, RunSummary, Workflow, WorkflowSummary } from "@hercule/contract";
import {
  expectInDocumentOrder,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

type LiveStub = Awaited<ReturnType<typeof renderApp>>["live"];

const MINUTE_MS = 60_000;

/** Returns the ISO timestamp of `minutes` minutes ago. */
const buildTimestampMinutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * MINUTE_MS).toISOString();

/* ------------------------------------------------------------------------ */
/* The workflows and Connections the stub controller holds.                  */
/* ------------------------------------------------------------------------ */

const RELEASE_NAME = "Plan a release";
const RELEASE_ID = "0199c0ff-1111-7000-8000-000000000001";

/**
 * A workflow that declares one input of every kind the run form draws:
 * text, number, checkbox, select for an enum, Connection select and JSON text.
 * The inputs are declared in this order, so the form shows them in this order.
 */
const RELEASE_SOURCE = `name: ${RELEASE_NAME}
inputs:
  - name: title
    schema:
      type: string
    required: true
  - name: count
    schema:
      type: integer
    required: false
    default: 3
  - name: urgent
    schema:
      type: boolean
    required: false
    default: true
  - name: priority
    schema:
      type: string
      enum: [low, normal, high]
    required: false
    default: normal
  - name: account
    connection:
      type: github/github
    required: true
  - name: extra
    schema:
      type: object
    required: false
    default:
      labels: [release]
steps:
  - id: create
    kind: action
    action: task.create
    params:
      title: "{{ inputs.title }}"
`;

const NIGHTLY_NAME = "Nightly sweep";
const NIGHTLY_ID = "0199c0ff-1111-7000-8000-000000000002";

/** A workflow with no inputs. */
const NIGHTLY_SOURCE = `name: ${NIGHTLY_NAME}
steps:
  - id: sweep
    kind: action
    action: task.query
`;

const RELEASE: Workflow = {
  id: RELEASE_ID,
  enabled: false,
  source: RELEASE_SOURCE,
  createdAt: buildTimestampMinutesAgo(600),
  updatedAt: buildTimestampMinutesAgo(500),
};

const NIGHTLY: Workflow = {
  id: NIGHTLY_ID,
  enabled: true,
  source: NIGHTLY_SOURCE,
  createdAt: buildTimestampMinutesAgo(900),
  updatedAt: buildTimestampMinutesAgo(800),
};

const WORKFLOW_SUMMARIES: readonly WorkflowSummary[] = [
  { id: RELEASE.id, name: RELEASE_NAME, enabled: RELEASE.enabled, updatedAt: RELEASE.updatedAt },
  { id: NIGHTLY.id, name: NIGHTLY_NAME, enabled: NIGHTLY.enabled, updatedAt: NIGHTLY.updatedAt },
];

/** A GitHub Connection the `account` input can use. */
const GITHUB_WORK: Connection = {
  id: "0199c0ff-aaaa-7000-8000-000000000001",
  type: "github/github",
  label: "work",
  displayName: "rogier-work",
  status: "connected",
  labels: ["Code"],
  config: {},
  credentials: [{ name: "token" }],
  createdAt: "2026-09-01T08:15:00.000Z",
  updatedAt: "2026-09-01T08:15:00.000Z",
};

/** A GitHub Connection that is turned off: shown in the select, but not selectable. */
const GITHUB_OLD: Connection = {
  ...GITHUB_WORK,
  id: "0199c0ff-aaaa-7000-8000-000000000002",
  label: "archived",
  displayName: "rogier-archived",
  status: "disabled",
};

/** A Connection of another type, which the `account` input cannot use. */
const MAIL: Connection = {
  ...GITHUB_WORK,
  id: "0199c0ff-aaaa-7000-8000-000000000003",
  type: "skyline/mail",
  label: "personal",
  displayName: "rogier@skyline.test",
};

const CONNECTIONS: readonly Connection[] = [GITHUB_WORK, GITHUB_OLD, MAIL];

/* ------------------------------------------------------------------------ */
/* The runs the stub controller holds.                                       */
/* ------------------------------------------------------------------------ */

const SESSION_ID = "0199c0ff-5555-7000-8000-00000000abcd";

/** A run that is still going, started by the user. The newest run. */
const RUNNING: RunSummary = {
  id: "0199c0ff-2222-7000-8000-000000000001",
  workflowId: RELEASE_ID,
  workflowName: RELEASE_NAME,
  origin: { kind: "manual", actor: "user" },
  status: "running",
  createdAt: buildTimestampMinutesAgo(2),
  startedAt: buildTimestampMinutesAgo(2),
};

/** A run that failed at a step, started by an agent's session. */
const FAILED: RunSummary = {
  id: "0199c0ff-2222-7000-8000-000000000002",
  workflowId: NIGHTLY_ID,
  workflowName: NIGHTLY_NAME,
  origin: { kind: "api", actor: `session:${SESSION_ID}` },
  status: "failed",
  failureReason: "step-failed",
  failedStepId: "sweep",
  createdAt: buildTimestampMinutesAgo(3 * 60),
  startedAt: buildTimestampMinutesAgo(3 * 60),
  finishedAt: buildTimestampMinutesAgo(3 * 60),
};

/**
 * A completed run of a workflow that was since deleted. Its row keeps the
 * name the workflow had when it ran, which the controller reads from the plan.
 */
const OF_DELETED: RunSummary = {
  id: "0199c0ff-2222-7000-8000-000000000003",
  workflowId: "0199c0ff-1111-7000-8000-0000000000dd",
  workflowName: "Retired digest",
  origin: { kind: "manual", actor: "user" },
  status: "completed",
  createdAt: buildTimestampMinutesAgo(2 * 24 * 60),
  startedAt: buildTimestampMinutesAgo(2 * 24 * 60),
  finishedAt: buildTimestampMinutesAgo(2 * 24 * 60),
};

/** The runs in the order the controller lists them: newest first. */
const LISTED_RUNS: readonly RunSummary[] = [RUNNING, FAILED, OF_DELETED];

/** The id the stub controller gives to a run the form starts. */
const STARTED_RUN_ID = "0199c0ff-2222-7000-8000-0000000000aa";

/** The run the stub controller returns for `STARTED_RUN_ID`, so its page can render. */
const buildStartedRun = (workflow: Workflow, name: string): Run => ({
  id: STARTED_RUN_ID,
  workflowId: workflow.id,
  plan: {
    name,
    steps: [{ id: "create", kind: "action", action: "task.create", params: { title: "x" } }],
  },
  inputs: {},
  origin: { kind: "manual", actor: "user" },
  status: "pending",
  steps: [{ stepId: "create", iteration: 1, status: "pending" }],
  edgeTraversals: [],
  createdAt: new Date().toISOString(),
});

/* ------------------------------------------------------------------------ */
/* The stub controller.                                                      */
/* ------------------------------------------------------------------------ */

/** The page size the stub controller uses, so that three runs need two pages. */
const PAGE_SIZE = 2;

/**
 * Returns the `run.query` handler over `readRuns()`. It applies the
 * `workflowId` and `status` filters, and pages by `PAGE_SIZE`; the cursor is
 * the index of the first run of the page.
 */
const buildRunQuery =
  (readRuns: () => readonly RunSummary[], pageSize: number): Handler =>
  (call) => {
    const params = new URLSearchParams(call.search);
    const workflowId = params.get("workflowId");
    const status = params.get("status");
    const matching = readRuns().filter(
      (run) =>
        (workflowId === null || run.workflowId === workflowId) &&
        (status === null || run.status === status),
    );
    const start = Number(params.get("cursor") ?? "0");
    const end = start + pageSize;
    return {
      body: {
        items: matching.slice(start, end),
        ...(end < matching.length ? { nextCursor: String(end) } : {}),
      },
    };
  };

/**
 * Renders the app at `path` against a stub controller that holds `runs`, the
 * two workflows and the three Connections.
 * - `pageSize` sets how many runs a `run.query` page holds.
 * - `overrides` replaces the handler of a route, or adds a route.
 *
 * Returns the app, the stubbed API, and `hold`, which replaces the runs the
 * controller holds from now on, as a change on the controller would.
 */
const openApp = async ({
  path = "/runs",
  runs = LISTED_RUNS,
  pageSize = 50,
  overrides = {},
}: {
  readonly path?: string;
  readonly runs?: readonly RunSummary[];
  readonly pageSize?: number;
  readonly overrides?: Readonly<Record<string, Handler>>;
} = {}) => {
  let heldRuns = [...runs];
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
    "GET /api/v1/runs": buildRunQuery(() => heldRuns, pageSize),
    "GET /api/v1/workflows": { body: { items: WORKFLOW_SUMMARIES } },
    [`GET /api/v1/workflows/${RELEASE.id}`]: { body: RELEASE },
    [`GET /api/v1/workflows/${NIGHTLY.id}`]: { body: NIGHTLY },
    // The real controller filters by type when a request names one; a screen
    // may also request every Connection and filter them itself.
    "GET /api/v1/connections": (call) => {
      const type = new URLSearchParams(call.search).get("type");
      return {
        body: {
          items: CONNECTIONS.filter((connection) => type === null || connection.type === type),
        },
      };
    },
    "POST /api/v1/runs/start": { body: { runId: STARTED_RUN_ID } },
    [`GET /api/v1/runs/${STARTED_RUN_ID}`]: { body: buildStartedRun(RELEASE, RELEASE_NAME) },
    ...overrides,
  });
  const app = await renderApp({ path, api: api.fetch, token: "held" });
  return {
    ...app,
    api,
    hold: (next: readonly RunSummary[]): void => {
      heldRuns = [...next];
    },
  };
};

/* ------------------------------------------------------------------------ */
/* Helpers that read and use the page the way a user does.                  */
/* ------------------------------------------------------------------------ */

/** Returns the `run.query` requests the screen made, oldest first. */
const listRunQueries = (api: { readonly calls: readonly Call[] }): readonly Call[] =>
  api.calls.filter((call) => call.method === "GET" && call.path === "/api/v1/runs");

/** Returns the `run.start` requests the screen made, oldest first. */
const listRunStarts = (api: { readonly calls: readonly Call[] }): readonly Call[] =>
  api.calls.filter((call) => call.method === "POST" && call.path === "/api/v1/runs/start");

/** Returns the rows of the run list: the list items that link to a run's page. */
const listRunRows = (): readonly HTMLElement[] =>
  within(screen.getByRole("main"))
    .queryAllByRole("listitem")
    .filter((item) =>
      within(item)
        .queryAllByRole("link")
        .some((link) => link.getAttribute("href")?.startsWith("/runs/") === true),
    );

/** Returns the ids of the runs the list shows, from the links of its rows, top to bottom. */
const listShownRunIds = (): readonly string[] =>
  listRunRows().flatMap((row) =>
    within(row)
      .getAllByRole("link")
      .flatMap((link) => /^\/runs\/(.+)$/.exec(link.getAttribute("href") ?? "")?.[1] ?? [])
      .slice(0, 1),
  );

/** Returns the row of the run with `id`. Throws when the list has none. */
const getRunRow = (id: string): HTMLElement => {
  const row = listRunRows().find((item) =>
    within(item)
      .queryAllByRole("link")
      .some((link) => link.getAttribute("href") === `/runs/${id}`),
  );
  if (row === undefined) throw new Error(`no row of the list links to /runs/${id}`);
  return row;
};

/** Waits for the row of the run with `id` and returns it. */
const findRunRow = async (id: string): Promise<HTMLElement> => {
  await waitFor(() => {
    getRunRow(id);
  });
  return getRunRow(id);
};

/** Returns the run form: the form whose name starts with "Run". */
const findRunForm = (): Promise<HTMLElement> => screen.findByRole("form", { name: /^Run\b/ });

/**
 * Returns the field of the run form for the input `name`. The label starts
 * with the input's name; it may go on with a mark that the input is required.
 */
const getInputField = (form: HTMLElement, name: string): HTMLElement =>
  within(form).getByLabelText(new RegExp(`^${name}\\b`));

/** Checks whether a control is marked required for assistive technology. */
const isMarkedRequired = (control: HTMLElement): boolean =>
  (control as HTMLInputElement).required || control.getAttribute("aria-required") === "true";

/** Opens the run form from the Runs list and picks the workflow named `name` in it. */
const openRunFormFor = async (
  user: ReturnType<typeof userEvent.setup>,
  name: string,
): Promise<HTMLElement> => {
  await user.click(await screen.findByRole("button", { name: "Run workflow" }));
  const form = await findRunForm();
  await user.selectOptions(within(form).getByLabelText("Workflow"), name);
  return form;
};

/** Sends one push on the `run` topic, once the screen has subscribed to it. */
const pushRunChange = async (
  live: LiveStub,
  id: string,
  kind: "created" | "updated" | "deleted",
): Promise<void> => {
  await waitFor(() => {
    expect(live.topics()).toContain("run");
  });
  act(() => {
    live.push("run", { _tag: "invalidate", ids: [id], kind });
  });
};

/* ------------------------------------------------------------------------ */
/* The Runs list.                                                           */
/* ------------------------------------------------------------------------ */

describe("Runs > the list", () => {
  it("shows a row per run in the controller's order, with its status, workflow name, who started it, failure reason and age", async () => {
    await openApp();

    await findRunRow(RUNNING.id);
    expect(listShownRunIds()).toEqual([RUNNING.id, FAILED.id, OF_DELETED.id]);

    for (const run of LISTED_RUNS) {
      const text = readPageText(getRunRow(run.id));
      expect(text).toContain(run.workflowName);
      expect(text.toLowerCase()).toContain(run.status);
      // The age uses the same function as the rest of the app. Its smallest
      // unit is a minute, so the two agree unless a minute boundary falls
      // between them.
      expect(text).toContain(formatAge(run.createdAt, new Date()));
    }

    // Who started the run, in the words the app uses for every actor.
    expect(readPageText(getRunRow(RUNNING.id))).toContain(describeActor("user").label);
    expect(readPageText(getRunRow(FAILED.id))).toContain(`session ${toIdTail(SESSION_ID)}`);

    // Only the failed run shows a failure reason.
    expect(readPageText(getRunRow(FAILED.id))).toMatch(/step.failed/i);
    expect(readPageText(getRunRow(RUNNING.id))).not.toMatch(/step.failed/i);
    expect(readPageText(getRunRow(OF_DELETED.id))).not.toMatch(/step.failed/i);
  });

  it("opens a run's page from its row", async () => {
    const user = userEvent.setup();
    const { router } = await openApp();

    const row = await findRunRow(RUNNING.id);
    const link = within(row)
      .getAllByRole("link")
      .find((each) => each.getAttribute("href") === `/runs/${RUNNING.id}`);
    await user.click(link!);

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${RUNNING.id}`);
    });
  });

  it("filters by workflow and by status through the controller", async () => {
    const user = userEvent.setup();
    const { api } = await openApp();
    await findRunRow(RUNNING.id);

    await user.selectOptions(screen.getByLabelText("Workflow"), NIGHTLY_NAME);
    await waitFor(() => {
      const last = listRunQueries(api).at(-1);
      expect(new URLSearchParams(last?.search).get("workflowId")).toBe(NIGHTLY_ID);
    });
    await waitFor(() => {
      expect(listShownRunIds()).toEqual([FAILED.id]);
    });

    await user.selectOptions(screen.getByLabelText("Status"), "failed");
    await waitFor(() => {
      const last = new URLSearchParams(listRunQueries(api).at(-1)?.search);
      expect(last.get("status")).toBe("failed");
      expect(last.get("workflowId")).toBe(NIGHTLY_ID);
    });
    expect(listShownRunIds()).toEqual([FAILED.id]);
  });

  it("pages forward with Load more, and offers it only while there is a next page", async () => {
    const user = userEvent.setup();
    const { api } = await openApp({ pageSize: PAGE_SIZE });

    await findRunRow(RUNNING.id);
    expect(listShownRunIds()).toEqual([RUNNING.id, FAILED.id]);

    await user.click(screen.getByRole("button", { name: "Load more" }));

    await findRunRow(OF_DELETED.id);
    expect(listShownRunIds()).toEqual([RUNNING.id, FAILED.id, OF_DELETED.id]);
    // The second page was requested with the cursor the first page returned.
    expect(new URLSearchParams(listRunQueries(api).at(-1)?.search).get("cursor")).toBe("2");
    await waitFor(() => {
      expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
    });
  });

  it("explains what a run is when there are no runs", async () => {
    const { api } = await openApp({ runs: [] });

    expect(await screen.findByText("No runs yet.")).toBeDefined();
    expect(
      screen.getByText(
        "A run is one execution of a workflow. Runs appear here when a trigger fires or you start one by hand.",
      ),
    ).toBeDefined();
    // The list is empty because the controller returned no runs, not because
    // the screen assumed so.
    expect(listRunQueries(api).length).toBeGreaterThan(0);
  });

  it("shows that the filters matched nothing, rather than that there are no runs", async () => {
    const user = userEvent.setup();
    await openApp();
    await findRunRow(RUNNING.id);

    await user.selectOptions(screen.getByLabelText("Status"), "cancelled");

    expect(await screen.findByText("Nothing matches these filters.")).toBeDefined();
    expect(screen.queryByText("No runs yet.")).toBeNull();
    expect(listShownRunIds()).toEqual([]);
  });

  it("shows a run started elsewhere, and a run's new status, when a change is pushed on the run topic", async () => {
    const { live, hold } = await openApp();
    await findRunRow(RUNNING.id);

    const started: RunSummary = {
      ...RUNNING,
      id: "0199c0ff-2222-7000-8000-000000000004",
      status: "pending",
      createdAt: new Date().toISOString(),
    };
    hold([started, ...LISTED_RUNS]);
    await pushRunChange(live, started.id, "created");

    const row = await findRunRow(started.id);
    expect(readPageText(row).toLowerCase()).toContain("pending");

    hold([
      started,
      { ...RUNNING, status: "completed", finishedAt: new Date().toISOString() },
      FAILED,
      OF_DELETED,
    ]);
    await pushRunChange(live, RUNNING.id, "updated");

    await waitFor(() => {
      expect(readPageText(getRunRow(RUNNING.id)).toLowerCase()).toContain("completed");
    });
    expect(readPageText(getRunRow(RUNNING.id)).toLowerCase()).not.toContain("running");
  });
});

/* ------------------------------------------------------------------------ */
/* The run form, opened from the Runs list.                                 */
/* ------------------------------------------------------------------------ */

describe("Runs > the run form", () => {
  it("opens from Run workflow with a picker that lists the workflows", async () => {
    const user = userEvent.setup();
    await openApp();

    await user.click(await screen.findByRole("button", { name: "Run workflow" }));

    const form = await findRunForm();
    const picker = within(form).getByLabelText<HTMLSelectElement>("Workflow");
    const names = [...picker.options].map((option) => option.textContent);
    expect(names).toContain(RELEASE_NAME);
    expect(names).toContain(NIGHTLY_NAME);
  });

  it("shows one field per declared input, of the input's type, with defaults filled in and required inputs marked", async () => {
    const user = userEvent.setup();
    await openApp();

    const form = await openRunFormFor(user, RELEASE_NAME);

    await waitFor(() => {
      getInputField(form, "title");
    });
    const title = getInputField(form, "title");
    const count = getInputField(form, "count");
    const urgent = getInputField(form, "urgent");
    const priority = getInputField(form, "priority");
    const account = getInputField(form, "account");
    const extra = getInputField(form, "extra");

    // The fields come in the order the inputs are declared.
    expectInDocumentOrder([title, count, urgent, priority, account, extra]);

    // A string is a text field, empty when the input has no default.
    expect(within(form).getByRole("textbox", { name: /^title\b/ })).toBe(title);
    expect((title as HTMLInputElement).value).toBe("");

    // A number is a number field, with its default.
    expect(within(form).getByRole("spinbutton", { name: /^count\b/ })).toBe(count);
    expect((count as HTMLInputElement).value).toBe("3");

    // A boolean is a checkbox, with its default.
    expect(within(form).getByRole("checkbox", { name: /^urgent\b/ })).toBe(urgent);
    expect(
      (urgent as HTMLInputElement).checked || urgent.getAttribute("aria-checked") === "true",
    ).toBe(true);

    // A string with an enum is a select of its values, with its default.
    expect(priority.tagName).toBe("SELECT");
    const priorityValues = [...(priority as HTMLSelectElement).options].map(
      (option) => option.value,
    );
    expect(priorityValues).toEqual(expect.arrayContaining(["low", "normal", "high"]));
    expect((priority as HTMLSelectElement).value).toBe("normal");

    // An object is JSON text, with its default.
    expect(extra.tagName).toBe("TEXTAREA");
    expect(JSON.parse((extra as HTMLTextAreaElement).value)).toEqual({ labels: ["release"] });

    // Required inputs are marked; optional ones are not.
    expect(isMarkedRequired(title)).toBe(true);
    expect(isMarkedRequired(account)).toBe(true);
    expect(isMarkedRequired(count)).toBe(false);
    expect(isMarkedRequired(extra)).toBe(false);
  });

  it("offers only the Connections of the input's type, and shows a disabled one without letting it be chosen", async () => {
    const user = userEvent.setup();
    await openApp();

    const form = await openRunFormFor(user, RELEASE_NAME);
    await waitFor(() => {
      getInputField(form, "account");
    });
    const account = getInputField(form, "account") as HTMLSelectElement;
    expect(account.tagName).toBe("SELECT");

    await waitFor(() => {
      expect([...account.options].map((option) => option.value)).toContain(GITHUB_WORK.id);
    });
    const options = [...account.options];
    const work = options.find((option) => option.value === GITHUB_WORK.id);
    const archived = options.find((option) => option.value === GITHUB_OLD.id);
    expect(work?.textContent).toContain(GITHUB_WORK.label);
    expect(work?.disabled).toBe(false);
    expect(archived?.textContent).toContain(GITHUB_OLD.label);
    expect(archived?.disabled).toBe(true);
    // A Connection of another type is not offered.
    expect(options.some((option) => option.value === MAIL.id)).toBe(false);
    expect(options.some((option) => option.textContent?.includes(MAIL.label) === true)).toBe(false);
  });

  it("starts the run with the typed values, then goes to the run's page", async () => {
    const user = userEvent.setup();
    const { api, router } = await openApp();

    const form = await openRunFormFor(user, RELEASE_NAME);
    await waitFor(() => {
      getInputField(form, "title");
    });
    await user.type(getInputField(form, "title"), "Fix login");
    await user.selectOptions(getInputField(form, "account"), GITHUB_WORK.id);
    await user.click(within(form).getByRole("button", { name: "Start" }));

    await waitFor(() => {
      expect(router.state.location.pathname).toBe(`/runs/${STARTED_RUN_ID}`);
    });
    const starts = listRunStarts(api);
    expect(starts).toHaveLength(1);
    expect(starts[0]?.body).toEqual({
      workflowId: RELEASE_ID,
      inputs: {
        title: "Fix login",
        count: 3,
        urgent: true,
        priority: "normal",
        account: GITHUB_WORK.id,
        extra: { labels: ["release"] },
      },
    });
  });

  it("shows each validation issue from the controller on the field its path names, and stays on the form", async () => {
    const user = userEvent.setup();
    const countMessage = "3 is more than the most this input allows, 2.";
    const titleMessage = "This input is required. Give it a value.";
    const { api, router } = await openApp({
      overrides: {
        "POST /api/v1/runs/start": {
          status: 400,
          body: {
            error: {
              code: "validation",
              message: "The inputs are not valid.",
              details: {
                issues: [
                  { path: ["inputs", "count"], message: countMessage },
                  { path: ["inputs", "title"], message: titleMessage },
                ],
              },
            },
          },
        },
      },
    });

    const form = await openRunFormFor(user, RELEASE_NAME);
    await waitFor(() => {
      getInputField(form, "account");
    });
    await user.selectOptions(getInputField(form, "account"), GITHUB_WORK.id);
    await user.click(within(form).getByRole("button", { name: "Start" }));

    const countIssue = await within(form).findByText(countMessage);
    const titleIssue = within(form).getByText(titleMessage);
    // Each message stands after its own field and before the next field.
    expectInDocumentOrder([
      getInputField(form, "title"),
      titleIssue,
      getInputField(form, "count"),
      countIssue,
      getInputField(form, "urgent"),
    ]);
    expect(listRunStarts(api)).toHaveLength(1);
    expect(router.state.location.pathname).toBe("/runs");
  });
});

describe("Runs > the run form, when a read fails or a workflow is picked", () => {
  it("shows an error when the Connections cannot be read and the workflow has a Connection input", async () => {
    const user = userEvent.setup();
    const { api } = await openApp({
      overrides: {
        "GET /api/v1/connections": {
          status: 500,
          body: { error: { code: "internal", message: "The database is locked." } },
        },
      },
    });

    const withConnection = await openRunFormFor(user, RELEASE_NAME);
    expect(
      await within(withConnection).findByText(
        "The form could not be read: The database is locked.",
      ),
    ).toBeDefined();
    await user.click(within(withConnection).getByRole("button", { name: "Start" }));
    expect(listRunStarts(api)).toEqual([]);

    // A workflow with no Connection input does not need the Connections.
    await user.selectOptions(within(withConnection).getByLabelText("Workflow"), NIGHTLY_NAME);
    await user.click(within(withConnection).getByRole("button", { name: "Start" }));
    await waitFor(() => {
      expect(
        listRunStarts(api).map((call) => (call.body as { workflowId?: unknown }).workflowId),
      ).toEqual([NIGHTLY_ID]);
    });
  });

  it("keeps the focus on the picker when the picked workflow's fields appear", async () => {
    const user = userEvent.setup();
    await openApp();

    const form = await openRunFormFor(user, RELEASE_NAME);
    await waitFor(() => {
      getInputField(form, "title");
    });

    expect(document.activeElement).toBe(within(form).getByLabelText("Workflow"));
  });
});
