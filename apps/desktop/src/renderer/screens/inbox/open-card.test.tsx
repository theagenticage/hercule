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
import type {
  EntityLink,
  EntitySignalLine,
  ExternalEntityDetail,
  Inbox,
  InboxCard,
  PluginDetail,
  Signal,
} from "@hercule/contract";
import type { EntityLinkMove } from "@hercule/client-core/inbox";
import { createQueryClient } from "../../app/query-client";
import { CONTROLLER_URL, stubApi, type Call, type Handler } from "../../app/testing";
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
  readonly onLink: ReturnType<typeof vi.fn<(move: EntityLinkMove) => void>>;
  readonly onUnlink: ReturnType<typeof vi.fn<(move: EntityLinkMove) => void>>;
  readonly onSeeInIntake: ReturnType<typeof vi.fn<(entityId: string) => void>>;
  /** The calls made to the stubbed controller, in order. */
  readonly calls: readonly Call[];
}

/**
 * Renders a page with one card that opens into the sheet, and returns what the
 * sheet's moves called. `handlers` answer more calls of the controller, and
 * `inbox` replaces the page's Inbox.
 */
const renderPage = (
  card: InboxCard,
  detail: ExternalEntityDetail,
  options: { readonly handlers?: Readonly<Record<string, Handler>>; readonly inbox?: Inbox } = {},
): Rendered => {
  const calls = stubApi({
    [`GET /api/v1/external-entities/${card.id}`]: { body: detail },
    ...options.handlers,
  });
  const client = createClient({ baseUrl: CONTROLLER_URL, token: "bearer" });
  const onTake = vi.fn<(cardId: string) => void>();
  const onSeeTask = vi.fn<(taskId: string) => void>();
  const onLink = vi.fn<(move: EntityLinkMove) => void>();
  const onUnlink = vi.fn<(move: EntityLinkMove) => void>();
  const onSeeInIntake = vi.fn<(entityId: string) => void>();
  const inbox = options.inbox ?? buildInboxOf(card);
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
          platform="linux"
          onTake={onTake}
          onDismiss={vi.fn()}
          onSeeTask={onSeeTask}
          onLink={onLink}
          onUnlink={onUnlink}
          onSeeInIntake={onSeeInIntake}
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
  return { onTake, onSeeTask, onLink, onUnlink, onSeeInIntake, calls };
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

// ---------- The timeline, its answers, the links ----------

const SIGNAL_IDS = [
  "01a06d02-7e00-7000-8000-000000000c01",
  "01a06d02-7e00-7000-8000-000000000c02",
  "01a06d02-7e00-7000-8000-000000000c03",
] as const;

const buildLine = (
  id: string,
  hoursAgo: number,
  overrides: Partial<EntitySignalLine> = {},
): EntitySignalLine => ({
  id,
  kind: "acme/comment",
  title: `Signal ${id.slice(-2)}`,
  priority: "normal",
  status: "open",
  createdAt: new Date(Date.now() - hoursAgo * 3_600_000).toISOString(),
  say: { say: `Said ${id.slice(-2)}`, tone: "plain" },
  snoozed: false,
  ...overrides,
});

/** Returns what `signal.read` answers for the signal `id`: it can be approved, and marked done. */
const buildSignal = (id: string, overrides: Partial<Signal> = {}): Signal => ({
  id,
  kind: "acme/comment",
  origin: { type: "api", actor: "user", eventIds: [], reason: "Test" },
  title: `Signal ${id.slice(-2)}`,
  priority: "normal",
  blocks: [],
  actions: [
    {
      id: "approve",
      label: "Approve",
      operation: null,
      primary: true,
      describeLine: [{ kind: "text", text: "Approves the change on Acme." }],
    },
    { id: "done", label: "Mark done", operation: null },
  ],
  match: {},
  status: "open",
  createdAt: "2026-11-05T09:00:00.000Z",
  ...overrides,
});

const signalPath = (id: string): string => `GET /api/v1/signals/${id}`;

/** Returns the calls whose method and path are `route`. */
const callsTo = (calls: readonly Call[], route: string): readonly Call[] =>
  calls.filter((call) => `${call.method} ${call.path}` === route);

describe("the timeline of the open card", () => {
  it("weaves the signals and what changed at the source by time, oldest first, each with how long ago", async () => {
    const detail = buildDetail(ORDER, {
      signals: [buildLine(SIGNAL_IDS[0], 5, { status: "resolved", outcome: "Approved" })],
      signalCount: 1,
      timeline: [
        {
          reason: "reassigned",
          say: { say: "Now with Tessa", tone: "plain" },
          at: new Date(Date.now() - 50 * 3_600_000).toISOString(),
        },
        {
          reason: "moved",
          say: { say: "Moved to In Review", tone: "plain" },
          at: new Date(Date.now() - 2 * 3_600_000).toISOString(),
        },
      ],
    });
    renderPage(ORDER, detail);

    const sheet = await openTheCard();

    const lines = await within(sheet).findAllByRole("listitem");
    const timeline = lines
      .filter((line) => line.classList.contains("open-card-signal"))
      .map((line) => line.textContent);
    expect(timeline).toEqual([
      "Now with Tessa2 days ago",
      `Said ${SIGNAL_IDS[0].slice(-2)}Approved5h ago`,
      "Moved to In Review2h ago",
    ]);
  });

  it("opens the newest open line that is not snoozed, and reads that one signal and no other", async () => {
    const detail = buildDetail(ORDER, {
      signals: [
        buildLine(SIGNAL_IDS[0], 70),
        buildLine(SIGNAL_IDS[1], 30),
        buildLine(SIGNAL_IDS[2], 1, { snoozed: true }),
      ],
      openCount: 3,
      signalCount: 3,
    });
    const { calls } = renderPage(ORDER, detail, {
      handlers: { [signalPath(SIGNAL_IDS[1])]: { body: buildSignal(SIGNAL_IDS[1]) } },
    });

    const sheet = await openTheCard();

    expect(await within(sheet).findByRole("button", { name: "Approve" })).toBeTruthy();
    expect(callsTo(calls, signalPath(SIGNAL_IDS[0]))).toHaveLength(0);
    expect(callsTo(calls, signalPath(SIGNAL_IDS[2]))).toHaveLength(0);
    expect(callsTo(calls, signalPath(SIGNAL_IDS[1]))).toHaveLength(1);
    // The Inbox's own keys are not keys of an answer.
    expect(sheet.querySelector(".open-card-answers kbd")).toBeNull();
  });

  it("answers through signal.act, and leaves out Hand to an agent, which stays on Intake", async () => {
    const detail = buildDetail(ORDER, {
      signals: [buildLine(SIGNAL_IDS[0], 3)],
      openCount: 1,
      signalCount: 1,
    });
    const handTo = {
      id: "hand-to-01a0ec64-6e80-7000-8000-0000000000f8",
      label: "Hand to Review PR",
      operation: {
        op: "signal.handOff",
        input: { signalId: SIGNAL_IDS[0], workflowId: "01a0ec64-6e80-7000-8000-0000000000f8" },
      },
    } as const;
    const open = buildSignal(SIGNAL_IDS[0]);
    const { calls } = renderPage(ORDER, detail, {
      handlers: {
        [signalPath(SIGNAL_IDS[0])]: { body: { ...open, actions: [...open.actions, handTo] } },
        [`POST /api/v1/signals/${SIGNAL_IDS[0]}/act`]: {
          body: {
            ...open,
            status: "resolved",
            resolution: {
              kind: "answered",
              outcome: "Approved",
              at: "2026-11-06T09:00:00.000Z",
              by: "user",
            },
          },
        },
      },
    });
    const sheet = await openTheCard();

    await userEvent.setup().click(await within(sheet).findByRole("button", { name: "Approve" }));

    await waitFor(() => {
      expect(callsTo(calls, `POST /api/v1/signals/${SIGNAL_IDS[0]}/act`)).toHaveLength(1);
    });
    expect(callsTo(calls, `POST /api/v1/signals/${SIGNAL_IDS[0]}/act`)[0]?.body).toEqual({
      actionId: "approve",
    });
    expect(within(sheet).queryByRole("button", { name: "Hand to Review PR" })).toBeNull();
  });

  it("marks only the opened line done, with signal.markDone", async () => {
    const detail = buildDetail(ORDER, {
      signals: [buildLine(SIGNAL_IDS[0], 30), buildLine(SIGNAL_IDS[1], 3)],
      openCount: 2,
      signalCount: 2,
    });
    const { calls } = renderPage(ORDER, detail, {
      handlers: {
        [signalPath(SIGNAL_IDS[1])]: { body: buildSignal(SIGNAL_IDS[1]) },
        "POST /api/v1/signals/mark-done": { body: { done: [SIGNAL_IDS[1]] } },
      },
    });
    const sheet = await openTheCard();

    await userEvent.setup().click(await within(sheet).findByRole("button", { name: "Mark done" }));

    await waitFor(() => {
      expect(callsTo(calls, "POST /api/v1/signals/mark-done")).toHaveLength(1);
    });
    expect(callsTo(calls, "POST /api/v1/signals/mark-done")[0]?.body).toEqual({
      signalIds: [SIGNAL_IDS[1]],
    });
  });

  it("says how many open lines it leaves out, and that line shows them on Intake", async () => {
    const detail = buildDetail(ORDER, {
      signals: [buildLine(SIGNAL_IDS[0], 30), buildLine(SIGNAL_IDS[1], 3)],
      openCount: 14,
      signalCount: 20,
    });
    const { onSeeInIntake } = renderPage(ORDER, detail, {
      handlers: { [signalPath(SIGNAL_IDS[1])]: { body: buildSignal(SIGNAL_IDS[1]) } },
    });
    const sheet = await openTheCard();

    await userEvent
      .setup()
      .click(await within(sheet).findByRole("button", { name: "and 12 more open" }));

    expect(onSeeInIntake).toHaveBeenCalledExactlyOnceWith(ORDER_ID);
  });

  it("says how many resolved lines it leaves out in plain words when no open line is left out", async () => {
    const detail = buildDetail(ORDER, {
      signals: [buildLine(SIGNAL_IDS[0], 3, { status: "resolved" })],
      openCount: 0,
      signalCount: 13,
    });
    renderPage(ORDER, detail);
    const sheet = await openTheCard();

    expect(await within(sheet).findByText("and 12 older")).toBeTruthy();
    expect(within(sheet).queryByRole("button", { name: "and 12 older" })).toBeNull();
  });
});

const PR = buildInboxPlace("acme:review:9", "Retry card payments", {
  kind: "acme/review",
  noun: "Review",
  identifier: "#9",
  status: { shape: "fork", tone: "active", label: "Checks failed" },
});
const SPEC = buildInboxPlace("acme:doc:3", "Payment retry spec", {
  kind: "acme/doc",
  noun: "Doc",
  identifier: "DOC-3",
});

const linkTo = (ref: string, claim: EntityLink["claim"]): EntityLink => ({
  fromRef: ORDER.ref,
  toRef: ref,
  claim,
});

describe("the Linked section of the open card", () => {
  it("names who says each link on hover, and lets only a link the user made be removed", async () => {
    const detail = buildDetail(ORDER, {
      places: [ROUND_A, ROUND_B, DEPOT, PR, SPEC],
      links: [
        linkTo(PR.ref, { type: "source", plugin: "acme" }),
        linkTo(SPEC.ref, { type: "person" }),
      ],
    });
    const { onUnlink } = renderPage(ORDER, detail);
    const sheet = await openTheCard();
    const linked = (await within(sheet).findByRole("heading", { name: "Linked" })).parentElement!;
    const rows = within(linked).getAllByRole("listitem");

    expect(rows.map((row) => row.querySelector(".relation-claim")?.textContent)).toEqual([
      "acme reports this",
      "You linked this",
    ]);
    expect(within(rows[0]!).queryByRole("button", { name: /^Remove the link/ })).toBeNull();
    await userEvent
      .setup()
      .click(
        within(rows[1]!).getByRole("button", { name: "Remove the link to Payment retry spec" }),
      );
    expect(onUnlink).toHaveBeenCalledExactlyOnceWith({
      fromRef: ORDER.ref,
      toRef: SPEC.ref,
      fromName: ORDER.identifier,
      toName: "DOC-3",
    });
  });

  it("draws a link to a thing no Connection can read as a locked row, and never throws for a far end nobody holds", async () => {
    const detail = buildDetail(ORDER, {
      links: [
        linkTo("acme:review:locked", { type: "source", plugin: "acme" }),
        linkTo("acme:review:nobody", { type: "source", plugin: "acme" }),
      ],
      peers: [
        {
          ref: "acme:review:locked",
          kind: "acme/review",
          noun: "Review",
          yours: false,
          restricted: true,
        },
      ],
    });
    renderPage(ORDER, detail);
    const sheet = await openTheCard();

    const linked = (await within(sheet).findByRole("heading", { name: "Linked" })).parentElement!;
    expect(within(linked).getByText("An acme review you cannot open")).toBeTruthy();
    expect(within(linked).getAllByRole("listitem")).toHaveLength(1);
  });

  it("offers a reference found in text as a hint that links when Link is pressed", async () => {
    const detail = buildDetail(ORDER, {
      places: [ROUND_A, ROUND_B, DEPOT, SPEC],
      links: [
        {
          fromRef: SPEC.ref,
          toRef: ORDER.ref,
          claim: { type: "text", evidenceKey: "description" },
        },
      ],
    });
    const { onLink } = renderPage(ORDER, detail);
    const sheet = await openTheCard();

    expect(await within(sheet).findByText("Found in the description of DOC-3")).toBeTruthy();
    await userEvent.setup().click(within(sheet).getByRole("button", { name: "Link" }));

    expect(onLink).toHaveBeenCalledExactlyOnceWith({
      fromRef: ORDER.ref,
      toRef: SPEC.ref,
      fromName: ORDER.identifier,
      toName: "DOC-3",
    });
  });

  it("ignores a press on a remove button in the moment after a link was made", async () => {
    const detail = buildDetail(ORDER, {
      places: [ROUND_A, ROUND_B, DEPOT, SPEC],
      links: [
        { fromRef: SPEC.ref, toRef: ORDER.ref, claim: { type: "text" } },
        linkTo(PR.ref, { type: "person" }),
      ],
      peers: [
        {
          ref: PR.ref,
          kind: "acme/review",
          noun: "Review",
          title: "Retry",
          identifier: "#9",
          yours: false,
          restricted: false,
        },
      ],
    });
    const { onLink, onUnlink } = renderPage(ORDER, detail);
    const sheet = await openTheCard();
    const user = userEvent.setup();

    await user.click(await within(sheet).findByRole("button", { name: "Link" }));
    await user.click(within(sheet).getByRole("button", { name: "Remove the link to Retry" }));

    expect(onLink).toHaveBeenCalledTimes(1);
    expect(onUnlink).not.toHaveBeenCalled();
  });
});

const buildSource = (id: string, displayName: string): PluginDetail => ({
  id,
  displayName,
  hostApi: 8,
  capabilities: ["entities"],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: [
    {
      word: `${id}/issue`,
      noun: "Issue",
      card: "compact",
      refPrefix: `${id}:issue:`,
      pace: "fast",
      patience: 24,
      identifier: "#{number}",
      person: null,
      owner: null,
      status: null,
      facts: [],
      reasons: {},
    },
  ],
});

describe("Link something in the open card", () => {
  const found = (ref: string, identifier: string, title: string) => ({
    ref,
    kind: "relay/issue",
    noun: "Issue",
    identifier,
    title,
    standing: "known",
  });

  it("searches a source other than the card's own, and links the chosen result", async () => {
    const detail = buildDetail(ORDER, {
      links: [linkTo("relay:issue:2", { type: "person" })],
      places: [
        ROUND_A,
        ROUND_B,
        DEPOT,
        buildInboxPlace("relay:issue:2", "Already linked", { kind: "relay/issue", noun: "Issue" }),
      ],
    });
    const { onLink, calls } = renderPage(ORDER, detail, {
      handlers: {
        "GET /api/v1/plugins": {
          body: [buildSource("acme", "Acme"), buildSource("relay", "Relay")],
        },
        "GET /api/v1/external-entities/search": {
          body: {
            source: "relay",
            outcome: "results",
            results: [
              found(ORDER.ref, "ACME-1", "The thing itself"),
              found("relay:issue:2", "#2", "Already linked"),
              found("relay:issue:3", "#3", "Gift message is cut off"),
            ],
            incomplete: false,
            linkSources: [],
          },
        },
      },
    });
    const sheet = await openTheCard();
    const user = userEvent.setup();

    await user.click(within(sheet).getByRole("button", { name: "Link something" }));
    await user.type(await within(sheet).findByRole("textbox", { name: "Link something" }), "gift");
    const row = await within(sheet).findByRole("button", { name: /Gift message is cut off/ });

    // The card's own plugin is acme, so the search starts on relay.
    expect(callsTo(calls, "GET /api/v1/external-entities/search")[0]?.search).toContain(
      "source=relay",
    );
    expect(within(sheet).queryByText("The thing itself")).toBeNull();
    const results = within(sheet.querySelector<HTMLElement>(".open-card-found")!);
    expect(results.queryByRole("button", { name: /Already linked/ })).toBeNull();
    await user.click(row);
    expect(onLink).toHaveBeenCalledExactlyOnceWith({
      fromRef: ORDER.ref,
      toRef: "relay:issue:3",
      fromName: ORDER.identifier,
      toName: "#3",
    });
  });
});
