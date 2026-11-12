/**
 * What a plugin declares as a saved query: a named list of the Inbox that a
 * source offers beside the core's own, such as GitHub's "Review requests".
 *
 * A saved query is data, written in the Inbox's one query vocabulary: the
 * `InboxClause`. Browse, Narrow and the search send the same clauses. This
 * lives in plugin-host, and not in the public contract, because the contract
 * imports this package and a plugin cannot import the contract. The contract
 * reuses `InboxClause` from here.
 */
import { Schema } from "effect";
import { ContributionWord } from "./contributions";
import { MAX_ENTITY_FIELD_TEXT_LENGTH, type EntityFieldType } from "./entities";
import { buildBoundedString } from "./limits";
import { PluginId } from "./manifest";

/** The operators of a clause (see `InboxClause`). */
export type InboxClauseOperator = "is" | "over" | "under";

/**
 * Returns the operators a clause on a field of `type` takes, and the type of
 * the value it carries. `is` compares for equality; `over` and `under`
 * compare a number, an amount, or a duration in seconds (`age` fields and
 * `waiting`).
 */
export const describeClauseForFieldType = (
  type: EntityFieldType,
): {
  readonly operators: ReadonlyArray<InboxClauseOperator>;
  readonly value: "string" | "number" | "boolean";
} => {
  switch (type) {
    case "text":
    case "person":
    case "enum":
      return { operators: ["is"], value: "string" };
    case "bool":
      return { operators: ["is"], value: "boolean" };
    case "number":
    case "money":
      return { operators: ["is", "over", "under"], value: "number" };
    case "age":
      return { operators: ["over", "under"], value: "number" };
  }
};

/**
 * The Inbox's own query fields, in the order the search lists them. Every
 * source answers them, so a plugin cannot declare an entity field with one of
 * these keys: a clause with that key would mean two things.
 *
 * - `source` is the plugin's id, `kind` the entity kind, and `account` the id
 *   or the label of a Connection.
 * - `from` is the person behind the thing: the asker of its open ask, else
 *   the thing's own person. `waiting` is the age of its oldest open ask.
 * - `asks`, `held` and `mine` are booleans: the thing has an open ask, a
 *   Task holds it, or it is yours.
 * - `signal` is the kind of one of its open signals.
 *
 * The predicate compiler, the checks that run when a plugin loads and the
 * outline's list of fields all read this one table.
 */
export const CORE_INBOX_FIELDS = [
  { key: "source", label: "Source", type: "text" },
  { key: "kind", label: "Kind", type: "text" },
  { key: "account", label: "Account", type: "text" },
  { key: "from", label: "From", type: "person" },
  { key: "waiting", label: "Waiting", type: "age" },
  { key: "asks", label: "Waits on me", type: "bool" },
  { key: "held", label: "With Hercule", type: "bool" },
  { key: "mine", label: "Mine", type: "bool" },
  { key: "signal", label: "Signal", type: "text" },
] as const satisfies ReadonlyArray<{
  readonly key: string;
  readonly label: string;
  readonly type: EntityFieldType;
}>;

export type CoreInboxFieldKey = (typeof CORE_INBOX_FIELDS)[number]["key"];

/** The keys of `CORE_INBOX_FIELDS`. */
export const CORE_INBOX_FIELD_KEYS: ReadonlyArray<CoreInboxFieldKey> = CORE_INBOX_FIELDS.map(
  (field) => field.key,
);

/** The most clauses one saved query has. */
export const MAX_SAVED_QUERY_CLAUSES = 8;

/** The most saved queries one plugin declares. */
export const MAX_SAVED_QUERIES_PER_PLUGIN = 4;

/** The longest a clause's key may be. */
export const MAX_INBOX_CLAUSE_KEY_LENGTH = 64;

/**
 * One condition on the things of the Inbox, such as "the signal is
 * review-requested" or "the waiting is over 86,400 seconds". Clauses of a
 * query are all required.
 *
 * - `key` is a core key (`CORE_INBOX_FIELD_KEYS`) or the key of a field a
 *   source declares.
 * - `is` compares equal: text, a person or an enum value without regard to
 *   case, or a boolean. `over` and `under` compare a number, an amount, or a
 *   duration in seconds (`age` fields and `waiting`).
 * - `source` and `connectionId` tie the clause to one source or one account.
 *   A clause that has neither holds across every source.
 */
export const InboxClause = Schema.Struct({
  key: buildBoundedString(1, MAX_INBOX_CLAUSE_KEY_LENGTH),
  op: Schema.Literals(["is", "over", "under"]),
  // As long as a stored field value, because a clause on a facet sends the
  // stored value (a record's ref) as it is.
  value: Schema.Union([
    buildBoundedString(1, MAX_ENTITY_FIELD_TEXT_LENGTH),
    Schema.Finite,
    Schema.Boolean,
  ]),
  source: Schema.optionalKey(PluginId),
  // A Connection's id. The schema is the loose bound the plugin API can say:
  // the public contract narrows it to an `Id`.
  connectionId: Schema.optionalKey(buildBoundedString(1, 64)),
});

export type InboxClause = Schema.Schema.Type<typeof InboxClause>;

/**
 * One saved query a source declares, as a plugin writes it.
 *
 * - `word` is the unqualified id. The host qualifies it with the plugin's id,
 *   so `review-requests` becomes `github/review-requests`.
 * - `name` is what the rail shows.
 * - `order` is `waiting` (things with an open ask first, the oldest ask
 *   first) or `newest` (the latest change first).
 * - `clauses` are all required. The value of a `kind` or `signal` clause is
 *   the plain word of one of the plugin's own entity or signal kinds; the
 *   host qualifies it. A plugin cannot name a Connection, so its clauses have
 *   no `source` or `connectionId`.
 */
export const SavedQuery = Schema.Struct({
  word: ContributionWord,
  name: buildBoundedString(1, 40),
  order: Schema.Literals(["waiting", "newest"]),
  clauses: Schema.Array(InboxClause).check(Schema.isMaxLength(MAX_SAVED_QUERY_CLAUSES)),
});

export type SavedQuery = Schema.Schema.Type<typeof SavedQuery>;
