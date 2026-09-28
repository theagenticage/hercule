/**
 * Tests for the notification center at `/notifications` and the sidebar's
 * count of new notifications.
 *
 * The stub controller serves `notification.query` from the notifications a
 * test holds, and applies `since`, `limit` and the cursor like the real
 * controller. It keeps the settings a test starts with and applies every
 * `settings.update`, so a test can check both what the screen wrote and what
 * it shows afterwards.
 */
import { describe, expect, it } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { formatTimeContext } from "@hercule/client-core";
import type { Notification } from "@hercule/contract";
import {
  buildErrorBody,
  expectInDocumentOrder,
  readPageText,
  renderApp,
  stubApi,
  type Call,
  type Handler,
} from "../../../app/testing";

const MINUTE_MS = 60_000;
const ZONE = "Europe/Amsterdam";

/** Returns the ISO timestamp of `minutes` minutes ago. */
const buildTimestampMinutesAgo = (minutes: number): string =>
  new Date(Date.now() - minutes * MINUTE_MS).toISOString();

const WORKFLOW_ID = "01a06d02-c111-7a0e-8b3d-000000000001";
const RUN_ID = "01a06d02-c111-7a0e-8b3d-000000000002";

/** Returns an id that differs for every `n`. */
const buildId = (n: number): string =>
  `01a06d02-c111-7a0e-8b3d-${n.toString(16).padStart(12, "0")}`;

/** Returns an informational notification from a workflow run, created `minutes` ago. */
const buildNotification = (
  n: number,
  minutes: number,
  overrides: Partial<Notification> = {},
): Notification => ({
  id: buildId(100 + n),
  kind: "triage.fyi",
  title: `Notification ${String(n)}`,
  producer: { type: "run", runId: RUN_ID, stepId: "notify" },
  muteKey: `workflow:${WORKFLOW_ID}`,
  subject: [],
  actions: [],
  status: "resolved",
  createdAt: buildTimestampMinutesAgo(minutes),
  ...overrides,
});

/**
 * Returns the core's report that a run failed, created `minutes` ago. It has
 * no mute key, because the core cannot be muted.
 */
const buildRunFailed = (n: number, minutes: number, title: string): Notification => ({
  id: buildId(100 + n),
  kind: "core.run-failed",
  title,
  producer: { type: "core" },
  subject: [],
  actions: [],
  status: "resolved",
  createdAt: buildTimestampMinutesAgo(minutes),
});

/** Builds `notification.query`: newest first, filtered by `since`, paged by `limit` and cursor. */
const buildNotificationQuery =
  (held: () => readonly Notification[]): Handler =>
  (call: Call) => {
    const params = new URLSearchParams(call.search);
    const since = params.get("since");
    const limit = Number(params.get("limit") ?? "50");
    const offset = Number(params.get("cursor") ?? "0");
    const matching = held()
      .filter((each) => since === null || Date.parse(each.createdAt) >= Date.parse(since))
      .toSorted((a, b) => Date.parse(b.createdAt) - Date.parse(a.createdAt));
    const items = matching.slice(offset, offset + limit);
    const next = offset + limit;
    return {
      body: next < matching.length ? { items, nextCursor: String(next) } : { items },
    };
  };

/**
 * Builds a stub controller holding `notifications` (read on every request, so
 * a test can add to the array) and user settings that start as `user`.
 */
const buildController = ({
  notifications,
  user = {},
  handlers = {},
}: {
  readonly notifications: Notification[];
  readonly user?: Readonly<Record<string, unknown>>;
  /** More operations the controller serves, such as `notification.act`. */
  readonly handlers?: Readonly<Record<string, Handler>>;
}) => {
  let stored: Record<string, unknown> = {
    "onboarding.completedSteps": ["timezone", "assistant"],
    timezone: ZONE,
    ...user,
  };
  const api = stubApi({
    "GET /api/v1/setup": { body: { complete: true } },
    "GET /api/v1/settings": () => ({ body: { controller: {}, user: stored } }),
    "PATCH /api/v1/settings": (call) => {
      stored = { ...stored, ...(call.body as { user: Record<string, unknown> }).user };
      return { body: { controller: {}, user: stored } };
    },
    "GET /api/v1/notifications": buildNotificationQuery(() => notifications),
    ...handlers,
  });
  return { api, readStored: () => stored };
};

/** Returns the settings writes the screen sent, oldest first. */
const listSettingsWrites = (calls: readonly Call[]): unknown[] =>
  calls.filter((call) => call.method === "PATCH").map((call) => call.body);

/** Returns the row that holds `title`. */
const getRow = (title: string): HTMLElement => {
  const row = screen.getByText(title).closest("li");
  if (row === null) throw new Error(`no row holds ${title}`);
  return row;
};

/** Returns the sidebar's Notifications link. */
const getNotificationsLink = (): HTMLElement =>
  within(screen.getByRole("navigation", { name: "Hercule" })).getByRole("link", {
    name: /^Notifications/,
  });

describe("Notifications > the list", () => {
  it("lists every notification newest first, with its producer, body and age", async () => {
    const { api } = buildController({
      notifications: [
        buildNotification(1, 90),
        buildNotification(2, 5, {
          title: "Token expires soon",
          producer: { type: "plugin", pluginId: "gmail" },
          muteKey: "plugin:gmail",
          body: "Reconnect **gmail/work** before Friday.",
        }),
        buildRunFailed(3, 30, "Nightly failed"),
      ],
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    expectInDocumentOrder([
      screen.getByText("Token expires soon"),
      screen.getByText("Nightly failed"),
      screen.getByText("Notification 1"),
    ]);
    const plugin = getRow("Token expires soon");
    expect(readPageText(plugin)).toContain("gmail");
    expect(within(plugin).getByText("gmail/work").tagName).toBe("STRONG");
    expect(readPageText(plugin)).toContain("5m");
    expect(readPageText(getRow("Nightly failed"))).toContain("Hercule");
    expect(getRow("Nightly failed").querySelector("[data-mark=failed]")).not.toBeNull();
    expect(readPageText(getRow("Notification 1"))).toContain("Workflow run");
  });

  it("shows the empty state when there are no notifications", async () => {
    const { api } = buildController({ notifications: [] });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    expect(screen.getByText("Decisions and outcomes will land here.")).toBeDefined();
  });

  it("marks an open decision and says how a resolved one was resolved", async () => {
    const decision = { actions: [{ id: "start", label: "Start", operation: null }] };
    const { api } = buildController({
      notifications: [
        buildNotification(1, 10, { ...decision, title: "Start Bugfix?", status: "open" }),
        buildNotification(2, 20, {
          ...decision,
          title: "Merge PR #94?",
          resolution: {
            kind: "decided",
            actor: "user",
            origin: "web",
            at: buildTimestampMinutesAgo(15),
          },
        }),
        buildNotification(3, 30, {
          ...decision,
          title: "Reconnect gmail?",
          resolution: {
            kind: "withdrawn",
            actor: "system",
            origin: "core",
            reason: "token refreshed",
            at: buildTimestampMinutesAgo(25),
          },
        }),
      ],
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    expect(getRow("Start Bugfix?").querySelector("[data-mark=decision]")).not.toBeNull();
    expect(readPageText(getRow("Merge PR #94?"))).toContain(
      "Workflow run · decided in the web app",
    );
    expect(getRow("Merge PR #94?").querySelector("[data-mark=done]")).not.toBeNull();
    expect(readPageText(getRow("Reconnect gmail?"))).toContain("withdrawn: token refreshed");
    expect(getRow("Reconnect gmail?").querySelector("[data-mark=cancelled]")).not.toBeNull();
  });

  it("pages through the list with Load more", async () => {
    const notifications = Array.from({ length: 51 }, (_, n) => buildNotification(n, n + 1));
    const { api } = buildController({ notifications });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    expect(screen.queryByText("Notification 50")).toBeNull();
    await userEvent.setup().click(screen.getByRole("button", { name: "Load more" }));

    expect(await screen.findByText("Notification 50")).toBeDefined();
    expect(screen.queryByRole("button", { name: "Load more" })).toBeNull();
  });

  it("shows a notification created while the screen is open when the topic nudges", async () => {
    const notifications = [buildNotification(1, 10)];
    const { api } = buildController({ notifications });
    const { live } = await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    await waitFor(() => {
      expect(live.topics()).toContain("notification");
    });
    const created = buildNotification(2, 0, { title: "Fresh one" });
    notifications.push(created);
    act(() => {
      live.push("notification", { _tag: "invalidate", ids: [created.id], kind: "created" });
    });

    expect(await screen.findByText("Fresh one")).toBeDefined();
  });
});

describe("Notifications > answering a decision", () => {
  const DECISION_ID = buildId(101);
  const ACT = `POST /api/v1/notifications/${DECISION_ID}/act`;
  /** The answers as the controller stores them, without describe lines. */
  const stored: Notification["actions"] = [
    {
      id: "start",
      label: "Start Bugfix",
      description: "Opens a session on the task.",
      operation: { op: "run.start", input: { workflowId: WORKFLOW_ID } },
      primary: true,
    },
    { id: "dismiss", label: "Dismiss", operation: null },
  ];
  /** The answers of the open decision, with the describe lines the controller adds. */
  const answers: Notification["actions"] = [
    {
      ...stored[0]!,
      describeLine: [
        { kind: "text", text: "Start a run of " },
        { kind: "marked", text: "Bugfix" },
      ],
    },
    { ...stored[1]!, describeLine: [{ kind: "text", text: "Does nothing" }] },
  ];
  const open = buildNotification(1, 10, {
    actions: answers,
    title: "Start Bugfix?",
    status: "open",
  });
  /** The same decision once the user took `start` in the web app. */
  const decided: Notification = {
    ...open,
    actions: stored,
    status: "resolved",
    resolution: {
      kind: "decided",
      actionId: "start",
      actor: "user",
      origin: "web",
      at: new Date().toISOString(),
    },
  };

  /** Returns the answer rows of the open decision. */
  const getAnswers = (): HTMLElement[] =>
    within(getRow("Start Bugfix?")).getAllByRole("button", { name: /Start Bugfix|Dismiss/ });

  it("shows each answer's label, what it does and its description, and a resolved decision's not at all", async () => {
    const { api } = buildController({
      notifications: [
        open,
        buildNotification(2, 20, { ...decided, id: buildId(102), title: "Merge PR #94?" }),
      ],
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    const rows = getAnswers();
    expect(rows.map((row) => readPageText(row))).toEqual([
      "Start BugfixStart a run of BugfixOpens a session on the task.",
      "DismissDoes nothing",
    ]);
    for (const row of rows) expect(row).toHaveProperty("disabled", false);
    // The entity's name is set apart in ink; an answer that runs nothing is in italics.
    expect(within(rows[0]!).getByText("Bugfix").className).toContain("text-ink");
    expect(within(rows[1]!).getByText("Does nothing").className).toContain("italic");
    expect(within(rows[0]!).getByText("Start a run of", { exact: false }).className).not.toContain(
      "italic",
    );
    const resolved = getRow("Merge PR #94?");
    expect(within(resolved).queryByRole("button", { name: /Start Bugfix|Dismiss/ })).toBeNull();
  });

  it("takes the clicked answer, disables the rows until it is taken, then shows the decision resolved", async () => {
    const notifications = [open];
    let finish = (): void => {};
    const { api } = buildController({
      notifications,
      handlers: {
        [ACT]: () =>
          new Promise((resolve) => {
            finish = () => {
              notifications[0] = decided;
              resolve({ body: decided });
            };
          }),
      },
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    await userEvent.setup().click(getAnswers()[0]!);

    await waitFor(() => {
      for (const row of getAnswers()) expect(row).toHaveProperty("disabled", true);
    });
    expect(
      api.calls.filter((call) => call.method === "POST" && call.path.endsWith("/act")),
    ).toEqual([expect.objectContaining({ body: { actionId: "start" } })]);
    act(() => {
      finish();
    });

    await waitFor(() => {
      expect(readPageText(getRow("Start Bugfix?"))).toContain("decided in the web app");
    });
    expect(within(getRow("Start Bugfix?")).queryByRole("button", { name: /Dismiss/ })).toBeNull();
    expect(getRow("Start Bugfix?").querySelector("[data-mark=done]")).not.toBeNull();
  });

  it("keeps the decision open and shows the error when the answer cannot be taken", async () => {
    const { api } = buildController({
      notifications: [open],
      handlers: {
        [ACT]: {
          status: 409,
          body: buildErrorBody("invalid_state", "The workflow Bugfix is disabled."),
        },
      },
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    await userEvent.setup().click(getAnswers()[0]!);

    const alert = await within(getRow("Start Bugfix?")).findByRole("alert");
    expect(alert.textContent).toBe("The workflow Bugfix is disabled.");
    expect(getRow("Start Bugfix?").querySelector("[data-mark=decision]")).not.toBeNull();
    for (const row of getAnswers()) expect(row).toHaveProperty("disabled", false);
  });

  it("reads the notifications again when the answer cannot be taken, so a decision resolved elsewhere shows as resolved", async () => {
    const notifications = [open];
    const { api } = buildController({
      notifications,
      handlers: {
        // The decision was answered from another place just before this click.
        [ACT]: () => {
          notifications[0] = decided;
          return {
            status: 409,
            body: buildErrorBody("invalid_state", "The decision is already resolved."),
          };
        },
      },
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    await userEvent.setup().click(getAnswers()[0]!);

    await waitFor(() => {
      expect(readPageText(getRow("Start Bugfix?"))).toContain("decided in the web app");
    });
    expect(within(getRow("Start Bugfix?")).queryByRole("button", { name: /Dismiss/ })).toBeNull();
  });
});

describe("Notifications > since you last checked", () => {
  it("puts a new divider between what came since the last visit and what came before", async () => {
    const marker = buildTimestampMinutesAgo(60);
    const { api } = buildController({
      notifications: [buildNotification(1, 120), buildNotification(2, 30)],
      user: { "lastChecked.notifications": marker },
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    const checked = formatTimeContext(new Date(marker), ZONE) ?? "";
    const divider = screen.getByText(`new above · last checked ${checked}`);
    expectInDocumentOrder([
      screen.getByText("Notification 2"),
      divider,
      screen.getByText("Notification 1"),
    ]);
  });

  it("pins the last visit in the URL, writes now as the marker, and keeps the divider there", async () => {
    const marker = buildTimestampMinutesAgo(60);
    const { api, readStored } = buildController({
      notifications: [buildNotification(1, 120), buildNotification(2, 30)],
      user: { "lastChecked.notifications": marker },
    });
    const before = Date.now();
    const { router } = await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    await waitFor(() => {
      expect(listSettingsWrites(api.calls)).toHaveLength(1);
    });
    expect(router.state.location.search).toEqual({ since: marker });
    const advanced = readStored()["lastChecked.notifications"] as string;
    expect(Date.parse(advanced)).toBeGreaterThanOrEqual(before);
    expect(listSettingsWrites(api.calls)[0]).toEqual({
      user: { "lastChecked.notifications": advanced },
    });
    // The marker moved on, but the visit still counts from the pinned instant:
    // the divider and the top bar stay where they were.
    const checked = formatTimeContext(new Date(marker), ZONE) ?? "";
    expect(screen.getByText(`new above · last checked ${checked}`)).toBeDefined();
    expect(screen.getByText(`since ${checked}`)).toBeDefined();
  });

  it("keeps the pinned instant on a refresh and does not move the marker again", async () => {
    const marker = buildTimestampMinutesAgo(60);
    const { api } = buildController({
      notifications: [buildNotification(1, 120), buildNotification(2, 30)],
      user: { "lastChecked.notifications": buildTimestampMinutesAgo(1) },
    });
    await renderApp({
      path: `/notifications?since=${encodeURIComponent(marker)}`,
      api: api.fetch,
      token: "held",
    });

    const checked = formatTimeContext(new Date(marker), ZONE) ?? "";
    expect(screen.getByText(`new above · last checked ${checked}`)).toBeDefined();
    expect(listSettingsWrites(api.calls)).toHaveLength(0);
  });

  it("shows everything as new, with no divider, on the first visit", async () => {
    const { api } = buildController({
      notifications: [buildNotification(1, 120), buildNotification(2, 30)],
    });
    const { router } = await renderApp({ path: "/notifications", api: api.fetch, token: "held" });

    await waitFor(() => {
      expect(listSettingsWrites(api.calls)).toHaveLength(1);
    });
    expect(router.state.location.search).toEqual({ since: "never" });
    expect(screen.queryByText(/^new above/)).toBeNull();
    expect(screen.getByText("Notification 1")).toBeDefined();
  });
});

describe("Notifications > muting", () => {
  it("writes the whole mute list and marks the producer's notifications muted", async () => {
    const { api } = buildController({
      notifications: [
        buildNotification(1, 10),
        buildNotification(2, 20),
        buildRunFailed(3, 30, "Nightly failed"),
      ],
      user: { "notifications.muted": ["plugin:gmail"] },
    });
    await renderApp({ path: "/notifications", api: api.fetch, token: "held" });
    await waitFor(() => {
      expect(listSettingsWrites(api.calls)).toHaveLength(1);
    });

    // The core cannot be muted, so its notification has no button.
    expect(within(getRow("Nightly failed")).queryByRole("button")).toBeNull();

    await userEvent
      .setup()
      .click(within(getRow("Notification 1")).getByRole("button", { name: "Mute workflow" }));

    await waitFor(() => {
      expect(listSettingsWrites(api.calls)).toHaveLength(2);
    });
    expect(listSettingsWrites(api.calls)[1]).toEqual({
      user: { "notifications.muted": ["plugin:gmail", `workflow:${WORKFLOW_ID}`] },
    });
    // Both notifications of the workflow are muted, and both still show.
    for (const title of ["Notification 1", "Notification 2"]) {
      const row = getRow(title);
      expect(within(row).getByText("muted")).toBeDefined();
      expect(within(row).getByRole("button", { name: "Unmute workflow" })).toBeDefined();
    }
  });
});

describe("the sidebar's notifications count", () => {
  it("counts the notifications since the marker, and follows the topic", async () => {
    const marker = buildTimestampMinutesAgo(60);
    const notifications = [
      buildNotification(1, 120),
      buildNotification(2, 30),
      buildNotification(3, 20),
    ];
    const { api } = buildController({
      notifications,
      user: { "lastChecked.notifications": marker },
    });
    const { live } = await renderApp({ path: "/intake", api: api.fetch, token: "held" });

    expect(await within(getNotificationsLink()).findByText("2")).toBeDefined();
    const read = api.calls.find((call) => call.path === "/api/v1/notifications");
    expect(new URLSearchParams(read?.search).get("since")).toBe(marker);
    expect(new URLSearchParams(read?.search).get("limit")).toBe("100");

    await waitFor(() => {
      expect(live.topics()).toContain("notification");
    });
    const created = buildNotification(4, 0);
    notifications.push(created);
    act(() => {
      live.push("notification", { _tag: "invalidate", ids: [created.id], kind: "created" });
    });

    expect(await within(getNotificationsLink()).findByText("3")).toBeDefined();
  });

  it("reads 99+ above 99", async () => {
    const { api } = buildController({
      notifications: Array.from({ length: 120 }, (_, n) => buildNotification(n, n + 1)),
    });
    await renderApp({ path: "/intake", api: api.fetch, token: "held" });

    expect(await within(getNotificationsLink()).findByText("99+")).toBeDefined();
  });

  it("drops to nothing once the notification center is opened", async () => {
    const { api } = buildController({
      notifications: [buildNotification(1, 20), buildNotification(2, 10)],
      user: { "lastChecked.notifications": buildTimestampMinutesAgo(60) },
    });
    await renderApp({ path: "/intake", api: api.fetch, token: "held" });
    expect(await within(getNotificationsLink()).findByText("2")).toBeDefined();

    await userEvent.setup().click(getNotificationsLink());

    await waitFor(() => {
      expect(getNotificationsLink().textContent).toBe("Notifications");
    });
    // The screen still shows both as new: it counts from the pinned visit.
    expect(screen.getByText("Notification 1")).toBeDefined();
    expect(screen.queryByText(/^new above/)).toBeNull();
  });
});
