/**
 * Tests, through the rendered app, how the Inbox holds its list: a list starts
 * only from a page read after it was asked for and the previous list stays
 * until then, the search is read after typing pauses, replies of a list the
 * user has left are ignored, a push takes rows out only when every read
 * succeeded, "Show" and the `.` key read again before they take arrivals in,
 * and the scope lives in the URL.
 */
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import type { InboxQuery } from "@hercule/contract";
import {
  buildErrorBody,
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

    mine.answer(answerQuery(inbox, { body: { list: { savedQuery: "mine" } } } as Call));
    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });
  });

  it("starts from a page read after the list was asked for, never from a cached older one", async () => {
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

  it("ignores the next page of a list the user has left", async () => {
    const inbox = defaultInbox();
    inbox.pageSize = 2;
    const latePage = holdAnswer();
    await openInbox(inbox, {
      [QUERY_PATH]: (call: Call) =>
        (call.body as InboxQuery).cursor !== undefined && readListName(call) === "waits"
          ? latePage.handler()
          : answerQuery(inbox, call),
    });
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.click(railButton(/Mine/));
    await waitFor(() => {
      expect(readRowTitles()).toEqual([BASKET.title]);
    });
    latePage.answer(
      answerQuery(inbox, { body: { list: { savedQuery: "waits" }, cursor: "2" } } as Call),
    );

    await act(async () => {
      await Promise.resolve();
    });
    expect(readRowTitles()).toEqual([BASKET.title]);
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
    await waitFor(() => {
      expect(opened.live.readTopics()).toContain("externalEntity");
    });
    return { ...opened, inbox };
  };

  it("takes a held row out when no read has it any more", async () => {
    const { inbox, live } = await openWithPush();
    inbox.lists.waits = [SLOTS, BASKET];

    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });

    await waitFor(() => {
      expect(readRowTitles()).toEqual([SLOTS.title, BASKET.title]);
    });
  });

  it("keeps every row when a read of the refresh failed, because a missing row may only be a read that did not happen", async () => {
    const inbox = defaultInbox();
    let isRefsRead = false;
    const { live } = await openInbox(inbox, {
      [QUERY_PATH]: (call: Call) => {
        if ((call.body as InboxQuery).refs === undefined) return answerQuery(inbox, call);
        isRefsRead = true;
        return { status: 500, body: buildErrorBody("internal", "The database is locked.") };
      },
    });
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    await waitFor(() => {
      expect(live.readTopics()).toContain("externalEntity");
    });
    inbox.lists.waits = [SLOTS, BASKET];

    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });

    await waitFor(() => {
      expect(isRefsRead).toBe(true);
    });
    expect(readRowTitles()).toEqual([SLOTS.title, LOYALTY.title, BASKET.title]);
  });

  /** Opens the Inbox on a controller whose first-page reads, once `slow.on` is set, take 100 ms to answer. */
  const openWithSlowFirstPage = async () => {
    const inbox = defaultInbox();
    const slow = { on: false };
    const opened = await openWithPush({
      [QUERY_PATH]: async (call: Call) => {
        const query = call.body as InboxQuery;
        if (slow.on && query.refs === undefined && query.cursor === undefined) {
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        return answerQuery(inbox, call);
      },
    });
    return { ...opened, inbox, slow };
  };
  const isFirstPage = (query: InboxQuery) => query.refs === undefined && query.cursor === undefined;

  it("reads the first page once for one push", async () => {
    const { inbox, live, calls } = await openWithPush();
    const before = readQueries(calls).filter(isFirstPage).length;
    inbox.lists.waits = [SLOTS, BASKET];

    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });
    await waitFor(() => {
      expect(readRowTitles()).toEqual([SLOTS.title, BASKET.title]);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(readQueries(calls).filter(isFirstPage).length - before).toBe(1);
  });

  it("reads the first page once for the signal push and the entity push of one change, because the second joins the read the first started", async () => {
    const { live, calls, slow } = await openWithSlowFirstPage();
    const before = readQueries(calls).filter(isFirstPage).length;
    slow.on = true;

    act(() => {
      live.pushInvalidation("signal", ["s1"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 20));
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(readQueries(calls).filter(isFirstPage).length - before).toBe(1);
  });

  it("reads the first page again for a push that arrives after the read finished", async () => {
    const { live, calls, slow } = await openWithSlowFirstPage();
    const before = readQueries(calls).filter(isFirstPage).length;
    slow.on = true;

    act(() => {
      live.pushInvalidation("signal", ["s1"]);
    });
    await new Promise((resolve) => setTimeout(resolve, 250));
    act(() => {
      live.pushInvalidation("externalEntity", [SLOTS.id]);
    });
    await new Promise((resolve) => setTimeout(resolve, 400));

    expect(readQueries(calls).filter(isFirstPage).length - before).toBe(2);
  });

  it("reads the first page again for the . key, and takes the arrivals in after it", async () => {
    const { inbox, live, calls } = await openWithPush();
    const arrival = request(4, "Bump the checkout SDK", "Noa");
    inbox.lists.waits = [arrival, SLOTS, LOYALTY, BASKET];
    act(() => {
      live.pushInvalidation("externalEntity", [LOYALTY.id]);
    });
    await screen.findByRole("button", { name: /1 new/ });
    const readsBefore = readQueries(calls).length;
    // The list's own keys work with the focus in the list.
    screen.getByRole("treeitem", { name: /Cache delivery slot lookups/ }).focus();

    await userEvent.keyboard(".");

    await waitFor(() => {
      expect(readRowTitles()).toContain(arrival.title);
    });
    expect(readQueries(calls).length).toBeGreaterThan(readsBefore);
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
