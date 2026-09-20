/**
 * Session tokens, resolved: the enforcement path from the credential an agent
 * presents to the grants its permission profile holds.
 *
 * One indexed lookup on the hashed token answers the whole question, because
 * the session row carries both the profile it copied at spawn and the status
 * that says whether anything is running to hold the credential. The three
 * statuses that resolve are the ones with a process behind them: a session that
 * has exited is gone, and a queued one - including a resumed session waiting to
 * be placed again - has no process yet, so nothing may act as either.
 *
 * That lookup runs on every call an agent makes, so its answer is held per
 * token hash. What the cache can go stale against is the two things that are
 * not the row's own status - the grants, which `profile.update` rewrites, and
 * the session's life, which a move to `exited` ends - so both drop what they
 * invalidate the moment they happen, and nothing is held on a timer.
 *
 * A drop that lands while a lookup is in flight has nothing to delete yet, so
 * the drop is counted and a lookup that started before the count moved does not
 * write its answer: what it read may be the row the drop was about.
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

  /** How many times anything has been dropped. See the note above. */
  let dropped = 0;

  const drop = (holds: (actor: SessionActor) => boolean): void => {
    dropped += 1;
    for (const [hash, actor] of held) if (holds(actor)) held.delete(hash);
  };

  return {
    /**
     * The session behind a presented token, or `None` where no live session
     * holds it. A profile row that does not decode is a defect rather than an
     * unauthenticated answer: the grants were written by `profile.update`
     * through the same codec, so an undecodable one is a schema that moved
     * underneath a stored row, not something the caller did.
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

    /** Forgets what these sessions' tokens resolved to: they have ended. */
    forgetSessions: (sessionIds: ReadonlyArray<string>): void => {
      if (sessionIds.length === 0) return;
      const ended = new Set(sessionIds);
      drop((actor) => ended.has(actor.sessionId));
    },

    /** Forgets every session on this profile: its grants have been rewritten. */
    forgetProfile: (profileId: string): void => {
      drop((actor) => actor.profileId === profileId);
    },
  };
});

/** The session-token resolver: token hash to session actor, with its cache. */
export class SessionTokens extends Context.Service<SessionTokens, Effect.Success<typeof make>>()(
  "hercule/controller/permissions/SessionTokens",
) {}

export const SessionTokensLayer: Layer.Layer<SessionTokens, never, SqlClient.SqlClient> =
  Layer.effect(SessionTokens)(make);
