/**
 * Ignore Rule rows and their catches.
 *
 * A rule's `match` is stored as JSON with its fields sorted by name, as a
 * signal's `match` is. Nothing here decides policy; it only reads and writes.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { IgnoreRule, IgnoreRuleWithCatches, SignalMatch } from "@hercule/contract";
import { uuidFromString, uuidToString } from "../db";
import { encodeSignalMatch } from "./repository";

interface IgnoreRuleRow {
  readonly id: Uint8Array;
  readonly kind: string;
  readonly match: string;
  readonly text: string;
  readonly actor: string;
  readonly created_at: string;
}

interface IgnoreRuleWithCatchesRow extends IgnoreRuleRow {
  readonly caught_count: number;
  readonly last_caught_at: string | null;
}

/** An event a rule stopped from raising a signal, as it is recorded. */
interface IgnoreRuleCatch {
  readonly eventId: number;
  readonly ruleId: string;
  /** The qualified kind the rule stopped, such as `github/review-requested`. */
  readonly kind: string;
  /** A copy of the rule's text, so the catch can name the rule after it is deleted. */
  readonly ruleText: string;
  readonly at: string;
}

const COLUMNS = "r.id, r.kind, r.match, r.text, r.actor, r.created_at";

/**
 * The order every list of rules is in: oldest first, and by id for rules
 * created at the same time. The raise path relies on it, because the oldest
 * rule that matches an event records its catch.
 */
const OLDEST_FIRST = "ORDER BY r.created_at, r.id";

/** Converts a stored row into the contract's rule. */
const parseRow = (row: IgnoreRuleRow): IgnoreRule => ({
  id: uuidToString(row.id),
  kind: row.kind,
  match: JSON.parse(row.match) as SignalMatch,
  text: row.text,
  createdAt: row.created_at,
  actor: row.actor,
});

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  return {
    /** Writes a new rule. The caller mints the id. */
    insert: (rule: IgnoreRule): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO ignore_rules (id, kind, match, text, actor, created_at)
        VALUES (${uuidFromString(rule.id)}, ${rule.kind}, ${encodeSignalMatch(rule.match)},
                ${rule.text}, ${rule.actor}, ${rule.createdAt})
      `),

    /**
     * Deletes the rule with that id and returns it as it was, or none when
     * no rule has that id. Its catches stay.
     */
    delete: (id: string): Effect.Effect<Option.Option<IgnoreRule>, SqlError> =>
      Effect.map(
        sql<IgnoreRuleRow>`
          DELETE FROM ignore_rules WHERE id = ${uuidFromString(id)}
          RETURNING id, kind, match, text, actor, created_at
        `,
        (rows) => Option.map(Option.fromNullishOr(rows[0]), parseRow),
      ),

    /**
     * Returns the rules of `kind`, oldest first.
     */
    list: (kind: string): Effect.Effect<ReadonlyArray<IgnoreRule>, SqlError> =>
      Effect.map(
        sql<IgnoreRuleRow>`
          SELECT ${sql.literal(COLUMNS)} FROM ignore_rules r
          WHERE r.kind = ${kind}
          ${sql.literal(OLDEST_FIRST)}
        `,
        (rows) => rows.map(parseRow),
      ),

    /**
     * Returns the rules, of one kind when `kind` is given, oldest first, each
     * with the number of its catches still in the log and the time of the
     * last one.
     */
    listWithCatches: (
      kind?: string,
    ): Effect.Effect<ReadonlyArray<IgnoreRuleWithCatches>, SqlError> =>
      Effect.map(
        sql<IgnoreRuleWithCatchesRow>`
          SELECT ${sql.literal(COLUMNS)},
            (SELECT COUNT(*) FROM ignore_rule_catches c WHERE c.rule_id = r.id) AS caught_count,
            (SELECT MAX(c.at) FROM ignore_rule_catches c WHERE c.rule_id = r.id) AS last_caught_at
          FROM ignore_rules r
          ${kind === undefined ? sql`` : sql`WHERE r.kind = ${kind}`}
          ${sql.literal(OLDEST_FIRST)}
        `,
        (rows) =>
          rows.map((row) => ({
            ...parseRow(row),
            caughtCount: row.caught_count,
            ...(row.last_caught_at === null ? {} : { lastCaughtAt: row.last_caught_at }),
          })),
      ),

    /**
     * Checks whether a rule caught the event `eventId` for a signal of
     * `kind`. A caught event stays caught after its rule is deleted, so the
     * raise path asks this before it raises a signal of the event again.
     */
    hasCatch: (eventId: number, kind: string): Effect.Effect<boolean, SqlError> =>
      Effect.map(
        sql<{ readonly found: number }>`
          SELECT 1 AS found FROM ignore_rule_catches WHERE event_id = ${eventId} AND kind = ${kind}
        `,
        (rows) => rows.length > 0,
      ),

    /**
     * Records that a rule stopped an event from raising a signal of its kind.
     * Writes nothing when the event is already caught for that kind: the
     * first catch of an event and a kind stays.
     */
    insertCatch: (caught: IgnoreRuleCatch): Effect.Effect<void, SqlError> =>
      Effect.asVoid(sql`
        INSERT INTO ignore_rule_catches (event_id, rule_id, kind, rule_text, at)
        VALUES (${caught.eventId}, ${uuidFromString(caught.ruleId)}, ${caught.kind},
                ${caught.ruleText}, ${caught.at})
        ON CONFLICT (event_id, kind) DO NOTHING
      `),
  };
});

/** Everything the Ignore Rule service and the raise path read and write about rules. */
export const ignoreRuleRepository = make;
