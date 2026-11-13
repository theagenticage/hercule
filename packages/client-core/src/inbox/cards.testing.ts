/**
 * Test cards and Inbox things, in the invented Northwind Market world, and a
 * fake controller's Inbox (`FakeInbox`) that answers the Inbox's reads from them.
 */
import type {
  Connection,
  EntityPlace,
  ExternalEntityDetail,
  InboxFirstPage,
  InboxQuery,
  InboxReply,
  EntityRecord,
  EntitySignalLine,
  InboxAsk,
  InboxCounts,
  InboxOutline,
  InboxThing,
  PluginDetail,
  WorkflowOffer,
} from "@hercule/contract";

/**
 * Returns a rich card of the invented `acme/ticket` kind, grouped under
 * an `acme/project`, that was assigned to the user and observed on 1 November. `overrides` change any field.
 */
export const buildInboxCard = (
  id: string,
  overrides: Partial<EntityRecord> = {},
): EntityRecord => ({
  id,
  ref: `acme:ticket:${id}`,
  kind: "acme/ticket",
  noun: "Ticket",
  card: "rich",
  home: "acme/project",
  section: "acme/milestone",
  pace: "slow",
  patience: 336,
  identifier: `ACME-${id}`,
  title: `Ticket ${id}`,
  url: `https://acme.example/${id}`,
  lifecycle: "open",
  yours: false,
  facts: [],
  concerns: ["assigned"],
  access: "ok",
  observedAt: "2026-11-05T09:00:00.000Z",
  stale: false,
  sourceUpdatedAt: "2026-11-05T09:00:00.000Z",
  firstObservedAt: "2026-11-01T09:00:00.000Z",
  ancestors: [],
  contextComplete: true,
  ...overrides,
});

/**
 * Returns a compact card of the invented `acme/review` kind: a fast-paced
 * request with a patience of 24 hours. `overrides` change any field.
 */
export const buildRequestCard = (id: string, overrides: Partial<EntityRecord> = {}): EntityRecord =>
  buildInboxCard(id, {
    ref: `acme:review:${id}`,
    kind: "acme/review",
    noun: "Review",
    card: "compact",
    home: "acme/repository",
    pace: "fast",
    patience: 24,
    identifier: `#${id}`,
    title: `Review ${id}`,
    concerns: ["review-requested"],
    ...overrides,
  });

/**
 * Returns a place of the invented `acme/project` kind, a groupable kind with
 * the noun "Project" and the caption "Acme project". `overrides` change any field.
 */
export const buildInboxPlace = (
  ref: string,
  title: string,
  overrides: Partial<EntityPlace> = {},
): EntityPlace => ({
  ref,
  kind: "acme/project",
  noun: "Project",
  caption: "Acme project",
  title,
  restricted: false,
  ...overrides,
});

/**
 * Returns a signal line landed at `createdAt`, whose sentence is `say`. The
 * kind is the invented `acme/review-requested`. `overrides` change any field.
 */
export const buildSignalLine = (
  id: string,
  say: string,
  overrides: Partial<EntitySignalLine> = {},
): EntitySignalLine => ({
  id,
  kind: "acme/review-requested",
  title: say,
  priority: "normal",
  status: "open",
  createdAt: "2026-11-07T09:00:00.000Z",
  say: { say, tone: "plain" },
  snoozed: false,
  ...overrides,
});

/**
 * Returns an open ask of the invented `acme/review-requested` kind, raised by
 * `asker` ("Mei asked for your review"), or by nobody when `asker` is null.
 * `overrides` change any field.
 */
export const buildInboxAsk = (
  id: string,
  asker: string | null = "Mei",
  overrides: Partial<InboxAsk> = {},
): InboxAsk => ({
  id,
  kind: "acme/review-requested",
  noun: "review request",
  ...(asker === null ? {} : { asker }),
  say: {
    say: asker === null ? "Review requested" : `${asker} asked for your review`,
    tone: "plain",
  },
  createdAt: "2026-11-07T09:00:00.000Z",
  ...overrides,
});

/**
 * Returns an available offer of the workflow `name` that answers the given
 * signal kinds. `unavailable` makes it one the card cannot be handed to.
 */
export const buildWorkflowOffer = (
  name: string,
  answers: readonly string[] = [],
  unavailable?: WorkflowOffer["unavailable"],
): WorkflowOffer => ({
  workflowId: `wf-${name.toLowerCase().replaceAll(" ", "-")}`,
  name,
  answers,
  ...(unavailable === undefined ? {} : { unavailable }),
});

/** Returns the sidebar's counts with nothing in them. `overrides` change any field. */
export const buildInboxCounts = (overrides: Partial<InboxCounts> = {}): InboxCounts => ({
  waiting: 0,
  newestArrival: 0,
  ...overrides,
});

/** Returns the Inbox's outline with nothing in it: no saved query counts anything. `overrides` change any field. */
export const buildInboxOutline = (overrides: Partial<InboxOutline> = {}): InboxOutline => ({
  savedQueries: [],
  sources: [],
  pins: [],
  fields: [],
  failing: [],
  ...overrides,
});

/**
 * Returns a row of the Inbox for a thing of the invented `acme/ticket` kind,
 * with no asks and no Task. `overrides` change any field.
 */
export const buildInboxThing = (id: string, overrides: Partial<InboxThing> = {}): InboxThing => ({
  id,
  ref: `acme:ticket:${id}`,
  kind: "acme/ticket",
  noun: "Ticket",
  source: "acme",
  identifier: `ACME-${id}`,
  title: `Ticket ${id}`,
  url: `https://acme.example/${id}`,
  access: "ok",
  stale: false,
  observedAt: "2026-11-05T09:00:00.000Z",
  sourceUpdatedAt: "2026-11-05T09:00:00.000Z",
  patience: 336,
  face: null,
  asks: [],
  askCount: 0,
  askKinds: [],
  openKinds: [],
  takenOn: false,
  arrival: 0,
  liveWorkflows: [],
  offerSetId: "none",
  actingConnections: [],
  accounts: [],
  ...overrides,
});

/**
 * Returns a plugin that declares the given kinds of card, such as
 * `{ word: "acme/review", card: "compact", connect: "Reviews people ask of you" }`.
 * A kind is shortened to what a test sets: the rest is a plain kind.
 */
export const buildSourcePlugin = (
  id: string,
  displayName: string,
  kinds: ReadonlyArray<{
    readonly word: string;
    readonly card?: "rich" | "compact";
    readonly pace?: "fast" | "slow" | "context";
    readonly connect?: string;
  }> = [],
): PluginDetail => ({
  id,
  displayName,
  hostApi: 8,
  capabilities: [],
  enabled: true,
  status: { _tag: "active" },
  config: {},
  contributions: [],
  intake: { eventKinds: [], signalKinds: [] },
  entityKinds: kinds.map((kind) => ({
    word: kind.word,
    noun: "Thing",
    refPrefix: `${id}:`,
    pace: kind.pace ?? "slow",
    patience: 24,
    identifier: "#{number}",
    person: null,
    owner: null,
    status: null,
    facts: [],
    reasons: {},
    ...(kind.card === undefined ? {} : { card: kind.card }),
    ...(kind.connect === undefined ? {} : { connect: kind.connect }),
  })),
});

/** Returns a Connection of the given type, such as `acme/account`, in the given status. */
export const buildSourceConnection = (
  id: string,
  type: string,
  overrides: Partial<Connection> = {},
): Connection => ({
  id,
  type,
  label: id,
  displayName: id,
  status: "connected",
  labels: [],
  config: {},
  feedIntervals: {},
  credentials: [],
  createdAt: "2026-10-01T00:00:00.000Z",
  updatedAt: "2026-10-01T00:00:00.000Z",
  ...overrides,
});

/** Builds the detail the Inbox's pane reads for `thing`: a compact card with no signals, links or offers. */
export const buildFakeInboxDetail = (thing: InboxThing): ExternalEntityDetail => ({
  id: thing.id,
  ref: thing.ref,
  kind: thing.kind,
  noun: thing.noun,
  card: "compact",
  pace: "fast",
  patience: thing.patience,
  identifier: thing.identifier,
  title: thing.title,
  url: thing.url,
  lifecycle: "open",
  yours: false,
  facts: [],
  concerns: [],
  access: "ok",
  observedAt: thing.observedAt,
  stale: false,
  sourceUpdatedAt: thing.sourceUpdatedAt,
  firstObservedAt: thing.observedAt,
  ancestors: [],
  contextComplete: true,
  kindAvailable: true,
  fields: [],
  face: null,
  places: [],
  edges: [],
  links: [],
  hints: [],
  conflicts: [],
  signals: [],
  openCount: 0,
  signalCount: 0,
  timeline: [],
  peers: [],
  offers: [],
  actingConnections: [],
});

/** What the fake controller holds for the Inbox: the things of each saved query, in order, the rail's outline, and the arrival the sidebar's count reports. */
export interface FakeInbox {
  lists: Record<string, InboxThing[]>;
  outline: InboxOutline;
  /** The sidebar's `newestArrival`. */
  newestArrival: number;
  /** The most things one page holds. */
  pageSize: number;
  /** The workflows each `offerSetId` of the things offers. */
  offerSets: Record<string, WorkflowOffer[]>;
}

/**
 * Returns the controller's answer to one `queryInbox` from `inbox`, in the
 * mode the query asks: the first page, the next page after a cursor, a
 * refresh of the first page with the held rows, or the held rows alone.
 */
export const answerFakeInboxQuery = (inbox: FakeInbox, query: InboxQuery): InboxReply => {
  const name = "savedQuery" in query.list ? query.list.savedQuery : "browse";
  let things = inbox.lists[name] ?? [];
  // The fake narrows by any clause value found in a title, which is all the tests need of a filter.
  const values = (query.clauses ?? []).map((clause) => String(clause.value).toLowerCase());
  things = things.filter((thing) =>
    values.every((value) => thing.title.toLowerCase().includes(value)),
  );
  const { offerSets } = inbox;
  const heldThings = (refs: readonly string[]): InboxThing[] =>
    things.filter((thing) => refs.includes(thing.ref));
  if (query.mode === "rows") {
    return { mode: "rows", things: heldThings(query.held), groups: [], offerSets };
  }
  const from = query.mode === "next" ? Number(query.after) : 0;
  const page = things.slice(from, from + inbox.pageSize);
  const next = from + inbox.pageSize;
  const nextCursor = next < things.length ? { nextCursor: String(next) } : {};
  if (query.mode === "next") {
    return { mode: "next", things: page, groups: [], ...nextCursor, offerSets };
  }
  const first: InboxFirstPage = {
    mode: "first",
    things: page,
    groups: [],
    total: things.length,
    order: name === "waits" ? "waiting" : "newest",
    facets: [],
    ...nextCursor,
    offerSets,
  };
  if (query.mode === "first") return first;
  const onFirstPage = new Set(page.map((thing) => thing.ref));
  return {
    mode: "refresh",
    first,
    held: {
      things: heldThings(query.held).filter((thing) => !onFirstPage.has(thing.ref)),
      groups: [],
      offerSets,
    },
  };
};
