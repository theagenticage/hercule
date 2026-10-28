/**
 * Adds Ignore Rules (spec 10 §9.9): `ignore_rules`, the user's rules, and
 * `ignore_rule_catches`, one row for each event and kind a rule stopped from
 * raising a signal.
 *
 * A signal's `match`, and a rule's, is stored as JSON with its fields sorted
 * by name. Two signals with the same values then store the same text, even
 * when a plugin update reorders its kind's match fields, so the core can read
 * a group of signals by the text of `match`. Signals written before this
 * migration hold their fields in the order the plugin built them, so the
 * migration rewrites each one whose stored text is not sorted.
 *
 * A catch's `event_id` is a foreign key that cascades: a catch is pruned with
 * its event, and does not keep the event in the log. Its `rule_id` is not
 * one: a catch outlives its rule, and keeps a copy of the rule's text so
 * Everything can still name a deleted rule. An event is caught at most once
 * per kind, by the oldest rule of that kind that matches it, so the event and
 * the kind are the key. An event that would raise two kinds keeps both
 * catches, so neither kind is raised again once its rule is deleted.
 *
 * Three indexes on `signals` serve the reads the rules and the core's offers
 * make. SQLite uses a partial or an expression index only when the query
 * repeats its expression and its `WHERE` exactly, so each query in the
 * signal repository is written to match:
 *
 * - `signals_group` lets the core's offer read one group of signals, the
 *   signals of one kind with the same match values, newest first, without
 *   reading the rest of the kind. The id is the last column, so signals
 *   created at the same time are read in id order with no sort. A core
 *   signal has no match values and is never in a group, so the index leaves
 *   it out;
 * - `signals_open_kind` lets a new rule find the open signals of its kind
 *   without reading the resolved ones, which pile up;
 * - `signals_ignore_rule_offer` lets the core find the offers it raised for
 *   a kind without reading every signal: only offers carry `ignore_rule`.
 *
 * The rewrite runs before `signals_group` is built, so the index is built
 * once, from the sorted text.
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";

export default Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  yield* sql`
    CREATE TABLE ignore_rules (
      id BLOB PRIMARY KEY NOT NULL,
      kind TEXT NOT NULL,
      match TEXT NOT NULL CHECK (json_valid(match)),
      text TEXT NOT NULL,
      actor TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `;
  // Serves the raise path, which reads the rules of one kind oldest first,
  // and the list filtered by kind.
  yield* sql`CREATE INDEX ignore_rules_kind ON ignore_rules (kind, created_at, id)`;

  yield* sql`
    CREATE TABLE ignore_rule_catches (
      event_id INTEGER NOT NULL REFERENCES events (id) ON DELETE CASCADE,
      rule_id BLOB NOT NULL,
      kind TEXT NOT NULL,
      rule_text TEXT NOT NULL,
      at TEXT NOT NULL,
      PRIMARY KEY (event_id, kind)
    )
  `;
  // Serves the count of each rule's catches and the time of its last one.
  yield* sql`CREATE INDEX ignore_rule_catches_rule ON ignore_rule_catches (rule_id, at)`;

  const signals = yield* sql<{ readonly id: Uint8Array; readonly match: string }>`
    SELECT id, match FROM signals WHERE match <> '{}'
  `;
  for (const signal of signals) {
    const sorted = JSON.stringify(
      Object.fromEntries(
        Object.entries(JSON.parse(signal.match) as Record<string, string>).sort(([a], [b]) =>
          a < b ? -1 : 1,
        ),
      ),
    );
    if (sorted !== signal.match) {
      yield* sql`UPDATE signals SET match = ${sorted} WHERE id = ${signal.id}`;
    }
  }

  yield* sql`
    CREATE INDEX signals_group ON signals (kind, match, created_at, id) WHERE match <> '{}'
  `;
  yield* sql`CREATE INDEX signals_open_kind ON signals (kind) WHERE status = 'open'`;
  yield* sql`
    CREATE INDEX signals_ignore_rule_offer ON signals (json_extract(ignore_rule, '$.kind'))
    WHERE ignore_rule IS NOT NULL
  `;
});
