/** Test cards for the Inbox, in the invented Northwind Market world. */
import type { EntityPlace, Inbox, InboxCard } from "@hercule/contract";

/**
 * Returns a rich card of the invented `acme/ticket` kind, grouped under
 * an `acme/project`, that was assigned to the user and observed on 1 November. `overrides` change any field.
 */
export const buildInboxCard = (id: string, overrides: Partial<InboxCard> = {}): InboxCard => ({
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
  side: "ongoing",
  ...overrides,
});

/**
 * Returns a compact card of the invented `acme/review` kind: a fast-paced
 * request with a patience of 24 hours. `overrides` change any field.
 */
export const buildRequestCard = (id: string, overrides: Partial<InboxCard> = {}): InboxCard =>
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
    side: "requests",
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

/** Returns an Inbox of these cards, in this order, with the places and edges given. */
export const buildInbox = (
  cards: readonly InboxCard[],
  context: Partial<Pick<Inbox, "places" | "edges">> = {},
): Inbox => ({
  cards,
  places: [],
  edges: [],
  counts: { onTheClock: 0, requests: 0, withSomeoneElse: 0, newestArrival: 0 },
  truncated: false,
  ...context,
});

/** Returns the ids of these cards, for a short comparison. */
export const listCardIds = (cards: readonly { readonly card: InboxCard }[]): readonly string[] =>
  cards.map((row) => row.card.id);
