/**
 * Tests archiving as the signed-in app renders it, against a stubbed
 * controller that archives Threads as the real one does: from the Done
 * shelf (a row's Archive and "Archive all"), from the open thread's header,
 * and the toast that follows. jsdom lays nothing out, so each test stubs the
 * size of the sidebar.
 */
import { beforeEach, describe, expect, it } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { Session } from "@hercule/contract";
import {
  buildErrorBody,
  buildSidebarHandlers,
  buildThreadHandlers,
  CONTROLLER_URL,
  createFakeBridge,
  FIXTURE_THREAD_IDS,
  renderApp,
  SIDEBAR_FIXTURE,
  stubApi,
  stubElementSize,
  THREAD_FIXTURES,
  type Call,
  type Handler,
} from "../app/testing";

const ARCHIVE_PATH = "/api/v1/sessions/archive";
const ARCHIVED_AT = "2026-11-02T12:00:00.000Z";

beforeEach(() => {
  stubElementSize(272, 800);
});

/** "Sketch the pricing page": idle, in no workspace, so a row of its own. The base of the threads a test makes. */
const PLAIN_THREAD = SIDEBAR_FIXTURE.threads.find(
  (session) => session.id === FIXTURE_THREAD_IDS.pricingPage,
)!;

/**
 * Returns a Thread "Thread <number>" in no workspace, marked Done `number`
 * minutes after 09:00, so a higher number is a more recent Done. `over`
 * changes its fields, such as `status: "busy"`.
 */
const buildDoneThread = (number: number, over: Partial<Session> = {}): Session => ({
  ...PLAIN_THREAD,
  id: `01a06d02-7400-7000-8000-${String(1000 + number).padStart(12, "0")}`,
  title: `Thread ${String(number)}`,
  createdAt: "2026-09-10T08:00:00.000Z",
  lastActivityAt: "2026-09-10T08:00:00.000Z",
  done: { at: new Date(Date.UTC(2026, 8, 10, 9, number)).toISOString(), by: "user" },
  ...over,
});

/** The ids an archive request carries. */
const readSessionIds = (call: Call): readonly string[] =>
  (call.body as { readonly sessionIds: readonly string[] }).sessionIds;

/** Returns the archive requests the app sent, oldest first. */
const readArchiveRequests = (calls: readonly Call[]): readonly (readonly string[])[] =>
  calls.filter((call) => call.path === ARCHIVE_PATH).map(readSessionIds);

/**
 * Starts the app signed in at `path` against a controller that holds
 * `initial`. Its Threads list leaves out the archived ones, and `POST
 * /sessions/archive` archives the Threads it names, unless `refuse` is given
 * to answer in its place.
 */
const startApp = async (
  initial: readonly Session[],
  {
    path = "/",
    refuse,
    handlers = {},
  }: {
    readonly path?: string;
    readonly refuse?: Handler;
    readonly handlers?: Readonly<Record<string, Handler>>;
  } = {},
) => {
  let threads = initial;
  const calls = stubApi({
    ...buildSidebarHandlers({ ...SIDEBAR_FIXTURE, threads, agentSessions: [] }),
    ...handlers,
    // Each Thread's own record follows the controller's state, archived or not.
    ...Object.fromEntries(
      initial.map((each) => [
        `GET /api/v1/sessions/${each.id}`,
        () => ({ body: threads.find((session) => session.id === each.id) }),
      ]),
    ),
    "GET /api/v1/sessions": () => ({
      body: { items: threads.filter((session) => session.archived === undefined) },
    }),
    [`POST ${ARCHIVE_PATH}`]:
      refuse ??
      ((call) => {
        const ids = readSessionIds(call);
        threads = threads.map((session) =>
          ids.includes(session.id)
            ? { ...session, archived: { at: ARCHIVED_AT, by: "user" as const } }
            : session,
        );
        return { body: threads.filter((session) => ids.includes(session.id)) };
      }),
  });
  const fake = createFakeBridge({ controllerUrl: CONTROLLER_URL, token: "bearer" });
  const app = await renderApp(fake, { path });
  const nav = await screen.findByRole("navigation", { name: "Threads" });
  return { calls, nav, ...app };
};

/** Opens the Done shelf, and returns its heading. */
const openShelf = async (nav: HTMLElement): Promise<HTMLElement> => {
  const heading = within(nav).getByRole("button", { name: /^Done \d+$/ });
  await userEvent.click(heading);
  return heading;
};

/** Returns the confirmation dialog, once it shows. */
const findConfirmation = (title: string): Promise<HTMLElement> =>
  screen.findByRole("dialog", { name: title });

describe("archiving from the Done shelf", () => {
  it("asks first, archives the row's Threads, and says only Archived, with no Undo", async () => {
    const { nav, calls } = await startApp([buildDoneThread(1), buildDoneThread(2)]);
    await openShelf(nav);
    const row = within(nav).getByRole("link", { name: "Thread 1, done" });

    await userEvent.click(
      within(row.closest<HTMLElement>(".side-item")!).getByRole("button", { name: "Archive" }),
    );
    const dialog = await findConfirmation("Archive Thread 1?");
    expect(document.activeElement).toBe(within(dialog).getByRole("button", { name: "Keep it" }));
    expect(readArchiveRequests(calls)).toEqual([]);
    await userEvent.click(within(dialog).getByRole("button", { name: "Archive" }));

    const toast = await screen.findByText("Archived");
    expect(toast.parentElement!.getAttribute("role")).toBe("status");
    expect(within(toast.parentElement!).queryByRole("button", { name: "Undo" })).toBeNull();
    expect(readArchiveRequests(calls)).toEqual([[buildDoneThread(1).id]]);
    await waitFor(() => {
      expect(within(nav).queryByRole("link", { name: "Thread 1, done" })).toBeNull();
    });
    expect(within(nav).getByRole("link", { name: "Thread 2, done" })).toBeTruthy();
  });

  it("does nothing when the user keeps the row", async () => {
    const { nav, calls } = await startApp([buildDoneThread(1)]);
    await openShelf(nav);

    await userEvent.click(within(nav).getByRole("button", { name: "Archive" }));
    await userEvent.click(
      within(await findConfirmation("Archive Thread 1?")).getByRole("button", { name: "Keep it" }),
    );

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readArchiveRequests(calls)).toEqual([]);
    expect(within(nav).getByRole("link", { name: "Thread 1, done" })).toBeTruthy();
  });

  it("disables Archive on a row that works, with the reason as its tooltip", async () => {
    const { nav, calls } = await startApp([buildDoneThread(1, { status: "busy" })]);
    await openShelf(nav);

    const archive = within(nav).getByRole("button", { name: "Archive" });
    expect(archive.getAttribute("aria-disabled")).toBe("true");
    expect(archive.title).toBe("Thread 1 is working. Stop it first.");
    await userEvent.click(archive);

    expect(screen.queryByRole("dialog")).toBeNull();
    expect(readArchiveRequests(calls)).toEqual([]);
  });

  it("shows the controller's message as an alert when it refuses, and keeps the row", async () => {
    const { nav } = await startApp([buildDoneThread(1)], {
      refuse: {
        status: 409,
        body: buildErrorBody("invalid_state", "Thread 1 started working."),
      },
    });
    await openShelf(nav);

    await userEvent.click(within(nav).getByRole("button", { name: "Archive" }));
    await userEvent.click(
      within(await findConfirmation("Archive Thread 1?")).getByRole("button", { name: "Archive" }),
    );

    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't archive: Thread 1 started working.");
    expect(within(nav).getByRole("link", { name: "Thread 1, done" })).toBeTruthy();
  });

  it("shows Archive all only while the shelf is open", async () => {
    const { nav } = await startApp([buildDoneThread(1)]);
    expect(within(nav).queryByRole("button", { name: "Archive all" })).toBeNull();

    await openShelf(nav);

    expect(within(nav).getByRole("button", { name: "Archive all" })).toBeTruthy();
  });

  it("archives every row the shelf holds with Archive all, oldest first, and says how many working rows it skipped", async () => {
    const threads = [
      buildDoneThread(3),
      buildDoneThread(1),
      buildDoneThread(4, { status: "busy" }),
      buildDoneThread(2),
    ];
    const { nav, calls } = await startApp(threads);
    await openShelf(nav);

    await userEvent.click(within(nav).getByRole("button", { name: "Archive all" }));
    await userEvent.click(
      within(await findConfirmation("Archive 3 rows?")).getByRole("button", { name: "Archive" }),
    );

    expect(await screen.findByText("Archived 3. 1 working row skipped.")).toBeTruthy();
    expect(readArchiveRequests(calls)).toEqual([
      [1, 2, 3].map((number) => buildDoneThread(number).id),
    ]);
    // Only the working row is left on the shelf.
    await waitFor(() => {
      expect(within(nav).getByRole("button", { name: "Done 1" })).toBeTruthy();
    });
  });

  it("archives at most 500 Threads in one call, whole rows, and says how many rows are left", async () => {
    const threads = [
      ...Array.from({ length: 502 }, (_, index) => buildDoneThread(index + 1)),
      buildDoneThread(600, { status: "queued" }),
    ];
    const { nav, calls } = await startApp(threads);
    await openShelf(nav);

    await userEvent.click(within(nav).getByRole("button", { name: "Archive all" }));
    await userEvent.click(
      within(await findConfirmation("Archive 500 rows?")).getByRole("button", {
        name: "Archive",
      }),
    );

    expect(
      await screen.findByText("Archived 500. 1 working row skipped. 2 rows left."),
    ).toBeTruthy();
    const [sent] = readArchiveRequests(calls);
    expect(sent).toHaveLength(500);
    expect(sent![0]).toBe(buildDoneThread(1).id);
    expect(sent!.at(-1)).toBe(buildDoneThread(500).id);
  });

  it("disables Archive all when every row on the shelf works", async () => {
    const { nav } = await startApp([buildDoneThread(1, { status: "busy" })]);
    await openShelf(nav);

    const all = within(nav).getByRole("button", { name: "Archive all" });
    expect(all.getAttribute("aria-disabled")).toBe("true");
    await userEvent.click(all);

    expect(screen.queryByRole("dialog")).toBeNull();
  });
});

describe("archiving from the open thread's header", () => {
  it("archives the thread, shows Archived, and turns the header into the archived header", async () => {
    const thread = THREAD_FIXTURES.finished.session;
    const { calls, nav } = await startApp(SIDEBAR_FIXTURE.threads, {
      path: `/threads/${thread.id}`,
      handlers: buildThreadHandlers(THREAD_FIXTURES.finished),
    });
    const header = await screen.findByRole("banner");

    await userEvent.click(await within(header).findByRole("button", { name: "More" }));
    await userEvent.click(screen.getByRole("menuitem", { name: "Archive…", hidden: true }));
    await userEvent.click(
      within(await findConfirmation("Archive Bump the Bun pin?")).getByRole("button", {
        name: "Archive",
      }),
    );

    expect(await within(header).findByText("Archived 2 Nov")).toBeTruthy();
    expect(within(header).queryByRole("button", { name: "More" })).toBeNull();
    expect(within(header).queryByRole("button", { name: "Mark done" })).toBeNull();
    expect(screen.getByText("Archived").parentElement!.getAttribute("role")).toBe("status");
    expect(readArchiveRequests(calls)).toEqual([[thread.id]]);
    // The sidebar no longer holds the thread, though it is open.
    expect(within(nav).queryByRole("link", { name: /^Bump the Bun pin/ })).toBeNull();
  });
});
