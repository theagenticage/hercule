/** Test cards and Inbox things, in the invented Northwind Market world. */
import type {
  Connection,
  EntityHint,
  EntityLink,
  EntityPeer,
  EntityPlace,
  EntitySignalLine,
  InboxThing,
  PluginDetail,
  WorkflowOffer,
} from "@hercule/contract";
import type { CardRecord } from "./card-face";

/**
 * Returns a rich card of the invented `acme/ticket` kind, grouped under
 * an `acme/project`, that was assigned to the user and observed on 1 November. `overrides` change any field.
 */
export const buildInboxCard = (id: string, overrides: Partial<CardRecord> = {}): CardRecord => ({
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
export const buildRequestCard = (id: string, overrides: Partial<CardRecord> = {}): CardRecord =>
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
 * Returns a link between two refs under the claim given: a `source` claim of
 * the invented `acme` plugin, or a `person` claim of the user.
 */
export const buildInboxLink = (
  fromRef: string,
  toRef: string,
  type: EntityLink["claim"]["type"] = "source",
  hasPersonClaim: boolean = type === "person",
): EntityLink => ({
  fromRef,
  toRef,
  hasPersonClaim,
  claim: type === "source" ? { type, plugin: "acme" } : { type, actor: "user" },
});

/** Returns a hint: `fromRef` mentions `toRef` in its description. */
export const buildInboxHint = (fromRef: string, toRef: string): EntityHint => ({
  fromRef,
  toRef,
  evidenceKey: "description",
});

/**
 * Returns a peer: a linked record with no card of its own, named by an
 * identifier made from its ref. `overrides` change any field, and
 * `withoutIdentifier` leaves the identifier out, as a source that has none does.
 */
export const buildInboxPeer = (
  ref: string,
  overrides: Partial<EntityPeer> = {},
  withoutIdentifier = false,
): EntityPeer => {
  const { identifier, ...rest } = {
    ref,
    kind: "acme/ticket",
    noun: "Ticket",
    identifier: ref.slice(ref.lastIndexOf(":") + 1).toUpperCase(),
    title: `Peer ${ref}`,
    yours: false,
    restricted: false,
    ...overrides,
  };
  return withoutIdentifier || identifier === undefined ? rest : { ...rest, identifier };
};

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
  lifecycle: "open",
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
