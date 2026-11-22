/**
 * What the gateway keeps for each Session Token, and keeps in step with the
 * database: its MCP sessions, its open streams, the calls running for it, and
 * the names it was sent. State lives in memory only. A controller restart
 * drops it, and a harness that names an unknown MCP session gets 404 and opens
 * a new one.
 *
 * The state also records that a client of the token has named an MCP session
 * the token does not keep, and marks each MCP session opened after that. A
 * client that lost its session may hold tool names from before, and it may
 * list the tools before it resends its call (pi does). Once it has listed, the
 * names the token was sent no longer prove that the client's name still means
 * the tool the client chose, so the first call of such a session is refused
 * once (`decideCall` in `call-policy.ts`).
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
import * as Schedule from "effect/Schedule";
import * as Semaphore from "effect/Semaphore";
import * as Stream from "effect/Stream";
import { absorbFailures, forkAndAbsorbFailures } from "../absorbing";
import type { SessionActor } from "../actor";
import { PROFILE_GRANTS_TOPIC, RecordChanges } from "../db";
import { McpServerCalls } from "../mcp-servers";
import { PromotionState } from "../promotion";
import { makeFreshReads } from "./reads";
import type { SeenWarning } from "./refusals";
import { fingerprintServed } from "./served";
import type { OpenStream } from "./streams";
import { makeNameLedger, type NameLedger } from "./tool-names";

/** How often the sweep forgets the Session Tokens that ended. */
const SWEEP_INTERVAL = Duration.minutes(1);

/** The most MCP sessions one Session Token keeps. A harness that never sends DELETE loses its oldest. */
const MAX_MCP_SESSIONS_PER_TOKEN = 16;

/**
 * The most `subscriptions/listen` streams one Session Token keeps open. Claude
 * Code opens one, and a few more when subagents connect on their own. Each open
 * stream holds a response and a queue, and costs a read on every server change.
 */
export const MAX_LISTEN_STREAMS_PER_TOKEN = 8;

/**
 * The most `tools/call` requests one Session Token runs at once. A harness
 * runs the calls of one turn side by side, and subagents add a few more. An
 * agent with a shell can send calls directly, and each one that runs holds an
 * upstream request on the user's credential for up to a minute.
 */
export const MAX_RUNNING_CALLS_PER_TOKEN = 32;

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
  /**
   * The `tools/call` requests running now, each with its JSON-RPC id as JSON
   * text, so `notifications/cancelled` can stop the ones it names. Keyed by the
   * running call, because two calls can share an id.
   */
  readonly calls: Map<Fiber.Fiber<unknown, unknown>, string>;
  /**
   * Whether the client of this session may hold tool names from before: the
   * token had already seen a request name an MCP session it did not keep when
   * this session opened. The first `tools/call` of the session clears it,
   * whether that call is refused or not.
   */
  mayHoldNamesFromBefore: boolean;
}

/** What the gateway remembers about the warnings it wrote to the Thread of one Session Token. */
export interface WarningState {
  /** When the Thread was last told about each refusal. */
  readonly seen: Map<string, SeenWarning>;
  /** Serializes the claim of a warning and its write, so a burst of refusals writes one line. */
  readonly writing: Semaphore.Semaphore;
}

/** What the gateway keeps for one Session Token. */
export interface TokenState {
  readonly tokenHash: string;
  readonly sessionId: string;
  readonly mcpSessions: Map<string, McpSession>;
  /**
   * Whether any request of this token has named an MCP session the token does
   * not keep. That happens after a controller restart, and after the gateway
   * dropped a session itself. Never cleared while the token lives, so every
   * MCP session opened later is marked `mayHoldNamesFromBefore`.
   */
  sawUnknownMcpSession: boolean;
  readonly streams: Set<OpenStream>;
  /** Every `tools/call` running for the token, of either era, so the end of the token can stop them. */
  readonly runningCalls: Set<Fiber.Fiber<unknown, unknown>>;
  /** The names `tools/list` sent to this token. A call is accepted only under one of them. */
  readonly names: NameLedger;
  /** Serializes the admission of streams, so a legacy GET stream replaces its predecessor once. */
  readonly admission: Semaphore.Semaphore;
  readonly warnings: WarningState;
}

/** Tells every open stream of the token to list the tools again. */
export const notifyListChanged = (state: TokenState): Effect.Effect<void> =>
  Effect.forEach([...state.streams], (stream) => stream.notifyListChanged, { discard: true });

/** Stops the calls of the MCP session that have this JSON-RPC id, if any is running. */
export const cancelCall = (
  session: McpSession | undefined,
  requestId: unknown,
): Effect.Effect<void> => {
  const key = JSON.stringify(requestId);
  return Effect.forEach(
    [...(session?.calls ?? [])].filter(([, runningKey]) => runningKey === key),
    ([running]) => Fiber.interrupt(running),
    { discard: true },
  );
};

/** Returns whether the token may open one more `subscriptions/listen` stream. The GET streams of its MCP sessions are not counted. */
export const hasRoomForListenStream = (state: TokenState): boolean =>
  [...state.streams].filter((stream) => stream.mcpSessionId === undefined).length <
  MAX_LISTEN_STREAMS_PER_TOKEN;

/** Builds the gateway's per-token state and the operations on it. */
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
      sawUnknownMcpSession: false,
      streams: new Set(),
      runningCalls: new Set(),
      names: makeNameLedger(),
      admission: Semaphore.makeUnsafe(1),
      warnings: { seen: new Map(), writing: Semaphore.makeUnsafe(1) },
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

  /**
   * Removes an MCP session from its token at once, and returns the effect
   * that closes its streams and stops its running calls. The caller runs that
   * effect after it has done what must happen in the same step as the removal.
   * Returns an effect that does nothing for a session the token does not keep.
   */
  const removeMcpSession = (state: TokenState, mcpSessionId: string): Effect.Effect<void> => {
    const session = state.mcpSessions.get(mcpSessionId);
    if (session === undefined) return Effect.void;
    state.mcpSessions.delete(mcpSessionId);
    return Effect.andThen(
      endStreams(state, mcpSessionId),
      Effect.forEach([...session.calls.keys()], (call) => Fiber.interrupt(call), {
        discard: true,
      }),
    );
  };

  /** Ends one MCP session: its streams close and its running calls stop. */
  const endMcpSession = (state: TokenState, mcpSessionId: string): Effect.Effect<void> =>
    Effect.suspend(() => removeMcpSession(state, mcpSessionId));

  /**
   * Opens an MCP session at `revision`, marked `mayHoldNamesFromBefore` when
   * the token has seen an unknown MCP session id. A token that already keeps 16
   * loses its oldest. The oldest leaves and the new session joins in one synchronous
   * step, so two `initialize` requests that arrive together never both find
   * room. The oldest session's streams and calls end after that.
   */
  const openMcpSession = (state: TokenState, revision: string): Effect.Effect<McpSession> =>
    Effect.suspend(() => {
      const [oldest] = state.mcpSessions.keys();
      const ending =
        state.mcpSessions.size >= MAX_MCP_SESSIONS_PER_TOKEN && oldest !== undefined
          ? removeMcpSession(state, oldest)
          : Effect.void;
      const session: McpSession = {
        id: crypto.randomUUID(),
        revision,
        calls: new Map(),
        mayHoldNamesFromBefore: state.sawUnknownMcpSession,
      };
      state.mcpSessions.set(session.id, session);
      return Effect.as(ending, session);
    });

  /**
   * Runs a `tools/call` as a fiber of the token and waits for its exit. While
   * it runs, `notifications/cancelled`, the end of its MCP session and the end
   * of the token can interrupt it. Returns `none`, and runs nothing, when the
   * token already runs `MAX_RUNNING_CALLS_PER_TOKEN` calls.
   */
  const runCall = <A>(
    state: TokenState,
    session: McpSession | undefined,
    requestId: unknown,
    call: Effect.Effect<A>,
  ): Effect.Effect<Option.Option<Exit.Exit<A>>> =>
    Effect.gen(function* () {
      if (state.runningCalls.size >= MAX_RUNNING_CALLS_PER_TOKEN) return Option.none();
      const running = yield* Effect.forkChild(call);
      session?.calls.set(running, JSON.stringify(requestId));
      state.runningCalls.add(running);
      return yield* Fiber.await(running).pipe(
        Effect.map(Option.some),
        Effect.ensuring(
          Effect.sync(() => {
            session?.calls.delete(running);
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
            const roomLeft = stream.mcpSessionId !== undefined || hasRoomForListenStream(state);
            if (!alive || !sessionAlive || !roomLeft) return undefined;
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
  const buildStreamHooks = (state: TokenState) => ({
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

  /**
   * Forgets a Session Token that no longer resolves: ends its streams at once,
   * then stops its calls and closes its upstream sessions in the background,
   * in that order, so no call is still using a session when it closes. An
   * upstream server that answers slowly holds up only that background work,
   * never the follower of changes.
   */
  const forgetToken = (state: TokenState): Effect.Effect<void> =>
    Effect.gen(function* () {
      states.delete(state.tokenHash);
      yield* endStreams(state);
      state.mcpSessions.clear();
      const calls = [...state.runningCalls];
      yield* forkAndAbsorbFailures(
        "Closing the upstream MCP sessions of a token that ended failed",
        Effect.andThen(
          Effect.forEach(calls, (call) => Fiber.interrupt(call), { discard: true }),
          catalogue.closeUpstreamSessionsExcept(state.tokenHash, new Set()),
        ),
      );
    });

  /**
   * Brings one token in step with the database. A token that no longer
   * resolves is forgotten. Otherwise:
   *
   * - each open stream that was last told about another tool list gets
   *   `list_changed`. Each stream is judged against what it was told itself,
   *   so a `tools/list` that one client made never hides the change from
   *   another. A token with no stream needs no comparison, so its tool lists
   *   are not read;
   * - the upstream sessions of the servers the session is not served any
   *   more are closed in the background.
   */
  const reconcileToken = (state: TokenState): Effect.Effect<void> =>
    Effect.gen(function* () {
      const actor = yield* reads.resolveActor(state.tokenHash);
      if (Option.isNone(actor)) return yield* forgetToken(state);
      let servedServerIds: ReadonlyArray<string>;
      if (state.streams.size > 0) {
        const served = yield* reads.readServed(actor.value);
        servedServerIds = served.map(({ server }) => server.id);
        const fingerprint = fingerprintServed(served, actor.value, state.names);
        yield* Effect.forEach(
          [...state.streams].filter((stream) => stream.told !== fingerprint),
          (stream) => {
            stream.told = fingerprint;
            return stream.notifyListChanged;
          },
          { discard: true },
        );
      } else {
        const served = yield* reads.readServedAvailability(actor.value);
        servedServerIds = served.map(({ server }) => server.id);
      }
      yield* forkAndAbsorbFailures(
        "Closing the upstream MCP sessions of servers a session is not served any more failed",
        catalogue.closeUpstreamSessionsExcept(state.tokenHash, new Set(servedServerIds)),
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
    const subscription = yield* changes.subscribe(["session", "mcpServer", PROFILE_GRANTS_TOPIC]);
    while (true) {
      const batch = yield* subscription.takePending;
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
    buildStreamHooks,

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
