/**
 * Resolves session tokens: from the credential an agent presents to the
 * grants of its permission profile.
 *
 * One indexed lookup on the hashed token is enough, because the session row
 * holds both the profile it copied at spawn and the status that shows whether
 * a process is running to use the credential. Only the three statuses with a
 * process behind them resolve. A session that has exited is gone, and a queued
 * one - including a resumed session waiting to be placed again - has no
 * process yet, so nothing may act as either.
 *
 * The lookup runs on every call an agent makes, so its result is cached per
 * token hash. The cache can go stale in two ways:
 *
 * - `profile.update` rewrites the grants;
 * - the session moves to `exited`.
 *
 * Both events remove the affected entries from the cache as soon as they
 * happen, so no entry needs a timeout.
 *
 * A removal that happens while a lookup is running has nothing to delete yet.
 * So every removal increments a counter, and a lookup that started before the
 * counter changed does not cache its result, because the row it read may be
 * the one the removal was about.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import { GrantSchema } from "@hercule/contract";
import type { SessionActor } from "../actor";
import { uuidToString } from "../db";

interface Row {
  readonly id: Uint8Array;
  readonly permission_profile_id: Uint8Array;
  readonly grants: string;
}

const decodeGrants = Schema.decodeUnknownSync(Schema.fromJsonString(Schema.Array(GrantSchema)));

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;

  const held = new Map<string, SessionActor>();

  /** How many times cache entries have been removed. See the top of this file. */
  let dropped = 0;

  const dropHeldActors = (holds: (actor: SessionActor) => boolean): void => {
    dropped += 1;
    for (const [hash, actor] of held) if (holds(actor)) held.delete(hash);
  };

  return {
    /**
     * Returns the session actor for a token hash, or `None` if no running
     * session has that token. A profile row whose grants do not decode is a
     * defect, not an authentication failure: `profile.update` wrote the grants
     * with the same schema, so a decode failure means the schema changed under
     * a stored row, not that the caller did something wrong.
     */
    resolve: (tokenHash: string): Effect.Effect<Option.Option<SessionActor>, SqlError> =>
      Effect.gen(function* () {
        const cached = held.get(tokenHash);
        if (cached !== undefined) return Option.some(cached);
        const before = dropped;
        const rows = yield* sql<Row>`
          SELECT s.id, s.permission_profile_id, p.grants
          FROM sessions s
          JOIN permission_profiles p ON p.id = s.permission_profile_id
          WHERE s.token_hash = ${tokenHash} AND s.status IN ('starting', 'idle', 'busy')
        `;
        const row = rows[0];
        if (row === undefined) return Option.none();
        const actor: SessionActor = {
          _tag: "session",
          sessionId: uuidToString(row.id),
          profileId: uuidToString(row.permission_profile_id),
          grants: decodeGrants(row.grants),
        };
        if (dropped === before) held.set(tokenHash, actor);
        return Option.some(actor);
      }),

    /** Removes the cached actors of these sessions, because they have ended. */
    forgetSessions: (sessionIds: ReadonlyArray<string>): void => {
      if (sessionIds.length === 0) return;
      const ended = new Set(sessionIds);
      dropHeldActors((actor) => ended.has(actor.sessionId));
    },

    /** Removes the cached actors of every session on this profile, because its grants changed. */
    forgetProfile: (profileId: string): void => {
      dropHeldActors((actor) => actor.profileId === profileId);
    },
  };
});

/** The session-token resolver: maps a token hash to a session actor, with a cache. */
export class SessionTokens extends Context.Service<SessionTokens, Effect.Success<typeof make>>()(
  "hercule/controller/permissions/SessionTokens",
) {}

export const SessionTokensLayer: Layer.Layer<SessionTokens, never, SqlClient.SqlClient> =
  Layer.effect(SessionTokens)(make);
