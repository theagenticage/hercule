/**
 * The first operation of the claims module: writes the claims that a batch of
 * observations from one Connection reports, as a difference against the
 * claims stored.
 *
 * An observation reports four kinds of claim, and each has its own rule for
 * what replaces what:
 *
 * - Parents and peers (`relations.partOf`, `relations.linked`) are `source`
 *   claims matched by (relation, target). A complete read removes the ones it
 *   leaves out. A new `part-of` claim that would close a loop is stored as
 *   `conflicted`.
 * - Web addresses (`relations.linkedUrls`) are `source` claims matched by the
 *   address, whatever their target. A stored address keeps its target.
 * - Texts (`texts`) are `text` claims matched by what the text said
 *   (`recognized_as`). A text replaces all the claims of its evidence key.
 *
 * The plugins recognized the addresses and texts before the write (see
 * `RecognizedEvidence`). This module reads no entity, fetches nothing and
 * announces nothing. It joins the caller's transaction.
 *
 * The work is bounded by the changes, not by the observations: one write reads
 * the stored claims of all its refs in one statement per kind of claim,
 * compares them in memory, and writes each kind of change in one statement. A
 * poll that repeats what is stored sends the same few statements for 3 refs as
 * for 300.
 */
import * as Arr from "effect/Array";
import * as Effect from "effect/Effect";
import type * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityConflict } from "@hercule/contract";
import type { EntityObservation } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import type { RecognizedTarget } from "../plugins";
import { findNewLinks, type AddedLink, type ClaimChanges } from "./claim-changes";
import type { makeClaimGraph, Relation } from "./claim-graph";
import { encodePendingTarget, isPendingTarget } from "./pending-target";

/** What the active plugins made of the addresses and texts that one observation reports. */
export interface RecognizedEvidence {
  /** The thing each address was recognized as. An address that is not here was recognized by no plugin. */
  readonly urlTargets: ReadonlyMap<string, RecognizedTarget>;
  /**
   * Every thing each text names, each once, by the text's `evidenceKey`. A text
   * whose stored claims were made from the same `revision` is marked
   * `"unchanged"` and was not searched: its claims stay as they are. A text
   * that is not here was searched and names nothing.
   */
  readonly textTargets: ReadonlyMap<string, ReadonlyArray<RecognizedTarget> | "unchanged">;
}

/** What one observation reports as claims, with what the plugins recognized in it. */
export interface ObservedClaims {
  readonly fromRef: string;
  /** The observation's `relations`. Absent: the observation says nothing about parents, peers or addresses. */
  readonly relations: EntityObservation["relations"];
  /** The observation's `texts`. A key that is not here is left alone. */
  readonly texts: EntityObservation["texts"];
  /** Absent when nothing was recognized, as when the core itself stores a read. */
  readonly recognized: RecognizedEvidence | undefined;
  /** The source's revision of `fromRef`. Recorded on the address and relation claims. */
  readonly observedRevision: string | undefined;
  /**
   * True when the thing was not yet a full record before this write. What it
   * reports now is part of what it arrived with, so no pair it joins is news,
   * however late a pending claim of it resolves.
   */
  readonly inBaseline: boolean;
}

/** The reason stored with a claim that was refused because it closes a loop. */
const LOOP_REASON = "Part of this would make a loop: the parent is already part of this thing.";
const SELF_REASON = "A thing cannot be part of itself.";

/**
 * A stored `source` claim of the Connection. One with an empty `evidence_key`
 * is a parent or a peer the source reported. One with a key is a web address,
 * and the key is the address.
 */
interface StoredSourceClaim {
  readonly id: number;
  readonly from_ref: string;
  readonly relation: Relation;
  readonly to_ref: string;
  readonly state: "current" | "conflicted";
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

/** The difference between the parents and peers one observation reports and what is stored. */
interface RelationPlan {
  readonly entry: ObservedClaims;
  readonly stored: ReadonlyArray<StoredSourceClaim>;
  readonly removed: ReadonlyArray<StoredSourceClaim>;
  readonly added: ReadonlyArray<{ readonly relation: Relation; readonly toRef: string }>;
}

/** A claim of an address or a text to insert. */
interface NewEvidenceClaim {
  readonly fromRef: string;
  readonly toRef: string;
  readonly evidenceKey: string;
  readonly revision: string | null;
  readonly recognizedAs: string | null;
  /** Whether the claim belongs to its thing's first full record (see `ObservedClaims.inBaseline`). */
  readonly inBaseline: boolean;
}

/** The difference between the addresses and texts a write reports and what is stored. */
interface EvidencePlan {
  readonly removedClaims: Array<{
    readonly id: number;
    readonly fromRef: string;
    readonly toRef: string;
  }>;
  readonly urlClaims: Array<NewEvidenceClaim>;
  readonly textClaims: Array<NewEvidenceClaim>;
  /** Stored claims that stay but were made from an older revision of their source or text. */
  readonly revisionUpdates: Array<{ readonly id: number; readonly revision: string | null }>;
}

const buildClaimKey = (relation: string, toRef: string) => `${relation}\u0000${toRef}`;

/** Compares the parents and peers one observation reports with the `source` claims stored from its ref. */
const planRelations = (
  entry: ObservedClaims,
  relations: NonNullable<ObservedClaims["relations"]>,
  stored: ReadonlyArray<StoredSourceClaim>,
): RelationPlan => {
  const storedKeys = new Set(stored.map((row) => buildClaimKey(row.relation, row.to_ref)));
  const desired = new Map<string, { relation: Relation; toRef: string }>();
  for (const toRef of relations.partOf) {
    desired.set(buildClaimKey("part-of", toRef), { relation: "part-of", toRef });
  }
  for (const toRef of relations.linked) {
    desired.set(buildClaimKey("linked", toRef), { relation: "linked", toRef });
  }
  const removed = relations.complete
    ? stored.filter((row) => !desired.has(buildClaimKey(row.relation, row.to_ref)))
    : [];
  const added = [...desired.entries()]
    .filter(([key]) => !storedKeys.has(key))
    .map(([, claim]) => claim);
  return { entry, stored, removed, added };
};

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
  entry: ObservedClaims,
  relations: NonNullable<ObservedClaims["relations"]>,
  stored: ReadonlyArray<StoredSourceClaim>,
  plan: EvidencePlan,
): void => {
  const { fromRef, observedRevision } = entry;
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

  for (const url of reported.filter((address) => !storedKeys.has(address))) {
    const recognized = entry.recognized?.urlTargets.get(url);
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
 *   may be disabled now. So is a text the plugins did not search for the same
 *   reason (`"unchanged"` in `RecognizedEvidence`).
 * - A stored claim is matched by what the text said (`recognized_as`), not by
 *   its target, so a claim the resolver already rewrote to a ref keeps its id
 *   and time while its text still says the same.
 * - A text that recognizes nothing, with nothing stored, changes nothing, so
 *   it costs no statement. A plugin enabled later finds its references the
 *   next time the text is reported.
 */
const planTexts = (
  entry: ObservedClaims,
  stored: ReadonlyArray<StoredTextClaim>,
  plan: EvidencePlan,
): void => {
  const { fromRef } = entry;
  const storedByKey = Arr.groupBy(stored, (row) => row.evidence_key);
  const seen = new Set<string>();
  for (const text of entry.texts ?? []) {
    if (seen.has(text.evidenceKey)) continue;
    seen.add(text.evidenceKey);
    const recognized = entry.recognized?.textTargets.get(text.evidenceKey);
    if (recognized === "unchanged") continue;
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
    for (const target of recognized ?? []) {
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

/** Builds the operation that writes observed claims. Needs the database and the walks over `part-of`. */
export const makeObservedClaims = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly graph: Pick<ReturnType<typeof makeClaimGraph>, "closesLoop" | "listRefsBelow">;
}) => {
  const { sql, graph } = input;

  /** Reads the stored `source` claims of `refs` from one Connection, in one statement. */
  const readStoredSourceClaims = (connectionId: Uint8Array, refs: ReadonlyArray<string>) =>
    refs.length === 0
      ? Effect.succeed([])
      : sql<StoredSourceClaim>`
          SELECT id, from_ref, relation, to_ref, state, evidence_key, observed_revision
          FROM external_entity_relation_claims
          WHERE from_ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
            AND connection_id = ${connectionId} AND claim_type = 'source'`;

  const readStoredTextClaims = (connectionId: Uint8Array, refs: ReadonlyArray<string>) =>
    refs.length === 0
      ? Effect.succeed([])
      : sql<StoredTextClaim>`
          SELECT id, from_ref, to_ref, evidence_key, recognized_as, observed_revision
          FROM external_entity_relation_claims
          WHERE from_ref IN (SELECT value FROM json_each(${JSON.stringify(refs)}))
            AND relation = 'linked' AND connection_id = ${connectionId}
            AND claim_type = 'text'`;

  /**
   * Writes the claims that several observations from one Connection report,
   * in the caller's transaction, and returns what they changed. Each ref may
   * appear once. Fails only with a database error. The caller supplies the
   * Connection id, so a claim is stamped with who really reported it.
   *
   * - A claim already stored keeps its id and time, and nothing is written.
   * - All removals of the whole batch happen before any claim is added, and
   *   the claims are added in the order of (ref, relation, target). So a batch
   *   that turns B-is-part-of-A into A-is-part-of-B stores the new claim as
   *   current, which of two claims that close a loop together is refused never
   *   depends on the order the source listed them, and whether a claim joins
   *   a pair for the first time never depends on the order of the entries.
   * - A conflicted claim is not promoted later when the loop opens, but a
   *   complete read that no longer reports it removes it, and reporting it
   *   again checks it again.
   */
  return (args: {
    readonly connectionId: string;
    readonly entries: ReadonlyArray<ObservedClaims>;
    readonly now: string;
  }): Effect.Effect<ClaimChanges, SqlError> =>
    Effect.gen(function* () {
      const { entries, now } = args;
      const connectionId = uuidFromString(args.connectionId);
      const withRelations = entries.flatMap((entry) =>
        entry.relations === undefined ? [] : [{ entry, relations: entry.relations }],
      );
      const textEntries = entries.filter((entry) => (entry.texts?.length ?? 0) > 0);
      const relationRefs = withRelations.map(({ entry }) => entry.fromRef);
      const storedSource = yield* readStoredSourceClaims(connectionId, relationRefs);
      const storedRelations = Arr.groupBy(
        storedSource.filter((row) => row.evidence_key === ""),
        (row) => row.from_ref,
      );
      const storedUrls = Arr.groupBy(
        storedSource.filter((row) => row.evidence_key !== ""),
        (row) => row.from_ref,
      );
      const storedTexts = Arr.groupBy(
        yield* readStoredTextClaims(
          connectionId,
          textEntries.map((entry) => entry.fromRef),
        ),
        (row) => row.from_ref,
      );

      // First work out the whole difference, so that no write depends on
      // which ref was handled first.
      const relationPlans = withRelations.map(({ entry, relations }) =>
        planRelations(entry, relations, storedRelations[entry.fromRef] ?? []),
      );
      const evidence: EvidencePlan = {
        removedClaims: [],
        urlClaims: [],
        textClaims: [],
        revisionUpdates: [],
      };
      for (const { entry, relations } of withRelations) {
        planUrls(entry, relations, storedUrls[entry.fromRef] ?? [], evidence);
      }
      for (const entry of textEntries) {
        planTexts(entry, storedTexts[entry.fromRef] ?? [], evidence);
      }

      // The refs below the ones whose claims change, read before a claim is
      // removed. Nothing is read when the observations repeat what is stored.
      const refsBelowBefore = yield* graph.listRefsBelow(
        relationPlans
          .filter((plan) => plan.removed.length > 0 || plan.added.length > 0)
          .map((plan) => plan.entry.fromRef),
      );

      const removedIds = [
        ...relationPlans.flatMap((plan) => plan.removed.map((row) => row.id)),
        ...evidence.removedClaims.map((claim) => claim.id),
      ];
      if (removedIds.length > 0) {
        yield* sql`DELETE FROM external_entity_relation_claims
          WHERE id IN (SELECT value FROM json_each(${JSON.stringify(removedIds)}))`;
      }

      const relationAdditions = relationPlans
        .flatMap((plan) => plan.added.map((claim) => ({ fromRef: plan.entry.fromRef, ...claim })))
        .sort(
          (a, b) =>
            a.fromRef.localeCompare(b.fromRef) ||
            a.relation.localeCompare(b.relation) ||
            a.toRef.localeCompare(b.toRef),
        );
      const entryByRef = new Map(entries.map((entry) => [entry.fromRef, entry]));
      const urlClaimsWithRef = evidence.urlClaims.filter((claim) => !isPendingTarget(claim.toRef));
      const newLinks = yield* findNewLinks(sql, [
        ...relationAdditions
          .filter(({ relation }) => relation === "linked")
          .map(({ fromRef, toRef }): AddedLink => ({
            fromRef,
            toRef,
            inBaseline: entryByRef.get(fromRef)!.inBaseline,
          })),
        ...urlClaimsWithRef,
      ]);

      // The refs whose card or detail changed: the ref of each changed claim,
      // the far end of each `linked` claim, and both ends of an address or a
      // text claim that has a ref at that end.
      const changed = new Set<string>();
      for (const plan of relationPlans) {
        if (plan.removed.length > 0 || plan.added.length > 0) changed.add(plan.entry.fromRef);
        for (const row of plan.removed) if (row.relation === "linked") changed.add(row.to_ref);
      }
      const refusedByRef = new Map<string, Array<EntityConflict>>();
      for (const { fromRef, relation, toRef } of relationAdditions) {
        if (relation === "linked") changed.add(toRef);
        const conflictReason =
          relation !== "part-of"
            ? null
            : toRef === fromRef
              ? SELF_REASON
              : (yield* graph.closesLoop(fromRef, toRef))
                ? LOOP_REASON
                : null;
        const { observedRevision, inBaseline } = entryByRef.get(fromRef)!;
        yield* sql`
          INSERT INTO external_entity_relation_claims
            (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
             observed_revision, state, conflict_reason, observed_at, in_baseline)
          VALUES (${fromRef}, ${relation}, ${toRef}, 'source', ${connectionId}, NULL, '',
                  ${observedRevision ?? null},
                  ${conflictReason === null ? "current" : "conflicted"}, ${conflictReason}, ${now},
                  ${inBaseline ? 1 : 0})`;
        if (conflictReason !== null) {
          const refused = refusedByRef.get(fromRef) ?? [];
          refused.push({ fromRef, relation, toRef, reason: conflictReason });
          refusedByRef.set(fromRef, refused);
        }
      }

      const conflicts: Array<EntityConflict> = [];
      for (const { entry, stored, removed } of relationPlans) {
        const { fromRef, observedRevision } = entry;
        const removedHere = new Set(removed.map((row) => row.id));
        // A claim that stays keeps its id and time. Only its record of the
        // source's revision follows the source.
        if (observedRevision !== undefined) {
          for (const row of stored) {
            if (!removedHere.has(row.id) && row.observed_revision !== observedRevision) {
              evidence.revisionUpdates.push({ id: row.id, revision: observedRevision });
            }
          }
        }
        conflicts.push(
          ...stored
            .filter((row) => row.state === "conflicted" && !removedHere.has(row.id))
            .map((row) => ({
              fromRef,
              relation: row.relation,
              toRef: row.to_ref,
              reason: row.to_ref === fromRef ? SELF_REASON : LOOP_REASON,
            })),
          ...(refusedByRef.get(fromRef) ?? []),
        );
      }

      for (const claim of evidence.removedClaims) {
        if (isPendingTarget(claim.toRef)) continue;
        changed.add(claim.fromRef);
        changed.add(claim.toRef);
      }
      for (const claim of [...urlClaimsWithRef, ...evidence.textClaims]) {
        if (isPendingTarget(claim.toRef)) continue;
        changed.add(claim.fromRef);
        changed.add(claim.toRef);
      }

      if (evidence.urlClaims.length > 0) {
        yield* sql`
          INSERT INTO external_entity_relation_claims
            (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
             observed_revision, recognized_as, state, conflict_reason, observed_at, in_baseline)
          SELECT json_extract(value, '$.fromRef'), 'linked', json_extract(value, '$.toRef'),
                 'source', ${connectionId}, NULL, json_extract(value, '$.evidenceKey'),
                 json_extract(value, '$.revision'), NULL, 'current', NULL, ${now},
                 json_extract(value, '$.inBaseline')
          FROM json_each(${JSON.stringify(evidence.urlClaims)})`;
      }
      if (evidence.textClaims.length > 0) {
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
          FROM json_each(${JSON.stringify(evidence.textClaims)})`;
      }
      if (evidence.revisionUpdates.length > 0) {
        yield* sql`
          UPDATE external_entity_relation_claims SET observed_revision = updates.revision
          FROM (
            SELECT json_extract(value, '$.id') AS id, json_extract(value, '$.revision') AS revision
            FROM json_each(${JSON.stringify(evidence.revisionUpdates)})
          ) AS updates
          WHERE external_entity_relation_claims.id = updates.id`;
      }

      return {
        changedRefs: [...changed].sort(),
        refsBelowBefore,
        newLinks,
        conflicts: conflicts.sort(
          (a, b) =>
            a.fromRef.localeCompare(b.fromRef) ||
            a.relation.localeCompare(b.relation) ||
            a.toRef.localeCompare(b.toRef),
        ),
      };
    });
};
