/**
 * Tests the Recent section of a machine's page (spec 17 §Fleet, A machine's
 * page): the newest five activity entries, an entry that unfolds, "All
 * activity", and the live push that shows a change of the machine at once.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { stubIntersectionObserver } from "../../../../app/testing";
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
  vi.stubEnv("TZ", "UTC");
  vi.useFakeTimers({ now: new Date("2026-11-02T14:00:00.000Z"), toFake: ["Date"] });
});

afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  localStorage.clear();
});

/** Seven entries, built oldest first: two from yesterday, then today's, with three sessions spawned in one minute. */
const buildSevenEntries = () => [
  buildCameOnline(1500),
  buildWentOffline(1000),
  buildCameOnline(990),
  buildStoppedNewWork(300),
  buildSessionSpawned(120, "01a06d02-0000-7000-8000-0000000000a1"),
  buildSessionSpawned(120, "01a06d02-0000-7000-8000-0000000000a2"),
  buildSessionSpawned(120, "01a06d02-0000-7000-8000-0000000000a3"),
  buildWentOffline(60),
  buildCameOnline(30),
];

const openRecent = async (events = buildSevenEntries()) => {
  const opened = await openMachineWithEvents(`/fleet/${ATLAS.id}`, events);
  const recent = await screen.findByRole("region", { name: "Recent" });
  return { ...opened, recent };
};

/** Returns the text of each entry in `region`, newest first: its time, sentence, who did it and its button. */
const readEntries = (region: HTMLElement): readonly string[] =>
  Array.from(region.querySelectorAll(".machine-activity-row"), (row) => row.textContent);

describe("the Recent section", () => {
  it("lists the newest five entries, with the day of those not from today", async () => {
    const { recent } = await openRecent();
    await waitFor(() => expect(readEntries(recent)).not.toHaveLength(0));

    expect(readEntries(recent)).toEqual([
      "13:30Came onlineby Hercule",
      "13:00Went offlineby Hercule",
      "12:003 sessions spawnedby HerculeShow 3",
      "09:00Set to take no new workby you",
      "Yesterday, 21:30Came onlineby Hercule",
    ]);
  });

  it("marks an entry that is a problem", async () => {
    const { recent } = await openRecent();
    const offline = await within(recent).findByText("Went offline");
    expect(offline.closest(".machine-activity-row")?.classList.contains("is-problem")).toBe(true);
  });

  it("unfolds an entry that folded several, and folds it again", async () => {
    const { recent } = await openRecent();
    const show = await within(recent).findByRole("button", { name: "Show 3" });
    expect(show.getAttribute("aria-expanded")).toBe("false");

    await userEvent.click(show);
    expect(within(recent).getByRole("button", { name: "Hide" }).getAttribute("aria-expanded")).toBe(
      "true",
    );
    expect(within(recent).getAllByText(/^Session spawned/)).toHaveLength(3);

    await userEvent.click(within(recent).getByRole("button", { name: "Hide" }));
    expect(within(recent).queryAllByText(/^Session spawned/)).toHaveLength(0);
  });

  it("opens the Activity page from All activity", async () => {
    const { app, recent } = await openRecent();
    await userEvent.click(await within(recent).findByRole("link", { name: /All activity/ }));

    expect(await screen.findByRole("heading", { level: 2, name: "Activity" })).toBeTruthy();
    expect(app.router.state.location.pathname).toBe(`/fleet/${ATLAS.id}/activity`);
  });

  it("says so in one line, with no way to more, when nothing has happened", async () => {
    const { recent } = await openRecent([]);
    expect(await within(recent).findByText("Nothing has happened on atlas yet.")).toBeTruthy();
    expect(within(recent).queryByRole("link", { name: /All activity/ })).toBeNull();
  });

  it("shows a failed read as a line with a Retry, and the rest of the page stays", async () => {
    await openMachineWithEvents(`/fleet/${ATLAS.id}`, [], {
      overrides: {
        "GET /api/v1/events": {
          status: 500,
          body: { error: { code: "internal", message: "Down" } },
        },
      },
    });
    const recent = await screen.findByRole("region", { name: "Recent" });
    expect(await within(recent).findByRole("alert")).toBeTruthy();
    expect(within(recent).getByRole("button", { name: "Retry" })).toBeTruthy();
    expect(screen.getByRole("heading", { level: 2, name: "atlas" })).toBeTruthy();
  });

  it("shows a change of the machine as soon as the runner topic pushes it", async () => {
    const events = buildSevenEntries();
    const { app, recent, setEvents } = await openRecent(events);
    await waitFor(() => expect(readEntries(recent)).not.toHaveLength(0));
    await app.live.waitForFirstPushes();

    setEvents([...events, buildStoppedNewWork(0)]);
    app.live.pushInvalidation("runner", [ATLAS.id]);

    await waitFor(() => {
      expect(readEntries(recent)[0]).toBe("14:00Set to take no new workby you");
    });
  });
});
