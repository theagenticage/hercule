/**
 * Tests the Clean up… button and the cleanup dialog through the rendered app:
 * the dialog's groups, what the button archives and removes, a workspace used
 * since the dialog opened, the partial result with Try again, the toast when
 * everything is removed, an archive that is refused, and the empty machine.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildWorkspace } from "@hercule/client-core/threads/testing";
import {
  USED_SINCE_LOOKED_REFUSAL,
  type MutableLiveTopic,
  type Runner,
  type Session,
  type Workspace,
} from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubIntersectionObserver,
  type Call,
} from "../../../../app/testing";
import { rememberMachineView } from "../../../../screens/fleet/machine-view";

const GIB = 1024 ** 3;
const GB = 1e9;

beforeEach(() => {
  // Monday 2 November 2026, 14:00 in UTC, the time zone the settings name.
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
  rememberMachineView("grid");
  stubIntersectionObserver();
});

afterEach(() => {
  vi.useRealTimers();
});

/** Orbit's disk is 87% full, so its card offers Clean up…. */
const ORBIT: Runner = {
  ...SIDEBAR_FIXTURE.runners[0]!,
  id: "01a06d02-a000-7000-8000-000000000004",
  name: "orbit",
  connectivity: "online",
  lifecycle: "active",
  facts: { ...SIDEBAR_FIXTURE.runners[0]!.facts!, diskTotalBytes: 500 * GIB },
  metrics: { diskFreeBytes: 65 * GIB, availableMemoryBytes: 24 * GIB },
  maxConcurrentSessions: 16,
  diskWatermarkBytes: 10 * GIB,
};

const uuid = (number: number): string =>
  `01a06d02-7400-7000-8000-${String(number).padStart(12, "0")}`;

/** Returns an idle ephemeral workspace of orbit, last used on `lastUsedAt`, that frees `freesGb` GB. */
const buildIdle = (number: number, freesGb: number, lastUsedAt: string): Workspace =>
  buildWorkspace({
    id: uuid(number),
    runnerId: ORBIT.id,
    kind: "ephemeral",
    lastUsedAt,
    diskUsage: {
      sizeBytes: freesGb * 2 * GB,
      freesBytes: freesGb * GB,
      measuredAt: "2026-11-01T09:00:00.000Z",
    },
  });

const DONE_A = buildIdle(10, 30, "2026-10-10T09:00:00.000Z");
const DONE_B = buildIdle(11, 11, "2026-10-12T09:00:00.000Z");
const OPEN_C = buildIdle(12, 8, "2026-10-14T09:00:00.000Z");

/** Returns the Thread "Thread <number>" in `workspace`, Done unless `isDone` is false. */
const buildThread = (number: number, workspace: Workspace, isDone = true): Session => ({
  ...SIDEBAR_FIXTURE.threads[0]!,
  id: uuid(number),
  workspaceId: workspace.id,
  title: `Thread ${String(number)}`,
  runnerId: ORBIT.id,
  status: "idle",
  ...(isDone ? { done: { at: "2026-10-11T09:00:00.000Z", by: "user" as const } } : {}),
});

const THREADS = [
  buildThread(101, DONE_A),
  buildThread(102, DONE_A),
  buildThread(103, DONE_B),
  buildThread(104, OPEN_C, false),
];

/** Returns what the controller answers `session.archive` with: the Threads, archived. */
const archived = (ids: readonly string[]): Session[] =>
  THREADS.filter((thread) => ids.includes(thread.id)).map((thread) => ({
    ...thread,
    archived: { at: "2026-11-02T14:00:00.000Z", by: "user" as const },
  }));

interface World {
  /** What the controller lists as the workspaces. A test changes it, then pushes on `workspace`. */
  workspaces: Workspace[];
  /** How `workspace.disposeMany` answers a workspace: `requested` unless the test refuses it. */
  refuse: Map<string, string>;
  archiveAnswer: { status?: number; body: unknown } | null;
}

/**
 * Opens the Fleet page with orbit and its idle workspaces. `disposeMany`
 * reserves the workspaces it accepts at once, as the controller does: they
 * read as `disposing` from then on.
 */
const openFleet = async (workspaces: Workspace[] = [DONE_A, DONE_B, OPEN_C]) => {
  const world: World = { workspaces, refuse: new Map(), archiveAnswer: null };
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [] }),
    "GET /api/v1/runners": { body: { items: [ORBIT] } },
    "GET /api/v1/workspaces": () => ({ body: { items: world.workspaces } }),
    "GET /api/v1/sessions": (call: Call) =>
      new URLSearchParams(call.search).has("workspaceId")
        ? { body: { items: THREADS } }
        : { body: { items: [] } },
    "POST /api/v1/sessions/archive": (call: Call) =>
      world.archiveAnswer ?? {
        body: archived((call.body as { sessionIds: string[] }).sessionIds),
      },
    "POST /api/v1/workspaces/dispose": (call: Call) => {
      const { items } = call.body as { items: { workspaceId: string }[] };
      const results = items.map(({ workspaceId }) => {
        const message = world.refuse.get(workspaceId);
        if (message !== undefined) return { workspaceId, outcome: "refused", message };
        world.workspaces = world.workspaces.map((workspace) =>
          workspace.id === workspaceId ? { ...workspace, status: "disposing" } : workspace,
        );
        return { workspaceId, outcome: "requested" };
      });
      return { body: { results } };
    },
    "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
    "GET /api/v1/controller": {
      body: {
        id: "01a06d02-c000-7000-8000-000000000001",
        publicKey: "key",
        version: "0.9.3",
        defaultRunnerId: null,
        localRunnerId: null,
        textGeneration: { model: null, unavailableReason: null, lastFailure: null },
      },
    },
  });
  const app = await renderApp(
    createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }),
    { path: "/fleet" },
  );
  await screen.findByRole("navigation", { name: "Fleet" });
  return { world, calls, ...app };
};

/** Presses Clean up… on orbit's card and returns the dialog it opens. */
const openDialog = async (): Promise<HTMLElement> => {
  await userEvent.click(await screen.findByRole("button", { name: "Clean up…" }));
  return screen.findByRole("dialog", { name: "Clean up orbit" });
};

/** Returns the checkbox of the row or the group whose name starts with `name`. */
const getBox = (dialog: HTMLElement, name: string): HTMLInputElement =>
  within(dialog).getByRole<HTMLInputElement>("checkbox", { name: new RegExp(`^${name}`) });

/** Lists the dialog's rows as [name, when it was last used, what removing it frees]. */
const readRows = (dialog: HTMLElement): string[][] =>
  [...dialog.querySelectorAll("li.cleanup-row")].map((row) =>
    [".cleanup-name b", ".cleanup-age", ".cleanup-frees"].map(
      (selector) => row.querySelector(selector)?.textContent ?? "",
    ),
  );

/** Changes the workspaces the controller lists, then pushes on the `workspace` topic as it would. */
const changeWorkspaces = (
  world: World,
  live: { pushInvalidation: (topic: MutableLiveTopic, ids: string[]) => void },
  changes: Record<string, Partial<Workspace>>,
): void => {
  world.workspaces = world.workspaces.map((workspace) => ({
    ...workspace,
    ...changes[workspace.id],
  }));
  act(() => {
    live.pushInvalidation("workspace", Object.keys(changes));
  });
};

/** Returns the toast that is up, or `null` when none is. */
const readToast = (): string | null => document.querySelector(".side-toast")?.textContent ?? null;

const ARCHIVE_PATH = "/api/v1/sessions/archive";
const DISPOSE_PATH = "/api/v1/workspaces/dispose";
const ALL_REMOVED_TOAST = "Archived 3 threads and removed 2 workspaces. 41 GB freed.";

describe("the cleanup dialog", () => {
  it("lists the workspaces in two groups, the largest first, with the Done ones ticked", async () => {
    await openFleet();

    const dialog = await openDialog();

    expect(
      within(dialog)
        .getAllByText(/^Threads (Done|not Done)$/)
        .map((each) => each.textContent),
    ).toEqual(["Threads Done", "Threads not Done"]);
    expect(readRows(dialog)).toEqual([
      ["Thread 101", "3 weeks ago", "30 GB"],
      ["Thread 103", "3 weeks ago", "11 GB"],
      ["Thread 104", "2 weeks ago", "8 GB"],
    ]);
    expect(
      ["Threads Done", "Thread 101", "Thread 103", "Threads not Done", "Thread 104"].map(
        (name) => getBox(dialog, name).checked,
      ),
    ).toEqual([true, true, true, false, false]);
    expect(
      within(dialog).getByRole("button", { name: "Archive and remove 2, frees 41 GB" }),
    ).toBeTruthy();
    expect(
      within(dialog).getByText(
        "Everything in these workspaces is deleted, files you never committed included.",
      ),
    ).toBeTruthy();
  });

  it("ticks a whole group from its head, and shows a group with some rows ticked as mixed", async () => {
    const user = userEvent.setup();
    await openFleet();
    const dialog = await openDialog();
    const doneGroup = getBox(dialog, "Threads Done");

    await user.click(getBox(dialog, "Threads not Done"));
    expect(
      within(dialog).getByRole("button", { name: "Archive and remove 3, frees 49 GB" }),
    ).toBeTruthy();

    await user.click(getBox(dialog, "Thread 103"));
    expect(doneGroup.indeterminate).toBe(true);
    expect(
      within(dialog).getByRole("button", { name: "Archive and remove 2, frees 38 GB" }),
    ).toBeTruthy();

    await user.click(doneGroup);
    expect(doneGroup.indeterminate).toBe(false);
    expect(doneGroup.checked).toBe(true);
  });

  it("archives the Threads and asks for the removals as the dialog showed them", async () => {
    const user = userEvent.setup();
    const { calls } = await openFleet();
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole("button", { name: /^Archive and remove/ }));

    await within(dialog).findAllByText("Removing…");
    const archive = calls.find((call) => call.path === ARCHIVE_PATH);
    expect(archive?.body).toEqual({ sessionIds: [uuid(101), uuid(102), uuid(103)] });
    const dispose = calls.find((call) => call.path === DISPOSE_PATH);
    expect(dispose?.body).toEqual({
      items: [
        { workspaceId: DONE_A.id, expectedLastUsedAt: DONE_A.lastUsedAt },
        { workspaceId: DONE_B.id, expectedLastUsedAt: DONE_B.lastUsedAt },
      ],
    });
  });

  it("closes the dialog and shows the toast once every workspace is removed", async () => {
    const user = userEvent.setup();
    const { world, live } = await openFleet();
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole("button", { name: /^Archive and remove/ }));
    await within(dialog).findAllByText("Removing…");

    changeWorkspaces(world, live, {
      [DONE_A.id]: { status: "deleted" },
      [DONE_B.id]: { status: "deleted" },
    });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Clean up orbit" })).toBeNull();
    });
    expect(readToast()).toContain(ALL_REMOVED_TOAST);
  });

  it("keeps removing when the dialog is closed, shows the progress again when it is reopened, and ends with the toast", async () => {
    const user = userEvent.setup();
    const { world, live } = await openFleet();
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole("button", { name: /^Archive and remove/ }));
    await within(dialog).findAllByText("Removing…");

    await user.click(within(dialog).getByRole("button", { name: "Close" }));
    expect(screen.queryByRole("dialog", { name: "Clean up orbit" })).toBeNull();
    const reopened = await openDialog();
    expect(within(reopened).getAllByText("Removing…")).toHaveLength(2);
    await user.click(within(reopened).getByRole("button", { name: "Close" }));

    changeWorkspaces(world, live, {
      [DONE_A.id]: { status: "deleted" },
      [DONE_B.id]: { status: "deleted" },
    });

    await waitFor(() => {
      expect(readToast()).toContain(ALL_REMOVED_TOAST);
    });
  });

  it("refuses a workspace used since the dialog opened with no Try again, and keeps the rest of the result", async () => {
    const user = userEvent.setup();
    const { world, live } = await openFleet();
    world.refuse.set(DONE_B.id, USED_SINCE_LOOKED_REFUSAL);
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole("button", { name: /^Archive and remove/ }));
    changeWorkspaces(world, live, { [DONE_A.id]: { status: "deleted" } });

    expect(
      await within(dialog).findByText("Archived 3 threads. Removed 1 of 2 workspaces."),
    ).toBeTruthy();
    expect(within(dialog).getByText("Used since you looked.")).toBeTruthy();
    expect(within(dialog).queryByRole("button", { name: "Try again" })).toBeNull();
    // The dialog shows the result in its head, so no toast says it as well.
    expect(readToast()).toBeNull();
  });

  it("offers Try again for a refusal of the machine, and asks again for that workspace alone", async () => {
    const user = userEvent.setup();
    const { world, live, calls } = await openFleet();
    const dialog = await openDialog();
    await user.click(within(dialog).getByRole("button", { name: /^Archive and remove/ }));
    await within(dialog).findAllByText("Removing…");

    changeWorkspaces(world, live, {
      [DONE_A.id]: { status: "deleted" },
      [DONE_B.id]: { status: "ready", message: "A process still has a file open." },
    });

    expect(
      await within(dialog).findByText("Archived 3 threads. Removed 1 of 2 workspaces."),
    ).toBeTruthy();
    expect(within(dialog).getByText("A process still has a file open.")).toBeTruthy();

    await user.click(within(dialog).getByRole("button", { name: "Try again" }));
    await waitFor(() => {
      expect(calls.filter((call) => call.path === DISPOSE_PATH)).toHaveLength(2);
    });
    const second = calls.filter((call) => call.path === DISPOSE_PATH)[1]!;
    expect(second.body).toEqual({
      items: [{ workspaceId: DONE_B.id, expectedLastUsedAt: DONE_B.lastUsedAt }],
    });
    expect(calls.filter((call) => call.path === ARCHIVE_PATH)).toHaveLength(1);
    // Still removing: the old reason is gone with the retry.
    await waitFor(() => {
      expect(within(dialog).queryByText("A process still has a file open.")).toBeNull();
    });

    changeWorkspaces(world, live, { [DONE_B.id]: { status: "deleted" } });

    await waitFor(() => {
      expect(screen.queryByRole("dialog", { name: "Clean up orbit" })).toBeNull();
    });
    expect(readToast()).toContain(ALL_REMOVED_TOAST);
  });

  it("shows the controller's message and removes nothing when the archive is refused", async () => {
    const user = userEvent.setup();
    const { world, calls } = await openFleet();
    world.archiveAnswer = {
      status: 409,
      body: buildErrorBody("invalid_state", "Thread 104 started working again."),
    };
    const dialog = await openDialog();

    await user.click(within(dialog).getByRole("button", { name: /^Archive and remove/ }));

    expect((await within(dialog).findByRole("alert")).textContent).toBe(
      "Thread 104 started working again.",
    );
    expect(calls.some((call) => call.path === DISPOSE_PATH)).toBe(false);
    // The groups are still there, so the user may change the ticks and press again.
    expect(within(dialog).getByRole("button", { name: /^Archive and remove/ })).toBeTruthy();
  });

  it("says there is nothing to clean up when no workspace is idle", async () => {
    await openFleet([]);

    const dialog = await openDialog();

    expect(
      within(dialog).getByText(
        "Nothing to clean up. Every workspace here was used in the last 7 days.",
      ),
    ).toBeTruthy();
    expect(within(dialog).queryByRole("checkbox")).toBeNull();
    expect(within(dialog).getByRole("button", { name: "Close" })).toBeTruthy();
  });

  it("is disabled with its reason as a tooltip on the page of a machine that is offline", async () => {
    const user = userEvent.setup();
    const offline: Runner = { ...ORBIT, connectivity: "offline" };
    stubApi({
      ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, runners: [] }),
      "GET /api/v1/runners": { body: { items: [offline] } },
      [`GET /api/v1/runners/${offline.id}`]: {
        body: { ...offline, negotiatedCapabilities: null, protocolVersion: null },
      },
      "GET /api/v1/workspaces": { body: { items: [DONE_A] } },
      "GET /api/v1/sessions": { body: { items: THREADS } },
      "GET /api/v1/settings": { body: { controller: {}, user: { timezone: "UTC" } } },
      "GET /api/v1/controller": {
        body: {
          id: "01a06d02-c000-7000-8000-000000000001",
          publicKey: "key",
          version: "0.9.3",
          defaultRunnerId: null,
          localRunnerId: null,
          textGeneration: { model: null, unavailableReason: null, lastFailure: null },
        },
      },
    });
    await renderApp(createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" }), {
      path: `/fleet/${offline.id}`,
    });

    const button = await screen.findByRole("button", { name: "Clean up…" });
    await user.click(button);

    expect(button.getAttribute("aria-disabled")).toBe("true");
    expect(button.getAttribute("title")).toBe("orbit is offline. Cleaning up needs it online.");
    expect(screen.queryByRole("dialog")).toBeNull();
  });
});
