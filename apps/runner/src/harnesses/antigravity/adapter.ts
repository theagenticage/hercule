/**
 * The Antigravity adapter: probes the account, signs in, installs `agy`,
 * deletes the files of a conversation, and hosts sessions. One `agy` process
 * serves each session (`session.ts`); this file keeps them by Hercule session
 * id and publishes their events on one stream.
 */
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as PubSub from "effect/PubSub";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import type { HarnessEvent } from "@hercule/protocol";
import {
  buildAdapterFailed,
  buildAnswerNotDelivered,
  buildSessionAlreadyRunning,
  buildSessionNotRunning,
} from "../adapter-error-builders";
import type { HarnessAdapter } from "../index";
import { buildFailedProbe } from "../probe";
import { runProcess, spawnAgy } from "../process";
import { ANTIGRAVITY_NAME, buildLoginCommand, type AgySeam } from "./agy";
import { makeHarnessHomeLeases } from "../harness-home-leases";
import { deleteSessionFiles } from "./harness-home";
import { makeAntigravityInstall } from "./install";
import { makeProbe } from "./probe";
import { startAgySession, type AgySession } from "./session";

/** The harness id: the plugin's id, then the harness's own id in it. */
export const ANTIGRAVITY = "antigravity/antigravity";

const ANTIGRAVITY_BINARY = "agy";

/**
 * Builds the Antigravity adapter on `seam`. Tests pass a fake `agy` process
 * and a fake command runner.
 */
export const makeAntigravityAdapter = (seam: AgySeam): HarnessAdapter => {
  const probe = makeProbe(seam);
  // Sessions and probes hold a read lease on their Harness Home, a sign-in the
  // exclusive one, so a sign-in never rewrites the login under a running `agy`.
  const leases = makeHarnessHomeLeases();
  // Creating an unbounded PubSub only allocates, so it is safe to run here and
  // keeps `findAdapter` a synchronous lookup.
  const published = Effect.runSync(PubSub.unbounded<HarnessEvent>());
  /** A hosted session with its own scope, whose closing stops its process. */
  interface Hosted {
    readonly session: AgySession;
    readonly scope: Scope.Closeable;
  }
  /** The sessions this adapter hosts. A session that is still starting holds its id with `"starting"`. */
  const hosted = new Map<string, Hosted | "starting">();

  const emit = (events: ReadonlyArray<HarnessEvent>): void => {
    for (const event of events) PubSub.publishUnsafe(published, event);
  };

  /** Forgets a session that has exited and closes its scope. Leaves a newer session of the same id alone. */
  const release = (sessionId: string, entry: Hosted) =>
    Effect.suspend(() => {
      if (hosted.get(sessionId) === entry) hosted.delete(sessionId);
      return Scope.close(entry.scope, Exit.void);
    });

  const readHosted = (sessionId: string): Hosted | undefined => {
    const entry = hosted.get(sessionId);
    return entry === "starting" ? undefined : entry;
  };

  return {
    harnessId: ANTIGRAVITY,
    harnessName: ANTIGRAVITY_NAME,
    binaryName: ANTIGRAVITY_BINARY,
    mapsMcpServers: true,

    events: Stream.fromPubSub(published),
    usageReports: Stream.empty,

    // The probe ignores `options.readUsage`: `agy` has no usage read.
    probe: (ctx) => {
      const binary = ctx.binary;
      if (binary === undefined) {
        return Effect.succeed(buildFailedProbe(null, `no ${ANTIGRAVITY_BINARY} on this machine`));
      }
      return Effect.suspend(() => {
        const lease = leases.acquireRead(ctx.home, "probe");
        if (!lease.acquired) return Effect.succeed(buildFailedProbe(null, lease.message));
        return probe(ctx, binary).pipe(Effect.ensuring(Effect.sync(lease.release)));
      });
    },

    startSession: (sessionId, spec, ctx) =>
      Effect.gen(function* () {
        // The id stays held until the session has exited, so a second `agy`
        // never serves the same conversation.
        if (hosted.has(sessionId)) return yield* Effect.fail(buildSessionAlreadyRunning());
        // Taken before the session reads the account's login, so a sign-in that
        // is in progress is never read half written.
        const lease = leases.acquireRead(ctx.home, "session");
        if (!lease.acquired) return yield* Effect.fail(buildAdapterFailed(lease.message));
        hosted.set(sessionId, "starting");
        // The session's own scope: closing it stops its process, which happens when it exits or fails to start.
        const scope = Scope.makeUnsafe();
        // Added first, so it runs last: the lease ends after the process is gone.
        yield* Scope.addFinalizer(scope, Effect.sync(lease.release));
        const session = yield* startAgySession(seam, sessionId, spec, ctx, emit).pipe(
          Scope.provide(scope),
          // Also on interruption: an interrupted start must not hold the id for good.
          Effect.onError(() =>
            Effect.suspend(() => {
              hosted.delete(sessionId);
              return Scope.close(scope, Exit.void);
            }),
          ),
        );
        const entry = { session, scope };
        hosted.set(sessionId, entry);
        yield* Effect.forkDetach(Effect.andThen(session.exited, release(sessionId, entry)));
        return session.binding;
      }),
    sendInput: (sessionId, input) =>
      Effect.suspend(() => {
        const entry = readHosted(sessionId);
        return entry === undefined
          ? Effect.fail(buildSessionNotRunning())
          : entry.session.send(input);
      }),
    // `agy` reports no subagents, so an interrupt of one has nothing to stop.
    interrupt: (sessionId, subagentId) =>
      Effect.suspend(() => {
        const entry = readHosted(sessionId);
        return entry === undefined || subagentId !== undefined
          ? Effect.void
          : entry.session.interrupt;
      }),
    respondToApprovalRequest: (sessionId, requestId, decision) =>
      Effect.suspend(
        () => readHosted(sessionId)?.session.decide(requestId, decision) ?? Effect.void,
      ),
    // An answer never starts a turn, so the model selection that comes with it is not used.
    respondToQuestion: (sessionId, requestId, answers) =>
      Effect.suspend(() => {
        const entry = readHosted(sessionId);
        return entry === undefined
          ? Effect.fail(buildAnswerNotDelivered("This session is not running on this runner."))
          : entry.session.answer(requestId, answers);
      }),
    // The entry goes as soon as the exit is complete, so the same id can start again right after.
    stopSession: (sessionId, reason) =>
      Effect.suspend(() => {
        const entry = readHosted(sessionId);
        return entry === undefined
          ? Effect.void
          : Effect.andThen(entry.session.stop(reason), release(sessionId, entry));
      }),
    listSessions: Effect.sync(() =>
      [...hosted.values()].flatMap((entry) =>
        entry === "starting" ? [] : [entry.session.binding],
      ),
    ),

    deleteSessionFiles,

    generateText: () =>
      Effect.fail(
        `${ANTIGRAVITY_NAME} runs no text generations. Pick another model for it in Settings.`,
      ),

    login: (ctx, binary, method) =>
      method === "sign-in" ? buildLoginCommand(ctx, binary) : undefined,
    acquireLoginLease: (ctx) => leases.acquireExclusive(ctx.home),

    install: makeAntigravityInstall(seam.run),
  };
};

export const antigravity: HarnessAdapter = makeAntigravityAdapter({
  spawn: spawnAgy,
  run: runProcess,
});
