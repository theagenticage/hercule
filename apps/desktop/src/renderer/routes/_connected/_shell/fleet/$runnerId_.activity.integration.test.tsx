/**
 * Tests a machine's Activity page (spec 17 §Fleet, Activity): its header, the
 * days and entries, the filters, an entry that unfolds, and reading older
 * pages as the user scrolls or filters.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { EventWithFacts } from "@hercule/contract";
import { stubElementSize, stubIntersectionObserver } from "../../../../app/testing";
import {
  ATLAS,
  buildCameOnline,
  buildSessionSpawned,
  buildStoppedNewWork,
  buildWentOffline,
  openMachineWithEvents,
} from "./-machine-activity.testing";

beforeEach(() => {
  stubIntersectionObserver();
  // jsdom lays nothing out, so without this the list would find no room for any line.
  stubElementSize(900, 700);
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
});

const ACTIVITY_PATH = `/fleet/${ATLAS.id}/activity`;

/** Yesterday's two entries, then today's four, with three sessions spawned in one minute among them. */
const buildSixEntries = () => [
  buildWentOffline(1000),
  buildCameOnline(990),
  buildStoppedNewWork(300),
  buildSessionSpawned(120, "01a06d02-0000-7000-8000-0000000000a1"),
  buildSessionSpawned(120, "01a06d02-0000-7000-8000-0000000000a2"),
  buildSessionSpawned(120, "01a06d02-0000-7000-8000-0000000000a3"),
  buildWentOffline(60),
];

/**
 * Builds `count` entries of the machine coming online, one every two minutes
 * going back from two minutes ago, so no two fold into one. The oldest is
 * built first.
 */
const buildQuietEntries = (count: number): EventWithFacts[] =>
  Array.from({ length: count }, (_, index) => buildCameOnline((count - index) * 2));

const openActivity = async (events: readonly EventWithFacts[]) => {
  const opened = await openMachineWithEvents(ACTIVITY_PATH, events);
  await screen.findByRole("heading", { level: 2, name: "Activity" });
  // The controller's first push on each topic reads the shell's data again. Waiting for it
  // keeps it out of the requests a test counts.
  await opened.app.live.waitForFirstPushes();
  return opened;
};

/** Returns the text of each line of the list, in order: day headings, entries and members. */
const readLines = (): readonly string[] =>
  Array.from(
    document.querySelectorAll(
      ".machine-activity-day, .machine-activity-row, .machine-activity-member",
    ),
    (line) => line.textContent,
  );

const readEventCalls = (calls: readonly { readonly path: string; readonly search: string }[]) =>
  calls.filter((call) => call.path === "/api/v1/events");

const getScrollArea = (): HTMLElement => document.querySelector<HTMLElement>(".fleet-scroll")!;

describe("the Activity page's header", () => {
  it("shows the crumbs Fleet, the machine and Activity, with Add a machine and no jump links", async () => {
    await openActivity(buildSixEntries());

    const crumbs = within(screen.getByRole("navigation", { name: "Fleet" }));
    expect(crumbs.getByRole("link", { name: "Fleet" }).getAttribute("href")).toBe("/fleet");
    expect(crumbs.getByRole("link", { name: "atlas" }).getAttribute("href")).toBe(
      `/fleet/${ATLAS.id}`,
    );
    expect(crumbs.getByText("Activity").getAttribute("aria-current")).toBe("page");
    expect(crumbs.queryAllByRole("button")).toHaveLength(0);
    expect(screen.getByRole("button", { name: "Add a machine" })).toBeTruthy();
  });

  it("goes back to the machine's page from the machine's crumb", async () => {
    const { app } = await openActivity(buildSixEntries());
    const crumbs = within(screen.getByRole("navigation", { name: "Fleet" }));
    await userEvent.click(crumbs.getByRole("link", { name: "atlas" }));

    expect(await screen.findByRole("heading", { level: 2, name: "atlas" })).toBeTruthy();
    expect(app.router.state.location.pathname).toBe(`/fleet/${ATLAS.id}`);
  });

  it("goes back to Fleet from the Fleet crumb", async () => {
    const { app } = await openActivity(buildSixEntries());
    const crumbs = within(screen.getByRole("navigation", { name: "Fleet" }));
    await userEvent.click(crumbs.getByRole("link", { name: "Fleet" }));

    await waitFor(() => expect(app.router.state.location.pathname).toBe("/fleet"));
  });

  it("opens the Add a machine dialog", async () => {
    await openActivity(buildSixEntries());
    await userEvent.click(screen.getByRole("button", { name: "Add a machine" }));

    expect(await screen.findByRole("dialog")).toBeTruthy();
  });

  it("shows the same screen as the machine's page for a machine that does not exist", async () => {
    await openMachineWithEvents(`/fleet/01a06d02-0000-7000-8000-00000000dead/activity`, []);

    expect(await screen.findByText("This machine was not found.")).toBeTruthy();
  });
});

describe("the Activity page's entries", () => {
  it("lists the days newest first, each with its entries newest first", async () => {
    await openActivity(buildSixEntries());
    await waitFor(() => expect(readLines()).not.toHaveLength(0));

    expect(readLines()).toEqual([
      "Today",
      "13:00Went offlineby Hercule",
      "12:003 sessions spawnedby HerculeShow 3",
      "09:00Set to take no new workby you",
      "Yesterday",
      "21:30Came onlineby Hercule",
      "21:20Went offlineby Hercule",
    ]);
  });

  it("unfolds an entry that folded several into a line for each, and folds it again", async () => {
    await openActivity(buildSixEntries());
    await userEvent.click(await screen.findByRole("button", { name: "Show 3" }));

    expect(document.querySelectorAll(".machine-activity-member")).toHaveLength(3);
    expect(screen.getByRole("button", { name: "Hide" }).getAttribute("aria-expanded")).toBe("true");

    await userEvent.click(screen.getByRole("button", { name: "Hide" }));
    expect(document.querySelectorAll(".machine-activity-member")).toHaveLength(0);
  });

  it("draws only the lines near the view of a long list", async () => {
    await openActivity(buildQuietEntries(100));
    await waitFor(() => expect(readLines()).not.toHaveLength(0));

    expect(document.querySelectorAll(".machine-activity-row").length).toBeLessThan(40);
  });

  it("makes no promise of how far back it reaches", async () => {
    await openActivity(buildSixEntries());
    expect(screen.queryByText(/last \d+ days|keeps \d+ days|90 days/i)).toBeNull();
  });
});

describe("the filters", () => {
  it("lists All, Problems, Connection, Sessions, Workspaces and Settings, with All pressed", async () => {
    await openActivity(buildSixEntries());
    const filters = within(screen.getByRole("group", { name: "Show" }));

    expect(filters.getAllByRole("button").map((button) => button.textContent)).toEqual([
      "All",
      "Problems",
      "Connection",
      "Sessions",
      "Workspaces",
      "Settings",
    ]);
    expect(filters.getByRole("button", { name: "All" }).getAttribute("aria-pressed")).toBe("true");
  });

  it("shows only the problems under Problems", async () => {
    await openActivity(buildSixEntries());
    await userEvent.click(screen.getByRole("button", { name: "Problems" }));

    expect(readLines()).toEqual([
      "Today",
      "13:00Went offlineby Hercule",
      "Yesterday",
      "21:20Went offlineby Hercule",
    ]);
    expect(screen.getByRole("button", { name: "Problems" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("shows a count on no filter", async () => {
    await openActivity(buildSixEntries());
    const buttons = within(screen.getByRole("group", { name: "Show" })).getAllByRole("button");

    expect(buttons.map((button) => button.textContent)).not.toContainEqual(
      expect.stringMatching(/\d/),
    );
  });

  it("moves to the next filter with the right arrow key, and stays on the last", async () => {
    await openActivity(buildSixEntries());
    screen.getByRole("button", { name: "All" }).focus();

    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Problems" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
    expect(document.activeElement).toBe(screen.getByRole("button", { name: "Problems" }));

    await userEvent.click(screen.getByRole("button", { name: "Settings" }));
    await userEvent.keyboard("{ArrowRight}");
    expect(screen.getByRole("button", { name: "Settings" }).getAttribute("aria-pressed")).toBe(
      "true",
    );
  });

  it("says that nothing went wrong when no entry is a problem", async () => {
    await openActivity([buildCameOnline(30)]);
    await userEvent.click(screen.getByRole("button", { name: "Problems" }));

    expect(await screen.findByText("No problems on atlas.")).toBeTruthy();
  });

  it("says that nothing has happened when the log is empty", async () => {
    await openActivity([]);

    expect(await screen.findByText("Nothing has happened on atlas yet.")).toBeTruthy();
  });
});

describe("reading older pages", () => {
  it("reads the next page when the user scrolls to the end of what is loaded", async () => {
    const { calls } = await openActivity(buildQuietEntries(250));
    await waitFor(() => expect(readLines()).not.toHaveLength(0));
    expect(readEventCalls(calls).filter((call) => call.search.includes("cursor="))).toHaveLength(0);

    const scroll = getScrollArea();
    scroll.scrollTop = 100_000;
    fireEvent.scroll(scroll);

    // The test's scroll position stays far past the end, so the page after it is read too.
    await waitFor(() =>
      expect(
        readEventCalls(calls).filter((call) => call.search.includes("cursor=")).length,
      ).toBeGreaterThan(0),
    );
  });

  it("keeps reading while the filter leaves the view empty, until it finds an entry", async () => {
    // The only problem is the oldest entry, on the second page.
    const oldestProblem = buildWentOffline(700);
    const { calls } = await openActivity([oldestProblem, ...buildQuietEntries(150)]);
    await waitFor(() => expect(readLines()).not.toHaveLength(0));

    await userEvent.click(screen.getByRole("button", { name: "Problems" }));

    expect(await screen.findByText("Went offline")).toBeTruthy();
    expect(readEventCalls(calls).filter((call) => call.search.includes("cursor="))).toHaveLength(1);
    expect(screen.queryByText(/Reading older activity/)).toBeNull();
  });

  it("says that nothing matches once the whole log is read", async () => {
    await openActivity(buildQuietEntries(150));
    await waitFor(() => expect(readLines()).not.toHaveLength(0));

    await userEvent.click(screen.getByRole("button", { name: "Problems" }));

    expect(await screen.findByText("No problems on atlas.")).toBeTruthy();
  });

  it("shows a failed page with a Retry that reads it again", async () => {
    let failing = false;
    const events = buildQuietEntries(150);
    const { app } = await openMachineWithEvents(ACTIVITY_PATH, events, {
      overrides: {
        "GET /api/v1/events": (call) => {
          const query = new URLSearchParams(call.search);
          if (query.has("cursor") && failing) {
            return { status: 500, body: { error: { code: "internal", message: "Down" } } };
          }
          const before = Number(query.get("cursor") ?? Infinity);
          const older = events.filter((event) => event.id < before).toSorted((a, b) => b.id - a.id);
          const items = older.slice(0, 100);
          return {
            body: {
              items,
              ...(older.length > 100 ? { nextCursor: String(items.at(-1)!.id) } : {}),
            },
          };
        },
      },
    });
    await screen.findByRole("heading", { level: 2, name: "Activity" });
    await app.live.waitForFirstPushes();
    await waitFor(() => expect(readLines()).not.toHaveLength(0));

    failing = true;
    const scroll = getScrollArea();
    scroll.scrollTop = 100_000;
    fireEvent.scroll(scroll);
    const alert = await screen.findByRole("alert");
    expect(alert.textContent).toContain("Couldn't read older activity.");

    failing = false;
    await userEvent.click(within(alert).getByRole("button", { name: "Retry" }));
    await waitFor(() => expect(screen.queryByRole("alert")).toBeNull());
  });
});
