/**
 * What the gateway reads fresh for one Session Token: the session behind it
 * and the servers in that session's list. Each read goes to the database, never
 * to a cache, because every caller acts on the answer. A database error is a
 * defect here, as it is everywhere the gateway reads.
 */
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import type { SessionActor } from "../actor";
import { McpServerCalls, type ServedMcpServer } from "../mcp-servers";
import { SessionTokens } from "../permissions";
import { sessionRepository } from "../sessions";
import { selectServed } from "./served";

/** Builds the fresh database reads the gateway makes for a Session Token and its session. */
export const makeFreshReads = Effect.gen(function* () {
  const tokens = yield* SessionTokens;
  const sessions = yield* sessionRepository;
  const catalogue = yield* McpServerCalls;

  const readListedServers = (sessionId: string): Effect.Effect<ReadonlyArray<ServedMcpServer>> =>
    Effect.orDie(
      Effect.flatMap(sessions.readMcpServers(sessionId), (listed) =>
        catalogue.readServedServers(listed.map((entry) => entry.mcpServerId)),
      ),
    );

  return {
    /** Resolves a Session Token from the database. Returns none once its session has ended. */
    resolveActor: (tokenHash: string): Effect.Effect<Option.Option<SessionActor>> =>
      Effect.orDie(tokens.resolveUncached(tokenHash)),

    /** Reads the ids of the servers in the session's own list. */
    readListedServerIds: (sessionId: string): Effect.Effect<ReadonlyArray<string>> =>
      Effect.map(Effect.orDie(sessions.readMcpServers(sessionId)), (listed) =>
        listed.map((entry) => entry.mcpServerId),
      ),

    /** Reads the session's list of servers as the catalogue holds them now, served or not. */
    readListedServers,

    /** Reads the servers the session is served now. */
    readServed: (actor: SessionActor): Effect.Effect<ReadonlyArray<ServedMcpServer>> =>
      Effect.map(readListedServers(actor.sessionId), (records) => selectServed(records, actor)),
  };
});
