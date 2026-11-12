/**
 * Tests the Inbox screen through the rendered app: the first page of the
 * default list, a push that updates a row in place and holds an arrival
 * behind "N new", the rail changing the list, a typed token narrowing it, the
 * pane showing the current thing's detail, a next page, and the empty states.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildInboxCounts } from "@hercule/client-core/inbox/testing";
import { setVisibility, stubElementSize, stubIntersectionObserver } from "../../../app/testing";
import {
  BASKET,
  COUNTS,
  LOYALTY,
  SLOTS,
  defaultInbox,
  openInbox,
  readQueries,
  readRowTitles,
  request,
} from "./inbox.testing";

beforeEach(() => {
  stubIntersectionObserver();
  // jsdom lays nothing out, so every element is 400 by 600: room for about eleven rows.
  stubElementSize(400, 600);
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
  localStorage.clear();
});

describe("the Inbox screen", () => {
  it("draws the first page of Someone waits on me, with its count, and opens the first thing in the pane", async () => {
    const { calls } = await openInbox(defaultInbox());

    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
    expect(
      screen.getByRole("heading", { name: "Someone waits on me" }).parentElement!.textContent,
    ).toContain("3");
    expect(readQueries(calls)[0]).toMatchObject({ list: { savedQuery: "waits" } });
    // The pane shows the current thing, which is the first row.
    await waitFor(() => {
      expect(
        within(document.getElementById("inbox-pane")!).getByRole("heading", {
          name: SLOTS.title,
        }),
      ).toBeTruthy();
    });
  });

  it("updates a held row in place on a push, and holds an arrival behind N new until Show", async () => {
    const inbox = defaultInbox();
    const { live, calls } = await openInbox(inbox);
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    await waitFor(() => {
      expect(live.readTopics()).toContain("externalEntity");
    });

    const arrival = request(4, "Bump the checkout SDK", "Noa");
    inbox.lists.waits = [
      { ...LOYALTY, title: "Round loyalty points down, again" },
      arrival,
      SLOTS,
      BASKET,
    ];
    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });

    // The changed row updates where it stands, and the arrival does not move anything.
    await screen.findByRole("treeitem", { name: /Round loyalty points down, again/ });
    expect(readRowTitles()).toEqual([
      SLOTS.title,
      "Round loyalty points down, again",
      BASKET.title,
    ]);
    await userEvent.click(await screen.findByRole("button", { name: /1 new/ }));
    expect(readRowTitles()).toContain(arrival.title);
    expect(screen.queryByRole("button", { name: /1 new/ })).toBeNull();
    expect(readQueries(calls).length).toBeGreaterThan(1);
  });

  it("changes the list when a rail entry is picked", async () => {
    const { calls } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.click(
      within(screen.getByRole("navigation", { name: "Inbox lists" })).getByRole("button", {
        name: /Mine/,
      }),
    );

    await screen.findByRole("heading", { name: "Mine" });
    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });
    expect(readQueries(calls).at(-1)).toMatchObject({ list: { savedQuery: "mine" } });
  });

  it("narrows the list when a field token is typed", async () => {
    const { calls } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.type(screen.getByRole("combobox"), "team:basket ");

    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });
    expect(readQueries(calls).at(-1)).toMatchObject({
      list: { savedQuery: "waits" },
      clauses: [{ key: "team", op: "is", value: "basket" }],
    });
  });

  it("shows the detail of the thing a click makes current", async () => {
    const { calls } = await openInbox(defaultInbox());
    await userEvent.click(
      await screen.findByRole("treeitem", { name: /Round loyalty points down/ }),
    );

    await waitFor(() => {
      expect(
        within(document.getElementById("inbox-pane")!).getByRole("heading", {
          name: LOYALTY.title,
        }),
      ).toBeTruthy();
    });
    expect(calls.some((call) => call.path === `/api/v1/external-entities/${LOYALTY.id}`)).toBe(
      true,
    );
  });

  it("reads the next page when the list nears its end, and holds it with the rest", async () => {
    const inbox = defaultInbox();
    inbox.pageSize = 2;
    const { calls } = await openInbox(inbox);

    await screen.findByRole("treeitem", { name: /Fix the basket rounding/ });
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
    expect(readQueries(calls).some((query) => query.cursor === "2")).toBe(true);
  });

  it("says nobody waits when the list is empty, and all is clear when nothing is anywhere", async () => {
    const inbox = defaultInbox();
    inbox.lists.waits = [];
    await openInbox(inbox);
    expect(await screen.findByRole("heading", { name: "Nobody waits on you" })).toBeTruthy();
    cleanup();

    const clear = defaultInbox();
    clear.lists.waits = [];
    clear.counts = buildInboxCounts({
      savedQueries: COUNTS.savedQueries.map((query) => ({ ...query, count: 0 })),
    });
    await openInbox(clear);
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeTruthy();
  });
});
