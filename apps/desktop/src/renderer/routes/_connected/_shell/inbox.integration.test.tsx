/**
 * Tests the Inbox screen through the rendered app: the first page of the
 * default list, a push that updates a row in place and holds an arrival
 * behind "N new", the rail changing the list, a typed token narrowing it, the
 * pane showing the current thing's detail, a next page, and the empty states.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { buildInboxOutline } from "@hercule/client-core/inbox/testing";
import {
  neverAnswer,
  setVisibility,
  stubElementSize,
  stubIntersectionObserver,
} from "../../../app/testing";
import {
  BASKET,
  OUTLINE,
  LOYALTY,
  SLOTS,
  defaultInbox,
  openInbox,
  readQueries,
  readRowTitles,
  request,
  QUERY_PATH,
} from "./-inbox.testing";

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
    const readsBeforeShow = readQueries(calls).length;
    await userEvent.click(await screen.findByRole("button", { name: /1 new/ }));
    // Show reads the first page again before it takes the arrivals in.
    await waitFor(() => {
      expect(readRowTitles()).toContain(arrival.title);
    });
    expect(screen.queryByRole("button", { name: /1 new/ })).toBeNull();
    expect(readQueries(calls).length).toBeGreaterThan(readsBeforeShow);
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

  it("reads each thing for the pane once while walking, and reads none again when walking back", async () => {
    const { calls, live } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    // Let the live connection's own first read of everything pass, so it is not counted as a step.
    await waitFor(() => {
      expect(live.readTopics()).toContain("externalEntity");
    });
    await new Promise((resolve) => setTimeout(resolve, 300));
    const readsOf = (id: string) =>
      calls.filter((call) => call.path === `/api/v1/external-entities/${id}`).length;
    const stepTo = async (key: string, title: string) => {
      await userEvent.keyboard(key);
      await waitFor(() => {
        expect(
          within(document.getElementById("inbox-pane")!).getByRole("heading", { name: title }),
        ).toBeTruthy();
      });
    };
    screen.getByRole("treeitem", { name: /Cache delivery slot lookups/ }).focus();
    const slotsBefore = readsOf(SLOTS.id);

    await stepTo("j", LOYALTY.title);
    await stepTo("j", BASKET.title);
    await stepTo("k", LOYALTY.title);
    await stepTo("k", SLOTS.title);

    expect([SLOTS.id, LOYALTY.id, BASKET.id].map(readsOf)).toEqual([slotsBefore, 1, 1]);
  });

  it("reads no thing for a pane that lies over the list and is closed", async () => {
    // Only the frame is told its width: the list's virtualizer measures itself.
    vi.stubGlobal(
      "ResizeObserver",
      class {
        readonly callback: ResizeObserverCallback;
        constructor(callback: ResizeObserverCallback) {
          this.callback = callback;
        }
        observe(element: Element): void {
          if (!element.classList.contains("ib")) return;
          this.callback([{ contentRect: { width: 900 } } as ResizeObserverEntry], this);
        }
        unobserve(): void {}
        disconnect(): void {}
      },
    );
    const { calls } = await openInbox(defaultInbox());
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });
    screen.getByRole("treeitem", { name: /Cache delivery slot lookups/ }).focus();
    await userEvent.keyboard("j");
    await new Promise((resolve) => setTimeout(resolve, 100));

    expect(calls.some((call) => call.path.startsWith("/api/v1/external-entities/ent"))).toBe(false);
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
    clear.outline = buildInboxOutline({
      savedQueries: OUTLINE.savedQueries.map((query) => ({ ...query, count: 0 })),
    });
    await openInbox(clear);
    expect(await screen.findByRole("heading", { name: "All clear" })).toBeTruthy();
  });

  it("draws the rail's count bars while the first page is on its way", async () => {
    await openInbox(defaultInbox(), { [QUERY_PATH]: neverAnswer });

    await waitFor(() => {
      expect(document.querySelector(".ib-rail-count-skeleton")).not.toBeNull();
    });
  });

  it("writes the time a failing source's Connection last changed as a 24-hour clock time", async () => {
    const inbox = defaultInbox();
    inbox.outline = {
      ...OUTLINE,
      failing: [{ source: "github", updatedAt: "2026-11-11T09:12:00.000Z" }],
    };
    await openInbox(inbox);

    const line = await screen.findByText(/can’t be read; last changed/);

    expect(line.textContent).toMatch(/last changed \d{2}:\d{2}\./);
  });

  it('starts a search in Everything, tied to the facet\'s source and account, from its "Search the other" row', async () => {
    const inbox = defaultInbox();
    const { calls } = await openInbox({
      ...inbox,
      outline: {
        ...OUTLINE,
        sources: [
          {
            source: "acme",
            count: 3,
            folded: false,
            accounts: [],
            facets: [
              {
                source: "acme",
                connectionId: "0199e0e7-0000-7000-8000-00000000000a",
                key: "team",
                label: "Team",
                plural: "teams",
                values: [{ value: "basket", label: "Basket", count: 1 }],
                more: 4,
              },
            ],
          },
        ],
      },
    });
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.click(await screen.findByRole("button", { name: "Search the other 4" }));
    await userEvent.type(screen.getByRole("combobox"), "Payments ");

    await waitFor(() => {
      expect(readQueries(calls).at(-1)).toMatchObject({
        list: { savedQuery: "everything" },
        clauses: [
          {
            key: "team",
            op: "is",
            value: "Payments",
            source: "acme",
            connectionId: "0199e0e7-0000-7000-8000-00000000000a",
          },
        ],
      });
    });
  });

  it("offers the values of the field being typed", async () => {
    const { calls } = await openInbox(defaultInbox(), {
      "POST /api/v1/external-entities/inbox/values": () => ({
        body: { values: [{ value: "Checkout", label: "Checkout", count: 3, source: "github" }] },
      }),
    });
    await screen.findByRole("treeitem", { name: /Cache delivery slot lookups/ });

    await userEvent.type(screen.getByRole("combobox"), "team:");

    expect(await screen.findByRole("option", { name: /team:Checkout/, hidden: true })).toBeTruthy();
    expect(calls.find((call) => call.path.endsWith("/inbox/values"))?.body).toMatchObject({
      key: "team",
      list: { savedQuery: "waits" },
    });
  });
});
