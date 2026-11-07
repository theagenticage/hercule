/**
 * External Entities: durable records of outside things, such as a pull
 * request, a ticket or an error, and the Inbox that lists the ones that
 * concern the user.
 *
 * An External Entity is never a copy of the thing. It holds what a card
 * needs to draw, copied from the plugin's kind table when the entity is
 * observed, so a card reads well after its plugin is gone. A record of a kind
 * with no card, such as a repository, is a place (`EntityPlace`): it has no
 * Inbox card and no moves, and it travels in a reply by ref.
 *
 * This file holds the operations and the schemas they carry. The status, the
 * place and the edge are in `entity-context.ts`, which the Work board shares.
 */
import {
  ENTITY_CONCERNS,
  EntityRepository,
  MAX_ENTITY_EVIDENCE_KEY_LENGTH,
  MAX_ENTITY_FACTS,
  PluginId,
} from "@hercule/plugin-host";
import { Schema } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import {
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Actor, ExternalRef, Id, Timestamp } from "../ids";
import { Authenticated } from "../security";
import { atMost, bounded } from "../strings";
import {
  EntityChange,
  EntityEdge,
  EntityPlace,
  EntityReason,
  EntityStatus,
  MAX_GRAPH_EDGES,
} from "./entity-context";
import {
  MAX_SIGNAL_ASKER_LENGTH,
  MAX_SIGNAL_OUTCOME_LENGTH,
  MAX_SIGNAL_TITLE_LENGTH,
  SignalKind,
  SignalStatus,
} from "./signal";
import { MAX_SEARCH_TEXT_LENGTH, TaskPriority, TaskStage } from "./task";

export { ENTITY_CONCERNS, EntityRepository, MAX_ENTITY_FACTS };

/** The most cards one Inbox read returns. The reply says when there were more. */
export const MAX_INBOX_CARDS = 1000;

/**
 * The most places one Inbox read carries. Each card brings at most one home,
 * and each edge at most one more place above it, so the bound is the card
 * limit plus `MAX_GRAPH_EDGES`.
 */
export const MAX_INBOX_PLACES = MAX_INBOX_CARDS + MAX_GRAPH_EDGES;

/** The most results one search reply holds. */
export const MAX_ENTITY_SEARCH_RESULTS = 20;

/**
 * The most levels the walk up `part of` goes. A thing reached at the limit
 * has more above it that the reply does not carry, and `contextComplete` says
 * so.
 */
export const MAX_CONTEXT_DEPTH = 8;

/** The most parents read for one thing when keeping context true. */
export const MAX_CONTEXT_PARENTS = 32;

/**
 * The most ancestors one entity lists, each once. It equals
 * `MAX_CONTEXT_PARENTS`: more than that many parents are never read for one
 * thing, so the list cannot honestly be longer. Past it, `contextComplete` is
 * false. Every card carries its list, so a small bound keeps an Inbox of
 * 1,000 cards small.
 */
export const MAX_ENTITY_ANCESTORS = MAX_CONTEXT_PARENTS;

/**
 * The most relationships one entity read lists, and the most refused claims.
 * A person links a few things; 100 is far past real use and keeps one read
 * small.
 */
export const MAX_ENTITY_LINKS = 100;

/**
 * The most direct links one Inbox read carries: the links of the cards on the
 * page. It equals `MAX_GRAPH_EDGES`, the bound of the reply's other lists of
 * pairs. A card links a few things, so the limit is far past real use.
 */
export const MAX_INBOX_LINKS = MAX_GRAPH_EDGES;

/**
 * The most peers one Inbox read carries: the records at the far end of a link
 * that have no card of their own. At most one per link.
 */
export const MAX_INBOX_PEERS = MAX_INBOX_LINKS;

/** The most signal lines one entity read carries. Open signals come first, so open work is never cut for resolved work. */
export const MAX_ENTITY_SIGNALS = 50;

/** The most changes one entity read carries. The oldest change of a thing is dropped first. */
export const MAX_ENTITY_TIMELINE = 50;

/** The most suggestions `listSuggestions` returns. The reply says when there were more. */
export const MAX_ENTITY_SUGGESTIONS = 100;

/** The most other contexts a suggestion names ("Also in Pricing rules"). */
export const MAX_SUGGESTION_CONTEXTS = 8;

/**
 * Why a thing concerns the user. A thing concerns the user while at least one
 * Connection reports a concern for it, or a live Task follows it.
 *
 * - `assigned`, `opened`, `review-requested`, `mentioned`: reported by a
 *   plugin, per Connection.
 * - `following`: never reported. It is worked out on read, from a live Task
 *   whose link to the thing was made by `addToWork`.
 */
export const EntityConcern = Schema.Literals(ENTITY_CONCERNS);

export type EntityConcern = Schema.Schema.Type<typeof EntityConcern>;

/**
 * A person a card names, in words. It carries no avatar: people are drawn as
 * letters taken from the name.
 */
export const EntityPerson = Schema.Struct({ name: bounded(1, 120) });

export type EntityPerson = Schema.Schema.Type<typeof EntityPerson>;

/**
 * One fact on a card, already in one of the six fixed forms, so a client
 * draws it with no knowledge of the kind that produced it.
 *
 * - `delta`: lines added and removed, drawn "+120 -30".
 * - `count`: a number with its unit in the singular ("file"). A client makes
 *   the plural.
 * - `word`: a short text.
 * - `date`: a day, drawn as "Due 12 Mar".
 * - `money`: an amount, as the source wrote it, currency included.
 * - `bars`: a level from 1 to 3, drawn as three bars of which `level` are lit.
 */
export const EntityFact = Schema.Union([
  Schema.Struct({
    form: Schema.Literal("delta"),
    added: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    removed: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  }),
  Schema.Struct({
    form: Schema.Literal("count"),
    value: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
    unit: bounded(1, 40),
  }),
  Schema.Struct({ form: Schema.Literal("word"), text: bounded(1, 80) }),
  Schema.Struct({ form: Schema.Literal("date"), on: Timestamp }),
  Schema.Struct({ form: Schema.Literal("money"), text: bounded(1, 40) }),
  Schema.Struct({
    form: Schema.Literal("bars"),
    level: Schema.Int.check(Schema.isBetween({ minimum: 1, maximum: 3 })),
  }),
]);

export type EntityFact = Schema.Schema.Type<typeof EntityFact>;

/**
 * A claim the graph refused, with why. A `part of` claim that would close a
 * loop is stored as evidence and shown here, never drawn.
 */
export const EntityConflict = Schema.Struct({
  fromRef: ExternalRef,
  relation: Schema.Literals(["part-of", "linked"]),
  toRef: ExternalRef,
  reason: bounded(1, 512),
});

export type EntityConflict = Schema.Schema.Type<typeof EntityConflict>;

/**
 * One relationship between peers as it is drawn: the pair once, under its
 * firmest claim (`source`, then `person`, then `text`).
 */
export const EntityLink = Schema.Struct({
  fromRef: ExternalRef,
  toRef: ExternalRef,
  /** The firmest claim, for the hover. It names only a plugin or an actor, never a Connection. */
  claim: Schema.Struct({
    type: Schema.Literals(["source", "person", "text"]),
    plugin: Schema.optionalKey(PluginId),
    actor: Schema.optionalKey(Actor),
    /**
     * Which text the reference was found in, such as "description". Set for a
     * `text` claim only, so a client can say "The description of #6263". A
     * `source` claim never carries one: the URL it came from stays on the server.
     */
    evidenceKey: Schema.optionalKey(bounded(1, MAX_ENTITY_EVIDENCE_KEY_LENGTH)),
  }),
  /**
   * True when a person also claims this pair (`externalEntity.link`), whatever
   * the firmest claim is. A source's claim hides the person's one in `claim`,
   * but the person can still remove theirs, and a client offers it from this.
   */
  hasPersonClaim: Schema.Boolean,
});

export type EntityLink = Schema.Schema.Type<typeof EntityLink>;

/**
 * One signal as a card draws it. Every field comes from the `Signal` record,
 * except `outcome`. A line holds no blocks and no answers: opening one reads
 * `signal.read`, which returns both.
 */
export const EntitySignalLine = Schema.Struct({
  id: Id,
  kind: SignalKind,
  title: bounded(1, MAX_SIGNAL_TITLE_LENGTH),
  asker: Schema.optionalKey(bounded(1, MAX_SIGNAL_ASKER_LENGTH)),
  priority: TaskPriority,
  status: SignalStatus,
  createdAt: Timestamp,
  /**
   * The sentence the card says for this line, finished: the kind's own words
   * for the signal with the asker put in, else the title.
   */
  say: EntityReason,
  /** `resolution.outcome`, when the signal has ended. */
  outcome: Schema.optionalKey(Schema.String.check(Schema.isMaxLength(MAX_SIGNAL_OUTCOME_LENGTH))),
  /** True while the signal is snoozed. */
  snoozed: Schema.Boolean,
});

export type EntitySignalLine = Schema.Schema.Type<typeof EntitySignalLine>;

/**
 * A record at the far end of a link that has no card of its own: it is not on
 * the Inbox, and a card shows it as a quiet row. A `restricted` peer, one no
 * Connection can read, holds only `ref`, `kind` and `noun`, with `restricted`
 * true and `yours` false: no title, identifier, status or change.
 */
export const EntityPeer = Schema.Struct({
  /**
   * The record's id when it is a full record of a work kind, so its quiet row
   * can open through `externalEntity.read`. Absent when `restricted` and for a place.
   */
  id: Schema.optionalKey(Id),
  ref: ExternalRef,
  kind: Schema.String,
  noun: bounded(1, 40),
  identifier: Schema.optionalKey(bounded(1, 64)),
  title: Schema.optionalKey(bounded(1, 512)),
  status: Schema.optionalKey(EntityStatus),
  /** True when any observing Connection reported the thing as owned by the user. Always false when `restricted`. */
  yours: Schema.Boolean,
  restricted: Schema.Boolean,
  /** The latest change at the source, when there is one. Absent when `restricted`. */
  latestChange: Schema.optionalKey(EntityChange),
});

export type EntityPeer = Schema.Schema.Type<typeof EntityPeer>;

/**
 * Which column of the Inbox a card lies in. The server decides it:
 *
 * - `with-someone-else`: the entity has a live Task.
 * - `requests`: no live Task, and the kind's card is `compact`.
 * - `ongoing`: no live Task, and the kind's card is `rich`.
 *
 * A client that keeps a card in its column for the length of a visit, after
 * it gets a Task, does so itself. The next read puts it under
 * `with-someone-else`.
 */
export const INBOX_SIDES = ["requests", "ongoing", "with-someone-else"] as const;

export const InboxSide = Schema.Literals(INBOX_SIDES);

export type InboxSide = Schema.Schema.Type<typeof InboxSide>;

/**
 * What every read of an entity holds. The slot names (`identifier`,
 * `person`, `facts` and the rest) come from the kind table, and the core
 * renders them from the plugin's raw fields before storing the row.
 */
const entityFields = {
  id: Id,
  ref: ExternalRef,
  /** The qualified kind word, such as `github/pull-request`. */
  kind: Schema.String,
  /** Copied from the kind at observation, so a card reads well after its plugin is gone. */
  noun: bounded(1, 40),
  /** Copied from the kind. */
  card: Schema.Literals(["rich", "compact"]),
  /** Copied from the kind: the qualified kind of place it is usually grouped under, such as `linear/project`. */
  home: Schema.optionalKey(Schema.String),
  /** Copied from the kind: the qualified kind of the level a row shows below its home. */
  section: Schema.optionalKey(Schema.String),
  /** Copied from the kind. `fast` has a clock, `slow` has none. */
  pace: Schema.Literals(["fast", "slow"]),
  /** Copied from the kind: the hours before a wait counts as due. */
  patience: Schema.Int,
  /** How the source names it, such as `#87` or `SHOP-123`. */
  identifier: bounded(1, 64),
  title: bounded(1, 512),
  url: Schema.String,
  /** Absent for a kind with no status. */
  status: Schema.optionalKey(EntityStatus),
  lifecycle: Schema.Literals(["open", "completed", "abandoned"]),
  person: Schema.optionalKey(EntityPerson),
  /**
   * True when any observing Connection reported the thing as owned by its
   * user, whichever Connection presents the shared fields.
   */
  yours: Schema.Boolean,
  /** At most `MAX_ENTITY_FACTS`, each in a fixed form. */
  facts: atMost(EntityFact, MAX_ENTITY_FACTS),
  /** Where the work lands, and where it comes from. Absent for a kind with no repository. */
  repository: Schema.optionalKey(EntityRepository),
  concerns: Schema.Array(EntityConcern),
  /**
   * Whether any Connection can read the thing: `ok` if any can, else
   * `deleted` if a source said so for certain, else `inaccessible`. An entity
   * that is `inaccessible` keeps its last known facts, and a client says so
   * beside them. Only a place carries `restricted`, for a thing that was
   * never readable.
   */
  access: Schema.Literals(["ok", "inaccessible", "deleted"]),
  /**
   * When its facts were last known true. They are as fresh as the last change
   * a client was told about: a poll that changes nothing announces nothing,
   * so on an open screen `observedAt` can lag a poll that succeeded and found
   * nothing new. A client shows the age only when `stale` is true.
   */
  observedAt: Timestamp,
  /** True when no Connection with `access: ok` can poll now. */
  stale: Schema.Boolean,
  sourceUpdatedAt: Timestamp,
  firstObservedAt: Timestamp,
  /** The sentence for the card when no signal gives one, from the kind's `reasons`. */
  reason: Schema.optionalKey(EntityReason),
  /** When the wait a fast kind shows began: `waitingSince`, else when the current concern first appeared. */
  waitingSince: Schema.optionalKey(Timestamp),
  /** The active Task, when there is one: the oldest live Task that links this ref. */
  taskId: Schema.optionalKey(Id),
  /** The refs above this one, each once, nearest first. Their records are in `places`, and the paths are in `edges`. */
  ancestors: atMost(ExternalRef, MAX_ENTITY_ANCESTORS),
  /** False when part of what is above this thing could not be read. */
  contextComplete: Schema.Boolean,
  /** The latest change at the source, from the thing's timeline. Absent when nothing has changed since it was first seen. */
  latestChange: Schema.optionalKey(EntityChange),
};

/** One full record of a work kind: what every read of an entity holds. An Inbox card is one, with its side. */
export const EntityRecord = Schema.Struct(entityFields);

export type EntityRecord = Schema.Schema.Type<typeof EntityRecord>;

/**
 * One card on the Inbox. A card is a full record of a work kind that concerns
 * the user, is not dismissed, and has a current concern, an open signal or a
 * live Task.
 */
export const InboxCard = Schema.Struct({
  ...entityFields,
  side: InboxSide,
  signals: Schema.Struct({
    /** The newest open signal that is not snoozed, by `createdAt`, then `id`. */
    latest: Schema.optionalKey(EntitySignalLine),
    /** How many open signals that are not snoozed the card holds. */
    openCount: Schema.Int,
  }),
  /**
   * Set when this compact thing rides on a rich thing on the Inbox: it has a
   * direct `source` or `person` link to it. The client draws it with its lead
   * instead of as a card of its own.
   */
  ridesOn: Schema.optionalKey(ExternalRef),
});

export type InboxCard = Schema.Schema.Type<typeof InboxCard>;

/**
 * The numbers the sidebar and the page head show. `queryInbox` and
 * `countInbox` return the same thing from the same function, and the counts
 * include cards past `MAX_INBOX_CARDS`.
 */
export const InboxCounts = Schema.Struct({
  /**
   * The sidebar's number: distinct refs on the Inbox, not dismissed, with no
   * live Task, of a kind with `pace: fast`. An entity seen by two accounts or
   * for two concerns counts once.
   */
  onTheClock: Schema.Int,
  /** The small count beside Requests. */
  requests: Schema.Int,
  /** The count at the foot of the column. */
  withSomeoneElse: Schema.Int,
  /**
   * The highest arrival sequence among the entities counted in `onTheClock`.
   * It comes from a durable counter the writer raises, never from a time, and
   * the counter never goes backwards, even after pruning. Opaque and ordered:
   * a client compares it with the value it stored, and never displays it.
   */
  newestArrival: Schema.Int,
});

export type InboxCounts = Schema.Schema.Type<typeof InboxCounts>;

/** What `queryInbox` returns. */
export const Inbox = Schema.Struct({
  /** Oldest first inside each side, by `firstObservedAt` then `id`. Never ordered by activity. */
  cards: atMost(InboxCard, MAX_INBOX_CARDS),
  /** Each record above a card, once, so 300 cards do not repeat their repository. */
  places: atMost(EntityPlace, MAX_INBOX_PLACES),
  edges: atMost(EntityEdge, MAX_GRAPH_EDGES),
  counts: InboxCounts,
  /** The direct links of the cards on the page. */
  links: atMost(EntityLink, MAX_INBOX_LINKS),
  /** The records at the far end of those links that have no card of their own. */
  peers: atMost(EntityPeer, MAX_INBOX_PEERS),
  /** True when more cards exist than `MAX_INBOX_CARDS`. The screen says so. */
  truncated: Schema.Boolean,
});

export type Inbox = Schema.Schema.Type<typeof Inbox>;

/**
 * What `read` returns: one full record of a work kind. `kindAvailable` is
 * false when the catalog no longer has an active kind: the card draws, its
 * actions are off, and it shows why.
 */
export const ExternalEntityDetail = Schema.Struct({
  ...entityFields,
  kindAvailable: Schema.Boolean,
  /**
   * The records above this one and the targets of its links, each once. Its
   * bound is the most ancestors plus the most links, so no record the entity
   * reaches is left out.
   */
  places: atMost(EntityPlace, MAX_ENTITY_ANCESTORS + MAX_ENTITY_LINKS),
  edges: atMost(EntityEdge, MAX_GRAPH_EDGES),
  links: atMost(EntityLink, MAX_ENTITY_LINKS),
  /** Claims the graph refused, such as a loop, with why. */
  conflicts: atMost(EntityConflict, MAX_ENTITY_LINKS),
  /**
   * The signals about this thing, in time order, oldest first. Open ones are
   * selected first, up to `MAX_ENTITY_SIGNALS`, and resolved ones fill the room
   * left. Snoozed signals are included, marked `snoozed`.
   */
  signals: atMost(EntitySignalLine, MAX_ENTITY_SIGNALS),
  /** How many open signals the thing has, snoozed ones included. */
  openCount: Schema.Int,
  /** How many signals the thing has in all, open and resolved. */
  signalCount: Schema.Int,
  /** What changed at the source, in time order, oldest first. */
  timeline: atMost(EntityChange, MAX_ENTITY_TIMELINE),
  /** The records at the far end of this thing's links that have no card of their own. */
  peers: atMost(EntityPeer, MAX_ENTITY_LINKS),
});

export type ExternalEntityDetail = Schema.Schema.Type<typeof ExternalEntityDetail>;

/** What `takeOn` returns: the active Task, and whether this call made it. */
export const EntityTakeOnResult = Schema.Struct({ taskId: Id, created: Schema.Boolean });

export type EntityTakeOnResult = Schema.Schema.Type<typeof EntityTakeOnResult>;

/**
 * What `undoTakeOn` takes besides the entity's id. The Task is named, so the
 * undo can only delete the Task that the Take or the Add created.
 */
export const EntityUndoTakeOnInput = Schema.Struct({ taskId: Id });

export type EntityUndoTakeOnInput = Schema.Schema.Type<typeof EntityUndoTakeOnInput>;

/**
 * What `undoTakeOn` returns. `undone` is false when the Task is no longer
 * untouched since it was created (a Thread, a run, another link or an edit
 * appeared), or is not live. Then nothing changed, and `reason`
 * says why in a sentence the undo line shows.
 */
export const EntityUndoTakeOnResult = Schema.Struct({
  undone: Schema.Boolean,
  reason: Schema.optionalKey(bounded(1, 200)),
});

export type EntityUndoTakeOnResult = Schema.Schema.Type<typeof EntityUndoTakeOnResult>;

/**
 * The query of `search`.
 *
 * - `source` is a plugin id: the source the sheet's tab is on.
 * - `text` is words, an identifier, or one pasted URL. A URL that another
 *   plugin recognizes changes the source, and the reply says so.
 * - `scopeRef` narrows the search to one context of the source, such as one
 *   Linear team. A source that cannot search by that scope fails the call
 *   rather than searching wider.
 */
export const EntitySearchQuery = Schema.Struct({
  source: PluginId,
  text: bounded(1, MAX_SEARCH_TEXT_LENGTH),
  scopeRef: Schema.optionalKey(ExternalRef),
});

export type EntitySearchQuery = Schema.Schema.Type<typeof EntitySearchQuery>;

/**
 * What Hercule holds of a search result.
 *
 * - `new`: no record. Adding it creates the entity and follows it.
 * - `known`: a record, and no live Task.
 * - `on-work`: a live Task has it. The result names it in `taskId`.
 */
export const EntitySearchStanding = Schema.Literals(["new", "known", "on-work"]);

export type EntitySearchStanding = Schema.Schema.Type<typeof EntitySearchStanding>;

/**
 * One search result, as the source answered live. Nothing of it is stored by
 * the search. A link to something no Connection can read has no `title`,
 * `identifier` or `url`, because none was read.
 */
export const EntitySearchResult = Schema.Struct({
  ref: ExternalRef,
  kind: Schema.String,
  noun: bounded(1, 40),
  identifier: Schema.optionalKey(bounded(1, 64)),
  title: Schema.optionalKey(bounded(1, 512)),
  url: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(EntityStatus),
  /** Where it sits, in words, such as "Pricing rules". */
  location: Schema.optionalKey(bounded(1, 200)),
  standing: EntitySearchStanding,
  /** The active Task, when `standing` is `on-work`. */
  taskId: Schema.optionalKey(Id),
});

export type EntitySearchResult = Schema.Schema.Type<typeof EntitySearchResult>;

/**
 * The outcomes of a search:
 *
 * - `results`: one or more things found.
 * - `no-match`: the source answered and nothing matched.
 * - `inaccessible`, `not-found`, `unknown`: a link or identifier was resolved
 *   and the source could say that much. `unknown` is what a source that
 *   cannot tell a missing thing from a forbidden one answers, as GitHub does.
 * - `ambiguous`: an identifier named different things in different
 *   workspaces. It stays unresolved.
 * - `incomplete`: a Connection failed or was skipped, so the answer may be
 *   short.
 * - `unknown-link`: a URL that no plugin recognizes.
 * - `source-unavailable`: the source has no eligible Connection, or its
 *   plugin is not active.
 */
export const ENTITY_SEARCH_OUTCOMES = [
  "results",
  "no-match",
  "inaccessible",
  "not-found",
  "unknown",
  "ambiguous",
  "incomplete",
  "unknown-link",
  "source-unavailable",
] as const;

/** What `search` returns. */
export const EntitySearchReply = Schema.Struct({
  /** The source that was read. It differs from the query's when a pasted link belongs to another plugin. */
  source: PluginId,
  outcome: Schema.Literals(ENTITY_SEARCH_OUTCOMES),
  results: atMost(EntitySearchResult, MAX_ENTITY_SEARCH_RESULTS),
  /** True when a Connection failed, or eligible ones were left out by the limit, so the list may be short. */
  incomplete: Schema.Boolean,
  /** Plugins that can read links, for "a link from elsewhere". */
  linkSources: Schema.Array(PluginId),
});

export type EntitySearchReply = Schema.Schema.Type<typeof EntitySearchReply>;

/** The query of `listSuggestions`: the context to list under, when the sheet has one chosen. */
export const EntitySuggestionsQuery = Schema.Struct({
  contextRef: Schema.optionalKey(ExternalRef),
});

export type EntitySuggestionsQuery = Schema.Schema.Type<typeof EntitySuggestionsQuery>;

/**
 * One thing the sheet lists before the user types: it concerns the user and
 * has no live Task. A thing in two contexts is listed once, and `alsoIn`
 * names the other contexts, whose records are in the reply's `places`.
 */
export const EntitySuggestion = Schema.Struct({
  ref: ExternalRef,
  kind: Schema.String,
  noun: bounded(1, 40),
  identifier: bounded(1, 64),
  title: bounded(1, 512),
  url: Schema.String,
  status: Schema.optionalKey(EntityStatus),
  /** The contexts besides the chosen one that hold it ("Also in Pricing rules"). */
  alsoIn: atMost(ExternalRef, MAX_SUGGESTION_CONTEXTS),
});

export type EntitySuggestion = Schema.Schema.Type<typeof EntitySuggestion>;

/**
 * What `listSuggestions` returns. Context records are never listed as
 * suggestions, and choosing a context never creates Tasks for its children.
 */
export const EntitySuggestions = Schema.Struct({
  suggestions: atMost(EntitySuggestion, MAX_ENTITY_SUGGESTIONS),
  /** The contexts named by `alsoIn`, each once. */
  places: atMost(EntityPlace, MAX_ENTITY_SUGGESTIONS * MAX_SUGGESTION_CONTEXTS),
  /** True when more things qualify than `MAX_ENTITY_SUGGESTIONS`. */
  truncated: Schema.Boolean,
});

export type EntitySuggestions = Schema.Schema.Type<typeof EntitySuggestions>;

/** The input of `addToWork`: the thing, and the Project for its Task when the user picked one. */
export const EntityAddToWorkInput = Schema.Struct({
  ref: ExternalRef,
  projectId: Schema.optionalKey(Id),
});

export type EntityAddToWorkInput = Schema.Schema.Type<typeof EntityAddToWorkInput>;

/**
 * What `addToWork` returns.
 *
 * - `id` is the entity's id, created when the thing was new to Hercule. Absent
 *   when the Task links the ref but Hercule holds no record of it.
 * - `taskId` is the active Task, and `created` says whether this call made it.
 * - `stage` is the stage that Task is at.
 * - `followed` is true when the thing has no concern of its own, so the Task
 *   makes Hercule follow it.
 */
export const EntityAddToWorkResult = Schema.Struct({
  id: Schema.optionalKey(Id),
  taskId: Id,
  created: Schema.Boolean,
  stage: TaskStage,
  followed: Schema.Boolean,
});

export type EntityAddToWorkResult = Schema.Schema.Type<typeof EntityAddToWorkResult>;

/** The input of `link` and `unlink`: the two ends of the relationship. */
export const EntityLinkInput = Schema.Struct({ fromRef: ExternalRef, toRef: ExternalRef });

export type EntityLinkInput = Schema.Schema.Type<typeof EntityLinkInput>;

/**
 * What `unlink` returns. `removed` is false when the user had made no link
 * between the two. `remaining` is the firmest claim still joining them, when a
 * source or a text claim is left: only the user's own claim can be removed.
 */
export const EntityUnlinkResult = Schema.Struct({
  removed: Schema.Boolean,
  remaining: Schema.optionalKey(Schema.Literals(["source", "person", "text"])),
});

export type EntityUnlinkResult = Schema.Schema.Type<typeof EntityUnlinkResult>;

/**
 * The External Entity operations: read the Inbox and its counts, read one
 * entity, take one on as a Task, dismiss and restore a card, and the three
 * that let the user add a thing to Work: search the source, list suggestions,
 * and add.
 */
export const externalEntity = HttpApiGroup.make("externalEntity")
  .add(
    /**
     * Returns the Inbox whole, capped at `MAX_INBOX_CARDS` with `truncated`,
     * in one reply and a fixed number of statements.
     */
    // Static paths beside `/external-entities/:id`: the router prefers them,
    // and "inbox", "search" and "suggestions" are not ids.
    HttpApiEndpoint.get("queryInbox", "/external-entities/inbox", {
      success: Inbox,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    /** Returns the Inbox's counts alone, for the sidebar, which reads them on every screen. */
    HttpApiEndpoint.get("countInbox", "/external-entities/inbox/count", {
      success: InboxCounts,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    HttpApiEndpoint.get("search", "/external-entities/search", {
      query: EntitySearchQuery,
      success: EntitySearchReply,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    HttpApiEndpoint.get("listSuggestions", "/external-entities/suggestions", {
      query: EntitySuggestionsQuery,
      success: EntitySuggestions,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Returns the entity of the id. Only a full record of a work kind can be
     * read: a partial record, or a record of a kind with no card (a place),
     * fails with `NotFound`. Places travel as `EntityPlace` by ref in other
     * replies.
     */
    HttpApiEndpoint.get("read", "/external-entities/:id", {
      params: { id: Id },
      success: ExternalEntityDetail,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Returns the entity's active Task, or makes one. Fails `NotFound` for an
     * unknown id and `InvalidState` for a kind that cannot be taken on or a
     * thing that could not be read. Fails `Conflict` when the entity changed
     * while the Task was being made and the call should be repeated.
     */
    HttpApiEndpoint.post("takeOn", "/external-entities/:id/take-on", {
      params: { id: Id },
      success: EntityTakeOnResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Conflict, Internal],
    }),
    HttpApiEndpoint.post("undoTakeOn", "/external-entities/:id/take-on/undo", {
      params: { id: Id },
      payload: EntityUndoTakeOnInput,
      success: EntityUndoTakeOnResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /** Takes the card off the Inbox. Only `restore` brings it back. */
    HttpApiEndpoint.post("dismiss", "/external-entities/:id/dismiss", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("restore", "/external-entities/:id/restore", {
      params: { id: Id },
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    // The same errors as `takeOn`, and `NotFound` also for an unknown Project.
    HttpApiEndpoint.post("addToWork", "/external-entities/add-to-work", {
      payload: EntityAddToWorkInput,
      success: EntityAddToWorkResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Conflict, Internal],
    }),
    /**
     * Links two things, as the user's own claim (`person`). The target may be a
     * ref nobody has read yet; it is read on the next refresh. The source is
     * never told. User only: a session cannot link.
     */
    HttpApiEndpoint.post("link", "/external-entities/links", {
      payload: EntityLinkInput,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, InvalidState, Internal],
    }),
    /**
     * Removes the user's own claim between two things, in either direction, and
     * says what is left. A claim a source made stays. User only. The refs travel
     * in a body because they hold `:`, `/` and `#`.
     */
    HttpApiEndpoint.post("unlink", "/external-entities/links/remove", {
      payload: EntityLinkInput,
      success: EntityUnlinkResult,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
  )
  .middleware(Authenticated);
