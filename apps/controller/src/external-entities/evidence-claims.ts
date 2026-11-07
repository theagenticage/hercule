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
 */
import * as Effect from "effect/Effect";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import type { EntityObservation } from "@hercule/plugin-host";
import { uuidFromString } from "../db";
import type { RecognizedClaims, RecognizedTarget } from "../plugins";
import { encodePendingTarget, isPendingTarget } from "./pending-target";
import type { NewLink } from "./claim-sql";

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
}

/** What `applyEvidenceClaims` changed. */
export interface EvidenceWrite {
  /**
   * The refs on either end of a claim that was added or removed and has a ref
   * at that end: their cards or details changed. A pending target is not a
   * ref and a claim that holds one draws nothing, so it is not listed.
   */
  readonly changedRefs: ReadonlyArray<string>;
  /** The pairs that an added `source` claim joined for the first time. */
  readonly newLinks: ReadonlyArray<NewLink>;
}

interface StoredUrlClaim {
  readonly id: number;
  readonly to_ref: string;
  readonly evidence_key: string;
}

interface StoredTextClaim {
  readonly id: number;
  readonly to_ref: string;
  readonly recognized_as: string | null;
  readonly observed_revision: string | null;
}

/**
 * Returns the target a new claim stores for a recognized thing, or undefined
 * when it should store none: the thing is the claim's own origin, or a scoped
 * target cannot be encoded.
 */
const buildStoredTarget = (fromRef: string, target: RecognizedTarget): string | undefined => {
  if (target.recognized === "ref") return target.ref === fromRef ? undefined : target.ref;
  return encodePendingTarget({
    form: "scoped",
    pluginId: target.pluginId,
    ...(target.kind === undefined ? {} : { kind: target.kind }),
    ...(target.scopeHint === undefined ? {} : { scopeHint: target.scopeHint }),
    identifier: target.identifier,
  });
};

/** Builds the writer of evidence claims. Needs the database and the question "does a pair already join". */
export const makeEvidenceClaims = (input: {
  readonly sql: SqlClient.SqlClient;
  readonly hasEffectiveLink: (a: string, b: string) => Effect.Effect<boolean, SqlError>;
}) => {
  const { sql, hasEffectiveLink } = input;

  /**
   * Compares the web addresses an observation reports with the `source`
   * claims stored for it, and writes the difference.
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
  const applyUrls = (
    connectionId: Uint8Array,
    entry: EvidenceEntry,
    revision: string | undefined,
    now: string,
    write: { readonly changed: Set<string>; readonly newLinks: Array<NewLink> },
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const { fromRef, relations } = entry;
      if (relations === undefined) return;
      const reported = [...new Set(relations.linkedUrls ?? [])];
      const stored = yield* sql<StoredUrlClaim>`
        SELECT id, to_ref, evidence_key FROM external_entity_relation_claims
        WHERE from_ref = ${fromRef} AND relation = 'linked' AND connection_id = ${connectionId}
          AND claim_type = 'source' AND evidence_key <> ''`;
      const storedKeys = new Set(stored.map((row) => row.evidence_key));
      const reportedKeys = new Set(reported);

      if (relations.complete) {
        for (const row of stored.filter((claim) => !reportedKeys.has(claim.evidence_key))) {
          yield* sql`DELETE FROM external_entity_relation_claims WHERE id = ${row.id}`;
          if (!isPendingTarget(row.to_ref)) {
            write.changed.add(fromRef);
            write.changed.add(row.to_ref);
          }
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
        const pending = isPendingTarget(toRef);
        const wasLinked = pending ? true : yield* hasEffectiveLink(fromRef, toRef);
        yield* sql`
          INSERT INTO external_entity_relation_claims
            (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
             observed_revision, state, conflict_reason, observed_at)
          VALUES (${fromRef}, 'linked', ${toRef}, 'source', ${connectionId}, NULL, ${url},
                  ${revision ?? null}, 'current', NULL, ${now})`;
        if (!pending) {
          write.changed.add(fromRef);
          write.changed.add(toRef);
          if (!wasLinked) write.newLinks.push({ fromRef, toRef });
        }
      }

      if (revision !== undefined) {
        yield* sql`
          UPDATE external_entity_relation_claims SET observed_revision = ${revision}
          WHERE from_ref = ${fromRef} AND relation = 'linked' AND connection_id = ${connectionId}
            AND claim_type = 'source' AND evidence_key <> ''
            AND observed_revision IS NOT ${revision}`;
      }
    });

  /**
   * Compares the references found in each text an observation carries with the
   * `text` claims stored for that text's `evidenceKey`, and writes the
   * difference. A key the observation does not carry is not touched. A text
   * with nothing recognized in it clears the key.
   *
   * - A text whose `revision` equals the revision its stored claims were made
   *   from is skipped: nothing changed, and the plugins that recognized it
   *   may be disabled now.
   * - A stored claim is matched by what the text said (`recognized_as`), not by
   *   its target, so a claim the resolver already rewrote to a ref keeps its id
   *   and time while its text still says the same.
   */
  const applyTexts = (
    connectionId: Uint8Array,
    entry: EvidenceEntry,
    now: string,
    write: { readonly changed: Set<string> },
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const { fromRef } = entry;
      const seen = new Set<string>();
      for (const text of entry.texts ?? []) {
        if (seen.has(text.evidenceKey)) continue;
        seen.add(text.evidenceKey);
        const stored = yield* sql<StoredTextClaim>`
          SELECT id, to_ref, recognized_as, observed_revision FROM external_entity_relation_claims
          WHERE from_ref = ${fromRef} AND relation = 'linked' AND connection_id = ${connectionId}
            AND claim_type = 'text' AND evidence_key = ${text.evidenceKey}`;
        const revision = text.revision;
        if (
          revision !== undefined &&
          stored.length > 0 &&
          stored.every((row) => row.observed_revision === revision)
        ) {
          continue;
        }

        const desired = new Set<string>();
        const recognized = entry.recognized?.texts.find(
          (candidate) => candidate.evidenceKey === text.evidenceKey,
        );
        for (const target of recognized?.targets ?? []) {
          const toRef = buildStoredTarget(fromRef, target);
          if (toRef !== undefined) desired.add(toRef);
        }
        const storedKeys = new Set(stored.map((row) => row.recognized_as ?? row.to_ref));

        for (const row of stored.filter(
          (claim) => !desired.has(claim.recognized_as ?? claim.to_ref),
        )) {
          yield* sql`DELETE FROM external_entity_relation_claims WHERE id = ${row.id}`;
          if (!isPendingTarget(row.to_ref)) {
            write.changed.add(fromRef);
            write.changed.add(row.to_ref);
          }
        }
        for (const toRef of desired) {
          const recognizedAs = toRef;
          if (storedKeys.has(recognizedAs)) continue;
          // A resolved claim of this text may already hold the same ref under
          // another wording, which the unique key refuses. The text still
          // says it, so there is nothing to add.
          yield* sql`
            INSERT OR IGNORE INTO external_entity_relation_claims
              (from_ref, relation, to_ref, claim_type, connection_id, actor, evidence_key,
               observed_revision, recognized_as, state, conflict_reason, observed_at)
            VALUES (${fromRef}, 'linked', ${toRef}, 'text', ${connectionId}, NULL, ${text.evidenceKey},
                    ${revision ?? null}, ${recognizedAs}, 'current', NULL, ${now})`;
          if (!isPendingTarget(toRef)) {
            write.changed.add(fromRef);
            write.changed.add(toRef);
          }
        }
        yield* sql`
          UPDATE external_entity_relation_claims SET observed_revision = ${revision ?? null}
          WHERE from_ref = ${fromRef} AND relation = 'linked' AND connection_id = ${connectionId}
            AND claim_type = 'text' AND evidence_key = ${text.evidenceKey}
            AND observed_revision IS NOT ${revision ?? null}`;
      }
    });

  return {
    /**
     * Writes the evidence claims of several observations from one Connection,
     * in the caller's transaction, and returns the refs they changed and the
     * pairs they joined. Each ref may appear once. `revision`, the source's
     * revision of `fromRef`, is recorded on the address claims; a text claim
     * records its own text's revision.
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
        const changed = new Set<string>();
        const newLinks: Array<NewLink> = [];
        for (const entry of args.entries) {
          yield* applyUrls(connectionId, entry, entry.observedRevision, args.now, {
            changed,
            newLinks,
          });
          yield* applyTexts(connectionId, entry, args.now, { changed });
        }
        return { changedRefs: [...changed].sort(), newLinks };
      }),
  };
};
