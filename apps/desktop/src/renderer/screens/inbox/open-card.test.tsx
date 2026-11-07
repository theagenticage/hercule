/**
 * Tests the open card of the Inbox against a stubbed controller: what a card
 * says (every place above it, why its facts may be old), what its moves do
 * and when they are off, and walking to a place inside the sheet and back.
 */
import { Suspense, type JSX } from "react";
import { describe, expect, it, vi } from "vitest";
import { render, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { QueryClientProvider } from "@tanstack/react-query";
import { createClient } from "@hercule/client-core";
import { buildInbox, buildInboxCard, buildInboxPlace } from "@hercule/client-core/inbox/testing";
import type { ExternalEntityDetail, Inbox, InboxCard } from "@hercule/contract";
import { createQueryClient } from "../../app/query-client";
import { CONTROLLER_URL, stubApi } from "../../app/testing";
import { InboxOpenCard } from "./open-card";
import { useOpenCard } from "./use-open-card";

const ORDER_ID = "01a06d02-7e00-7000-8000-000000000a01";

const ROUND_A = buildInboxPlace("acme:round:a", "Round A", { kind: "acme/round", noun: "Round" });
const ROUND_B = buildInboxPlace("acme:round:b", "Round B", { kind: "acme/round", noun: "Round" });
const DEPOT = buildInboxPlace("acme:site:depot", "Rotterdam depot", {
  kind: "acme/site",
  noun: "Site",
  caption: "Acme site",
  status: { shape: "half", tone: "active", label: "Receiving" },
  progress: { fraction: 4 / 9, done: 4, total: 9 },
});

/** An order that sits in two delivery rounds, both of which are in one depot: two paths to the depot. */
const ORDER = buildInboxCard(ORDER_ID, {
  title: "Chilled crates for the depot",
  ancestors: [ROUND_A.ref, ROUND_B.ref, DEPOT.ref],
});
const EDGES = [
  { fromRef: ORDER.ref, toRef: ROUND_A.ref },
  { fromRef: ORDER.ref, toRef: ROUND_B.ref },
  { fromRef: ROUND_A.ref, toRef: DEPOT.ref },
  { fromRef: ROUND_B.ref, toRef: DEPOT.ref },
];

const buildInboxOf = (card: InboxCard): Inbox =>
  buildInbox([card], { places: [ROUND_A, ROUND_B, DEPOT], edges: EDGES });

/** Returns what `externalEntity.read` answers for `card`. */
const buildDetail = (
  card: InboxCard,
  overrides: Partial<ExternalEntityDetail> = {},
): ExternalEntityDetail => {
  return {
    ...card,
    kindAvailable: true,
    places: [ROUND_A, ROUND_B, DEPOT],
    edges: EDGES,
    links: [],
    conflicts: [],
    signals: [],
    openCount: 0,
    signalCount: 0,
    timeline: [],
    peers: [],
    ...overrides,
  };
};

interface Rendered {
  readonly onTake: ReturnType<typeof vi.fn<(cardId: string) => void>>;
  readonly onSeeTask: ReturnType<typeof vi.fn<(taskId: string) => void>>;
}

/** Renders a page with one card that opens into the sheet, and returns what the sheet's moves called. */
const renderPage = (card: InboxCard, detail: ExternalEntityDetail): Rendered => {
  stubApi({ [`GET /api/v1/external-entities/${card.id}`]: { body: detail } });
  const client = createClient({ baseUrl: CONTROLLER_URL, token: "bearer" });
  const onTake = vi.fn<(cardId: string) => void>();
  const onSeeTask = vi.fn<(taskId: string) => void>();
  const inbox = buildInboxOf(card);
  function Page(): JSX.Element {
    const openCard = useOpenCard();
    return (
      <div className="inbox-desk">
        <div className="inbox-row" data-card-id={card.id}>
          <button
            onClick={(event) => {
              openCard.open({ kind: "card", id: card.id }, event.currentTarget.parentElement!);
            }}
          >
            Open the card
          </button>
        </div>
        <InboxOpenCard
          openCard={openCard}
          client={client}
          inbox={inbox}
          plugins={[]}
          onTake={onTake}
          onDismiss={vi.fn()}
          onSeeTask={onSeeTask}
        />
      </div>
    );
  }
  render(
    <QueryClientProvider client={createQueryClient()}>
      <Suspense fallback={null}>
        <Page />
      </Suspense>
    </QueryClientProvider>,
  );
  return { onTake, onSeeTask };
};

/** Opens the card and waits until the moves take a pointer, which they do not for the first moment. */
const openTheCard = async (): Promise<HTMLElement> => {
  await userEvent.setup().click(await screen.findByRole("button", { name: "Open the card" }));
  const sheet = await screen.findByRole("dialog");
  await waitFor(() => {
    expect(sheet.hasAttribute("data-arming")).toBe(false);
  });
  return sheet;
};

describe("InboxOpenCard", () => {
  it("keeps the page's own card in the list while the sheet opens out of a copy of it", async () => {
    // A test page has no layout, so nothing counts as drawn unless it says so.
    vi.spyOn(HTMLElement.prototype, "getClientRects").mockReturnValue([
      new DOMRect(0, 0, 300, 40),
    ] as unknown as DOMRectList);
    renderPage(ORDER, buildDetail(ORDER));
    const sheet = await openTheCard();

    const rows = document.querySelectorAll(`.inbox-desk > .inbox-row[data-card-id="${ORDER_ID}"]`);
    expect(rows).toHaveLength(1);
    expect(rows[0]!.querySelector("button")).not.toBeNull();
    // The copy inside the sheet has no card id, so no lookup of the card finds it.
    expect(sheet.querySelector(".opening-ghost .inbox-row")).not.toBeNull();
    expect(sheet.querySelector(".opening-ghost [data-card-id]")).toBeNull();
    vi.restoreAllMocks();
  });

  it("lays the sheet above its veil, so the veil takes no click meant for the sheet", async () => {
    renderPage(ORDER, buildDetail(ORDER));
    const sheet = await openTheCard();
    const veil = document.querySelector<HTMLElement>(".open-card-veil")!;

    // Two positioned boxes in one layer paint in the order of the page, unless a z-index says otherwise.
    expect(veil.compareDocumentPosition(sheet) & Node.DOCUMENT_POSITION_FOLLOWING).not.toBe(0);
    expect(getComputedStyle(veil).zIndex).toMatch(/^(auto|0|)$/);
  });

  it("lists every place above a card with two paths, each once", async () => {
    renderPage(ORDER, buildDetail(ORDER));

    const sheet = await openTheCard();

    const partOf = within(sheet).getByRole("heading", { name: "Part of" }).parentElement!;
    const rows = within(partOf).getAllByRole("listitem");
    expect(
      rows.map((row) => within(row).getByText(/^(Round A|Round B|Rotterdam depot)$/).textContent),
    ).toEqual(["Round A", "Round B", "Rotterdam depot"]);
  });

  it("says why a card may be out of date when no account can poll it", async () => {
    const stale = buildInboxCard(ORDER_ID, {
      ...ORDER,
      stale: true,
      observedAt: new Date(Date.now() - 3.5 * 24 * 3_600_000).toISOString(),
    });
    renderPage(stale, buildDetail(stale));

    const sheet = await openTheCard();

    expect(within(sheet).getByText(/^Last read 3 days ago/)).toBeTruthy();
  });

  it("says no account can read a card that lost access, and keeps what it knew", async () => {
    const lost = buildInboxCard(ORDER_ID, { ...ORDER, access: "inaccessible" });
    renderPage(lost, buildDetail(lost));

    const sheet = await openTheCard();

    expect(within(sheet).getByText(/^No account can read this now\./)).toBeTruthy();
    expect(
      within(sheet).getByRole("heading", { name: "Chilled crates for the depot" }),
    ).toBeTruthy();
  });

  it("offers Take it and Dismiss, and Take it calls the page with the card", async () => {
    const { onTake } = renderPage(ORDER, buildDetail(ORDER));
    const sheet = await openTheCard();

    await userEvent.setup().click(within(sheet).getByRole("button", { name: /^Take it/ }));

    expect(onTake).toHaveBeenCalledExactlyOnceWith(ORDER_ID);
  });

  it("turns the moves off and says why when the card's plugin is not active", async () => {
    renderPage(ORDER, buildDetail(ORDER, { kindAvailable: false }));
    const sheet = await openTheCard();

    expect(await within(sheet).findByText(/plugin is turned off/)).toBeTruthy();
    expect(
      within(sheet).getByRole<HTMLButtonElement>("button", { name: /^Take it/ }).disabled,
    ).toBe(true);
    expect(
      within(sheet).getByRole<HTMLButtonElement>("button", { name: /^Dismiss/ }).disabled,
    ).toBe(true);
  });

  it("offers only the way to its Task on a card that has one", async () => {
    const held = buildInboxCard(ORDER_ID, { ...ORDER, taskId: "task-1" });
    const { onSeeTask } = renderPage(held, buildDetail(held));
    const sheet = await openTheCard();

    await userEvent.setup().click(within(sheet).getByRole("button", { name: /^See its Task/ }));

    expect(onSeeTask).toHaveBeenCalledExactlyOnceWith("task-1");
    expect(within(sheet).queryByRole("button", { name: /^Take it/ })).toBeNull();
  });

  it("walks to a place inside the sheet, shows what it says about itself, and a line at the top goes back", async () => {
    renderPage(ORDER, buildDetail(ORDER));
    const sheet = await openTheCard();
    const user = userEvent.setup();

    await user.click(within(sheet).getByRole("button", { name: /Rotterdam depot/ }));

    expect(within(sheet).getByRole("heading", { name: "Rotterdam depot" })).toBeTruthy();
    expect(within(sheet).getByText("4 of 9 done, as reported by acme")).toBeTruthy();
    expect(within(sheet).getByRole("heading", { name: "Yours here" })).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: /^Take it/ })).toBeNull();

    // The card lies under the depot by two paths, so it is listed under both rounds. The first button with its name is the line at the top.
    const [back] = within(sheet).getAllByRole("button", { name: "Chilled crates for the depot" });
    await user.click(back!);

    expect(
      within(sheet).getByRole("heading", { name: "Chilled crates for the depot" }),
    ).toBeTruthy();
    expect(within(sheet).getByRole("button", { name: /^Take it/ })).toBeTruthy();
  });

  it("walks from a place to a place inside it, and back through each", async () => {
    renderPage(ORDER, buildDetail(ORDER));
    const sheet = await openTheCard();
    const user = userEvent.setup();
    await user.click(within(sheet).getByRole("button", { name: /Rotterdam depot/ }));

    await user.click(within(sheet).getByRole("button", { name: /^Round A/ }));
    expect(within(sheet).getByRole("heading", { name: "Round A" })).toBeTruthy();

    await user.click(within(sheet).getByRole("button", { name: "Rotterdam depot" }));
    expect(within(sheet).getByRole("heading", { name: "Rotterdam depot" })).toBeTruthy();
  });
});
