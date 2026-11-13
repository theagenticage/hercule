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
  MAX_ENTITY_FIELD_TEXT_LENGTH,
  MAX_ENTITY_KIND_FIELDS,
  MAX_INBOX_CLAUSE_KEY_LENGTH,
  InboxClause as PluginInboxClause,
  PluginId,
  splitClauseWord,
} from "@hercule/plugin-host";
import { Schema, SchemaGetter } from "effect";
import * as HttpApiEndpoint from "effect/http-api/HttpApiEndpoint";
import * as HttpApiGroup from "effect/http-api/HttpApiGroup";
import {
  CapExceeded,
  Conflict,
  Forbidden,
  Internal,
  InvalidState,
  NotFound,
  Unauthenticated,
  Validation,
} from "../errors";
import { Actor, ExternalRef, Id, Timestamp } from "../ids";
import { closedStruct } from "../closed";
import { Authenticated } from "../security";
import { markRepeatedShorthand, markShorthand } from "../shorthand";
import { atMost, bounded } from "../strings";
import { MAX_CONNECTION_LABEL_LENGTH } from "./connection";
import {
  EntityChange,
  EntityEdge,
  EntityLifecycle,
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
import { RunStarted } from "./run";
import { MAX_THREAD_THINGS } from "./session";
import { MAX_SEARCH_TEXT_LENGTH, TaskPriority, TaskStage } from "./task";
import { MAX_INPUT_ANSWERED_SIGNAL_KINDS, MAX_WORKFLOW_NAME_LENGTH } from "./workflow-definition";

export { ENTITY_CONCERNS, EntityRepository, MAX_ENTITY_FACTS };

/**
 * One condition of an Inbox query, as the clients send it: a plugin's clause
 * (see `InboxClause` in the plugin API) with the account as an `Id`.
 */
export const InboxClause = Schema.Struct({
  ...PluginInboxClause.fields,
  connectionId: Schema.optionalKey(Id),
});

export type InboxClause = Schema.Schema.Type<typeof InboxClause>;

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

/** The most hints one entity read lists. Hints are bounded apart from links, so a flood of mentions never hides a link. */
export const MAX_ENTITY_HINTS = MAX_ENTITY_LINKS;

/** The most signal lines one entity read carries. Open signals come first, so open work is never cut for resolved work. */
export const MAX_ENTITY_SIGNALS = 50;

/** The most changes one entity read carries. The oldest change of a thing is dropped first. */
export const MAX_ENTITY_TIMELINE = 50;

/** The most suggestions `listSuggestions` returns. The reply says when there were more. */
export const MAX_ENTITY_SUGGESTIONS = 100;

/** The most other contexts a suggestion names ("Also in Pricing rules"). */
export const MAX_SUGGESTION_CONTEXTS = 8;

/**
 * The most workflows one offer set lists. A person writes a few workflows
 * that take one kind of thing; 100 is far past real use and keeps the reply
 * small.
 */
export const MAX_ENTITY_OFFERS = 100;

/**
 * The most Connections one card lists as able to act on it. A person connects
 * a few accounts of one source.
 */
export const MAX_ACTING_CONNECTIONS = 16;

/** The most live workflows one card lists. A person has a few workflows running on one Task at once. */
export const MAX_LIVE_WORKFLOWS = 8;

/** The longest id of an offer set. The server makes the ids, and the client only compares them. */
export const MAX_OFFER_SET_ID_LENGTH = 64;

/** The longest sentence that explains why a workflow cannot be offered. */
export const MAX_OFFER_MESSAGE_LENGTH = 512;

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
 * One link between peers: a pair that a source reports or a person made, once,
 * under its firmest claim (`source`, then `person`). A pair that only text
 * mentions is no link; it is an `EntityHint`.
 */
export const EntityLink = Schema.Struct({
  fromRef: ExternalRef,
  toRef: ExternalRef,
  /** The firmest claim, for the hover. It names only a plugin or an actor, never a Connection. */
  claim: Schema.Struct({
    type: Schema.Literals(["source", "person"]),
    plugin: Schema.optionalKey(PluginId),
    actor: Schema.optionalKey(Actor),
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
 * A pair of peers that only text holds together: a reference found in the
 * text of one of them. It joins nothing until a person links the two. A pair
 * that a source or a person also claims is an `EntityLink`, never a hint.
 */
export const EntityHint = Schema.Struct({
  /** The thing whose text holds the reference. */
  fromRef: ExternalRef,
  /** The thing the reference points at. */
  toRef: ExternalRef,
  /**
   * Which text the reference was found in, such as "description", so a client
   * can say "The description of #6263". Absent when the claim has no evidence key.
   */
  evidenceKey: Schema.optionalKey(bounded(1, MAX_ENTITY_EVIDENCE_KEY_LENGTH)),
});

export type EntityHint = Schema.Schema.Type<typeof EntityHint>;

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
 * true and `yours` false: no title, identifier, URL, status or change.
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
  /** Where the source shows it, which the apps open in the browser. Absent when the source reports none. */
  url: Schema.optionalKey(Schema.String),
  status: Schema.optionalKey(EntityStatus),
  /** True when any observing Connection reported the thing as owned by the user. Always false when `restricted`. */
  yours: Schema.Boolean,
  restricted: Schema.Boolean,
  /** The latest change at the source, when there is one. Absent when `restricted`. */
  latestChange: Schema.optionalKey(EntityChange),
});

export type EntityPeer = Schema.Schema.Type<typeof EntityPeer>;

/**
 * One workflow a card can hand its thing to, or could if something changed.
 * The workflow is available when it is enabled and valid, takes this kind
 * through an `entity` input, can fill every other required input, fits the
 * thing's repository, and an account can act. Otherwise `unavailable` says
 * why, when the user can do something about it.
 */
export const WorkflowOffer = Schema.Struct({
  workflowId: Id,
  name: bounded(1, MAX_WORKFLOW_NAME_LENGTH),
  /** The signal kinds this handoff would end, for the Describe Line. */
  answers: atMost(SignalKind, MAX_INPUT_ANSWERED_SIGNAL_KINDS),
  /** The `connection` input the core fills with the acting account. Absent when the workflow has none. */
  connectionInputName: Schema.optionalKey(Schema.String),
  /**
   * When the user last handed a thing of this kind to this workflow, from the
   * hand-off history. Absent when never. The menu ranks by fit, then by this,
   * then by name.
   */
  lastHandedAt: Schema.optionalKey(Timestamp),
  /** Set when the workflow cannot be handed this thing. Absent when it is available. */
  unavailable: Schema.optionalKey(
    Schema.Struct({
      /**
       * - `needs-input`: a required input the core cannot fill.
       * - `repository`: the workflow works on another repository only.
       * - `no-account`: no connected account can act on this thing.
       * - `needs-workflow-change`: the workflow takes a `signal` input and no
       *   `entity` input, so it cannot take a card.
       */
      reason: Schema.Literals(["needs-input", "repository", "no-account", "needs-workflow-change"]),
      /** The sentence the menu shows. */
      message: bounded(1, MAX_OFFER_MESSAGE_LENGTH),
    }),
  ),
});

export type WorkflowOffer = Schema.Schema.Type<typeof WorkflowOffer>;

/** A workflow with a live run on a card's active Task: its id, and its name for "<name> has it". */
export const LiveWorkflow = Schema.Struct({
  workflowId: Id,
  name: bounded(1, MAX_WORKFLOW_NAME_LENGTH),
});

export type LiveWorkflow = Schema.Schema.Type<typeof LiveWorkflow>;

/** A Connection that can act on a thing: its id, and its label for the menu ("as northwind-bot"). */
export const ActingConnection = Schema.Struct({
  id: Id,
  label: bounded(1, MAX_CONNECTION_LABEL_LENGTH),
});

export type ActingConnection = Schema.Schema.Type<typeof ActingConnection>;

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
  lifecycle: EntityLifecycle,
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

const fieldValueIdentity = {
  key: bounded(1, 64),
  /** The label the kind declares, such as "Team". */
  label: bounded(1, 40),
};

/**
 * The value of one field a kind declares, read from what the source last
 * reported. `type` is the declared type of the field.
 *
 * - `text`, `person`: a string. A `text` field whose facet lists the records
 *   of a context kind also has `ref`, the ref of that record, and `text` is
 *   the record's title.
 * - `enum`: `value` is one of the declared values, and `text` is its label, or
 *   the value itself when it has none.
 * - `number`, `money` (`amount` in major units of `currency`), `bool`: as
 *   reported.
 * - `age`: `since` is the moment the age counts from. The client draws the age.
 */
export const EntityFieldValue = Schema.Union([
  Schema.Struct({
    ...fieldValueIdentity,
    type: Schema.Literal("text"),
    text: bounded(0, MAX_ENTITY_FIELD_TEXT_LENGTH),
    ref: Schema.optionalKey(ExternalRef),
  }),
  Schema.Struct({
    ...fieldValueIdentity,
    type: Schema.Literal("person"),
    text: bounded(0, MAX_ENTITY_FIELD_TEXT_LENGTH),
  }),
  Schema.Struct({
    ...fieldValueIdentity,
    type: Schema.Literal("enum"),
    value: bounded(1, 64),
    text: bounded(1, 64),
  }),
  Schema.Struct({ ...fieldValueIdentity, type: Schema.Literal("number"), number: Schema.Finite }),
  Schema.Struct({
    ...fieldValueIdentity,
    type: Schema.Literal("money"),
    amount: Schema.Finite,
    currency: bounded(3, 3),
  }),
  Schema.Struct({ ...fieldValueIdentity, type: Schema.Literal("age"), since: Timestamp }),
  Schema.Struct({ ...fieldValueIdentity, type: Schema.Literal("bool"), value: Schema.Boolean }),
]);

export type EntityFieldValue = Schema.Schema.Type<typeof EntityFieldValue>;

/**
 * What a card of a kind shows beyond the generic card, with the values filled
 * in. A slot whose field has no value is left out.
 *
 * - `place`: the faint "where" at the end of the row, beside the identifier.
 * - `context`: what a quiet row says after its status.
 * - `fact`: a number or an amount a quiet row says.
 */
export const CardFace = Schema.Struct({
  place: Schema.optionalKey(EntityFieldValue),
  context: Schema.optionalKey(EntityFieldValue),
  fact: Schema.optionalKey(EntityFieldValue),
});

export type CardFace = Schema.Schema.Type<typeof CardFace>;

/** The most clauses a search sends beside the list's own. */
export const MAX_INBOX_QUERY_CLAUSES = 12;

/** The longest free text of a search. */
export const MAX_INBOX_TEXT_LENGTH = 200;

/**
 * The most open asks one row lists, newest first. `askCount` still counts all
 * of them. A row draws only the newest ask and how many there are; the pane
 * reads every ask from `externalEntity.read`.
 */
export const MAX_INBOX_ASKS = 3;

/** The most values one facet lists on a page. `more` counts the rest. */
export const MAX_INBOX_PAGE_FACET_VALUES = 30;

/** The most values one facet lists in the rail's counts. `more` counts the rest. */
export const MAX_INBOX_RAIL_FACET_VALUES = 100;

/** The most values a suggestion read returns. */
export const MAX_INBOX_SUGGESTIONS = 8;

/** The most things one `dismiss` or `restore` call takes. */
export const MAX_INBOX_MOVED_THINGS = 1000;

/** The longest saved query id: a plugin id, a slash and a word. */
const MAX_SAVED_QUERY_ID_LENGTH = 130;

/** The most Connections one thing lists as observing it. */
export const MAX_INBOX_ACCOUNTS = 32;

/** The most sources, accounts, facets and saved queries the Inbox's counts list. */
const MAX_INBOX_RAIL_ROWS = 500;

/**
 * The ids of the core's saved queries, the ones that exist whatever plugins
 * are loaded. A plugin's saved query has a qualified id (`github/review-requests`).
 */
export const CORE_SAVED_QUERY_IDS = {
  waits: "waits",
  mine: "mine",
  updates: "updates",
  held: "with-hercule",
  everything: "everything",
} as const;

export type CoreSavedQueryId = (typeof CORE_SAVED_QUERY_IDS)[keyof typeof CORE_SAVED_QUERY_IDS];

/**
 * One value of one Facet, of one source, in one account when the source has
 * several: what Browse lists, what the user pins, and what a list or a search
 * tie names. `key` is the field's key and `value` the stored value (a record's
 * ref for a facet of records).
 */
export const InboxBrowseValue = Schema.Struct({
  source: PluginId,
  connectionId: Schema.optionalKey(Id),
  key: bounded(1, MAX_INBOX_CLAUSE_KEY_LENGTH),
  value: bounded(1, MAX_ENTITY_FIELD_TEXT_LENGTH),
});

export type InboxBrowseValue = Schema.Schema.Type<typeof InboxBrowseValue>;

/**
 * Which list the Inbox reads: a saved query by its id (`waits`,
 * `github/review-requests`), or Browse, one value of one Facet.
 *
 * The CLI types the saved query's id as one word, for `--list`.
 */
const InboxListValue = Schema.Union([
  Schema.Struct({ savedQuery: bounded(1, MAX_SAVED_QUERY_ID_LENGTH) }),
  Schema.Struct({ browse: InboxBrowseValue }),
]);

export const InboxList = markShorthand(
  InboxListValue,
  Schema.String.pipe(
    Schema.decodeTo(InboxListValue, {
      decode: SchemaGetter.transform((word: string) => ({ savedQuery: word })),
      encode: SchemaGetter.transform((list) =>
        "savedQuery" in list ? list.savedQuery : JSON.stringify(list),
      ),
    }),
  ),
);

export type InboxList = Schema.Schema.Type<typeof InboxList>;

/** How a list is ordered: `waiting` puts the oldest open ask first, `newest` the latest change. */
export const InboxOrder = Schema.Literals(["waiting", "newest"]);

export type InboxOrder = Schema.Schema.Type<typeof InboxOrder>;

/**
 * Parses one typed clause, `key=value` (is), `key>value` (over) or
 * `key<value` (under). The value stays the raw text: it is the controller that
 * reads it for the type of the field the key names (the clause value grammar
 * of plugin-host), so `team=2d` names a team and `waiting>2d` is a duration.
 */
const parseClauseWord = (word: string): InboxClause | undefined => {
  const raw = splitClauseWord(word);
  return raw === undefined ? undefined : { key: raw.key, op: raw.op, value: raw.raw };
};

/** The one-word form of a clause: what `--clause` takes. */
const InboxClauseFromWord = Schema.String.check(
  Schema.makeFilter((word: string) =>
    parseClauseWord(word) === undefined
      ? `${word} is not a clause. Write key=value, key>value or key<value, such as team=Checkout or waiting>2d.`
      : undefined,
  ),
).pipe(
  Schema.decodeTo(InboxClause, {
    // The check above has already rejected every word this cannot parse.
    decode: SchemaGetter.transform((word: string) => parseClauseWord(word) as InboxClause),
    encode: SchemaGetter.transform(
      (clause: InboxClause) =>
        `${clause.key}${clause.op === "is" ? "=" : clause.op === "over" ? ">" : "<"}${String(clause.value)}`,
    ),
  }),
);

/** The most things one page of the Inbox holds. */
export const MAX_INBOX_PAGE = 200;

/** The most refs a client holds and sends in a `refresh` or a `rows` read. */
export const MAX_INBOX_HELD_REFS = 400;

/**
 * What every `queryInbox` mode selects: the list, and the search inside it.
 * `clauses` and `text` narrow the list, and nothing more. A Browse list is
 * ordered `waiting`.
 */
const InboxSelectionFields = {
  list: InboxList,
  clauses: Schema.optionalKey(
    markRepeatedShorthand(atMost(InboxClause, MAX_INBOX_QUERY_CLAUSES), InboxClauseFromWord),
  ),
  text: Schema.optionalKey(bounded(0, MAX_INBOX_TEXT_LENGTH)),
};

const InboxHeldRefs = atMost(ExternalRef, MAX_INBOX_HELD_REFS);

/**
 * The query of `queryInbox`: one selection, read in one of four modes.
 *
 * - `first` reads the first page of the selection, with the total and the
 *   facets of the whole result.
 * - `next` reads the page after `after`, the `nextCursor` of an earlier page
 *   of the same selection. A cursor of another selection, or one that does not
 *   decode, fails with `validation`.
 * - `refresh` reads the first page, and the rows the client `held` that are
 *   not on it, in one read at one moment. It is how a client that shows a list
 *   keeps its rows current.
 * - `rows` reads the `held` rows alone, at one moment, in the list's order.
 *
 * A field that does not belong to the mode is refused, so `after` with `first`
 * fails instead of silently reading the first page. A held ref that is missing
 * from the reply of `refresh` or `rows` is no longer on the list. A client that shows a list uses the two held modes; the
 * CLI uses `first` and `next`.
 */
export const InboxQuery = Schema.Union([
  closedStruct({ mode: Schema.Literal("first"), ...InboxSelectionFields }),
  closedStruct({ mode: Schema.Literal("next"), ...InboxSelectionFields, after: bounded(1, 512) }),
  closedStruct({
    mode: Schema.Literal("refresh"),
    ...InboxSelectionFields,
    held: InboxHeldRefs,
  }),
  closedStruct({ mode: Schema.Literal("rows"), ...InboxSelectionFields, held: InboxHeldRefs }),
]);

export type InboxQuery = Schema.Schema.Type<typeof InboxQuery>;

/**
 * One open ask on a thing: an open signal, not snoozed and not taken, of a
 * kind that asks the user for a move. `say` is the finished sentence, such as
 * "Mei asked for your review", and `noun` names the kind ("review request").
 */
export const InboxAsk = Schema.Struct({
  id: Id,
  kind: SignalKind,
  noun: bounded(1, 40),
  asker: Schema.optionalKey(bounded(1, MAX_SIGNAL_ASKER_LENGTH)),
  say: EntityReason,
  createdAt: Timestamp,
});

export type InboxAsk = Schema.Schema.Type<typeof InboxAsk>;

/**
 * One row of the Inbox. It is lean: it holds only what a row draws, and the
 * pane reads the rest (such as the lifecycle and every ask) from
 * `externalEntity.read` when a thing is opened. A page holds 200 rows, so each
 * field costs 200 times its size.
 *
 * - `source` is the plugin that reports the thing.
 * - `face` is the card face of the thing's kind, or null for the generic row.
 * - `asks` are the open asks, newest first, at most `MAX_INBOX_ASKS`;
 *   `askCount` counts all of them, `askKinds` lists their distinct kinds, and
 *   `waitingSince` is when the oldest one began.
 * - `takenOn` is true when the user took the thing on: the link to its active
 *   Task was made or joined by Take on or Add to Work, not by a hand-off, a
 *   session or a signal. Only then does the row say that you have it.
 * - `openKinds` are the distinct kinds of every open signal, snoozed ones
 *   included: what a hand-off ends is read from it.
 * - `dismissedAt` is set only when the thing came back after a dismissal.
 * - `arrival` is the thing's place in the controller's arrival sequence: the
 *   number it took when it last arrived on the Inbox (new, back after a
 *   dismissal, or began to ask). It is opaque and only ordered: a larger number
 *   arrived later. 0 when the thing never arrived. A client that holds a list
 *   uses it to tell a genuine arrival from a row that only slid into the first
 *   page because another row left.
 * - `accounts` are the Connections that observe the thing.
 */
export const InboxThing = Schema.Struct({
  id: Id,
  ref: ExternalRef,
  kind: Schema.String,
  noun: bounded(1, 40),
  source: PluginId,
  identifier: bounded(1, 64),
  title: bounded(1, 512),
  url: Schema.String,
  status: Schema.optionalKey(EntityStatus),
  access: Schema.Literals(["ok", "inaccessible", "deleted"]),
  stale: Schema.Boolean,
  observedAt: Timestamp,
  sourceUpdatedAt: Timestamp,
  /** Copied from the kind: the hours before a wait counts as due. */
  patience: Schema.Int,
  face: Schema.NullOr(CardFace),
  asks: atMost(InboxAsk, MAX_INBOX_ASKS),
  askCount: Schema.Int,
  askKinds: atMost(SignalKind, MAX_ENTITY_SIGNALS),
  openKinds: atMost(SignalKind, MAX_ENTITY_SIGNALS),
  waitingSince: Schema.optionalKey(Timestamp),
  /** The active Task, when there is one. */
  taskId: Schema.optionalKey(Id),
  takenOn: Schema.Boolean,
  liveWorkflows: atMost(LiveWorkflow, MAX_LIVE_WORKFLOWS),
  dismissedAt: Schema.optionalKey(Timestamp),
  arrival: Schema.Int,
  /**
   * The key of this thing's offers in the `offerSets` of a reply. Things that share
   * a kind, a target repository and an acting-account state share one set.
   */
  offerSetId: bounded(1, MAX_OFFER_SET_ID_LENGTH),
  /** The Connections that can act on the thing, oldest first. The first is the default. */
  actingConnections: atMost(ActingConnection, MAX_ACTING_CONNECTIONS),
  accounts: atMost(Id, MAX_INBOX_ACCOUNTS),
});

export type InboxThing = Schema.Schema.Type<typeof InboxThing>;

/**
 * One value of a facet, with how many things in the result hold it. `value`
 * is what a clause sends: the stored text, or the ref of a context record.
 * `label` is what the row shows: the record's title when the value is a
 * ref and some Connection can read that record, else the text. `health` is the
 * record's status, when it has one.
 */
export const InboxFacetValue = Schema.Struct({
  value: bounded(1, MAX_ENTITY_FIELD_TEXT_LENGTH),
  label: bounded(1, 512),
  count: Schema.Int,
  health: Schema.optionalKey(EntityStatus),
});

export type InboxFacetValue = Schema.Schema.Type<typeof InboxFacetValue>;

/**
 * The values of one facet field of one source, most common first. `values` is
 * cut and `more` counts the values left out. `connectionId` is set when the
 * source has several accounts, and then the counts are that account's.
 */
export const InboxFacet = Schema.Struct({
  source: PluginId,
  connectionId: Schema.optionalKey(Id),
  key: bounded(1, 64),
  label: bounded(1, 40),
  plural: bounded(1, 40),
  values: atMost(InboxFacetValue, MAX_INBOX_RAIL_FACET_VALUES),
  more: Schema.Int,
});

export type InboxFacet = Schema.Schema.Type<typeof InboxFacet>;

/**
 * The workflows each thing of a read can be handed to, by
 * `InboxThing.offerSetId`. A presentation list: the hand-off checks its
 * workflow itself.
 */
const InboxOfferSets = Schema.Record(
  bounded(1, MAX_OFFER_SET_ID_LENGTH),
  atMost(WorkflowOffer, MAX_ENTITY_OFFERS),
).check(Schema.isMaxProperties(MAX_INBOX_HELD_REFS));

/**
 * The reply to `first`: the first page of a list. `total` counts the whole
 * result of the selection, not the page, and `facets` describe the whole
 * result.
 *
 * Order `waiting`: things with an open ask come first, the oldest ask first,
 * then the rest, the latest change first. Order `newest`: the latest change
 * first. Ties break by ref.
 */
export const InboxFirstPage = Schema.Struct({
  mode: Schema.Literal("first"),
  things: atMost(InboxThing, MAX_INBOX_PAGE),
  nextCursor: Schema.optionalKey(bounded(1, 512)),
  total: Schema.Int,
  order: InboxOrder,
  facets: atMost(InboxFacet, MAX_INBOX_RAIL_ROWS),
  offerSets: InboxOfferSets,
});

export type InboxFirstPage = Schema.Schema.Type<typeof InboxFirstPage>;

/** The reply to `next`: one more page, in the order of the first. It has no total and no facets. */
export const InboxNextPage = Schema.Struct({
  mode: Schema.Literal("next"),
  things: atMost(InboxThing, MAX_INBOX_PAGE),
  nextCursor: Schema.optionalKey(bounded(1, 512)),
  offerSets: InboxOfferSets,
});

export type InboxNextPage = Schema.Schema.Type<typeof InboxNextPage>;

/**
 * The held rows of `refresh` and `rows` that are still on the list, in the
 * list's order. A held ref that is not here has left the list.
 */
const InboxHeldRows = {
  things: atMost(InboxThing, MAX_INBOX_HELD_REFS),
  offerSets: InboxOfferSets,
};

/**
 * The reply to `refresh`: the first page, and the held rows that are still on
 * the list but not on that page, both read at one moment. A held ref that is
 * on neither has left the list.
 */
export const InboxRefresh = Schema.Struct({
  mode: Schema.Literal("refresh"),
  first: InboxFirstPage,
  held: Schema.Struct(InboxHeldRows),
});

export type InboxRefresh = Schema.Schema.Type<typeof InboxRefresh>;

/** The reply to `rows`: the held rows that are still on the list, in the list's order. */
export const InboxRows = Schema.Struct({ mode: Schema.Literal("rows"), ...InboxHeldRows });

export type InboxRows = Schema.Schema.Type<typeof InboxRows>;

/** The reply to `queryInbox`: the reply of the mode that was asked. */
export const InboxReply = Schema.Union([InboxFirstPage, InboxNextPage, InboxRefresh, InboxRows]);

export type InboxReply = Schema.Schema.Type<typeof InboxReply>;

/** The types a query field has. */
const InboxFieldType = Schema.Literals([
  "text",
  "person",
  "enum",
  "number",
  "money",
  "age",
  "bool",
]);

/**
 * The numbers the sidebar draws, in one small read that every screen holds.
 *
 * - `waiting` is how many things are in "Someone waits on me".
 * - `newestArrival` is the highest arrival sequence among them. It comes from
 *   a durable counter the writer raises, never from a time, and the counter
 *   never goes backwards, even after pruning. Opaque and ordered: a client
 *   compares it with the value it stored, and never displays it.
 */
export const InboxCounts = Schema.Struct({
  waiting: Schema.Int,
  newestArrival: Schema.Int,
});

/**
 * What the Inbox's rail draws, in one read that only the Inbox screen makes.
 * Counts are of distinct things, never of rows. The controller reads the
 * user's own `inbox.pins` and `inbox.browseFolded`, so the reply holds exactly
 * what the rail draws. It names accounts, so it needs `connection.query`.
 */
export const InboxOutline = Schema.Struct({
  /** Every saved query, the core's first and then the plugins', with its count. */
  savedQueries: atMost(
    Schema.Struct({
      id: bounded(1, MAX_SAVED_QUERY_ID_LENGTH),
      name: bounded(1, 40),
      order: InboxOrder,
      /** The plugin that declared it. Absent for a core query. */
      source: Schema.optionalKey(PluginId),
      count: Schema.Int,
    }),
    MAX_INBOX_RAIL_ROWS,
  ),
  /**
   * Browse: one entry per source that holds things. `accounts` are listed when
   * more than one account holds things. `facets` come only for a source that
   * is not folded, and list known values that hold nothing with count 0.
   */
  sources: atMost(
    Schema.Struct({
      source: PluginId,
      count: Schema.Int,
      folded: Schema.Boolean,
      accounts: atMost(
        Schema.Struct({
          connectionId: Id,
          label: bounded(1, MAX_CONNECTION_LABEL_LENGTH),
          count: Schema.Int,
        }),
        MAX_INBOX_RAIL_ROWS,
      ),
      facets: Schema.optionalKey(atMost(InboxFacet, MAX_INBOX_RAIL_ROWS)),
    }),
    MAX_INBOX_RAIL_ROWS,
  ),
  /** Each pin with its current label and count. A value that no longer exists keeps its stored text as label, with count 0. */
  pins: atMost(
    Schema.Struct({
      ...InboxBrowseValue.fields,
      label: bounded(1, 512),
      count: Schema.Int,
    }),
    MAX_INBOX_RAIL_ROWS,
  ),
  /** The query fields: one per source and key, and the core's own with no `source`. */
  fields: atMost(
    Schema.Struct({
      key: bounded(1, 64),
      label: bounded(1, 40),
      type: InboxFieldType,
      source: Schema.optionalKey(PluginId),
      /** The values of an `enum` field, with their labels. */
      values: Schema.optionalKey(
        atMost(Schema.Struct({ value: bounded(1, 64), label: bounded(1, 64) }), 64),
      ),
      /** The currency of a `money` field. */
      currency: Schema.optionalKey(bounded(3, 3)),
    }),
    MAX_INBOX_RAIL_ROWS * 16,
  ),
  /**
   * The sources that cannot be read now. `updatedAt` is when a failing
   * Connection of the source was last changed, which is the latest sign of
   * the failure the controller keeps. It is not when the failure began.
   */
  failing: atMost(Schema.Struct({ source: PluginId, updatedAt: Timestamp }), MAX_INBOX_RAIL_ROWS),
});

export type InboxCounts = Schema.Schema.Type<typeof InboxCounts>;

export type InboxOutline = Schema.Schema.Type<typeof InboxOutline>;

/**
 * The input of `suggestInboxValues`: the values of the field `key` among the
 * things of the list `list` (before any search), whose text starts with
 * `prefix` without regard to case. `source` and `connectionId` limit it to one
 * source or one account.
 */
export const InboxValueQuery = Schema.Struct({
  list: InboxList,
  key: bounded(1, 64),
  prefix: bounded(0, 100),
  source: Schema.optionalKey(PluginId),
  connectionId: Schema.optionalKey(Id),
});

export type InboxValueQuery = Schema.Schema.Type<typeof InboxValueQuery>;

/** What `suggestInboxValues` returns: at most `MAX_INBOX_SUGGESTIONS` values, most common first. */
export const InboxValues = Schema.Struct({
  values: atMost(
    Schema.Struct({
      value: bounded(1, MAX_ENTITY_FIELD_TEXT_LENGTH),
      label: bounded(1, 512),
      count: Schema.Int,
      source: PluginId,
    }),
    MAX_INBOX_SUGGESTIONS,
  ),
});

export type InboxValues = Schema.Schema.Type<typeof InboxValues>;

/** The input of `dismiss` and `restore`: the things to move, all or none. */
export const InboxMove = Schema.Struct({
  ids: atMost(Id, MAX_INBOX_MOVED_THINGS).check(Schema.isMinLength(1)),
});

export type InboxMove = Schema.Schema.Type<typeof InboxMove>;

/** The input of `matchProject`: the things the user is about to start a thread on. */
export const EntityProjectMatchInput = Schema.Struct({
  ids: atMost(Id, MAX_THREAD_THINGS).check(Schema.isMinLength(1)),
});

export type EntityProjectMatchInput = Schema.Schema.Type<typeof EntityProjectMatchInput>;

/**
 * A thing named as evidence: its id, the identifier its Inbox row shows, and
 * its title. The title is left out when no Connection can read the record, as
 * the title of another record always is (spec 20 section 1.3).
 */
export const EntityMention = Schema.Struct({
  id: Id,
  identifier: Schema.optionalKey(bounded(1, 64)),
  title: Schema.optionalKey(bounded(1, 512)),
});

export type EntityMention = Schema.Schema.Type<typeof EntityMention>;

/**
 * What `matchProject` finds. `matched` names the Project, the Resource whose
 * canonical remote matched, the selected `thing` the evidence is about, and,
 * when the repository is a linked thing's, that `via` thing one link away.
 * `none` means nothing points at a repository of a Project that is not
 * deleted. `ambiguous` means the evidence points at more than one Project.
 */
export const ProjectMatch = Schema.Union([
  Schema.Struct({
    kind: Schema.Literal("matched"),
    projectId: Id,
    resourceId: Id,
    thing: EntityMention,
    via: Schema.optionalKey(EntityMention),
  }),
  Schema.Struct({ kind: Schema.Literal("none") }),
  Schema.Struct({ kind: Schema.Literal("ambiguous") }),
]);

export type ProjectMatch = Schema.Schema.Type<typeof ProjectMatch>;

/**
 * What `read` returns: one full record of a work kind. `kindAvailable` is
 * false when the catalog no longer has an active kind: the card draws, its
 * actions are off, and it shows why.
 */
export const ExternalEntityDetail = Schema.Struct({
  ...entityFields,
  kindAvailable: Schema.Boolean,
  /**
   * The fields the thing's kind declares that have a value, in declaration
   * order. Empty when the kind's plugin is not active.
   */
  fields: atMost(EntityFieldValue, MAX_ENTITY_KIND_FIELDS),
  /** The card face of the thing's kind, or null for the generic card (no face declared, or its plugin is not active). */
  face: Schema.NullOr(CardFace),
  /**
   * The records above this one and the targets of its links and hints, each
   * once. Its bound is the most ancestors plus the most links and hints, so no
   * record the entity reaches is left out.
   */
  places: atMost(EntityPlace, MAX_ENTITY_ANCESTORS + MAX_ENTITY_LINKS + MAX_ENTITY_HINTS),
  edges: atMost(EntityEdge, MAX_GRAPH_EDGES),
  links: atMost(EntityLink, MAX_ENTITY_LINKS),
  hints: atMost(EntityHint, MAX_ENTITY_HINTS),
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
  /** The records at the far end of this thing's links and hints that have no card of their own. */
  peers: atMost(EntityPeer, MAX_ENTITY_LINKS + MAX_ENTITY_HINTS),
  /**
   * The workflows this thing can be handed to, as `Inbox.offerSets` holds
   * them for a card: available ones first, then unavailable ones, each by
   * name, cut to the first `MAX_ENTITY_OFFERS`. A presentation list: the
   * handoff checks its workflow itself.
   */
  offers: atMost(WorkflowOffer, MAX_ENTITY_OFFERS),
  /**
   * The Connections that can act on this thing, oldest first, cut to the
   * first `MAX_ACTING_CONNECTIONS`. The first is the default. A presentation
   * list: the handoff checks the account it uses itself.
   */
  actingConnections: atMost(ActingConnection, MAX_ACTING_CONNECTIONS),
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
 * The input of `handOff`, beside the entity's id in the path: the workflow to
 * hand the thing to, and the account that acts. Without `connectionId` the
 * first of the thing's acting Connections acts.
 */
export const EntityHandOffInput = Schema.Struct({
  workflowId: Id,
  connectionId: Schema.optionalKey(Id),
});

export type EntityHandOffInput = Schema.Schema.Type<typeof EntityHandOffInput>;

/** What `handOff` returns: the run it started, and the Task that run works on (new or continued). */
export const EntityHandOffResult = Schema.Struct({ ...RunStarted.fields, taskId: Id });

export type EntityHandOffResult = Schema.Schema.Type<typeof EntityHandOffResult>;

/**
 * What `undoHandOff` returns. A repeat of the call returns the first answer
 * again. The undo line never claims more than happened.
 *
 * - `undone`: nothing had started, so the run is cancelled and the Task is
 *   deleted or back at its earlier stage.
 * - `stopped`: the run was asked to stop, but it had gone too far to take
 *   back. The Task and its stage stay, and anything the run did stays.
 * - `too-late`: the run had already ended. Nothing changed.
 *
 * Signals the handoff ended stay ended in every case.
 */
export const HandOffUndo = Schema.Struct({
  outcome: Schema.Literals(["undone", "stopped", "too-late"]),
  /** True when a stop was asked for. It does not mean execution has stopped: the run's sessions report that. */
  stopRequested: Schema.Boolean,
  taskRemoved: Schema.Boolean,
  stageRestored: Schema.Boolean,
  failureRestored: Schema.Boolean,
  /** Why the Task or its stage stayed, in words for the undo line. */
  reason: Schema.optionalKey(Schema.String),
});

export type HandOffUndo = Schema.Schema.Type<typeof HandOffUndo>;

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
 * entity, take one on as a Task, dismiss and restore things, and the three
 * that let the user add a thing to Work: search the source, list suggestions,
 * and add.
 */
export const externalEntity = HttpApiGroup.make("externalEntity")
  .add(
    /**
     * Reads an Inbox list in one of four modes (see `InboxQuery`): the first
     * page with the total and the facets of the whole result, the page after a
     * cursor, a refresh (the first page and the held things beyond it, in one
     * snapshot), or the held things alone. A page holds at most 200 things in
     * the list's order. The reply carries the mode it answers.
     */
    // A POST that reads and stores nothing, as `workflow.validate` is: the
    // query is a nested value (a list, an array of clauses) that a flat query
    // string cannot carry. Static paths beside `/external-entities/:id`: the
    // router prefers them, and "inbox", "search" and "suggestions" are not ids.
    HttpApiEndpoint.post("queryInbox", "/external-entities/inbox/query", {
      payload: InboxQuery,
      success: InboxReply,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    /** Returns the Inbox's counts alone, for the sidebar, which reads them on every screen. */
    HttpApiEndpoint.get("countInbox", "/external-entities/inbox/count", {
      success: InboxCounts,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    /**
     * Returns what the Inbox's rail draws: every saved query with its count,
     * the sources, accounts and facet values, the pins, the query fields and
     * the sources that cannot be read. Only the Inbox screen reads it.
     */
    HttpApiEndpoint.get("readInboxOutline", "/external-entities/inbox/outline", {
      success: InboxOutline,
      error: [Unauthenticated, Forbidden, Internal],
    }),
    /**
     * Returns the values of one field among the things of a list, for the
     * search's suggestions. A POST that reads and stores nothing, for the
     * reason `queryInbox` is one.
     */
    HttpApiEndpoint.post("suggestInboxValues", "/external-entities/inbox/values", {
      payload: InboxValueQuery,
      success: InboxValues,
      error: [Unauthenticated, Forbidden, Validation, Internal],
    }),
    /**
     * Finds the Project a set of things points at: the evidence behind the
     * default Project of the start-thread dialog. A POST that reads and stores
     * nothing, for the reason `queryInbox` is one. Fails `NotFound`, naming the
     * ids, for an unknown id.
     */
    HttpApiEndpoint.post("matchProject", "/external-entities/match-project", {
      payload: EntityProjectMatchInput,
      success: ProjectMatch,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
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
    /**
     * Hands the thing to a workflow: starts a run on the thing's active Task
     * (new or continued) and ends the open signals of the kinds the workflow
     * answers. Returns the run and the Task. Only the user hands off. Fails
     * `NotFound` for an unknown entity or workflow, and `InvalidState` when
     * the workflow is not available on the thing, the same workflow already
     * works on its Task, or a reply to one of the signals is still running.
     */
    HttpApiEndpoint.post("handOff", "/external-entities/:id/hand-off", {
      params: { id: Id },
      payload: EntityHandOffInput,
      success: EntityHandOffResult,
      error: [
        Unauthenticated,
        Forbidden,
        Validation,
        NotFound,
        InvalidState,
        CapExceeded,
        Conflict,
        Internal,
      ],
    }),
    /**
     * Takes back a handoff as far as is safe: cancels its run, and deletes
     * the Task or restores its stage only when nothing had started and
     * nothing has changed the Task since. Only the user undoes. Fails
     * `NotFound` when the run is not a handoff of an entity.
     */
    // A static first segment: `/external-entities/:id/hand-off` and the other
    // `:id` routes end in a word that is not `undo`, so the router never takes
    // this path for one of them, and "handoffs" is not an id.
    HttpApiEndpoint.post("undoHandOff", "/external-entities/handoffs/:runId/undo", {
      params: { runId: Id },
      success: HandOffUndo,
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    /**
     * Takes things off the Inbox, all or none, in one transaction. `restore`
     * brings them back, and so does a new ask on a thing after the dismissal.
     * Fails `NotFound` when an id is unknown, and then none is dismissed.
     */
    // Static paths: "dismiss" and "restore" are not ids.
    HttpApiEndpoint.post("dismiss", "/external-entities/dismiss", {
      payload: InboxMove,
      success: Schema.Struct({}),
      error: [Unauthenticated, Forbidden, Validation, NotFound, Internal],
    }),
    HttpApiEndpoint.post("restore", "/external-entities/restore", {
      payload: InboxMove,
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
