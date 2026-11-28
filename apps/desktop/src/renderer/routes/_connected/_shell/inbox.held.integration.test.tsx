/**
 * Tests, through the rendered app, what needs the whole screen of how the
 * Inbox holds its list: the previous list stays until the next one's first
 * page arrives, one push reads once and changes a row in place, "N new" and
 * Show, a row that scrolls back into view is read again, Undo after a
 * refresh, the window hidden, and the scope in the URL. The races between
 * reads are tested in the visit itself (`inbox-visit.test.ts` in client-core).
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxQuery } from "@hercule/contract";
import {
  holdAnswer,
  setVisibility,
  stubElementSize,
  stubIntersectionObserver,
  type Call,
} from "../../../app/testing";
import {
  BASKET,
  LOYALTY,
  QUERY_PATH,
  SLOTS,
  answerQuery,
  defaultInbox,
  openInbox,
  readQueries,
  readRowTitles,
  request,
} from "./-inbox.testing";

beforeEach(() => {
  stubIntersectionObserver();
  stubElementSize(400, 600);
});

afterEach(() => {
  cleanup();
  setVisibility("visible");
  localStorage.clear();
});

/** Returns the name of the saved query a call reads. */
const readListName = (call: Call): string => {
  const { list } = call.body as InboxQuery;
  return "savedQuery" in list ? list.savedQuery : "browse";
};

const railButton = (name: RegExp): HTMLElement =>
  within(screen.getByRole("navigation", { name: "Inbox lists" })).getByRole("button", { name });

/** Returns how many reads of each mode `calls` hold. */
const countModes = (calls: readonly Call[]): Record<string, number> => {
  const counts: Record<string, number> = {};
  for (const { mode } of readQueries(calls)) counts[mode] = (counts[mode] ?? 0) + 1;
  return counts;
};

describe("starting a list", () => {
  it("keeps the previous list on screen, with no skeleton, until the next list's first page arrives", async () => {
    const inbox = defaultInbox();
    const mine = holdAnswer();
    const { calls } = await openInbox(inbox, {
      [QUERY_PATH]: (call: Call) =>
        readListName(call) === "mine" ? mine.handler() : answerQuery(inbox, call),
    });
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.click(railButton(/Mine/));

    await waitFor(() => {
      expect(readQueries(calls).some((query) => "savedQuery" in query.list)).toBe(true);
    });
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
    expect(document.querySelector("[aria-busy='true']")).toBeNull();

    mine.answer(
      answerQuery(inbox, { body: { mode: "first", list: { savedQuery: "mine" } } } as Call),
    );
    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });
  });

  it("starts from a page read after the list was asked for, never from an older one", async () => {
    const inbox = defaultInbox();
    await openInbox(inbox);
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    await userEvent.click(railButton(/Mine/));
    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });

    // A thing arrived in the waits list while the user was elsewhere, and nothing pushed.
    inbox.lists.waits = [request(4, "Bump the checkout SDK", "Noa"), SLOTS, LOYALTY, BASKET];
    await userEvent.click(railButton(/Someone waits on me/));

    await waitFor(() => {
      expect(readRowTitles()).toEqual([
        "Bump the checkout SDK",
        SLOTS.title,
        LOYALTY.title,
        BASKET.title,
      ]);
    });
    expect(screen.queryByRole("button", { name: /new/ })).toBeNull();
  });
});

describe("the search", () => {
  it("reads once after typing pauses, and not once for each letter", async () => {
    const { calls } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.type(screen.getByRole("combobox"), "basket");

    await waitFor(() => {
      expect(readQueries(calls).some((query) => query.text === "basket")).toBe(true);
    });
    const texts = readQueries(calls)
      .map((query) => query.text)
      .filter((text) => text !== undefined && text !== "");
    expect(texts).toEqual(["basket"]);
  });
});

describe("a push", () => {
  const openWithPush = async (handlers: Parameters<typeof openInbox>[1] = {}) => {
    const inbox = defaultInbox();
    const opened = await openInbox(inbox, handlers);
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    return { ...opened, inbox };
  };

  it("changes a row in place with one refresh, and reads nothing else", async () => {
    const { inbox, live, calls } = await openWithPush();
    const before = countModes(calls);
    inbox.lists.waits = [SLOTS, { ...LOYALTY, title: "Round loyalty points up" }, BASKET];

    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });

    await waitFor(() => {
      expect(readRowTitles()).toEqual([SLOTS.title, "Round loyalty points up", BASKET.title]);
    });
    const after = countModes(calls);
    expect((after["refresh"] ?? 0) - (before["refresh"] ?? 0)).toBe(1);
    expect(after["first"]).toBe(before["first"]);
    expect(after["rows"]).toBe(before["rows"]);
  });

  it("waits behind N new until Show, then takes the arrival in", async () => {
    const { inbox, live } = await openWithPush();
    const arrival = request(4, "Bump the checkout SDK", "Noa");
    inbox.lists.waits = [arrival, SLOTS, LOYALTY, BASKET];

    act(() => {
      live.pushInvalidation("externalEntity", [arrival.id]);
    });

    const show = await screen.findByRole("button", { name: /1 new/ });
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
    await userEvent.click(show);
    await waitFor(() => {
      expect(readRowTitles()).toEqual([arrival.title, SLOTS.title, LOYALTY.title, BASKET.title]);
    });
  });

  it("takes the arrivals in with the . key as well", async () => {
    const { inbox, live } = await openWithPush();
    const arrival = request(4, "Bump the checkout SDK", "Noa");
    inbox.lists.waits = [arrival, SLOTS, LOYALTY, BASKET];
    act(() => {
      live.pushInvalidation("externalEntity", [arrival.id]);
    });
    await screen.findByRole("button", { name: /1 new/ });
    // The list's own keys work with the focus in the list.
    screen.getByRole("treeitem", { name: /Cache delivery slot lookups/ }).focus();

    await userEvent.keyboard(".");

    await waitFor(() => {
      expect(readRowTitles()).toContain(arrival.title);
    });
  });

  it("reads nothing while the window is hidden, and once when it shows again", async () => {
    const { inbox, live, calls } = await openWithPush();
    inbox.lists.waits = [SLOTS, { ...LOYALTY, title: "Round loyalty points up" }, BASKET];
    setVisibility("hidden");
    const before = readQueries(calls).length;

    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readQueries(calls).length).toBe(before);

    setVisibility("visible");
    await waitFor(() => {
      expect(readRowTitles()).toEqual([SLOTS.title, "Round loyalty points up", BASKET.title]);
    });
    expect(readQueries(calls).length - before).toBe(1);
  });
});

describe("Undo after a refresh", () => {
  it("brings the dismissed row back, and a read of the list does not take it out again", async () => {
    const inbox = defaultInbox();
    const { live } = await openInbox(inbox, {
      "POST /api/v1/external-entities/dismiss": () => {
        inbox.lists.waits = [LOYALTY, BASKET];
        return { body: {} };
      },
      "POST /api/v1/external-entities/restore": () => {
        inbox.lists.waits = [SLOTS, LOYALTY, BASKET];
        return { body: {} };
      },
    });
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    await userEvent.keyboard("e");
    await waitFor(() => {
      expect(readRowTitles()).toEqual([LOYALTY.title, BASKET.title]);
    });
    // A read after the dismissal found the controller dropped the row, so it stays out.
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readRowTitles()).toEqual([LOYALTY.title, BASKET.title]);

    await userEvent.click(
      within(document.querySelector<HTMLElement>(".ib .undo-line")!).getByRole("button", {
        name: /Undo/,
      }),
    );

    await waitFor(() => {
      expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
    });
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
  });
});

describe("a row that scrolls back into view", () => {
  /** The number of things in the long list: more than a refresh holds, so the far ones go stale. */
  const THINGS = 650;

  it("is read again on its own, because a push does not refresh rows far from the view", async () => {
    const inbox = defaultInbox();
    const things = Array.from({ length: THINGS }, (_, index) =>
      request(index + 1, `Thing ${String(index + 1)}`, "Mei", { arrival: THINGS - index }),
    );
    inbox.lists.waits = things;
    inbox.pageSize = 200;
    const { live, calls } = await openInbox(inbox);
    await screen.findByRole("treeitem", { name: /Thing 1\b/ });
    const scroll = document.querySelector<HTMLElement>(".ib-scroll")!;
    const rowHeight = (): number =>
      parseFloat(document.querySelector<HTMLElement>(".ib-rows")!.style.minHeight) /
      Number(screen.getAllByRole("treeitem")[0]!.getAttribute("aria-setsize"));
    const scrollToRow = (index: number): void => {
      scroll.scrollTop = index * rowHeight();
      fireEvent.scroll(scroll);
    };
    // Scrolling to the end of what is held reads the next pages, one after the other.
    await waitFor(() => {
      const held = Number(screen.getAllByRole("treeitem")[0]!.getAttribute("aria-setsize"));
      scrollToRow(held - 1);
      expect(held).toBe(THINGS);
    });
    scrollToRow(0);
    await screen.findByRole("treeitem", { name: /Thing 1\b/ });
    const far = things[600]!;
    inbox.lists.waits = things.map((thing) =>
      thing.ref === far.ref ? { ...thing, title: "Thing 601 changed" } : thing,
    );

    const refreshesBefore = countModes(calls)["refresh"] ?? 0;

    act(() => {
      live.pushInvalidation("externalEntity", [far.id]);
    });
    await waitFor(() => {
      expect(countModes(calls)["refresh"]).toBe(refreshesBefore + 1);
    });
    expect(readQueries(calls).some((query) => query.mode === "rows")).toBe(false);

    scrollToRow(600);

    await screen.findByRole("treeitem", { name: /Thing 601 changed/ });
    expect(
      readQueries(calls).some((query) => query.mode === "rows" && query.held.includes(far.ref)),
    ).toBe(true);
  });
});

describe("the scope in the URL", () => {
  it("opens on the saved query the URL names, and writes the list a pick opens into it", async () => {
    const { router } = await openInbox(defaultInbox(), {}, "/inbox?list=mine");

    await screen.findByRole("heading", { name: "Mine" });
    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });

    await userEvent.click(railButton(/Updates/));
    await waitFor(() => {
      expect(router.state.location.search).toMatchObject({ list: "updates" });
    });

    await userEvent.click(railButton(/Someone waits on me/));
    await waitFor(() => {
      expect(router.state.location.search).not.toHaveProperty("list");
    });
  });

  it("holds the workflows' topic while the Inbox is open", async () => {
    const { live } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await waitFor(() => {
      expect(live.readTopics()).toContain("workflow");
    });
  });
});
