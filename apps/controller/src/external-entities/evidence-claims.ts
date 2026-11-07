/**
 * The claims a Connection makes from evidence it reports with an observation:
 * the web addresses a source says belong to a thing (`source` claims) and the
 * references found in its texts (`text` claims).
 *
 * The plugins domain recognized the addresses and texts before the write
 * (`RecognizedClaims`). This module only compares what is recognized with what
 * is stored and writes the difference, in the caller's transaction. It reads
 * no entity, fetches nothing and announces nothing.
 *
 * A claim whose thing no plugin could place yet is stored with a pending
 * target (see `pending-target.ts`) and is resolved later by the resolver loop.
 *
 * The work is bounded by the changes, not by the observations: one write reads
 * the stored claims of all its refs in one statement per claim type, compares
 * them in memory, and writes each kind of change in one statement. A poll that
 * repeats what is stored sends the same few statements for 3 refs as for 300.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityObservation } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import type { RecognizedClaims, RecognizedTarget, StoredTextRevisions } from "../plugins";
import { encodePendingTarget, isPendingTarget } from "./pending-target";
import { buildPairKey, type NewLink } from "./claim-sql";

/** What one observation reports as evidence, with what the plugins recognized in it. */
export interface EvidenceEntry {
  readonly fromRef: string;
  /** The observation's `relations`. Absent: the observation says nothing about addresses. */
  readonly relations:
    | { readonly complete: boolean; readonly linkedUrls?: ReadonlyArray<string> }
    | undefined;
  /** The observation's `texts`. An entry that is not here is left alone. */
  readonly texts: EntityObservation["texts"];
  /** Absent when nothing was recognized, as when the call came from a test or from the core itself. */
  readonly recognized: RecognizedClaims | undefined;
  /**
   * True when the thing was not yet a full record before this write. What it
   * reports now is part of what it arrived with, so no pair it joins is news
   * (see `NewLink`), however late a pending claim of it resolves.
   */
  readonly inBaseline: boolean;
}

/** What `applyEvidenceClaims` changed. */
export interface EvidenceWrite {
  /**
   * The refs on either end of a claim that was added or removed and has a ref
   * at that end: their cards or details changed. A pending target is not a
   * ref and a claim that holds one draws nothing, so it is not listed.
   */
  readonly changedRefs: ReadonlyArray<string>;
  /** The pairs that an added `source` claim joined for the first time, leaving out those of a thing's baseline. */
  readonly newLinks: ReadonlyArray<NewLink>;
}

interface StoredUrlClaim {
  readonly id: number;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly evidence_key: string;
  readonly observed_revision: string | null;
}

interface StoredTextClaim {
  readonly id: number;
  readonly from_ref: string;
  readonly to_ref: string;
  readonly evidence_key: string;
  readonly recognized_as: string | null;
  readonly observed_revision: string | null;
}

/** A claim to insert. */
interface NewClaim {
  readonly fromRef: string;
  readonly toRef: string;
  readonly evidenceKey: string;
  readonly revision: string | null;
  readonly recognizedAs: string | null;
  /** Whether the claim belongs to its thing's first full baseline (see `EvidenceEntry.inBaseline`). */
  readonly inBaseline: boolean;
}

/** The difference between what one write reports and what is stored, before anything is written. */
interface EvidencePlan {
  readonly removedClaims: Array<{
    readonly id: number;
    readonly fromRef: string;
    readonly toRef: string;
  }>;
  readonly urlClaims: Array<NewClaim>;
  readonly textClaims: Array<NewClaim>;
  /** Stored claims that stay but were made from an older revision of their source or text. */
  readonly revisionUpdates: Array<{ readonly id: number; readonly revision: string | null }>;
}

/**
 * Returns the target a new claim stores for a recognized thing, or undefined
 * when it should store none: the thing is the claim's own origin, or a scoped
 * target cannot be encoded.
 */
const buildStoredTarget = (fromRef: string, target: RecognizedTarget): string | undefined => {
  if (target.recognized === "ref") return target.ref === fromRef ? undefined : target.ref;
  return encodePendingTarget({ ...target, form: "scoped" });
};

/**
 * Compares the web addresses an observation reports with the `source`
 * claims stored for it, and adds the difference to `plan`.
 *
 * - A stored address keeps its target, id and time, whatever the plugins
 *   recognize now: a resolved claim stays resolved when the plugin is
 *   disabled or the address recognizes as scoped on every poll.
 * - A new address becomes a claim at once. Its target is the recognized ref,
 *   or a pending target when the thing needs a read or nothing recognized it.
 * - `relations.complete` removes a stored address the source left out. A
 *   failed recognition never removes one, because the stored address is
 *   matched by the address alone.
 */
const planUrls = (
  entry: EvidenceEntry & { readonly observedRevision: string | undefined },
  stored: ReadonlyArray<StoredUrlClaim>,
  plan: EvidencePlan,
): void => {
  const { fromRef, relations, observedRevision } = entry;
  if (relations === undefined) return;
  const reported = [...new Set(relations.linkedUrls ?? [])];
  const storedKeys = new Set(stored.map((row) => row.evidence_key));
  const reportedKeys = new Set(reported);

  const kept = relations.complete
    ? stored.filter((row) => reportedKeys.has(row.evidence_key))
    : stored;
  if (relations.complete) {
    for (const row of stored.filter((claim) => !reportedKeys.has(claim.evidence_key))) {
      plan.removedClaims.push({ id: row.id, fromRef, toRef: row.to_ref });
    }
  }

  const recognizedByUrl = new Map(
    (entry.recognized?.urls ?? []).map(({ url, target }) => [url, target]),
  );
  for (const url of reported.filter((address) => !storedKeys.has(address))) {
    const recognized = recognizedByUrl.get(url);
    const toRef =
      recognized === undefined
        ? encodePendingTarget({ form: "url", url })
        : buildStoredTarget(fromRef, recognized);
    // A thing recognized as the claim's own origin is no link.
    if (toRef === undefined) continue;
    plan.urlClaims.push({
      fromRef,
      toRef,
      evidenceKey: url,
      revision: observedRevision ?? null,
      recognizedAs: null,
      inBaseline: entry.inBaseline,
    });
  }

  if (observedRevision !== undefined) {
    for (const row of kept) {
      if (row.observed_revision !== observedRevision) {
        plan.revisionUpdates.push({ id: row.id, revision: observedRevision });
      }
    }
  }
};

/**
 * Compares the references found in each text an observation carries with the
 * `text` claims stored for that text's `evidenceKey`, and adds the difference
 * to `plan`. A key the observation does not carry is not touched. A text
 * with nothing recognized in it clears the key.
 *
 * - A text whose `revision` equals the revision its stored claims were made
 *   from is skipped: nothing changed, and the plugins that recognized it
 *   may be disabled now. So is a text the host did not search for the same
 *   reason (its recognized entry has no `targets`).
 * - A stored claim is matched by what the text said (`recognized_as`), not by
 *   its target, so a claim the resolver already rewrote to a ref keeps its id
 *   and time while its text still says the same.
 * - A text that recognizes nothing, with nothing stored, changes nothing, so
 *   it costs no statement. A plugin enabled later finds its references the
 *   next time the text is reported.
 */
const planTexts = (
  entry: EvidenceEntry,
  stored: ReadonlyArray<StoredTextClaim>,
  plan: EvidencePlan,
): void => {
  const { fromRef } = entry;
  const storedByKey = Arr.groupBy(stored, (row) => row.evidence_key);
  const seen = new Set<string>();
  for (const text of entry.texts ?? []) {
    if (seen.has(text.evidenceKey)) continue;
    seen.add(text.evidenceKey);
    const recognized = entry.recognized?.texts.find(
      (candidate) => candidate.evidenceKey === text.evidenceKey,
    );
    // The host did not search this text because its claims were made from the same revision.
    if (recognized !== undefined && recognized.targets === undefined) continue;
    const storedForKey = storedByKey[text.evidenceKey] ?? [];
    const revision = text.revision;
    if (
      revision !== undefined &&
      storedForKey.length > 0 &&
      storedForKey.every((row) => row.observed_revision === revision)
    ) {
      continue;
    }

    const desired = new Set<string>();
    for (const target of recognized?.targets ?? []) {
      const toRef = buildStoredTarget(fromRef, target);
      if (toRef !== undefined) desired.add(toRef);
    }
    const storedKeys = new Set(storedForKey.map((row) => row.recognized_as ?? row.to_ref));

    const removed = storedForKey.filter(
      (claim) => !desired.has(claim.recognized_as ?? claim.to_ref),
    );
    for (const row of removed) plan.removedClaims.push({ id: row.id, fromRef, toRef: row.to_ref });
    for (const toRef of desired) {
      if (storedKeys.has(toRef)) continue;
      plan.textClaims.push({
        fromRef,
        toRef,
        evidenceKey: text.evidenceKey,
        revision: revision ?? null,
        recognizedAs: toRef,
        inBaseline: entry.inBaseline,
      });
    }
    for (const row of storedForKey) {
      if (removed.includes(row) || row.observed_revision === (revision ?? null)) continue;
      plan.revisionUpdates.push({ id: row.id, revision: revision ?? null });
    }
  }
};

/** Builds the writer of evidence claims. Needs the database and the question "which of these pairs already join". */
export const makeEvidenceClaims = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly listJoinedPairs: (pairs: ReadonlyArray<NewLink>) => Effect.Effect<Set<string>, SqlError>;
}) => {
  const { sql, listJoinedPairs } = input;

  /** Reads the stored `source` address claims of `refs` from one Connection, in one statement. */
  const readStoredUrlClaims = (connectionId: Uint8Array, refs: ReadonlyArray<string>) =>
    refs.length === 0
      ? Effect.succeed([])
      : sql<StoredUrlClaim>`
          SELECT id, from_ref, to_ref, evidence_key, observed_revision
          FROM external_entity_relation_claims
          WHERE from_ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
            AND relation = 'linked' AND connection_id = ${connectionId}
            AND claim_type = 'source' AND evidence_key <> ''`;

  /** Reads the stored `text` claims of `refs` from one Connection, in one statement. */
  const readStoredTextClaims = (connectionId: Uint8Array, refs: ReadonlyArray<string>) =>
    refs.length === 0
      ? Effect.succeed([])
      : sql<StoredTextClaim>`
          SELECT id, from_ref, to_ref, evidence_key, recognized_as, observed_revision
          FROM external_entity_relation_claims
          WHERE from_ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
            AND relation = 'linked' AND connection_id = ${connectionId}
            AND claim_type = 'text'`;

  return {
    /**
     * Returns the revision that the stored `text` claims of one Connection were
     * made from, for each of `refs` and each evidence key, in one statement.
     * A key is left out when it has no claim, when one of its claims has no
     * revision, or when its claims were made from different revisions.
     */
    readStoredTextRevisions: (
      connectionId: string,
      refs: ReadonlyArray<string>,
    ): Effect.Effect<StoredTextRevisions, SqlError> =>
      Effect.map(
        sql<{
          readonly from_ref: string;
          readonly evidence_key: string;
          readonly revision: string;
        }>`
          SELECT from_ref, evidence_key, MIN(observed_revision) AS revision
          FROM external_entity_relation_claims
          WHERE from_ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
            AND relation = 'linked' AND connection_id = ${uuidFromString(connectionId)}
            AND claim_type = 'text'
          GROUP BY from_ref, evidence_key
          HAVING COUNT(*) = COUNT(observed_revision)
            AND MIN(observed_revision) = MAX(observed_revision)`,
        (rows) => {
          const byRef = new Map<string, Map<string, string>>();
          for (const row of rows) {
            const keys = byRef.get(row.from_ref) ?? new Map<string, string>();
            keys.set(row.evidence_key, row.revision);
            byRef.set(row.from_ref, keys);
          }
          return byRef;
        },
      ),

    /**
     * Writes the evidence claims of several observations from one Connection,
     * in the caller's transaction, and returns the refs they changed and the
     * pairs they joined. Each ref may appear once. `observedRevision`, the
     * source's revision of `fromRef`, is recorded on the address claims; a
     * text claim records its own text's revision.
     *
     * Reads the stored claims in two statements however many entries there
     * are, and writes each kind of change (removals, new address claims, new
     * text claims, revision updates) in one statement, or none when there is
     * nothing of that kind. All removals happen before any claim is added, so
     * whether an added address joins a pair for the first time never depends
     * on the order of the entries.
     *
     * Fails only with a database error.
     */
    applyEvidenceClaims: (args: {
      readonly connectionId: string;
      readonly entries: ReadonlyArray<
        EvidenceEntry & { readonly observedRevision: string | undefined }
      >;
      readonly now: string;
    }): Effect.Effect<EvidenceWrite, SqlError> =>
      Effect.gen(function* () {
        const connectionId = uuidFromString(args.connectionId);
        const { now } = args;
        const urlEntries = args.entries.filter((entry) => entry.relations !== undefined);
        const textEntries = args.entries.filter((entry) => (entry.texts?.length ?? 0) > 0);
        const storedUrls = Arr.groupBy(
          yield* readStoredUrlClaims(
            connectionId,
            urlEntries.map((entry) => entry.fromRef),
          ),
          (row) => row.from_ref,
        );
        const storedTexts = Arr.groupBy(
          yield* readStoredTextClaims(
            connectionId,
            textEntries.map((entry) => entry.fromRef),
          ),
          (row) => row.from_ref,
        );

        const plan: EvidencePlan = {
          removedClaims: [],
          urlClaims: [],
          textClaims: [],
          revisionUpdates: [],
        };
        for (const entry of urlEntries) {
          planUrls(entry, storedUrls[entry.fromRef] ?? [], plan);
        }
        for (const entry of textEntries) {
          planTexts(entry, storedTexts[entry.fromRef] ?? [], plan);
        }

        const changed = new Set<string>();
        const newLinks: Array<NewLink> = [];
        if (plan.removedClaims.length > 0) {
          yield* sql`
            DELETE FROM external_entity_relation_claims
            WHERE id IN (SELECT value FROM json_each(${JSON.stringify(plan.removedClaims.map((claim) => claim.id))}))`;
        }
        for (const claim of plan.removedClaims) {
          if (isPendingTarget(claim.toRef)) continue;
          changed.add(claim.fromRef);
          changed.add(claim.toRef);
        }

        // Which of the added pairs already join, read once for the whole write
        // and before any claim is added. Two entries that report each other
        // join the pair once: the first one adds it to `joined`.
        const newPairs = plan.urlClaims.filter((claim) => !isPendingTarget(claim.toRef));
        const joined = yield* listJoinedPairs(newPairs);
        for (const claim of newPairs) {
          const pairKey = buildPairKey(claim.fromRef, claim.toRef);
          const wasJoined = joined.has(pairKey);
          joined.add(pairKey);
          changed.add(claim.fromRef);
          changed.add(claim.toRef);
          if (!wasJoined && !claim.inBaseline) {
            newLinks.push({ fromRef: claim.fromRef, toRef: claim.toRef });
          }
        }
        for (const claim of plan.textClaims) {
          if (isPendingTarget(claim.toRef)) continue;
          changed.add(claim.fromRef);
          changed.add(claim.toRef);
        }

        if (plan.urlClaims.length > 0) {
          yield* sql`
            INSERT INTO external_entity_relation_claims
              (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
               observed_revision, recognized_as, state, conflict_reason, observed_at, in_baseline)
            SELECT json_extract(value, '$.fromRef'), 'linked', json_extract(value, '$.toRef'),
                   'source', ${connectionId}, NULL, json_extract(value, '$.evidenceKey'),
                   json_extract(value, '$.revision'), NULL, 'current', NULL, ${now},
                   json_extract(value, '$.inBaseline')
            FROM json_each(${JSON.stringify(plan.urlClaims)})`;
        }
        if (plan.textClaims.length > 0) {
          // A resolved claim of a text may already hold the same ref under
          // another wording, which the unique key refuses. The text still
          // says it, so there is nothing to add.
          yield* sql`
            INSERT OR IGNORE INTO external_entity_relation_claims
              (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
               observed_revision, recognized_as, state, conflict_reason, observed_at, in_baseline)
            SELECT json_extract(value, '$.fromRef'), 'linked', json_extract(value, '$.toRef'),
                   'text', ${connectionId}, NULL, json_extract(value, '$.evidenceKey'),
                   json_extract(value, '$.revision'), json_extract(value, '$.recognizedAs'),
                   'current', NULL, ${now}, json_extract(value, '$.inBaseline')
            FROM json_each(${JSON.stringify(plan.textClaims)})`;
        }
        if (plan.revisionUpdates.length > 0) {
          yield* sql`
            UPDATE external_entity_relation_claims SET observed_revision = updates.revision
            FROM (
              SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.revision') AS revision
              FROM json_each(${JSON.stringify(plan.revisionUpdates)})
            ) AS updates
            WHERE external_entity_relation_claims.id = updates.id`;
        }
        return { changedRefs: [...changed].sort(), newLinks };
      }),
  };
};
