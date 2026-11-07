/**
 * Tests the claims a Connection makes from evidence, against a migrated
 * database with an invented tracker: tickets that carry attachment links, and
 * descriptions that mention other tickets.
 *
 * - web addresses: the first sight, the match by address alone, complete and
 *   partial reads, a failed recognition
 * - texts: no text is stored, a key is replaced or left alone, a revision skips
 *   a text, a hint joins nothing
 * - person links: one claim for a pair, removal of only the person's claim
 * - what the reads show: a pending claim is no link
 */
import { describe, expect, it } from "vitest";
import { Effect } from "effect";
import * as SqlClient from "effect/sql/SqlClient";
import { uuidFromString } from "../db";
import { inTransaction, TestDatabase } from "../db/testing";
import type { RecognizedClaims, RecognizedTarget } from "../plugins";
import { encodePendingTarget } from "./pending-target";
import { relationClaimRepository } from "./relation-claims";

const AT = "2026-01-01T00:00:00.000Z";
const LATER = "2026-01-02T00:00:00.000Z";

const TICKET = "acme-tracker:ticket:T-1";
const CHANGE = "acme-forge:change:7";
const OTHER_CHANGE = "acme-forge:change:8";

const TRACKER_ACCOUNT = "0190c000-0000-7000-8000-0000000000d1";
const OTHER_TRACKER_ACCOUNT = "0190c000-0000-7000-8000-0000000000d2";

const CHANGE_URL = "https://forge.example/changes/7";
const SCOPED_URL = "https://tracker.example/acme/ticket/OPS-47";
const UNKNOWN_URL = "https://nobody.example/page";

const SCOPED_OPS_47: RecognizedTarget = {
  recognized: "scoped",
  pluginId: "acme-tracker",
  kind: "acme-tracker/ticket",
  scopeHint: "acme",
  identifier: "OPS-47",
};
const PENDING_OPS_47 = encodePendingTarget({
  form: "scoped",
  pluginId: "acme-tracker",
  kind: "acme-tracker/ticket",
  scopeHint: "acme",
  identifier: "OPS-47",
})!;

type Claims = Effect.Success<typeof relationClaimRepository>;

/** Runs `body` on a fresh migrated database with two Connections of one plugin. */
const run = <A>(
  body: (
    claims: Claims,
    sql: SqlClient.SqlClient,
  ) => Effect.Effect<A, unknown, SqlClient.SqlClient>,
) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const sql = yield* SqlClient.SqlClient;
      yield* sql`INSERT INTO plugins (id, enabled, config, created_at, updated_at)
        VALUES ('acme-tracker', 1, '{}', ${AT}, ${AT})`;
      for (const [id, account] of [
        [TRACKER_ACCOUNT, "a-1"],
        [OTHER_TRACKER_ACCOUNT, "a-2"],
      ] as const) {
        yield* sql`INSERT INTO connections (id, plugin_id, type, label, display_name, account_id,
            status, labels, config, created_at, updated_at)
          VALUES (${uuidFromString(id)}, 'acme-tracker', 'acme-tracker/tracker', ${account}, ${account},
            ${account}, 'connected', '[]', '{}', ${AT}, ${AT})`;
      }
      const claims = yield* relationClaimRepository;
      return yield* body(claims, sql);
    }).pipe(inTransaction, Effect.provide(TestDatabase), Effect.orDie),
  );

interface Report {
  readonly connectionId?: string;
  readonly fromRef?: string;
  readonly complete?: boolean;
  /** Leave out to report no `relations` at all. */
  readonly urls?: ReadonlyArray<string>;
  readonly texts?: ReadonlyArray<{ evidenceKey: string; text: string; revision?: string }>;
  readonly recognized?: RecognizedClaims;
  readonly now?: string;
}

/** Reports the evidence of one observation, the way the ingest does after recognition. */
const report = (claims: Claims, input: Report) =>
  claims.applyEvidenceClaims({
    connectionId: input.connectionId ?? TRACKER_ACCOUNT,
    entries: [
      {
        fromRef: input.fromRef ?? TICKET,
        relations:
          input.urls === undefined
            ? undefined
            : { complete: input.complete ?? true, linkedUrls: input.urls },
        texts: input.texts,
        recognized: input.recognized,
        observedRevision: undefined,
      },
    ],
    now: input.now ?? AT,
  });

const recognizedUrls = (
  ...entries: ReadonlyArray<readonly [string, RecognizedTarget | undefined]>
): RecognizedClaims => ({
  urls: entries.map(([url, target]) => (target === undefined ? { url } : { url, target })),
  texts: [],
});

const asChange: RecognizedTarget = { recognized: "ref", ref: CHANGE };
const asOtherChange: RecognizedTarget = { recognized: "ref", ref: OTHER_CHANGE };

interface StoredClaim {
  readonly id: number;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly claim_type: string;
  readonly evidence_key: string;
  readonly observed_revision: string | null;
  readonly observed_at: string;
  readonly is_pending: number;
}

const readStored = (sql: SqlClient.SqlClient, fromRef = TICKET) =>
  sql<StoredClaim>`
    SELECT id, from_ref, to_ref, claim_type, evidence_key, observed_revision, observed_at, is_pending
    FROM external_entity_relation_claims WHERE from_ref = ${fromRef} ORDER BY id`;

describe("a web address a source reports", () => {
  it("becomes a source claim at once: a ref for a thing a plugin names, a pending target for the rest", async () => {
    const stored = await run((claims, sql) =>
      Effect.gen(function* () {
        const write = yield* report(claims, {
          urls: [CHANGE_URL, SCOPED_URL, UNKNOWN_URL],
          recognized: recognizedUrls(
            [CHANGE_URL, asChange],
            [SCOPED_URL, SCOPED_OPS_47],
            [UNKNOWN_URL, undefined],
          ),
        });
        return { write, rows: yield* readStored(sql) };
      }),
    );

    expect(stored.rows.map((row) => [row.evidence_key, row.to_ref, row.claim_type])).toEqual([
      [CHANGE_URL, CHANGE, "source"],
      [SCOPED_URL, PENDING_OPS_47, "source"],
      [UNKNOWN_URL, `unresolved:url:${UNKNOWN_URL}`, "source"],
    ]);
    expect(stored.rows.map((row) => row.is_pending)).toEqual([0, 1, 1]);
    // Only the claim with a ref changes what is drawn and joins a pair.
    expect(stored.write.changedRefs).toEqual([TICKET, CHANGE].sort());
    expect(stored.write.newLinks).toEqual([{ fromRef: TICKET, toRef: CHANGE }]);
  });

  it("keeps the canonical target, id and time of a stored address whatever is recognized later", async () => {
    const { before, after } = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          urls: [SCOPED_URL],
          recognized: recognizedUrls([SCOPED_URL, SCOPED_OPS_47]),
        });
        // The resolver rewrote the target to the canonical ref.
        yield* sql`UPDATE external_entity_relation_claims SET to_ref = ${OTHER_CHANGE}`;
        const before = yield* readStored(sql);
        // Identical complete read, then the same read when the recognizer is gone.
        yield* report(claims, {
          urls: [SCOPED_URL],
          recognized: recognizedUrls([SCOPED_URL, SCOPED_OPS_47]),
          now: LATER,
        });
        yield* report(claims, { urls: [SCOPED_URL], recognized: recognizedUrls(), now: LATER });
        yield* report(claims, { urls: [SCOPED_URL], now: LATER });
        return { before, after: yield* readStored(sql) };
      }),
    );

    expect(after).toEqual(before);
    expect(after).toHaveLength(1);
    expect(after[0]).toMatchObject({ to_ref: OTHER_CHANGE, observed_at: AT, is_pending: 0 });
  });

  it("is removed by a complete read that leaves it out, and by nothing else", async () => {
    const rows = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          urls: [CHANGE_URL, SCOPED_URL],
          recognized: recognizedUrls([CHANGE_URL, asChange], [SCOPED_URL, SCOPED_OPS_47]),
        });
        // A partial read that leaves both out removes nothing.
        yield* report(claims, { urls: [], complete: false });
        // A read with no `relations` at all removes nothing either.
        yield* report(claims, {});
        // Another Connection's complete read of the same ticket removes nothing of this one's.
        yield* report(claims, { connectionId: OTHER_TRACKER_ACCOUNT, urls: [] });
        const kept = yield* readStored(sql);
        yield* report(claims, { urls: [SCOPED_URL], complete: true });
        return { kept: kept.map((row) => row.evidence_key), left: yield* readStored(sql) };
      }),
    );

    expect(rows.kept).toEqual([CHANGE_URL, SCOPED_URL]);
    expect(rows.left.map((row) => row.evidence_key)).toEqual([SCOPED_URL]);
  });

  it("is not a new link when another Connection already joined the pair", async () => {
    const second = await run((claims) =>
      Effect.gen(function* () {
        yield* report(claims, {
          urls: [CHANGE_URL],
          recognized: recognizedUrls([CHANGE_URL, asChange]),
        });
        return yield* report(claims, {
          connectionId: OTHER_TRACKER_ACCOUNT,
          urls: [CHANGE_URL],
          recognized: recognizedUrls([CHANGE_URL, asChange]),
        });
      }),
    );

    expect(second.newLinks).toEqual([]);
  });

  it("is no link while it is pending, and one once it holds a ref", async () => {
    const { pending, resolved } = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          urls: [SCOPED_URL],
          recognized: recognizedUrls([SCOPED_URL, SCOPED_OPS_47]),
        });
        const pending = {
          detail: yield* claims.readClaimsFor(TICKET),
          joined: yield* claims.hasEffectiveLink(TICKET, PENDING_OPS_47),
        };
        yield* sql`UPDATE external_entity_relation_claims SET to_ref = ${OTHER_CHANGE}`;
        const resolved = {
          detail: yield* claims.readClaimsFor(TICKET),
          joined: yield* claims.hasEffectiveLink(TICKET, OTHER_CHANGE),
        };
        return { pending, resolved };
      }),
    );

    expect(pending.detail.links).toEqual([]);
    expect(pending.joined).toBe(false);
    expect(resolved.detail.links).toMatchObject([{ fromRef: TICKET, toRef: OTHER_CHANGE }]);
    expect(resolved.joined).toBe(true);
  });
});

describe("the references in a text", () => {
  const textClaims = (
    key: string,
    ...targets: ReadonlyArray<RecognizedTarget>
  ): RecognizedClaims => ({ urls: [], texts: [{ evidenceKey: key, targets }] });

  it("stores the claims and never the text", async () => {
    const description = "Blocked until OPS-47 ships, which is quite a long time away";
    const rows = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          texts: [{ evidenceKey: "description", text: description, revision: "r1" }],
          recognized: textClaims("description", SCOPED_OPS_47),
        });
        const stored = yield* readStored(sql);
        const everything = yield* sql`SELECT * FROM external_entity_relation_claims`;
        return { stored, dump: JSON.stringify(everything) };
      }),
    );

    expect(rows.stored).toMatchObject([
      {
        claim_type: "text",
        evidence_key: "description",
        observed_revision: "r1",
        to_ref: PENDING_OPS_47,
      },
    ]);
    expect(rows.dump).not.toContain("Blocked until");
  });

  it("replaces the claims of a key on a new revision, and leaves a key it does not carry alone", async () => {
    const keys = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          texts: [
            { evidenceKey: "description", text: "x", revision: "r1" },
            { evidenceKey: "notes", text: "y", revision: "n1" },
          ],
          recognized: {
            urls: [],
            texts: [
              { evidenceKey: "description", targets: [asChange] },
              { evidenceKey: "notes", targets: [asOtherChange] },
            ],
          },
        });
        const kept = yield* readStored(sql);
        yield* report(claims, {
          texts: [{ evidenceKey: "description", text: "z", revision: "r2" }],
          recognized: textClaims("description", SCOPED_OPS_47),
          now: LATER,
        });
        return { kept, now: yield* readStored(sql) };
      }),
    );

    expect(keys.kept.map((row) => row.to_ref)).toEqual([CHANGE, OTHER_CHANGE]);
    expect(keys.now.map((row) => [row.evidence_key, row.to_ref, row.observed_revision])).toEqual([
      ["notes", OTHER_CHANGE, "n1"],
      ["description", PENDING_OPS_47, "r2"],
    ]);
  });

  it("keeps a claim that was resolved while its text still says the same", async () => {
    const { before, after } = await run((claims, sql) =>
      Effect.gen(function* () {
        const text = { evidenceKey: "description", text: "x" };
        yield* report(claims, {
          texts: [text],
          recognized: textClaims("description", SCOPED_OPS_47),
        });
        yield* sql`UPDATE external_entity_relation_claims SET to_ref = ${CHANGE}`;
        const before = yield* readStored(sql);
        // No revision, so the text is compared again each time.
        yield* report(claims, {
          texts: [text],
          recognized: textClaims("description", SCOPED_OPS_47),
          now: LATER,
        });
        return { before, after: yield* readStored(sql) };
      }),
    );

    expect(after).toEqual(before);
    expect(after[0]).toMatchObject({ to_ref: CHANGE, observed_at: AT });
  });

  it("skips a text whose revision it already holds, even when nothing is recognized now", async () => {
    const rows = await run((claims, sql) =>
      Effect.gen(function* () {
        const text = { evidenceKey: "description", text: "x", revision: "r1" };
        yield* report(claims, { texts: [text], recognized: textClaims("description", asChange) });
        yield* report(claims, { texts: [text], recognized: textClaims("description"), now: LATER });
        return yield* readStored(sql);
      }),
    );

    expect(rows.map((row) => row.to_ref)).toEqual([CHANGE]);
  });

  it("clears the claims of a key when its text names nothing, and a hint joins nothing", async () => {
    const { joinedByHint, cleared } = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          texts: [{ evidenceKey: "description", text: "x", revision: "r1" }],
          recognized: textClaims("description", asChange),
        });
        const joinedByHint = yield* claims.hasEffectiveLink(TICKET, CHANGE);
        yield* report(claims, {
          texts: [{ evidenceKey: "description", text: "", revision: "r2" }],
          recognized: textClaims("description"),
          now: LATER,
        });
        return { joinedByHint, cleared: yield* readStored(sql) };
      }),
    );

    expect(joinedByHint).toBe(false);
    expect(cleared).toEqual([]);
  });

  it("never links a thing to itself", async () => {
    const rows = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          texts: [{ evidenceKey: "description", text: "x" }],
          recognized: textClaims("description", { recognized: "ref", ref: TICKET }),
        });
        return yield* readStored(sql);
      }),
    );

    expect(rows).toEqual([]);
  });
});

describe("a person's link", () => {
  it("is one claim for a pair in either direction, and unlink removes only the person's claim", async () => {
    const result = await run((claims, sql) =>
      Effect.gen(function* () {
        yield* report(claims, {
          urls: [CHANGE_URL],
          recognized: recognizedUrls([CHANGE_URL, asChange]),
        });
        const added = yield* claims.addPersonLink({
          fromRef: TICKET,
          toRef: CHANGE,
          actor: "user",
          now: AT,
        });
        const repeated = yield* claims.addPersonLink({
          fromRef: CHANGE,
          toRef: TICKET,
          actor: "user",
          now: AT,
        });
        const unread = yield* claims.addPersonLink({
          fromRef: TICKET,
          toRef: "acme-forge:change:never-read",
          actor: "user",
          now: AT,
        });
        const removed = yield* claims.removePersonLinks({ a: CHANGE, b: TICKET });
        const again = yield* claims.removePersonLinks({ a: CHANGE, b: TICKET });
        const unreadRemoved = yield* claims.removePersonLinks({
          a: "acme-forge:change:never-read",
          b: TICKET,
        });
        return {
          added,
          repeated,
          unread,
          removed,
          again,
          unreadRemoved,
          left: yield* readStored(sql),
        };
      }),
    );

    // The source already joined the pair, so the person's claim is no new link.
    expect(result.added).toEqual({ added: true, newLink: undefined });
    expect(result.repeated.added).toBe(false);
    expect(result.unread.newLink).toEqual({
      fromRef: TICKET,
      toRef: "acme-forge:change:never-read",
    });
    expect(result.removed).toEqual({ removed: true, remaining: "source" });
    expect(result.again).toEqual({ removed: false, remaining: "source" });
    expect(result.unreadRemoved).toEqual({ removed: true });
    expect(result.left.map((row) => row.claim_type)).toEqual(["source"]);
  });

  it("reports the hint that is left", async () => {
    const result = await run((claims) =>
      Effect.gen(function* () {
        yield* report(claims, {
          texts: [{ evidenceKey: "description", text: "x" }],
          recognized: { urls: [], texts: [{ evidenceKey: "description", targets: [asChange] }] },
        });
        yield* claims.addPersonLink({ fromRef: TICKET, toRef: CHANGE, actor: "user", now: AT });
        return yield* claims.removePersonLinks({ a: TICKET, b: CHANGE });
      }),
    );

    expect(result).toEqual({ removed: true, remaining: "text" });
  });
});
