/**
 * What the gateway keeps for each Session Token, and keeps in step with the
 * database: its MCP sessions, its open streams, the calls running for it, and
 * the names it was sent. State lives in memory only. A controller restart
 * drops it, and a harness that names an unknown MCP session gets 404 and opens
 * a new one.
 *
 * This module decides nothing about a request. The wire endpoint (`service.ts`)
 * and the call policy (`call-policy.ts`) use the state through the functions
 * here.
 */
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Fiber from "effect/Fiber";
import * as Option from "effect/Option";
import * as Queue from "effect/Queue";
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { absorbFailures } from "../absorbing";
import type { SessionActor } from "../actor";
import { PROFILE_GRANTS_TOPIC, RecordChanges } from "../db";
import { McpServerCalls } from "../mcp-servers";
import { PromotionState } from "../promotion";
import { makeFreshReads } from "./reads";
import { fingerprintServed } from "./served";
import type { OpenStream } from "./streams";
import { makeNameLedger, type NameLedger } from "./tool-names";

/** How often the sweep forgets the Session Tokens that ended. */
const SWEEP_INTERVAL = Duration.minutes(1);

/** The most MCP sessions one Session Token keeps. A harness that never sends DELETE loses its oldest. */
const MAX_MCP_SESSIONS_PER_TOKEN = 16;

/** Who is calling: the Session Token the route resolved, and the session behind it. */
export interface McpCaller {
  readonly tokenHash: string;
  readonly actor: SessionActor;
}

/** One stateful MCP session, which `initialize` creates. */
export interface McpSession {
  readonly id: string;
  /** The revision `initialize` negotiated. Later requests of the session must not name another. */
  readonly revision: string;
  /** The `tools/call` requests running now, by their JSON-RPC id, so `notifications/cancelled` can stop one. */
  readonly calls: Map<string, Fiber.Fiber<unknown, unknown>>;
}

/** What the gateway keeps for one Session Token. */
export interface TokenState {
  readonly tokenHash: string;
  readonly sessionId: string;
  readonly mcpSessions: Map<string, McpSession>;
  readonly streams: Set<OpenStream>;
  /** Every `tools/call` running for the token, of either era, so the end of the token can stop them. */
  readonly runningCalls: Set<Fiber.Fiber<unknown, unknown>>;
  /** The servers a call of this token went to, so the upstream session of one that is no longer served can be closed. */
  readonly calledServerIds: Set<string>;
  /** The names `tools/list` sent to this token. A call is accepted only under one of them. */
  readonly names: NameLedger;
  /** Serializes the admission of streams, so a legacy GET stream replaces its predecessor once. */
  readonly admission: Semaphore.Semaphore;
}

/** Tells every open stream of the token to list the tools again. */
export const notifyListChanged = (state: TokenState): Effect.Effect<void> =>
  Effect.forEach([...state.streams], (stream) => stream.notifyListChanged, { discard: true });

/** Stops the call of the MCP session with this JSON-RPC id, if it is running. */
export const cancelCall = (
  session: McpSession | undefined,
  requestId: unknown,
): Effect.Effect<void> => {
  const running = session?.calls.get(JSON.stringify(requestId));
  return running === undefined ? Effect.void : Effect.asVoid(Fiber.interrupt(running));
};

export const makeTokenStates = Effect.gen(function* () {
  const reads = yield* makeFreshReads;
  const catalogue = yield* McpServerCalls;
  const changes = yield* RecordChanges;
  const promotion = yield* PromotionState;

  const states = new Map<string, TokenState>();

  /** Set once the controller is shutting down: no stream opens after that. */
  let closing = false;

  const isServing: Effect.Effect<boolean> = Effect.map(
    promotion.phase,
    (phase) => phase._tag === "Serving",
  );

  const findOrCreateState = ({ tokenHash, actor }: McpCaller): TokenState => {
    const existing = states.get(tokenHash);
    if (existing !== undefined) return existing;
    const created: TokenState = {
      tokenHash,
      sessionId: actor.sessionId,
      mcpSessions: new Map(),
      streams: new Set(),
      runningCalls: new Set(),
      calledServerIds: new Set(),
      names: makeNameLedger(),
      admission: Semaphore.makeUnsafe(1),
    };
    states.set(tokenHash, created);
    return created;
  };

  const endStreams = (state: TokenState, only?: string): Effect.Effect<void> =>
    Effect.forEach(
      [...state.streams].filter((stream) => only === undefined || stream.mcpSessionId === only),
      (stream) => stream.end,
      { discard: true },
    );

  /** Ends one MCP session: its streams close and its running calls stop. */
  const endMcpSession = (state: TokenState, mcpSessionId: string): Effect.Effect<void> =>
    Effect.gen(function* () {
      const session = state.mcpSessions.get(mcpSessionId);
      if (session === undefined) return;
      state.mcpSessions.delete(mcpSessionId);
      yield* endStreams(state, mcpSessionId);
      yield* Effect.forEach([...session.calls.values()], (call) => Fiber.interrupt(call), {
        discard: true,
      });
    });

  /** Opens an MCP session at `revision`. A token that already keeps 16 loses its oldest. */
  const openMcpSession = (state: TokenState, revision: string): Effect.Effect<McpSession> =>
    Effect.gen(function* () {
      if (state.mcpSessions.size >= MAX_MCP_SESSIONS_PER_TOKEN) {
        const [oldest] = state.mcpSessions.keys();
        if (oldest !== undefined) yield* endMcpSession(state, oldest);
      }
      const session: McpSession = { id: crypto.randomUUID(), revision, calls: new Map() };
      state.mcpSessions.set(session.id, session);
      return session;
    });

  /**
   * Runs a `tools/call` as a fiber of the token and waits for its exit. While
   * it runs, `notifications/cancelled`, the end of its MCP session and the end
   * of the token can interrupt it.
   */
  const runCall = <A>(
    state: TokenState,
    session: McpSession | undefined,
    requestId: unknown,
    call: Effect.Effect<A>,
  ): Effect.Effect<Exit.Exit<A>> =>
    Effect.gen(function* () {
      const running = yield* Effect.forkChild(call);
      const key = JSON.stringify(requestId);
      session?.calls.set(key, running);
      state.runningCalls.add(running);
      return yield* Fiber.await(running).pipe(
        Effect.ensuring(
          Effect.sync(() => {
            session?.calls.delete(key);
            state.runningCalls.delete(running);
          }),
        ),
      );
    });

  // -- Streams --------------------------------------------------------------

  /**
   * Decides whether a stream whose response body is being read may open, and
   * adds it to the token's streams when it may. Everything that can have
   * changed since the request was checked is read again here: the controller
   * serves, the token still resolves, and the MCP session still exists. A
   * stream of a stateful MCP session replaces the one that session had. One
   * admission at a time per token, so two GETs cannot both replace the old
   * stream and both stay.
   */
  const admitStream =
    (state: TokenState) =>
    (stream: OpenStream): Effect.Effect<boolean> =>
      state.admission.withPermits(1)(
        Effect.gen(function* () {
          if (!(yield* isServing)) return false;
          const actor = yield* reads.resolveActor(state.tokenHash);
          if (Option.isNone(actor)) return false;
          stream.told = fingerprintServed(
            yield* reads.readServed(actor.value),
            actor.value,
            state.names,
          );
          // Nothing waits between this check and the add, so a token that is
          // forgotten or a shutdown that starts cannot slip between them.
          const replaced = yield* Effect.sync(() => {
            const alive = !closing && states.get(state.tokenHash) === state;
            const sessionAlive =
              stream.mcpSessionId === undefined || state.mcpSessions.has(stream.mcpSessionId);
            if (!alive || !sessionAlive) return undefined;
            const old = [...state.streams].filter(
              (other) =>
                stream.mcpSessionId !== undefined && other.mcpSessionId === stream.mcpSessionId,
            );
            state.streams.add(stream);
            return old;
          });
          if (replaced === undefined) return false;
          // The phase is read after the add, not before it. A freeze that
          // starts from now on drains this stream with the others. A freeze
          // that has drained already changed the phase first, so this read
          // sees it. Read before the add, a freeze could drain in between and
          // leave this stream open for a frozen controller.
          if (!(yield* isServing)) {
            state.streams.delete(stream);
            return false;
          }
          yield* Effect.forEach(replaced, (old) => old.end, { discard: true });
          return true;
        }),
      );

  /** Returns the two hooks a stream's response body needs: admit it when it is read, release it when it ends. */
  const streamLifecycle = (state: TokenState) => ({
    admit: admitStream(state),
    release: (stream: OpenStream): Effect.Effect<void> =>
      Effect.sync(() => {
        state.streams.delete(stream);
      }),
  });

  const endAllStreams: Effect.Effect<void> = Effect.suspend(() =>
    Effect.forEach([...states.values()], (state) => endStreams(state), { discard: true }),
  );

  yield* Effect.addFinalizer(() => endAllStreams);

  // -- Keeping in step with the database ------------------------------------

  /** Forgets a Session Token that no longer resolves: ends its streams and calls, and closes its upstream sessions. */
  const forgetToken = (state: TokenState): Effect.Effect<void> =>
    Effect.gen(function* () {
      states.delete(state.tokenHash);
      yield* endStreams(state);
      yield* Effect.forEach([...state.runningCalls], (call) => Fiber.interrupt(call), {
        discard: true,
      });
      state.mcpSessions.clear();
      yield* catalogue.closeUpstreamScope(state.tokenHash);
    });

  /**
   * Brings one token in step with the database. A token that no longer
   * resolves is forgotten. Otherwise:
   *
   * - each open stream that was last told about another tool list gets
   *   `list_changed`. Each stream is judged against what it was told itself,
   *   so a `tools/list` that one client made never hides the change from
   *   another. A token with no stream needs no comparison;
   * - the upstream session of every server a call of this token went to, and
   *   that the session is not served any more, is closed.
   */
  const reconcileToken = (state: TokenState): Effect.Effect<void> =>
    Effect.gen(function* () {
      const actor = yield* reads.resolveActor(state.tokenHash);
      if (Option.isNone(actor)) return yield* forgetToken(state);
      const served = yield* reads.readServed(actor.value);
      if (state.streams.size > 0) {
        const fingerprint = fingerprintServed(served, actor.value, state.names);
        yield* Effect.forEach(
          [...state.streams].filter((stream) => stream.told !== fingerprint),
          (stream) => {
            stream.told = fingerprint;
            return stream.notifyListChanged;
          },
          { discard: true },
        );
      }
      const servedIds = new Set(served.map(({ server }) => server.id));
      yield* Effect.forEach(
        [...state.calledServerIds].filter((serverId) => !servedIds.has(serverId)),
        (serverId) => {
          state.calledServerIds.delete(serverId);
          return catalogue.closeUpstreamSession(state.tokenHash, serverId);
        },
        { discard: true },
      );
    });

  /** Forgets a token that no longer resolves, whether or not it has a stream. */
  const forgetIfEnded = (state: TokenState): Effect.Effect<void> =>
    Effect.gen(function* () {
      if (Option.isNone(yield* reads.resolveActor(state.tokenHash))) yield* forgetToken(state);
    });

  /**
   * Follows the committed changes that alter what a session is served, for the
   * life of the fiber: a session's list or end, a server's switch, status or
   * tools, and a profile's grants. Subscribes before it reads anything, so no
   * change is lost.
   */
  const followChanges = Effect.gen(function* () {
    const queue = yield* changes.subscribe(["session", "mcpServer", PROFILE_GRANTS_TOPIC]);
    while (true) {
      const batch = yield* Queue.takeAll(queue);
      // A server or a profile can be in any session's list, so those changes
      // look at every token. A session change looks at that session's own.
      const everyToken = batch.some((change) => change.topic !== "session");
      const changedSessions = new Set(batch.map((change) => change.id));
      const affected = [...states.values()].filter(
        (state) => everyToken || changedSessions.has(state.sessionId),
      );
      yield* Effect.forEach(
        affected,
        (state) =>
          absorbFailures("Following a change for the MCP Gateway failed", reconcileToken(state)),
        { discard: true },
      );
    }
  });

  /** Forgets, once a minute, every token that ended, because no change may have told the gateway. */
  const sweepEndedTokens = Effect.repeat(
    Effect.suspend(() =>
      Effect.forEach(
        [...states.values()],
        (state) => absorbFailures("Sweeping the MCP Gateway's tokens failed", forgetIfEnded(state)),
        { discard: true },
      ),
    ),
    Schedule.spaced(SWEEP_INTERVAL),
  );

  /** Ends every stream whenever the controller freezes or seals, because nothing may be sent then. */
  const endStreamsWhenNotServing = promotion.phaseChanges.pipe(
    Stream.filter((phase) => phase._tag !== "Serving"),
    Stream.runForEach(() => endAllStreams),
  );

  return {
    findOrCreateState,
    isServing,
    openMcpSession,
    endMcpSession,
    runCall,
    streamLifecycle,

    /** Refuses every new stream from now on and ends the open ones. For a controller that is stopping. */
    closeStreams: Effect.suspend(() => {
      closing = true;
      return endAllStreams;
    }),

    /**
     * Follows the changes that alter what a session is served, sweeps the
     * tokens that ended, and ends every stream when the controller freezes or
     * seals. Runs for the life of the fiber and never returns.
     */
    follow: Effect.scoped(
      Effect.all([followChanges, sweepEndedTokens, endStreamsWhenNotServing], {
        concurrency: "unbounded",
        discard: true,
      }),
    ) as Effect.Effect<never, never, never>,
  };
});
