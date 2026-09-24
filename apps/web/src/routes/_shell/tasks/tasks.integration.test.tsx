/**
 * Tests the Tasks screen against a stubbed controller: the list, the filters,
 * the composer and the drawer. Task detail is a drawer over `/tasks`, never a
 * path of its own, so these tests also check the browser URL.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import {
  buildErrorBody,
  expectInDocumentOrder,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

const PROJECT = {
  id: "01a06d02-beca-760b-a6b2-83af536c3c20",
  name: "hydra",
  createdAt: "2026-09-04T15:21:31.594Z",
  updatedAt: "2026-09-04T15:21:31.594Z",
};

interface Fixture {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly status: string;
  readonly priority: string;
  readonly labels: readonly string[];
  readonly projectId?: string;
  readonly provenance: readonly {
    readonly ref?: string;
    readonly eventId?: number;
    readonly runId?: string;
    readonly at: string;
    readonly actor: string;
  }[];
  readonly createdAt: string;
  readonly updatedAt: string;
  readonly statusChangedAt: string;
}

const RUNNER: Fixture = {
  id: "01a06d02-beff-7037-9f5b-042822015952",
  title: "Wire the runner socket up",
  description: "The controller accepts a runner over one WebSocket and hosts sessions on it.",
  status: "open",
  priority: "high",
  labels: ["runner", "protocol"],
  projectId: PROJECT.id,
  provenance: [
    {
      ref: "github:issue:rogierpennink/hydra#61",
      at: "2026-09-04T15:21:31.646Z",
      actor: "user",
    },
  ],
  createdAt: "2026-09-04T15:21:31.646Z",
  updatedAt: "2026-09-04T15:21:31.646Z",
  statusChangedAt: "2026-09-04T15:21:31.646Z",
};

const PRUNE: Fixture = {
  id: "01a06d02-bf35-73be-8c1f-7c82ebeb9203",
  title: "Prune the event log after 90 days",
  description: "The retention job walks the log by arrival time and drops what is older.",
  status: "done",
  priority: "normal",
  labels: ["events"],
  projectId: PROJECT.id,
  provenance: [
    {
      eventId: 4242,
      at: "2026-09-04T15:21:31.701Z",
      actor: "session:01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb",
    },
  ],
  createdAt: "2026-09-04T15:21:31.701Z",
  updatedAt: "2026-09-04T15:21:31.755Z",
  statusChangedAt: "2026-09-04T15:21:31.755Z",
};

/**
 * Returns stub routes for a controller holding the given tasks. The list route
 * returns them, and a patch is applied to them, so a screen that reads back its
 * own write sees the change.
 */
const buildController = (
  tasks: readonly Fixture[],
  extra: Readonly<Record<string, Handler>> = {},
): Readonly<Record<string, Handler>> => {
  let held = [...tasks];
  return {
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": {
      body: {
        controller: {},
        user: { "onboarding.completedSteps": ["timezone"], timezone: "Europe/Amsterdam" },
      },
    },
    "GET /api/v1/projects": { body: { items: [PROJECT] } },
    "GET /api/v1/tasks": () => ({ body: { items: held } }),
    "POST /api/v1/tasks": (call: Call) => {
      const sent = call.body as { title: string; description?: string };
      const created: Fixture = {
        ...RUNNER,
        id: "01a06d03-0000-7000-8000-000000000001",
        title: sent.title,
        description: sent.description ?? "",
        status: "open",
        priority: "normal",
        labels: [],
        provenance: [],
      };
      held = [created, ...held];
      return { body: created };
    },
    ...Object.fromEntries(
      tasks.map((task) => [
        `GET /api/v1/tasks/${task.id}`,
        () => ({ body: held.find((candidate) => candidate.id === task.id) ?? task }),
      ]),
    ),
    ...Object.fromEntries(
      tasks.map((task) => [
        `PATCH /api/v1/tasks/${task.id}`,
        (call: Call) => {
          const sent = call.body as { status?: string };
          const next = { ...task, ...sent };
          held = held.map((candidate) => (candidate.id === task.id ? next : candidate));
          return { body: next };
        },
      ]),
    ),
    ...extra,
  };
};

const openApp = async (tasks: readonly Fixture[], extra?: Readonly<Record<string, Handler>>) => {
  const api = stubApi(buildController(tasks, extra));
  const app = await renderApp({ path: "/tasks", api: api.fetch, token: "held" });
  return { ...app, api };
};

/** Returns the task list requests, oldest first. */
const listTaskReads = (api: { readonly calls: readonly Call[] }) =>
  api.calls.filter((call) => call.method === "GET" && call.path === "/api/v1/tasks");

const getTaskRow = (title: string) => screen.getByRole("button", { name: new RegExp(title) });

describe("Tasks", () => {
  it("shows a row per task with its status, labels, project and priority", async () => {
    await openApp([RUNNER, PRUNE]);

    const first = await screen.findByRole("button", { name: new RegExp(RUNNER.title) });
    expect(first.textContent).toContain("open");
    expect(first.textContent).toContain("runner");
    expect(first.textContent).toContain("protocol");
    expect(first.textContent).toContain(PROJECT.name);
    expect(within(first).getByLabelText(/high/i)).toBeTruthy();

    const second = getTaskRow(PRUNE.title);
    expect(second.textContent).toContain("done");
    expect(within(second).getByLabelText(/normal/i)).toBeTruthy();
  });

  it("offers the four filters, each starting on Any", async () => {
    await openApp([RUNNER]);

    const status = screen.getByLabelText<HTMLSelectElement>("Status");
    expect([...status.options].map((option) => option.textContent)).toEqual([
      "Any status",
      "open",
      "in-progress",
      "done",
      "cancelled",
    ]);

    const project = screen.getByLabelText<HTMLSelectElement>("Project");
    expect(project.options[0]?.textContent).toBe("Any project");
    expect([...project.options].map((option) => option.textContent)).toContain(PROJECT.name);

    expect(screen.getByLabelText("Search")).toBeTruthy();
    expect(screen.getByLabelText("Labels")).toBeTruthy();
  });

  it("searches through the controller, not by filtering the loaded rows", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([RUNNER, PRUNE]);

    await user.type(screen.getByLabelText("Search"), "retention");

    await waitFor(() => {
      const last = listTaskReads(api).at(-1);
      expect(new URLSearchParams(last?.search).get("text")).toBe("retention");
    });
  });

  it("filters by status through the controller too", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([RUNNER, PRUNE]);

    await user.selectOptions(screen.getByLabelText("Status"), "in-progress");

    await waitFor(() => {
      const last = listTaskReads(api).at(-1);
      expect(new URLSearchParams(last?.search).has("status")).toBe(true);
      expect(decodeURIComponent(last?.search ?? "")).toContain("in-progress");
    });
  });

  it("explains what a task is for when there are no tasks", async () => {
    const { api } = await openApp([]);

    expect(await screen.findByText("No tasks yet.")).toBeTruthy();
    // The list is empty because the controller returned no tasks, not because
    // the screen assumed so.
    expect(listTaskReads(api).length).toBeGreaterThan(0);
    expect(
      screen.getByText(
        "Triage proposes tasks from what comes in, and you can add one by hand. A task is intent; a run or a thread does the work.",
      ),
    ).toBeTruthy();
  });

  it("says the filters matched nothing, rather than that there are no tasks", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController([RUNNER]),
      "GET /api/v1/tasks": (call: Call) => ({
        body: { items: call.search.includes("text=") ? [] : [RUNNER] },
      }),
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.type(screen.getByLabelText("Search"), "nothing at all");

    expect(await screen.findByText("Nothing matches these filters.")).toBeTruthy();
    expect(screen.queryByText("No tasks yet.")).toBeNull();
  });

  it("creates a task by hand from the composer", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([]);

    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByLabelText("Title"), "Read the log");
    await user.type(screen.getByLabelText("Description"), "Once a week is enough.");
    await user.click(screen.getByRole("button", { name: "Create" }));

    await waitFor(() => {
      const written = api.calls.filter(
        (call) => call.method === "POST" && call.path === "/api/v1/tasks",
      );
      expect(written).toHaveLength(1);
      expect(written[0]?.body).toMatchObject({
        title: "Read the log",
        description: "Once a week is enough.",
      });
    });
  });
});

describe("Tasks > the drawer", () => {
  it("opens the task beside the list without leaving the list", async () => {
    const user = userEvent.setup();
    const { router } = await openApp([RUNNER, PRUNE]);

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));

    const drawer = await screen.findByRole("dialog");
    expect(drawer.textContent).toContain(RUNNER.title);
    expect(drawer.textContent).toContain("open");
    expect(within(drawer).getByLabelText(/high/i)).toBeTruthy();
    expect(drawer.textContent).toContain("runner");
    expect(drawer.textContent).toContain(PROJECT.name);

    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.searchStr).toContain(RUNNER.id);
  });

  it("shows each provenance entry's source, actor and time", async () => {
    const user = userEvent.setup();
    await openApp([RUNNER, PRUNE]);

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    const first = await screen.findByRole("dialog");
    expect(first.textContent).toContain("github:issue:rogierpennink/hydra#61");
    expect(first.textContent).toContain("you");
    // The time may be shown in the user's zone or in UTC; either has the minute.
    expect(first.textContent).toMatch(/17:21|15:21/);

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    await user.click(getTaskRow(PRUNE.title));
    const second = await screen.findByRole("dialog");
    expect(second.textContent).toContain("4242");
    // A session actor is shown by the tail of its id, as a link to its thread,
    // rather than as the raw `session:<uuid>` stamp.
    expect(second.textContent).not.toContain("session:01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb");
    const thread = await within(second).findByRole("link", { name: "session 7c82ebeb" });
    expect(thread.getAttribute("href")).toBe("/threads/01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb");
  });

  it("shows a run actor by the tail of its id, as a link to the run's page", async () => {
    const user = userEvent.setup();
    const runId = "01a06d02-c222-7a0e-8b3d-9c1f1f3a9c2e";
    const filed: Fixture = {
      ...PRUNE,
      id: "01a06d02-bf35-73be-8c1f-7c82ebeb9204",
      title: "Filed by a run",
      provenance: [{ runId, at: "2026-09-04T15:21:31.701Z", actor: `run:${runId}` }],
    };
    await openApp([filed]);

    await user.click(getTaskRow(filed.title));
    const drawer = await screen.findByRole("dialog");
    expect(drawer.textContent).not.toContain(`run:${runId}`);
    const run = await within(drawer).findByRole("link", { name: "run 1f3a9c2e" });
    expect(run.getAttribute("href")).toBe(`/runs/${runId}`);
  });

  it("moves a task from any status to any other", async () => {
    const user = userEvent.setup();
    const { api } = await openApp([RUNNER, PRUNE]);

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    await user.selectOptions(
      within(await screen.findByRole("dialog")).getByLabelText("Status"),
      "in-progress",
    );

    await waitFor(() => {
      expect(
        api.calls.find(
          (call) => call.method === "PATCH" && call.path === `/api/v1/tasks/${RUNNER.id}`,
        )?.body,
      ).toEqual({ status: "in-progress" });
    });

    await user.keyboard("{Escape}");
    await user.click(getTaskRow(PRUNE.title));
    await user.selectOptions(
      within(await screen.findByRole("dialog")).getByLabelText("Status"),
      "open",
    );

    await waitFor(() => {
      expect(
        api.calls.find(
          (call) => call.method === "PATCH" && call.path === `/api/v1/tasks/${PRUNE.id}`,
        )?.body,
      ).toEqual({ status: "open" });
    });
  });

  it("closes on Escape and leaves the list where it was", async () => {
    const user = userEvent.setup();
    const { router } = await openApp([RUNNER, PRUNE]);

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    expect(await screen.findByRole("dialog")).toBeTruthy();

    await user.keyboard("{Escape}");

    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });
    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.searchStr).not.toContain(RUNNER.id);
    expect(getTaskRow(RUNNER.title)).toBeTruthy();
  });
});

describe("Tasks > errors the screen must show", () => {
  /** A full 403 response. A `forbidden` error includes the missing grant. */
  const refused = {
    status: 403,
    body: {
      error: {
        code: "forbidden",
        message: "task.update is not granted",
        details: { grant: "task.update" },
      },
    },
  };

  it("shows the error when the controller rejects an edit", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController([RUNNER]),
      [`PATCH /api/v1/tasks/${RUNNER.id}`]: refused,
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    await user.selectOptions(
      within(await screen.findByRole("dialog")).getByLabelText("Status"),
      "done",
    );

    expect((await screen.findByRole("alert")).textContent).toContain("task.update is not granted");
  });

  it("still shows an edit's error when a later edit returns first", async () => {
    const user = userEvent.setup();
    let release = (): void => {};
    const answered = new Promise<void>((resolve) => {
      release = resolve;
    });
    const api = stubApi({
      ...buildController([RUNNER]),
      // The status edit fails, but only after the priority edit that follows
      // it has already returned.
      [`PATCH /api/v1/tasks/${RUNNER.id}`]: async (call: Call) => {
        const sent = call.body as { status?: string; priority?: string };
        if (sent.status === undefined) return { body: { ...RUNNER, ...sent } };
        await answered;
        return refused;
      },
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    const drawer = within(await screen.findByRole("dialog"));
    await user.selectOptions(drawer.getByLabelText("Status"), "done");
    await user.selectOptions(drawer.getByLabelText("Priority"), "low");
    release();

    expect((await screen.findByRole("alert")).textContent).toContain("task.update is not granted");
  });

  it("does not show one task's edit error in the next task's drawer", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController([RUNNER, PRUNE]),
      [`PATCH /api/v1/tasks/${RUNNER.id}`]: refused,
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    await user.selectOptions(
      within(await screen.findByRole("dialog")).getByLabelText("Status"),
      "done",
    );
    expect((await screen.findByRole("alert")).textContent).toContain("task.update is not granted");

    await user.click(within(screen.getByRole("dialog")).getByRole("button", { name: "Close" }));
    await user.click(getTaskRow(PRUNE.title));

    const next = await screen.findByRole("dialog");
    expect(next.textContent).toContain(PRUNE.title);
    expect(within(next).queryByRole("alert")).toBeNull();
  });

  it("clears an edit error once a later edit of the same task succeeds", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController([RUNNER]),
      // The status edit fails; the priority edit that follows succeeds.
      [`PATCH /api/v1/tasks/${RUNNER.id}`]: (call: Call) => {
        const sent = call.body as { status?: string; priority?: string };
        return sent.status === undefined ? { body: { ...RUNNER, ...sent } } : refused;
      },
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    const drawer = within(await screen.findByRole("dialog"));
    await user.selectOptions(drawer.getByLabelText("Status"), "done");
    expect((await screen.findByRole("alert")).textContent).toContain("task.update is not granted");

    await user.selectOptions(drawer.getByLabelText("Priority"), "low");

    await waitFor(() => {
      expect(screen.queryByRole("alert")).toBeNull();
    });
  });

  it("drops an edit error when the drawer closes, even if Back reopens it", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController([RUNNER]),
      [`PATCH /api/v1/tasks/${RUNNER.id}`]: refused,
    });
    const { router } = await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    await user.selectOptions(
      within(await screen.findByRole("dialog")).getByLabelText("Status"),
      "done",
    );
    expect((await screen.findByRole("alert")).textContent).toContain("task.update is not granted");

    await user.keyboard("{Escape}");
    await waitFor(() => {
      expect(screen.queryByRole("dialog")).toBeNull();
    });

    // Back reopens the same drawer without a click on the row or on Close, so
    // no click handler gets a chance to clear the error on the way.
    await act(async () => {
      router.history.back();
      await router.load();
    });

    const reopened = await screen.findByRole("dialog");
    expect(reopened.textContent).toContain(RUNNER.title);
    expect(within(reopened).queryByRole("alert")).toBeNull();
  });

  it("shows the error when the task in the URL cannot be read", async () => {
    const api = stubApi({
      ...buildController([]),
      [`GET /api/v1/tasks/${RUNNER.id}`]: {
        status: 404,
        body: buildErrorBody("not_found", `no task with id ${RUNNER.id}`),
      },
    });
    await renderApp({ path: `/tasks?task=${RUNNER.id}`, api: api.fetch, token: "held" });

    const drawer = await screen.findByRole("dialog");
    expect(drawer.textContent).toContain("Task not found");
    expect(drawer.textContent).toContain(`no task with id ${RUNNER.id}`);
  });

  it("shows the error when creating a task fails, and keeps what was typed", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController([]),
      "POST /api/v1/tasks": {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByLabelText("Title"), "Read the log");
    await user.click(screen.getByRole("button", { name: "Create" }));

    expect((await screen.findByRole("alert")).textContent).toContain("the database is locked");
    expect(screen.getByLabelText<HTMLInputElement>("Title").value).toBe("Read the log");
  });

  it("clears a failed attempt's error when the composer is closed", async () => {
    const user = userEvent.setup();
    const api = stubApi({
      ...buildController([]),
      "POST /api/v1/tasks": {
        status: 500,
        body: buildErrorBody("internal", "the database is locked"),
      },
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(screen.getByRole("button", { name: "New task" }));
    await user.type(screen.getByLabelText("Title"), "Read the log");
    const cancel = screen.getByRole("button", { name: "Cancel" });
    expectInDocumentOrder([cancel, screen.getByRole("button", { name: "Create" })]);
    await user.click(screen.getByRole("button", { name: "Create" }));
    expect((await screen.findByRole("alert")).textContent).toContain("the database is locked");

    await user.click(cancel);
    await user.click(screen.getByRole("button", { name: "New task" }));

    expect(screen.queryByRole("alert")).toBeNull();
  });

  it("opens a task named in the URL that is on no loaded page of the list", async () => {
    const api = stubApi({
      ...buildController([]),
      [`GET /api/v1/tasks/${RUNNER.id}`]: { body: RUNNER },
    });
    await renderApp({ path: `/tasks?task=${RUNNER.id}`, api: api.fetch, token: "held" });

    const drawer = await screen.findByRole("dialog");
    expect(drawer.textContent).toContain(RUNNER.title);
  });

  it("keeps the drawer open when the edit takes the task out of the filter", async () => {
    const user = userEvent.setup();
    let held = { ...RUNNER };
    const api = stubApi({
      ...buildController([RUNNER]),
      // A list filtered to `open`. The edit below moves the task out of it.
      "GET /api/v1/tasks": (call: Call) => ({
        body: {
          items: call.search.includes("status=open") && held.status !== "open" ? [] : [held],
        },
      }),
      [`GET /api/v1/tasks/${RUNNER.id}`]: () => ({ body: held }),
      [`PATCH /api/v1/tasks/${RUNNER.id}`]: (call: Call) => {
        held = { ...held, ...(call.body as { status: string }) };
        return { body: held };
      },
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.selectOptions(screen.getByLabelText("Status"), "open");
    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    await user.selectOptions(
      within(await screen.findByRole("dialog")).getByLabelText("Status"),
      "done",
    );

    await waitFor(() => {
      expect(
        within(screen.getByRole("dialog")).getByLabelText<HTMLSelectElement>("Status").value,
      ).toBe("done");
    });
  });

  it("shows a project missing from the project list, rather than No project", async () => {
    const user = userEvent.setup();
    const orphan: Fixture = { ...RUNNER, projectId: "01a06d02-0000-7000-8000-00000000dead" };
    const api = stubApi({
      ...buildController([orphan]),
      "GET /api/v1/projects": { body: { items: [] } },
      [`GET /api/v1/tasks/${orphan.id}`]: { body: orphan },
    });
    await renderApp({ path: "/tasks", api: api.fetch, token: "held" });

    await user.click(await screen.findByRole("button", { name: new RegExp(orphan.title) }));
    const project = within(await screen.findByRole("dialog")).getByLabelText<HTMLSelectElement>(
      "Project",
    );
    expect(project.value).toBe(orphan.projectId);
    expect(project.selectedOptions[0]?.textContent).not.toBe("No project");
  });
});

describe("Tasks > live", () => {
  /** A task that appears while the screen is already open. */
  const ADDED: Fixture = {
    ...RUNNER,
    id: "01a06d03-1111-7000-8000-000000000002",
    title: "Ship the live overlay",
    labels: [],
    provenance: [],
  };

  /** Builds one invalidation message, in the wire shape the contract defines. */
  const buildInvalidation = (kind: string, ids: readonly string[]) => ({
    _tag: "invalidate",
    ids,
    kind,
  });

  /**
   * Sends one push on the `task` topic. The push passes through a stub socket
   * and the transport's own fibers, so it only starts the update; the test
   * waits for the result at the assertion.
   */
  const pushTaskInvalidation = (
    live: { push(topic: string, message: unknown): void },
    kind: string,
    ids: readonly string[],
  ): void => {
    act(() => {
      live.push("task", buildInvalidation(kind, ids));
    });
  };

  /** Waits until the screen subscribes to `task`; a push before that has no effect. */
  const waitForTaskTopic = async (live: { topics(): readonly string[] }) => {
    await waitFor(() => {
      expect(live.topics()).toContain("task");
    });
  };

  it("shows a task created elsewhere, without navigating", async () => {
    let held: readonly Fixture[] = [RUNNER];
    const { api, live, router } = await openApp([RUNNER], {
      "GET /api/v1/tasks": () => ({ body: { items: held } }),
    });

    await screen.findByRole("button", { name: new RegExp(RUNNER.title) });
    await waitForTaskTopic(live);
    const before = listTaskReads(api).length;

    // The controller now has one more task than the screen has loaded.
    held = [ADDED, ...held];
    pushTaskInvalidation(live, "created", [ADDED.id]);

    expect(await screen.findByRole("button", { name: new RegExp(ADDED.title) })).toBeTruthy();
    // The row came from a new list request, not from the push itself.
    expect(listTaskReads(api).length).toBeGreaterThan(before);
    expect(router.state.location.pathname).toBe("/tasks");
    expect(router.state.location.searchStr).not.toContain(ADDED.id);
  });

  it("drops the row for a task deleted elsewhere", async () => {
    let held: readonly Fixture[] = [RUNNER, PRUNE];
    const { live } = await openApp([RUNNER, PRUNE], {
      "GET /api/v1/tasks": () => ({ body: { items: held } }),
    });

    await screen.findByRole("button", { name: new RegExp(PRUNE.title) });
    await waitForTaskTopic(live);

    held = held.filter((candidate) => candidate.id !== PRUNE.id);
    pushTaskInvalidation(live, "deleted", [PRUNE.id]);

    await waitFor(() => {
      expect(screen.queryByRole("button", { name: new RegExp(PRUNE.title) })).toBeNull();
    });
    expect(getTaskRow(RUNNER.title)).toBeTruthy();
  });

  it("shows the new values in an open drawer when the task is updated elsewhere", async () => {
    const user = userEvent.setup();
    let held: Fixture = { ...RUNNER };
    const { live } = await openApp([RUNNER], {
      "GET /api/v1/tasks": () => ({ body: { items: [held] } }),
      [`GET /api/v1/tasks/${RUNNER.id}`]: () => ({ body: held }),
    });

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    const drawer = await screen.findByRole("dialog");
    expect(within(drawer).getByLabelText<HTMLSelectElement>("Status").value).toBe("open");
    await waitForTaskTopic(live);

    held = { ...held, title: "Wire the runner socket up, at last", status: "in-progress" };
    pushTaskInvalidation(live, "updated", [RUNNER.id]);

    await waitFor(() => {
      expect(
        within(screen.getByRole("dialog")).getByLabelText<HTMLSelectElement>("Status").value,
      ).toBe("in-progress");
    });
    expect(screen.getByRole("dialog").textContent).toContain("Wire the runner socket up, at last");
  });

  it("shows the error in an open drawer when the task is deleted elsewhere", async () => {
    const user = userEvent.setup();
    let held: readonly Fixture[] = [RUNNER];
    const { live } = await openApp([RUNNER], {
      "GET /api/v1/tasks": () => ({ body: { items: held } }),
      [`GET /api/v1/tasks/${RUNNER.id}`]: () =>
        held.length === 0
          ? { status: 404, body: buildErrorBody("not_found", "no task 01a06d02") }
          : { body: RUNNER },
    });

    await user.click(await screen.findByRole("button", { name: new RegExp(RUNNER.title) }));
    await screen.findByRole("dialog");
    await waitForTaskTopic(live);

    held = [];
    pushTaskInvalidation(live, "deleted", [RUNNER.id]);

    expect(await screen.findByText("no task 01a06d02")).toBeTruthy();
    expect(screen.getByRole("dialog").textContent).not.toContain(RUNNER.title);
  });

  it("unsubscribes when the user leaves the screen", async () => {
    const { live, router } = await openApp([RUNNER]);

    await screen.findByRole("button", { name: new RegExp(RUNNER.title) });
    await waitForTaskTopic(live);

    await act(async () => {
      await router.navigate({ to: "/runs" });
    });

    await waitFor(() => {
      expect(live.topics()).not.toContain("task");
    });
  });
});
