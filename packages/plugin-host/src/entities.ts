/**
 * What a plugin declares and reports about External Entities, the durable
 * records of things in an outside system, such as a pull request.
 *
 * - A plugin declares each kind of entity it reports as data: `EntityKindDeclaration`.
 * - A poll reports what it read as `EntityObservation`s, through `IngestContext.entities`.
 * - A plugin that can search its source, and recognize its own links, offers an `EntityLookup`.
 *
 * Everything a plugin writes here is plain data, bounded in size. A plugin
 * never draws: the core applies the declaration to the observation and stores
 * the result.
 */
import { type Effect, Schema } from "effect";
import type { ConnectionUnavailable } from "./connections";
import type { AuthError, IngestConnection } from "./contributions";
import { ContributionWord, QualifiedContributionId } from "./contributions";
import {
  buildBoundedString,
  ExternalRef,
  ISO_TIMESTAMP_PATTERN,
  MAX_EVENT_TITLE_LENGTH,
  MAX_EVENT_URL_LENGTH,
  MAX_EXTERNAL_REF_LENGTH,
} from "./limits";
import { StatusIcon, withPluginColor } from "./drawing";
import type { PluginError } from "./plugin";

/** An array of at most `max` items. */
const atMost = <S extends Schema.Top>(item: S, max: number) =>
  Schema.Array(item).check(Schema.isMaxLength(max));

// ---------------------------------------------------------------------------
// The kind table
// ---------------------------------------------------------------------------

/**
 * The shapes a status can have. Each is drawn by the core on its icon grid:
 * `ring` is open, `dashed` is not real yet, `quarter`, `half` and `most` are
 * under way, `fork` is a proposed change, `join` is merged, `check` is
 * finished, `cross` is failed or refused, `hold` waits for a change, and
 * `alert` is burning.
 */
export const ENTITY_STATUS_SHAPES = [
  "ring",
  "dashed",
  "quarter",
  "half",
  "most",
  "fork",
  "join",
  "check",
  "cross",
  "hold",
  "alert",
] as const;

/**
 * The tones a status can have. Each is one reserved colour of the design
 * system. The colour kept for the person is not in the list, so a plugin cannot
 * use it.
 */
export const ENTITY_STATUS_TONES = ["quiet", "active", "attention", "good", "bad"] as const;

/** The forms a fact is shown in that need no unit. The other form, `count`, names its unit. */
const UNITLESS_FACT_FORMS = ["delta", "word", "date", "money", "bars"] as const;

/** The tones of the sentence a card shows for a reason. */
export const ENTITY_REASON_TONES = ["plain", "attention", "good", "bad"] as const;

/**
 * The Task stages a status may map to. This repeats the contract's
 * `TASK_STAGES`, because this package cannot import the contract (the contract
 * imports this package). A test in the controller fails when the two differ.
 */
export const ENTITY_STATUS_STAGES = [
  "exploring",
  "planned",
  "building",
  "in-review",
  "landed",
  "done",
  "dropped",
] as const;

/** The longest text of a declaration's caption: a noun, a status word or a reason. */
const MAX_DECLARED_TEXT_LENGTH = 120;

/** The longest name of a field or a status key in a declaration. */
const MAX_DECLARED_NAME_LENGTH = 64;

/** The most facts a card shows. */
export const MAX_ENTITY_FACTS = 3;

/** The most statuses, and the most reasons, one kind declares. */
const MAX_DECLARED_ENTRIES = 32;

/**
 * A field name written between braces in a template, such as `number` in
 * `#{number}`.
 */
const TEMPLATE_PLACEHOLDER_SOURCE = "\\{[A-Za-z0-9_-]+\\}";

/**
 * A template that builds a short text from an observation's `fields`, such as
 * `#{number}` or `{messages} messages`. It holds at least one `{field}`
 * placeholder, so it names something, and every brace is part of a placeholder.
 */
export const EntityTemplate = buildBoundedString(1, MAX_DECLARED_NAME_LENGTH).check(
  Schema.isPattern(new RegExp(TEMPLATE_PLACEHOLDER_SOURCE), {
    message: "A template needs at least one {field} placeholder, such as #{number}.",
  }),
  Schema.isPattern(new RegExp(`^(?:[^{}]|${TEMPLATE_PLACEHOLDER_SOURCE})*$`), {
    message:
      "A template may use braces only for placeholders written {field}, with letters, digits, - or _ inside.",
  }),
);

/**
 * One status a kind can have, by key.
 *
 * - `shape` and `tone` are what the status means to Hercule. The apps draw
 *   them when the status has no `icon`.
 * - `icon` is the plugin's own drawing of the status, such as GitHub's merged
 *   icon, and `hue` or `color` colours it (see `withPluginColor`). An icon
 *   with no colour is drawn grey.
 * - `norm` marks the usual state of a request.
 * - `stage` is the Task stage a Task takes when its entity gets this status.
 */
export const EntityStatusDeclaration = withPluginColor({
  shape: Schema.Literals(ENTITY_STATUS_SHAPES),
  tone: Schema.Literals(ENTITY_STATUS_TONES),
  word: buildBoundedString(1, MAX_DECLARED_TEXT_LENGTH),
  icon: Schema.optionalKey(StatusIcon),
  norm: Schema.optionalKey(Schema.Boolean),
  stage: Schema.optionalKey(Schema.Literals(ENTITY_STATUS_STAGES)),
});

export type EntityStatusDeclaration = Schema.Schema.Type<typeof EntityStatusDeclaration>;

/**
 * One fact a card shows, read from the observation's field named `field`. A
 * `count` fact names its `unit`, such as "file"; the other forms have none.
 */
export const EntityFactDeclaration = Schema.Union([
  Schema.Struct({
    field: buildBoundedString(1, MAX_DECLARED_NAME_LENGTH),
    form: Schema.Literal("count"),
    unit: buildBoundedString(1, 20),
  }),
  Schema.Struct({
    field: buildBoundedString(1, MAX_DECLARED_NAME_LENGTH),
    form: Schema.Literals(UNITLESS_FACT_FORMS),
  }),
]);

export type EntityFactDeclaration = Schema.Schema.Type<typeof EntityFactDeclaration>;

/**
 * The sentence a card shows for one reason. `say` may hold `{person}` or
 * `{value}`, which the core fills in.
 */
export const EntityReasonDeclaration = Schema.Struct({
  say: buildBoundedString(1, MAX_DECLARED_TEXT_LENGTH),
  tone: Schema.Literals(ENTITY_REASON_TONES),
});

export type EntityReasonDeclaration = Schema.Schema.Type<typeof EntityReasonDeclaration>;

/** The most fields one kind declares. */
export const MAX_ENTITY_KIND_FIELDS = 16;

/** The most values an `enum` field lists. */
const MAX_ENUM_VALUES = 32;

/** The types of field whose value needs no further declaration. */
const PLAIN_FIELD_TYPES = ["text", "person", "number", "age", "bool"] as const;

/**
 * Builds the schema of one declared field. `facetValues` is the schema of
 * `facet.values`: a plain word as a plugin writes it, or the qualified id the
 * host stores.
 *
 * A field is read from the observation's `fields[key]` and nothing else is.
 *
 * - `text` and `person` hold a string, `number` a finite number, `bool` a
 *   boolean, and `age` an ISO timestamp the age counts from.
 * - `enum` holds one of its `values`, a closed set kept in the order listed.
 * - `money` holds an amount in major units of its `currency`, an ISO 4217 code.
 * - `facet` makes the field's values something Browse and Narrow list.
 *   `plural` names them ("Teams"). `values` names a context kind of the same
 *   source whose stored records are every value the source knows.
 */
const buildFieldDeclaration = <V extends Schema.Top>(facetValues: V) => {
  const base = {
    key: buildBoundedString(1, MAX_DECLARED_NAME_LENGTH).check(
      Schema.isPattern(/^[A-Za-z0-9_-]+$/, {
        message: "A field key may hold only letters, digits, - and _.",
      }),
    ),
    label: buildBoundedString(1, 40),
    facet: Schema.optionalKey(
      Schema.Struct({
        plural: buildBoundedString(1, 40),
        values: Schema.optionalKey(facetValues),
      }),
    ),
  };
  return Schema.Union([
    Schema.Struct({ ...base, type: Schema.Literals(PLAIN_FIELD_TYPES) }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("enum"),
      values: Schema.Array(
        Schema.Struct({
          value: buildBoundedString(1, MAX_DECLARED_NAME_LENGTH),
          label: Schema.optionalKey(buildBoundedString(1, 40)),
        }),
      ).check(Schema.isMinLength(1), Schema.isMaxLength(MAX_ENUM_VALUES)),
    }),
    Schema.Struct({
      ...base,
      type: Schema.Literal("money"),
      currency: Schema.String.check(
        Schema.isPattern(/^[A-Z]{3}$/, {
          message: "A currency is an ISO 4217 code of three capital letters, such as EUR.",
        }),
      ),
    }),
  ]);
};

/** One field of a kind, as a plugin declares it. */
export const EntityFieldDeclaration = buildFieldDeclaration(ContributionWord);

export type EntityFieldDeclaration = Schema.Schema.Type<typeof EntityFieldDeclaration>;

/** The type of a declared field: `text`, `person`, `enum`, `number`, `money`, `age` or `bool`. */
export type EntityFieldType = EntityFieldDeclaration["type"];

/** The types of field that can be a Facet: the values are words a person can name, so Browse can list them and a row can say them. */
export const FACET_FIELD_TYPES: ReadonlyArray<EntityFieldType> = ["text", "person", "enum"];

/** One field of a kind after the host qualified `facet.values`, as in `github/repository`. */
export const QualifiedEntityFieldDeclaration = buildFieldDeclaration(QualifiedContributionId);

export type QualifiedEntityFieldDeclaration = Schema.Schema.Type<
  typeof QualifiedEntityFieldDeclaration
>;

/**
 * What a card of a kind shows beyond the generic card. Each slot names the
 * `key` of a declared field.
 *
 * - `place` is the faint "where" at the end of the row, beside the identifier.
 * - `context` is what a quiet row says after its status.
 * - `fact` is a number or an amount a quiet row says.
 */
export const CardFaceDeclaration = Schema.Struct({
  place: Schema.optionalKey(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH)),
  context: Schema.optionalKey(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH)),
  fact: Schema.optionalKey(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH)),
});

export type CardFaceDeclaration = Schema.Schema.Type<typeof CardFaceDeclaration>;

/** The slots of a card face, in the order a card shows them. */
export const CARD_FACE_SLOTS = ["place", "context", "fact"] as const;

/**
 * The types of field each slot of a card face can read. `place` and `context`
 * say a word, so they take what a Facet takes. `fact` says an amount.
 */
export const CARD_FACE_SLOT_FIELD_TYPES: Readonly<
  Record<(typeof CARD_FACE_SLOTS)[number], ReadonlyArray<EntityFieldType>>
> = {
  place: FACET_FIELD_TYPES,
  context: FACET_FIELD_TYPES,
  fact: ["number", "money"],
};

/** The fields of a kind declaration, apart from the ones that name another kind. */
const kindFields = {
  /** The word the UI uses for several, such as "Pull requests". */
  plural: Schema.optionalKey(buildBoundedString(1, 40)),
  /**
   * How long a thing of this kind lasts, from 0 (briefest) to 3 (most lasting).
   * A group of linked things is labelled with the title of its most lasting one.
   */
  lasting: Schema.optionalKey(Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 3 }))),
  /** The fields an observation reports that Browse, Narrow and the card face read, in display order. */
  fields: Schema.optionalKey(atMost(EntityFieldDeclaration, MAX_ENTITY_KIND_FIELDS)),
  /** What the card shows beyond the generic card. Only a kind with a card has one. */
  face: Schema.optionalKey(CardFaceDeclaration),
  /** How much room it deserves. Left out means rich. A context kind has no card. */
  card: Schema.optionalKey(Schema.Literals(["rich", "compact"])),
  /** The word the UI uses for one, such as "Pull request". */
  noun: buildBoundedString(1, 40),
  /** Every ref of this kind starts with it, such as `github:pr:`. */
  refPrefix: buildBoundedString(1, 64),
  /** `fast` has a clock, `slow` has none, and `context` is a place with no card. */
  pace: Schema.Literals(["fast", "slow", "context"]),
  /** Hours before a wait counts as due. */
  patience: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  /** The identifier a card shows, built from the observation's fields: `#{number}`. */
  identifier: EntityTemplate,
  /** The field holding the person it is about. Null for a kind with no person. */
  person: Schema.NullOr(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH)),
  /** The field that says it is yours. Null for a kind that is never yours. */
  owner: Schema.NullOr(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH)),
  /** What first run says this kind brings. */
  connect: Schema.optionalKey(buildBoundedString(1, MAX_DECLARED_TEXT_LENGTH)),
  /** Present when this kind can be a lane or a filter, with the words for it: "Linear project". */
  groupable: Schema.optionalKey(Schema.Struct({ caption: buildBoundedString(1, 60) })),
  /** Each status a thing of this kind can have, by key. Null for a kind with no status. */
  status: Schema.NullOr(
    Schema.Record(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH), EntityStatusDeclaration).check(
      Schema.isMaxProperties(MAX_DECLARED_ENTRIES),
    ),
  ),
  /** At most `MAX_ENTITY_FACTS` facts a card shows. */
  facts: atMost(EntityFactDeclaration, MAX_ENTITY_FACTS),
  /** The sentence a card shows for each reason it is here, by reason key. */
  reasons: Schema.Record(
    buildBoundedString(1, MAX_DECLARED_NAME_LENGTH),
    EntityReasonDeclaration,
  ).check(Schema.isMaxProperties(MAX_DECLARED_ENTRIES)),
};

/**
 * One kind of External Entity as a plugin declares it, such as a pull request.
 * A plugin writes its own words unqualified, `pull-request`, and the host
 * qualifies them with the plugin's id (see `QualifiedEntityKindDeclaration`).
 *
 * - `word` names the kind. `home` is the kind of place it is usually grouped
 *   under, and `section` the level shown on a row below its home. Both name a
 *   kind of the same source by its `word`, so a kind that only a person could
 *   name is not possible.
 * - A kind declares no membership: which side a card lies on comes from `card`,
 *   its clock from `pace`, and its places from relations.
 */
export const EntityKindDeclaration = Schema.Struct({
  word: ContributionWord,
  home: Schema.optionalKey(ContributionWord),
  section: Schema.optionalKey(ContributionWord),
  ...kindFields,
});

export type EntityKindDeclaration = Schema.Schema.Type<typeof EntityKindDeclaration>;

/**
 * An entity kind after the host qualified it: `word`, `home`, `section` and
 * every field's `facet.values` start with the plugin's id, as in `github/pull-request`. This is what the
 * public API returns and what the core stores copies of.
 */
export const QualifiedEntityKindDeclaration = Schema.Struct({
  ...EntityKindDeclaration.fields,
  fields: Schema.optionalKey(atMost(QualifiedEntityFieldDeclaration, MAX_ENTITY_KIND_FIELDS)),
  word: QualifiedContributionId,
  home: Schema.optionalKey(QualifiedContributionId),
  section: Schema.optionalKey(QualifiedContributionId),
});

export type QualifiedEntityKindDeclaration = Schema.Schema.Type<
  typeof QualifiedEntityKindDeclaration
>;

// ---------------------------------------------------------------------------
// What a poll reports
// ---------------------------------------------------------------------------

/**
 * The most observations one `reconcile` call takes. A poll reads its whole
 * inventory and reconciles it in one transaction, and 2,000 observations of a
 * few hundred bytes fit one short transaction.
 */
export const MAX_ENTITY_OBSERVATIONS = 2000;

/** The most fields one observation reports. */
export const MAX_ENTITY_FIELDS = 32;

/** The longest name of a field. */
export const MAX_ENTITY_FIELD_NAME_LENGTH = 64;

/** The longest text of one field. A field holds a name, a number or a short word, never a document. */
export const MAX_ENTITY_FIELD_TEXT_LENGTH = 512;

/** The most parents, and the most peers, one observation reports. */
export const MAX_ENTITY_RELATIONS = 64;

/** The most texts one observation carries for the core to search for references. */
export const MAX_ENTITY_TEXTS = 3;

/** The most characters one observation text holds (16 KiB of ASCII). A description, never a document. */
export const MAX_ENTITY_TEXT_LENGTH = 16 * 1024;

/** The longest `evidenceKey` of an observation text. */
export const MAX_ENTITY_EVIDENCE_KEY_LENGTH = 128;

/**
 * Why a thing concerns the user, as the public API spells it. A plugin may not report `following`, because
 * only the core sets it. The schema lists it anyway: the core refuses it with a
 * message that explains why, which a schema error could not.
 */
export const ENTITY_CONCERNS = [
  "assigned",
  "opened",
  "review-requested",
  "mentioned",
  "following",
] as const;

const Timestamp = Schema.String.check(Schema.isPattern(ISO_TIMESTAMP_PATTERN));

/** Where the work lands, and where it comes from. `head` differs from `target` for a fork. */
export const EntityRepository = Schema.Struct({
  target: Schema.Struct({ remote: buildBoundedString(1, MAX_EXTERNAL_REF_LENGTH) }),
  head: Schema.optionalKey(
    Schema.Struct({
      remote: buildBoundedString(1, MAX_EXTERNAL_REF_LENGTH),
      branch: buildBoundedString(1, MAX_EXTERNAL_REF_LENGTH),
    }),
  ),
});

/** What the source reports of progress: only what it reports, never worked out. */
export const EntityProgress = Schema.Struct({
  fraction: Schema.Finite.check(Schema.isBetween({ minimum: 0, maximum: 1 })),
  done: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
  total: Schema.optionalKey(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0))),
});

/**
 * A link a person opens, at most `MAX_EVENT_URL_LENGTH` characters. Only
 * `http` and `https` are accepted: a `javascript:` or `file:` link written by
 * a plugin would otherwise travel to every client as it is.
 */
export const HttpUrl = buildBoundedString(1, MAX_EVENT_URL_LENGTH).check(
  Schema.isPattern(/^https?:\/\/\S+$/i, {
    message: "A url must start with http:// or https:// and hold no spaces.",
  }),
);

/** Returns true when `value` is a link a person opens (see `HttpUrl`). */
export const isHttpUrl = Schema.is(HttpUrl);

/** The web addresses an observation reports as its own (`relations.linkedUrls`). */
export const LinkedUrls = atMost(HttpUrl, MAX_ENTITY_RELATIONS);

/**
 * The relations one observation reports. `complete` is true when every
 * relation of the thing was read, so that a claim left out is really gone.
 */
export const EntityObservationRelations = Schema.Struct({
  complete: Schema.Boolean,
  /** The parents this Connection reports, by ref. */
  partOf: atMost(ExternalRef, MAX_ENTITY_RELATIONS),
  /** The peers this Connection reports, by ref. */
  linked: atMost(ExternalRef, MAX_ENTITY_RELATIONS),
  /**
   * URLs the source itself says belong to this thing, such as a Linear
   * attachment that points at a pull request. The source does not know the
   * other plugins' link forms, so the core recognizes each URL and turns it
   * into a `source` claim. Leave it out when the source reports none.
   */
  linkedUrls: Schema.optionalKey(LinkedUrls),
});

/** The fields a full and a partial observation share. */
const observationFields = {
  /** The unqualified word of a kind this source declared, such as `pull-request`. */
  kind: ContributionWord,
  ref: ExternalRef,
  title: buildBoundedString(1, MAX_EVENT_TITLE_LENGTH),
};

/**
 * One text of an observation. `revision` lets the core skip a text it already
 * searched. An empty `text` is allowed: it clears the hints this Connection
 * found under `evidenceKey`, as a description that was emptied needs.
 */
const ObservationText = Schema.Struct({
  evidenceKey: buildBoundedString(1, MAX_ENTITY_EVIDENCE_KEY_LENGTH),
  text: buildBoundedString(0, MAX_ENTITY_TEXT_LENGTH),
  revision: Schema.optionalKey(buildBoundedString(1, 256)),
});

/** The texts of one observation, at most `MAX_ENTITY_TEXTS`. */
export const ObservationTexts = atMost(ObservationText, MAX_ENTITY_TEXTS);

/** The fields of an observation that are all optional, whatever its kind of completeness. */
const optionalObservationFields = {
  url: Schema.optionalKey(HttpUrl),
  /** Needed except on a context kind or a partial observation. The core checks that. */
  lifecycle: Schema.optionalKey(Schema.Literals(["open", "completed", "abandoned"])),
  /** A key of the kind's `status` table. */
  status: Schema.optionalKey(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH)),
  repository: Schema.optionalKey(EntityRepository),
  progress: Schema.optionalKey(EntityProgress),
  targetDate: Schema.optionalKey(Timestamp),
  /**
   * When the source created the thing. Unlike `sourceUpdatedAt` it never
   * changes, so the core can tell a thing made before some moment from one
   * made after it. The branch link step reads it to keep an old pull request
   * on a reused branch name from linking to a new Task.
   */
  sourceCreatedAt: Schema.optionalKey(Timestamp),
  relations: Schema.optionalKey(EntityObservationRelations),
  /**
   * The source's revision of this thing. An unchanged revision means the
   * shared facts of the thing are unchanged. It does not mean nothing
   * changed: concerns, access and freshness are still applied.
   */
  sourceRevision: Schema.optionalKey(buildBoundedString(1, 256)),
  /**
   * Texts the core searches for references to other things, such as a ticket's
   * description. The core keeps no text: it keeps only the claims it finds.
   * An observation that carries an `evidenceKey` replaces this Connection's
   * `text` claims for that key; one that leaves the key out touches none.
   */
  texts: Schema.optionalKey(ObservationTexts),
};

/** Raw facts by name: the kind's templates, facts and declared fields read from these. A boolean is for a `bool` field. */
const ObservationFieldValues = Schema.Record(
  buildBoundedString(1, MAX_ENTITY_FIELD_NAME_LENGTH),
  Schema.NullOr(
    Schema.Union([
      buildBoundedString(0, MAX_ENTITY_FIELD_TEXT_LENGTH),
      Schema.Finite,
      Schema.Boolean,
    ]),
  ),
).check(Schema.isMaxProperties(MAX_ENTITY_FIELDS));

/**
 * What a source reports of one thing, in full. It carries what the thing is
 * (`fields`, `status`, `lifecycle`) and how it concerns the user (`concerns`,
 * `ownedByYou`, `reason`, `waitingSince`).
 *
 * The schema cannot tell a work kind from a context kind, so `url` and
 * `lifecycle` are optional here. The core refuses an observation of a work kind
 * that lacks either.
 */
const FullEntityObservation = Schema.Struct({
  ...observationFields,
  ...optionalObservationFields,
  partial: Schema.optionalKey(Schema.Literal(false)),
  /** Raw values, by field name. The kind's `identifier`, `person`, `owner` and `facts` read these. */
  fields: ObservationFieldValues,
  /** Why the thing concerns the user. Empty for a context thing. */
  concerns: atMost(Schema.Literals(ENTITY_CONCERNS), ENTITY_CONCERNS.length),
  /** True when the thing is the user's own, as the source says. */
  ownedByYou: Schema.optionalKey(Schema.Boolean),
  /** A key of the kind's `reasons`: what a card says when no signal gives a line. */
  reason: Schema.optionalKey(buildBoundedString(1, MAX_DECLARED_NAME_LENGTH)),
  /** When the wait began, when the source knows. */
  waitingSince: Schema.optionalKey(Timestamp),
  sourceUpdatedAt: Timestamp,
});

/**
 * What a read of something else happened to give, such as a parent issue's
 * title. It needs only `kind`, `ref` and `title`. It fills in what it carries
 * and never clears a known field. It says nothing about the user's concerns,
 * so it has no `concerns`, `ownedByYou`, `reason` or `waitingSince`.
 */
const PartialEntityObservation = Schema.Struct({
  ...observationFields,
  ...optionalObservationFields,
  partial: Schema.Literal(true),
  fields: Schema.optionalKey(ObservationFieldValues),
  sourceUpdatedAt: Schema.optionalKey(Timestamp),
});

/**
 * What a source reports of one thing. A partial observation, marked
 * `partial: true`, needs only `kind`, `ref` and `title`. Anything else is a
 * full observation. Narrow with `observation.partial === true`.
 */
export const EntityObservation = Schema.Union([FullEntityObservation, PartialEntityObservation]);

export type EntityObservation = Schema.Schema.Type<typeof EntityObservation>;

/** The observations of one kind that a `reconcile` call replaces what the Connection said with. */
export interface EntityInventory {
  /** The unqualified word of the kind. */
  readonly kind: string;
  /**
   * True when the plugin read every thing of the kind that concerns the user.
   * Only then may the core empty the concerns of what an earlier inventory
   * listed and this one does not.
   */
  readonly complete: boolean;
  readonly observations: ReadonlyArray<EntityObservation>;
}

/** A branch on a remote that a Task's checkout is on. `remote` is the address as the core stores it. */
export interface TrackedBranch {
  readonly remote: string;
  readonly branch: string;
}

/**
 * What the host passes to an ingest handle for reporting entities. Present
 * only when the manifest requested the `entities` capability.
 */
export interface IngestEntities {
  /**
   * Replaces what this Connection says about one kind, in one transaction:
   * inserts and updates every observation, and when `complete` is true, empties the
   * concerns of what the Connection reported before and left out now. Fails with a
   * `PluginError`, before writing anything, when it is given more than
   * `MAX_ENTITY_OBSERVATIONS`, a ref that does not start with the kind's
   * `refPrefix`, an oversized field, or the concern `following`.
   */
  readonly reconcile: (inventory: EntityInventory) => Effect.Effect<void, PluginError>;
  /** Updates what is known of entities without touching any concern. */
  readonly refresh: (
    observations: ReadonlyArray<EntityObservation>,
  ) => Effect.Effect<void, PluginError>;
  /**
   * Returns the refs of one kind the core wants this Connection to read, at most `limit`.
   * Each call moves on to the next ones, so every wanted ref gets its turn.
   */
  readonly listWanted: (kind: string, limit: number) => Effect.Effect<ReadonlyArray<string>>;
  /**
   * Returns the branches the core wants this Connection to look up pull
   * requests for, on remotes that start with `remotePrefix` (such as
   * `github.com/`), at most `limit`. Use it to find a short-lived pull request
   * that was opened and merged between two inventories, so the inventory never
   * listed it: read the pull requests whose head is each branch and report
   * them with `refresh`.
   *
   * A branch is listed when:
   *
   * - an ephemeral checkout of a live Task is on it;
   * - it is not the checkout's default branch;
   * - it exists on the remote;
   * - that Task does not yet link an entity whose `repository.head` is exactly
   *   this `(remote, branch)`. A link to something else, such as a ticket,
   *   does not hide the branch.
   *
   * Each call moves on to the next branches, kept durably per Connection, so
   * every tracked branch gets its turn. `remote` is the address as the core
   * stores it, such as `github.com/acme/storefront-web`. The same pair is
   * returned once, however many Tasks track it.
   */
  readonly listTrackedBranches: (
    remotePrefix: string,
    limit: number,
  ) => Effect.Effect<ReadonlyArray<TrackedBranch>>;
  /** Says a ref could not be read, and why. Never removes anything. */
  readonly reportMissing: (
    ref: string,
    reason: "inaccessible" | "deleted",
  ) => Effect.Effect<void, PluginError>;
}

// ---------------------------------------------------------------------------
// Search, recognition and resolution
// ---------------------------------------------------------------------------

/**
 * What a plugin recognizes in a piece of text. Recognition is pure: a plugin
 * recognizes only its own URL and identifier forms, and fetches nothing.
 * `kind` is the unqualified word of one of the plugin's entity kinds.
 */
export type EntityRecognition =
  /** The text names exactly one thing. */
  | {
      readonly recognized: "ref";
      readonly form: "url" | "identifier";
      readonly ref: string;
      readonly kind: string;
    }
  /**
   * The text names something only inside a scope, such as `SHOP-123`, which
   * means nothing without its workspace. `kind` is absent when the text does
   * not say which kind it is, such as GitHub's `owner/repo#87`, which names an
   * issue or a pull request: `resolve` finds out.
   */
  | {
      readonly recognized: "scoped";
      readonly form: "url" | "identifier";
      readonly kind?: string;
      readonly identifier: string;
      readonly scopeHint?: string;
    };

/** What a lookup reads, which is the credentials of the Connection it runs for. */
export interface EntityLookupContext {
  /**
   * Returns the Connection's credentials, read at the moment of the call. See
   * `IngestContext.credentials`.
   */
  readonly credentials: () => Effect.Effect<Record<string, string>, ConnectionUnavailable>;
}

/** Why a source found nothing, from firmest to weakest: it refused, it is sure nothing is there, or it cannot tell. */
export type EntityMissing = "inaccessible" | "not-found" | "unknown";

/**
 * What `resolve` found. `missing` says what the source can honestly say:
 * `inaccessible` when it refused, `not-found` when it is sure nothing is
 * there, and `unknown` when it cannot tell, as GitHub cannot. `outOfScope`
 * says the Connection is ruled out by the recognition's `scopeHint`.
 */
export type EntityResolution =
  | { readonly found: EntityObservation }
  | { readonly missing: EntityMissing }
  | { readonly outOfScope: true };

/** One block a plugin returns; the core checks it against the contract's Block. */
export type EntityBlockDraft = { readonly type: string; readonly [field: string]: unknown };

/**
 * Searching, recognizing and reading things at the source, for the Add button
 * on Work. A lookup runs outside any transaction, and the host gives each call
 * a timeout of 8 seconds and fails it with `PluginError`.
 */
export interface EntityLookup {
  /** Returns everything `text` names, in order, at most 20. Pure: no fetch, no credentials, no redirects. */
  readonly recognize: (text: string) => ReadonlyArray<EntityRecognition>;
  /**
   * Searches the source by words or an identifier, at most `limit`. `scopeRef` narrows
   * the search to one context of this plugin. Fails with an `AuthError` when the
   * credentials were rejected, and with a `PluginError` for any other failure.
   */
  readonly search: (
    connection: IngestConnection,
    context: EntityLookupContext,
    query: { readonly text: string; readonly scopeRef?: string; readonly limit: number },
  ) => Effect.Effect<ReadonlyArray<EntityObservation>, AuthError | PluginError>;
  /**
   * Reads one thing, by its ref or by a scoped recognition. Fails with an
   * `AuthError` when the credentials were rejected, and with a `PluginError`
   * for any other failure.
   */
  readonly resolve: (
    connection: IngestConnection,
    context: EntityLookupContext,
    target: EntityRecognition,
  ) => Effect.Effect<EntityResolution, AuthError | PluginError>;
  /**
   * Reads the blocks the Inbox pane draws for the thing `ref`, at most 8, in
   * order. Optional. Fails with AuthError when the credentials were rejected,
   * PluginError for any other failure (including the thing not being found).
   */
  readonly readBlocks?: (
    connection: IngestConnection,
    context: EntityLookupContext,
    ref: string,
  ) => Effect.Effect<ReadonlyArray<EntityBlockDraft>, AuthError | PluginError>;
}
