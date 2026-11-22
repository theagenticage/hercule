/**
 * What the gateway reads fresh for one Session Token: the session behind it
 * and the servers in that session's list. Each read goes to the database, never
 * to a cache, because every caller acts on the answer. A database error is a
 * defect here, as it is everywhere the gateway reads.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SessionActor } from "../actor";
import {
  isServable,
  mcpServerCatalogue,
  type McpServerAvailabilityView,
  type McpServerView,
} from "../mcp-servers";
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

  /**
   * Reads the servers of the session's list as the catalogue holds them now,
   * served or not, without their stored tool definitions. For a reader that
   * only judges whether a server may be used.
   */
  const readListedAvailability = (
    sessionId: string,
  ): Effect.Effect<ReadonlyArray<McpServerAvailabilityView>> =>
    Effect.flatMap(readListedServerIds(sessionId), (ids) =>
      Effect.map(Effect.orDie(catalogue.readViews(ids, "without-tools")), (views) => [
        ...views.values(),
      ]),
    );

  /** Reads the servers of the session's list as the catalogue holds them now, with their tools. */
  const readListedViews = (sessionId: string): Effect.Effect<ReadonlyArray<McpServerView>> =>
    Effect.flatMap(readListedServerIds(sessionId), (ids) =>
      Effect.map(Effect.orDie(catalogue.readViews(ids)), (views) => [...views.values()]),
    );

  /**
   * Reads the original names of the tools the server stores now. Returns an
   * empty list for a server that no longer exists.
   */
  const readStoredToolNames = (serverId: string): Effect.Effect<ReadonlyArray<string>> =>
    Effect.map(Effect.orDie(catalogue.readViews([serverId])), (views) =>
      (views.get(serverId)?.server.tools ?? []).map((tool) => tool.name),
    );

  /** Keeps the servers `tools/list` shows, and none for a session without `mcp.use`. */
  const keepServed = <View extends McpServerAvailabilityView>(
    actor: SessionActor,
    views: Effect.Effect<ReadonlyArray<View>>,
  ): Effect.Effect<ReadonlyArray<View>> =>
    holdsMcpUse(actor)
      ? Effect.map(views, (listed) => listed.filter(isServable))
      : Effect.succeed([]);

  return {
    /** Resolves a Session Token from the database. Returns none once its session has ended. */
    resolveActor: (tokenHash: string): Effect.Effect<Option.Option<SessionActor>> =>
      Effect.orDie(tokens.resolveUncached(tokenHash)),

    readListedServerIds,
    readListedAvailability,
    readStoredToolNames,

    /** Reads the servers the session is served now, with their tools: none without `mcp.use`. */
    readServed: (actor: SessionActor): Effect.Effect<ReadonlyArray<McpServerView>> =>
      keepServed(actor, readListedViews(actor.sessionId)),

    /** Reads the servers the session is served now, without their tools. */
    readServedAvailability: (
      actor: SessionActor,
    ): Effect.Effect<ReadonlyArray<McpServerAvailabilityView>> =>
      keepServed(actor, readListedAvailability(actor.sessionId)),
  };
});
