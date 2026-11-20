/**
 * What the gateway reads fresh for one Session Token: the session behind it
 * and the servers in that session's list. Each read goes to the database, never
 * to a cache, because every caller acts on the answer. A database error is a
 * defect here, as it is everywhere the gateway reads.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SessionActor } from "../actor";
import { isServable, mcpServerCatalogue, type McpServerView } from "../mcp-servers";
import { SessionTokens } from "../permissions";
import { sessionRepository } from "../sessions";
import { holdsMcpUse } from "./served";

/** Builds the fresh database reads the gateway makes for a Session Token and its session. */
export const makeFreshReads = Effect.gen(function* () {
  const tokens = yield* SessionTokens;
  const sessions = yield* sessionRepository;
  const catalogue = yield* mcpServerCatalogue;

  /** Reads the ids of the servers in the session's own list. */
  const readListedServerIds = (sessionId: string): Effect.Effect<ReadonlyArray<string>> =>
    Effect.orDie(sessions.readMcpServerIds(sessionId));

  /** Reads the servers of the session's list as the catalogue holds them now, served or not. */
  const readListedViews = (sessionId: string): Effect.Effect<ReadonlyArray<McpServerView>> =>
    Effect.flatMap(readListedServerIds(sessionId), (ids) =>
      Effect.map(Effect.orDie(catalogue.readViews(ids)), (views) => [...views.values()]),
    );

  return {
    /** Resolves a Session Token from the database. Returns none once its session has ended. */
    resolveActor: (tokenHash: string): Effect.Effect<Option.Option<SessionActor>> =>
      Effect.orDie(tokens.resolveUncached(tokenHash)),

    readListedServerIds,
    readListedViews,

    /** Reads the servers the session is served now: none without `mcp.use`. */
    readServed: (actor: SessionActor): Effect.Effect<ReadonlyArray<McpServerView>> =>
      holdsMcpUse(actor)
        ? Effect.map(readListedViews(actor.sessionId), (views) => views.filter(isServable))
        : Effect.succeed([]),
  };
});
