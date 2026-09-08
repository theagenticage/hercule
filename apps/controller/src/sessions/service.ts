/**
 * Sessions as the API sees them, and the one place the fleet's session traffic
 * is turned into rows.
 *
 * Only a Thread can be spawned in this build, and only by the user: every value
 * comes from their `thread.*` settings plus this call's overrides, so any other
 * actor reaching those defaults would make the thread profile an escalation
 * path (spec 02 Thread).
 *
 * `ingesting` is the driver: one fiber, reading what the fleet reported in the
 * order it arrived. Each event's stream rows and the status change they cause
 * commit together (spec 04 Truth model).
 */
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import type { SqlError } from "effect/unstable/sql/SqlError";
import type { DeclaredCapabilities, ProviderDefinition } from "@hydra/plugin-host";
import {
  SessionSpec,
  type AccessMode,
  type Delivery,
  type ModelSelection,
  type ProviderEvent,
  type SessionBinding,
  type SessionInputResult,
  type SessionStart,
} from "@hydra/protocol";
import {
  DEFAULT_PAGE_LIMIT,
  Id,
  INPUT_SORT_FIELDS,
  INPUT_UPDATE_FIELDS,
  InvalidState,
  invalidState,
  NotFound,
  notFound,
  SESSION_SORT_FIELDS,
  SessionFilter,
  SESSION_INPUT_FIELDS,
  SESSION_CONTINUE_FIELDS,
  SESSION_UPDATE_FIELDS,
  SessionSpawnInput,
  TRANSCRIPT_SORT_FIELDS,
  validation,
  validationOf,
  type Forbidden,
  type Input,
  type Session,
  type SessionInputOutcome,
  type SortDirection,
  type TranscriptRow,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { currentUser, requireGrant, USER_ACTOR } from "../actor";
import { announce, nowIso, pageInput, refuseCursor, withTransaction, type Page } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { providerRepository, type StoredInstance, type StoredSnapshot } from "../providers";
import { requireOnline, RunnerPresence, runnerRepository, type SessionTraffic } from "../runners";
import { Settings, type SettingError } from "../settings";
import { inputRepository, type StoredInput } from "./inputs";
import { sessionRepository, type StoredSession } from "./repository";
import { fold, track, type Tracked } from "./stream";

const QueryInput = Schema.Struct({
  ...SessionFilter.fields,
  ...pageInput(SESSION_SORT_FIELDS),
});

export type QueryInput = Schema.Schema.Type<typeof QueryInput>;

const Identified = Schema.Struct({ id: Id });

export type Identified = Schema.Schema.Type<typeof Identified>;

const InputInput = Schema.Struct({ id: Id, ...SESSION_INPUT_FIELDS });

export type InputInput = Schema.Schema.Type<typeof InputInput>;

const UpdateInput = Schema.Struct({ id: Id, ...SESSION_UPDATE_FIELDS });

export type UpdateInput = Schema.Schema.Type<typeof UpdateInput>;

const TranscriptInput = Schema.Struct({ id: Id, ...pageInput(TRANSCRIPT_SORT_FIELDS) });

export type TranscriptInput = Schema.Schema.Type<typeof TranscriptInput>;

const InputQueryInput = Schema.Struct({ id: Id, ...pageInput(INPUT_SORT_FIELDS) });

export type InputQueryInput = Schema.Schema.Type<typeof InputQueryInput>;

const InputUpdate = Schema.Struct({ id: Id, inputId: Id, ...INPUT_UPDATE_FIELDS });

export type InputUpdate = Schema.Schema.Type<typeof InputUpdate>;

const ContinueInput = Schema.Struct({ id: Id, ...SESSION_CONTINUE_FIELDS });

export type ContinueInput = Schema.Schema.Type<typeof ContinueInput>;

const InputIdentified = Schema.Struct({ id: Id, inputId: Id });

export type InputIdentified = Schema.Schema.Type<typeof InputIdentified>;

export interface SessionPage {
  readonly items: ReadonlyArray<Session>;
  readonly nextCursor?: string;
}

export interface TranscriptPage {
  readonly items: ReadonlyArray<TranscriptRow>;
  readonly nextCursor?: string;
}

export interface InputPage {
  readonly items: ReadonlyArray<Input>;
  readonly nextCursor?: string;
}

/** A listing as the contract hands it out: the cursor is a key, not a null. */
const pageOut = <A>(listing: Page<A>): { items: ReadonlyArray<A>; nextCursor?: string } => ({
  items: listing.items,
  ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
});

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeSpawn = Schema.decodeUnknownEffect(SessionSpawnInput);
const decodeInput = Schema.decodeUnknownEffect(InputInput);
const decodeUpdate = Schema.decodeUnknownEffect(UpdateInput);
const decodeTranscript = Schema.decodeUnknownEffect(TranscriptInput);
const decodeInputQuery = Schema.decodeUnknownEffect(InputQueryInput);
const decodeInputUpdate = Schema.decodeUnknownEffect(InputUpdate);
const decodeInputIdentified = Schema.decodeUnknownEffect(InputIdentified);
const decodeContinue = Schema.decodeUnknownEffect(ContinueInput);
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);

/** Newest first: a session list is read as a history. */
const DEFAULT_DIRECTION: SortDirection = "desc";

/** Oldest first: a transcript is read forwards, the way it happened. */
const TRANSCRIPT_DIRECTION: SortDirection = "asc";

/** Oldest first: the order the caller sent them in is the order they leave in. */
const INPUT_DIRECTION: SortDirection = "asc";

/**
 * How long the controller waits for a runner to say what it did with an input.
 * Long enough for a harness to take a message, short enough that a caller
 * blocked on the answer is not left there.
 */
const SESSION_INPUT_DEADLINE: Duration.Duration = Duration.seconds(10);

/** Tests hand over a deadline they can wait out. */
export const SessionInputDeadline = Context.Reference<Duration.Duration>(
  "hydra/controller/sessions/SessionInputDeadline",
  { defaultValue: (): Duration.Duration => SESSION_INPUT_DEADLINE },
);

const NO_SUCH_SESSION = "no such session";

const HAS_EXITED = "that session has exited";

const GONE = "that session's runner is no longer connected";

const NO_SUCH_INPUT = "no such input on that session";

const ALREADY_SENT = "that input has already gone to the machine";

const NOT_WAITING =
  "that input is no longer waiting: it was sent, delivered or cancelled in the meantime";

const REFUSED = "that session's runner would not take the input";

const NOT_BUSY = "only a busy session can be steered";

const STEERING_UNSUPPORTED =
  "that session's provider does not support steering into a running turn";

const NOT_RESUMABLE =
  "that session is not resumable: it is still live, it left no provider-native session, " +
  "or its machine is gone";

const DRAINING = "that session's runner is draining and takes no new sessions";

const ALREADY_CARRIED_ON =
  "another session is already live against that one's provider-native session; " +
  "stop it, or fork instead";

/**
 * Both ways an input can fail to reach the harness - no connection, and no
 * answer in time - read the same to a caller, and put the row back to
 * waiting for the next transition to idle, or a hand steer, to try again.
 */
const NOT_DELIVERED =
  "that session's runner did not take the input; it stays queued for the next turn";

const NO_PLACEMENT =
  "no connected runner is logged in to that provider instance; log in on a machine first";

/** The shipped profile a thread takes when the user has chosen none (spec 02 Thread). */
const DEFAULT_PROFILE = "unrestricted";

const DEFAULT_ACCESS_MODE: AccessMode = "approval-required";

/**
 * Least permissive first. The fallback of spec 06 section 8.4 walks downward
 * from what was asked for, so a substitution is never more permissive; the row
 * keeps both modes, which is how the caller sees what it actually got.
 */
const MODES: ReadonlyArray<AccessMode> = [
  "approval-required",
  "auto-accept-edits",
  "auto",
  "full-access",
];

const nearestSupported = (
  requested: AccessMode,
  declared: DeclaredCapabilities,
): AccessMode | undefined => {
  for (let index = MODES.indexOf(requested); index >= 0; index -= 1) {
    const mode = MODES[index]!;
    if (declared.accessModes[mode] === "native") return mode;
  }
  return undefined;
};

/**
 * A machine's own word that it can run this instance: the stored capability
 * snapshot saying it is logged in. Read, never probed.
 */
const loggedIn = (snapshot: StoredSnapshot): boolean => snapshot.auth.status === "ok";

/**
 * Where the provider-native id rides on the event that announces the harness.
 * The key is `SessionBinding`'s own field name, because it is the same fact.
 * An event that carries none leaves the id null until the next sessions report.
 */
const nativeIdIn = (event: ProviderEvent): string | undefined =>
  event._tag === "session.started" ? event.providerRefs?.nativeSessionId : undefined;

type ReadError = Unauthenticated | Forbidden | Validation | SqlError;

type SpawnError = ReadError | InvalidState | SettingError | GrantsError | Schema.SchemaError;

type InputError = ReadError | NotFound | InvalidState | Schema.SchemaError;

/** What an instance is, once the row and the provider behind it are both in hand. */
interface Resolved {
  readonly instance: StoredInstance;
  readonly definition: ProviderDefinition;
  readonly snapshots: ReadonlyArray<StoredSnapshot>;
}

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const sessions = yield* sessionRepository;
  const inputs = yield* inputRepository;
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const presence = yield* RunnerPresence;
  const profiles = yield* PermissionProfiles;
  const settings = yield* Settings;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;

  /**
   * One session's ingest state: where its sequence stands and what delta text
   * is held for it. Process memory - a restart re-reads the sequence from the
   * rows and holds nothing. An entry is dropped when the session exits, so a
   * session whose machine vanished holds one until the restart reconciliation
   * of spec 06 section 4.1, which this build does not have.
   */
  const tracking = new Map<string, Tracked>();

  const one = (id: string): Effect.Effect<StoredSession, NotFound | SqlError> =>
    Effect.flatMap(
      sessions.one(id),
      Option.match({
        onNone: () => Effect.fail(notFound(NO_SUCH_SESSION)),
        onSome: Effect.succeed,
      }),
    );

  /** An instance and the provider definition behind it, or a `validation` saying why not. */
  const resolved = (
    instanceId: string,
  ): Effect.Effect<Resolved, Validation | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      const found = yield* instances.one(instanceId);
      if (Option.isNone(found)) {
        return yield* Effect.fail(
          validation([{ path: ["instanceId"], message: "no such provider instance" }]),
        );
      }
      const registered = yield* host.providers();
      const definition = registered.find((one) => one.id === found.value.providerId);
      if (definition === undefined) {
        return yield* Effect.fail(
          validation([
            {
              path: ["instanceId"],
              message: `this build carries no ${found.value.providerId} provider`,
            },
          ]),
        );
      }
      return {
        instance: found.value,
        definition,
        snapshots: yield* instances.snapshotsOf(instanceId),
      };
    });

  /**
   * Which machine hosts the session: the first that is online and holds a
   * capability snapshot saying it has this instance's harness and a login for
   * it. Naming a runner on spawn (spec 03 section 5.4) is not built yet.
   */
  const placement = (
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): Effect.Effect<StoredSnapshot, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const placeable = yield* runners.placeable();
      const found = snapshots.find(
        (snapshot) => loggedIn(snapshot) && placeable.has(snapshot.runnerId),
      );
      if (found === undefined) return yield* Effect.fail(invalidState(NO_PLACEMENT));
      return found;
    });

  /** The shipped thread default until the user has a `thread.instanceId` (spec 02 Thread). */
  const firstLoggedIn = (): Effect.Effect<string, InvalidState | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      for (const snapshot of yield* instances.snapshots()) {
        if (loggedIn(snapshot)) return snapshot.instanceId;
      }
      return yield* Effect.fail(
        invalidState("no provider instance has a logged-in machine; log in on one first"),
      );
    });

  const threadProfile = (): Effect.Effect<string, InvalidState | GrantsError | SqlError> =>
    Effect.flatMap(
      profiles.getByName(DEFAULT_PROFILE),
      Option.match({
        // The boot seeds it, so this is a database somebody edited.
        onNone: () =>
          Effect.fail(invalidState(`the ${DEFAULT_PROFILE} permission profile is missing`)),
        onSome: (profile) => Effect.succeed(profile.id),
      }),
    );

  /**
   * The input a caller may still act on: one this session holds, one that has
   * not left or been called off already, and one that is not on the wire this
   * moment - a row the machine already has cannot be taken back, and saying it
   * was would be the worst thing this operation could tell anyone.
   */
  const queuedInput = (
    sessionId: string,
    inputId: string,
  ): Effect.Effect<StoredInput, NotFound | InvalidState | SqlError> =>
    Effect.gen(function* () {
      const found = yield* inputs.one(sessionId, inputId);
      if (Option.isNone(found)) return yield* Effect.fail(notFound(NO_SUCH_INPUT));
      if (found.value.status !== "queued") {
        return yield* Effect.fail(invalidState(`that input was already ${found.value.status}`));
      }
      if (found.value.sentAt !== null) return yield* Effect.fail(invalidState(ALREADY_SENT));
      return found.value;
    });

  /**
   * Sends one stored input to the machine holding the session and waits for the
   * machine to say what it did with it. `none` where there is no connection or
   * nothing came back in time; the wait is outside any transaction. The caller
   * has already claimed the row before this runs.
   *
   * The session's current model rides every frame: only the adapter knows
   * whether the input about to be sent opens a turn, which is the only moment
   * a harness will take a model change.
   */
  const deliverTo = (
    runnerId: string,
    row: StoredInput,
    modelSelection: ModelSelection,
  ): Effect.Effect<Option.Option<SessionInputResult>> =>
    Effect.gen(function* () {
      const deadline = yield* SessionInputDeadline;
      const answer = yield* presence.asked(
        runnerId,
        {
          _tag: "sessionInput",
          requestId: row.id,
          sessionId: row.sessionId,
          input: { text: row.text, modelSelection },
        },
        deadline,
      );
      return Option.filter(
        answer,
        (one): one is SessionInputResult => one._tag === "sessionInputResult",
      );
    });

  const recordDelivery = (row: StoredInput, delivery: Delivery): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        yield* inputs.delivered(row.id, delivery, yield* nowIso);
        yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
      }),
    );

  /**
   * Settles a row a delivery could not finish: back to waiting with the
   * reason, or cancelled if the session exited meanwhile. Read inside this
   * transaction so it serializes with `session.exited`'s own write.
   */
  const settleFailure = (row: StoredInput, reason: string): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.gen(function* () {
        const now = yield* sessions.one(row.sessionId);
        if (Option.isSome(now) && now.value.status === "exited") {
          yield* inputs.cancelWithReason(row.id, reason);
        } else {
          yield* inputs.requeue(row.id, reason);
        }
        yield* announce({ _tag: "record", topic: "session", id: row.sessionId, kind: "updated" });
      }),
    );

  /**
   * Sends a row that is already claimed - on the wire, `sent_at` set - and
   * settles what became of it: a delivery the machine reports is recorded and
   * handed back; a refusal or silence is left where `settleFailure` puts it,
   * and fails with the same reason. The idle path, a steer and the flush all
   * reach the machine through this and nothing else does.
   *
   * The model is read here, after the row is claimed, rather than earlier by
   * the caller: a `session.update` landing between the caller's own read and
   * the claim would otherwise ride a frame it never applied to.
   */
  const deliverClaimed = (
    runnerId: string,
    row: StoredInput,
  ): Effect.Effect<SessionInputOutcome, InvalidState | NotFound | SqlError> =>
    Effect.gen(function* () {
      const session = yield* one(row.sessionId);
      const answer = yield* deliverTo(runnerId, row, session.modelSelection);
      const delivery = Option.isSome(answer) && answer.value.ok ? answer.value.delivery : undefined;
      if (delivery !== undefined) {
        yield* recordDelivery(row, delivery);
        return { inputId: row.id, result: delivery };
      }
      const reason = Option.isSome(answer) ? (answer.value.message ?? REFUSED) : NOT_DELIVERED;
      yield* settleFailure(row, reason);
      return yield* Effect.fail(invalidState(reason));
    });

  /**
   * Sends what one transition to idle releases: the oldest row still waiting,
   * claimed the instant this finds it, so a second transition landing before
   * the machine answers cannot also take it - the claim is what a row's turn
   * actually was for, so there is no boundary to count and nothing to catch
   * up on. A refusal or silence is left where `deliverClaimed` puts it: back
   * to waiting, for the next transition to send.
   */
  const flush = (sessionId: string, runnerId: string): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const next = yield* inputs.oldestWaiting(sessionId);
      if (Option.isNone(next)) return;
      const claimed = yield* inputs.claim(next.value.id, yield* nowIso);
      if (Option.isNone(claimed)) return;
      yield* Effect.catchIf(
        deliverClaimed(runnerId, claimed.value),
        (error): error is InvalidState | NotFound =>
          error instanceof InvalidState || error instanceof NotFound,
        () => Effect.void,
      );
    });

  /** A driver must not stop on one failure, so the cause is logged and dropped. */
  const absorbing = (what: string, effect: Effect.Effect<void, SqlError>): Effect.Effect<void> =>
    Effect.ignore(Effect.tapCause(effect, (cause) => Effect.logError(what, cause)));

  /** The native ids a machine reports for the sessions it is holding. */
  const bound = (
    runnerId: string,
    bindings: ReadonlyArray<SessionBinding>,
  ): Effect.Effect<void, SqlError> =>
    withTransaction(
      sql,
      Effect.forEach(
        bindings,
        (binding) =>
          sessions.bind(binding.sessionId, runnerId, binding.instanceId, binding.nativeSessionId),
        { discard: true },
      ),
    );

  const reported = (
    runnerId: string,
    seq: number,
    event: ProviderEvent,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      const id = event.sessionId;
      const found = yield* sessions.one(id);
      // A machine speaks only for the sessions placed on it; anything else is a
      // runner reporting about a session that is not its to report.
      if (Option.isNone(found) || found.value.runnerId !== runnerId) return;
      const before = found.value.status;
      const held = tracking.get(id) ?? track(yield* sessions.lastSeq(id));
      const folded = fold(held, seq, event);
      if (folded === undefined) return;
      const moved = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          for (const row of folded.rows) yield* sessions.append(id, row);
          // Written with the move the same event causes: a session that reads
          // `idle` has the provider-native id that made it so.
          const native = nativeIdIn(event);
          if (native !== undefined) {
            yield* sessions.bind(id, runnerId, found.value.instanceId, native);
          }
          // `exited` is final (spec 06 section 4.1), so a stray event after it
          // is still recorded but never brings the session back to life.
          if (folded.status === undefined || folded.status === before || before === "exited") {
            // No announce: an event that moves nothing is most of the traffic,
            // and a refetch per delta would be a firehose.
            yield* sessions.touched(id, at);
            return undefined;
          }
          yield* sessions.moved(id, folded.status, at);
          // Nothing waits on a harness that is gone, so the queue goes with it.
          if (folded.status === "exited") yield* inputs.cancelQueued(id);
          yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          return folded.status;
        }),
      );
      // Only once it is durable: a failed transaction leaves the held text and
      // the sequence where they were, and nothing resends the frame, because
      // there is no outbox yet (spec 03 section 2.3).
      //
      // Dropped on the transition and on anything after it: an event reaching
      // an already-exited session would otherwise put its entry back for good.
      if (folded.status === "exited" || before === "exited") {
        tracking.delete(id);
      } else {
        tracking.set(id, folded.next);
      }
      // Forked, because a flush waits on the runner and the ingest is one fiber
      // for the whole fleet: waiting inline would stall every other session's
      // events for the deadline.
      if (moved === "idle") {
        yield* Effect.forkChild(
          absorbing("A session's queued input could not be sent", flush(id, runnerId)),
        );
      }
    });

  /**
   * What it takes to open one session on a machine, whether it is the first of
   * a conversation or the one carrying an earlier conversation on.
   */
  interface Opening {
    readonly permissionProfileId: string;
    readonly runnerId: string;
    readonly requestedAccessMode: AccessMode;
    /**
     * Known only where the session carries on the native session another one
     * left behind. A fresh session and a fork are both named by the machine.
     */
    readonly nativeSessionId: string | undefined;
    readonly parentSessionId: string | undefined;
    /** Everything the machine is told, and the source of what the row stores. */
    readonly spec: SessionSpec;
    readonly instance: StoredInstance;
    readonly prompt: string;
    readonly kind: "session.spawned" | "session.continued";
    /** What the audit entry records beyond the new session's own id. */
    readonly payload: Readonly<Record<string, unknown>>;
  }

  /**
   * The row, its first input and the entry that records it, in one
   * transaction, and then the frame that tells the machine to start it.
   *
   * A machine that went away between the two leaves a row nothing will ever
   * start, so it is ended here rather than left reading `starting` for good.
   */
  const opening = (open: Opening): Effect.Effect<StoredSession, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const stored = yield* withTransaction(
        sql,
        Effect.gen(function* () {
          // Asked inside the write, because two callers naming one native
          // session a moment apart would both pass a check made before it.
          if (
            open.nativeSessionId !== undefined &&
            (yield* sessions.liveOn(open.nativeSessionId))
          ) {
            return yield* Effect.fail(invalidState(ALREADY_CARRIED_ON));
          }
          const at = yield* nowIso;
          const row = yield* sessions.insert({
            permissionProfileId: open.permissionProfileId,
            instanceId: open.spec.instanceId,
            runnerId: open.runnerId,
            workspaceId: open.spec.workspaceId,
            requestedAccessMode: open.requestedAccessMode,
            accessMode: open.spec.accessMode,
            // Byte for byte: the row holds the exact document the runner is
            // told, not a re-encode of an object that resembles it.
            spec: JSON.stringify(encodeSpec(open.spec)),
            modelSelection: open.spec.modelSelection,
            nativeSessionId: open.nativeSessionId,
            parentSessionId: open.parentSessionId,
            at,
          });
          // The prompt is an ordinary input, waiting with the session: it
          // leaves when the harness comes up, and a controller restarted in
          // that window still has it.
          yield* inputs.insert({
            sessionId: row.id,
            source: "user",
            actor: USER_ACTOR,
            text: open.prompt,
            at,
          });
          yield* audit.append({
            kind: open.kind,
            actor: USER_ACTOR,
            record: { topic: "session", id: row.id },
            payload: { ...open.payload, sessionId: row.id },
            at,
          });
          return row;
        }),
      );

      const start: SessionStart = {
        _tag: "sessionStart",
        sessionId: stored.id,
        providerId: open.instance.providerId,
        config: open.instance.config,
        spec: open.spec,
      };
      if (yield* presence.tell(open.runnerId, start)) return stored;
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          yield* sessions.moved(stored.id, "exited", yield* nowIso);
          yield* announce({ _tag: "record", topic: "session", id: stored.id, kind: "updated" });
        }),
      );
      return yield* Effect.fail(invalidState(GONE));
    });

  const applying = (traffic: SessionTraffic): Effect.Effect<void, SqlError> =>
    traffic.frame._tag === "sessionsReport"
      ? bound(traffic.runnerId, traffic.frame.sessions)
      : reported(traffic.runnerId, traffic.frame.seq, traffic.frame.event);

  return {
    query: (input: QueryInput): Effect.Effect<SessionPage, ReadError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.query");
        const { limit, cursor, sort, status, runnerId } = yield* Effect.mapError(
          decodeQuery(input),
          validationOf,
        );
        const listing = yield* refuseCursor(
          sessions.list({
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? DEFAULT_DIRECTION,
            status,
            runnerId,
          }),
        );
        return pageOut(listing);
      }),

    read: (input: Identified): Effect.Effect<Session, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("session.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* one(id);
      }),

    /**
     * The session's normalized stream, in position order (spec 11 section 2).
     * The session is read first so a just-placed session with no rows yet is
     * told apart from one that does not exist.
     */
    transcript: (input: TranscriptInput): Effect.Effect<TranscriptPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("transcript.read");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeTranscript(input),
          validationOf,
        );
        yield* one(id);
        const listing = yield* refuseCursor(
          sessions.transcript({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? TRANSCRIPT_DIRECTION,
          }),
        );
        return pageOut(listing);
      }),

    spawn: (input: SessionSpawnInput): Effect.Effect<Session, SpawnError> =>
      Effect.gen(function* () {
        // A Thread carries the user's own thread profile, so only the user may
        // open one (spec 02 Thread).
        const user = yield* currentUser("session.spawn");
        const decoded = yield* Effect.mapError(decodeSpawn(input), validationOf);
        if (decoded.workspaceId !== undefined && decoded.workspaceId !== null) {
          return yield* Effect.fail(
            validation([
              {
                path: ["workspaceId"],
                message: "workspaces are not built yet; a thread runs without one",
              },
            ]),
          );
        }
        // An override is for this session only, never written back to the store.
        const defaults = yield* settings.allForUser(user.userId);

        const instanceId =
          decoded.instanceId ?? defaults["thread.instanceId"] ?? (yield* firstLoggedIn());
        const { instance, definition, snapshots } = yield* resolved(instanceId);
        const hosting = yield* placement(snapshots);

        const requestedAccessMode =
          decoded.accessMode ?? defaults["thread.accessMode"] ?? DEFAULT_ACCESS_MODE;
        const accessMode = nearestSupported(requestedAccessMode, definition.declared);
        if (accessMode === undefined) {
          return yield* Effect.fail(
            invalidState(
              `${definition.displayName} supports no access mode at or below ${requestedAccessMode}`,
            ),
          );
        }

        const model =
          decoded.model ??
          defaults["thread.model"] ??
          (hosting.models.find((one) => one.isDefault) ?? hosting.models[0])?.slug;
        if (model === undefined) {
          return yield* Effect.fail(
            invalidState("that machine reported no models for this provider instance"),
          );
        }

        const profileId = defaults["thread.profileId"] ?? (yield* threadProfile());

        const spec = {
          instanceId,
          workspaceId: null,
          modelSelection: { model, options: {} },
          accessMode,
        } satisfies SessionSpec;

        return yield* opening({
          permissionProfileId: profileId,
          runnerId: hosting.runnerId,
          requestedAccessMode,
          nativeSessionId: undefined,
          parentSessionId: undefined,
          spec,
          instance,
          prompt: decoded.prompt,
          kind: "session.spawned",
          payload: {
            instanceId,
            runnerId: hosting.runnerId,
            requestedAccessMode,
            accessMode,
          },
        });
      }),

    /**
     * What the session runs under from here on. The stored `spec` is left
     * alone: it is the document the runner was started with, and a resume or
     * a fork reads the session's own `modelSelection` instead.
     */
    update: (input: UpdateInput): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.update");
        const { id, model } = yield* Effect.mapError(decodeUpdate(input), validationOf);
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
        const modelSelection = { model, options: session.modelSelection.options };
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            yield* sessions.selectModel(id, modelSelection);
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
          }),
        );
        return { ...session, modelSelection };
      }),

    /**
     * One turn's input. Stored first, so the answer names a row the caller can
     * edit or cancel. An idle session has no transition to idle coming, so its
     * row is inserted already claimed - on the wire the instant it exists,
     * never visible to a cancel or a flush as merely waiting - and delivered
     * here rather than left for a flush that will never run; every other
     * status queues, and steering one is `input.steer`'s to do.
     *
     * What it did is always the machine's own word for it, never the status the
     * controller read: an input that opened a turn and one that was folded into
     * a turn already running are told apart by the adapter alone.
     */
    input: (input: InputInput): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.input");
        const { id, text } = yield* Effect.mapError(decodeInput(input), validationOf);
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
        const idle = session.status === "idle";
        const row = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const created = yield* inputs.insert({
              sessionId: id,
              source: "user",
              actor: USER_ACTOR,
              text,
              at,
              ...(idle ? { sentAt: at } : {}),
            });
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            return created;
          }),
        );
        if (!idle) return { inputId: row.id, result: "queued" };
        return yield* deliverClaimed(session.runnerId, row);
      }),

    /**
     * Folds a still-queued row into the turn a busy session is already
     * running, reusing the same delivery `session.input`'s idle path uses. A
     * row that is not there to steer - on another session, already left, on
     * the wire, or behind a provider that cannot fold a turn open - is refused
     * before anything is sent.
     */
    steer: (input: InputIdentified): Effect.Effect<SessionInputOutcome, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.steer");
        const { id, inputId } = yield* Effect.mapError(decodeInputIdentified(input), validationOf);
        const session = yield* one(id);
        // The row is looked up before the session's own status is judged, so an
        // id belonging to another session reads not_found rather than whatever
        // this session's status happens to be.
        const row = yield* queuedInput(id, inputId);
        if (session.status !== "busy") return yield* Effect.fail(invalidState(NOT_BUSY));
        const { definition } = yield* resolved(session.instanceId);
        if (definition.declared.steering !== "native") {
          return yield* Effect.fail(invalidState(STEERING_UNSUPPORTED));
        }
        // The claim is the guard against a second steer, or the flush, taking
        // the same row: only one caller's conditional update finds it still
        // waiting, whatever `queuedInput` read a moment ago - and its own
        // answer, not that stale read, is what gets sent, in case a rewrite
        // landed in between.
        const claimed = yield* inputs.claim(row.id, yield* nowIso);
        if (Option.isNone(claimed)) return yield* Effect.fail(invalidState(NOT_WAITING));
        return yield* deliverClaimed(session.runnerId, claimed.value);
      }),

    /**
     * Ends the turn the session is running. Fire and forget: what became of the
     * turn arrives in the session's own stream as `turn.completed`, so there is
     * nothing to wait for here.
     *
     * Only a session whose harness is gone refuses. The status the controller
     * holds lags the machine's own stream, so "no turn is running" here is a
     * guess about a moment that has already passed; the adapter knows, and its
     * interrupt is a no-op where there is nothing to end.
     */
    interrupt: (input: Identified): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.interrupt");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
        if (
          !(yield* presence.tell(session.runnerId, { _tag: "sessionInterrupt", sessionId: id }))
        ) {
          return yield* Effect.fail(invalidState(GONE));
        }
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "session.interrupted",
              actor: USER_ACTOR,
              payload: { sessionId: id, runnerId: session.runnerId },
              at,
            }),
          ),
        );
        return session;
      }),

    /**
     * Ends the harness. The session moves to `exited` when the machine reports
     * the exit, not here: this build has no way to end a session the machine
     * never confirms is gone.
     */
    stop: (input: Identified): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.stop");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
        if (!(yield* presence.tell(session.runnerId, { _tag: "sessionStop", sessionId: id }))) {
          return yield* Effect.fail(invalidState(GONE));
        }
        yield* withTransaction(
          sql,
          Effect.flatMap(nowIso, (at) =>
            audit.append({
              kind: "session.stopped",
              actor: USER_ACTOR,
              payload: { sessionId: id, runnerId: session.runnerId },
              at,
            }),
          ),
        );
        return session;
      }),

    /**
     * A second session against the provider-native one the parent left behind,
     * on the same machine and the same instance, because that is where the
     * native state is (spec 06 section 4.1).
     *
     * Only an exited parent may be carried on, and a resume only where nothing
     * else is live against that native session: two harnesses writing one
     * native transcript is a corruption nothing here could repair. A fork
     * writes a transcript of its own, so it is safe beside anything.
     *
     * It carries a Thread's profile onto a new session, so like `spawn` only
     * the user may open one (spec 02 Thread).
     */
    continue: (input: ContinueInput): Effect.Effect<Session, InputError> =>
      Effect.gen(function* () {
        yield* currentUser("session.continue");
        const { id, mode, prompt } = yield* Effect.mapError(decodeContinue(input), validationOf);
        const parent = yield* one(id);
        // The one rule, and the one a caller reads off the row before asking:
        // exited, with a native session, on a machine that still exists.
        if (!parent.resumable || parent.nativeSessionId === null) {
          return yield* Effect.fail(invalidState(NOT_RESUMABLE));
        }
        const machine = yield* runners.read(parent.runnerId);
        if (Option.isNone(machine)) return yield* Effect.fail(invalidState(NOT_RESUMABLE));
        // A continued session is a new session on that machine, and a draining
        // one takes none (spec 03 section 7). `resumable` says the transcript
        // is still there; this says the machine will not open it.
        if (machine.value.lifecycle !== "active") {
          return yield* Effect.fail(invalidState(DRAINING));
        }
        yield* requireOnline(machine.value);
        const { instance, snapshots } = yield* resolved(parent.instanceId);
        // The login half of what `spawn` asks placement for, of the one machine
        // that holds the native state rather than of the fleet: the stored
        // snapshot's word that this machine can run this instance.
        if (!snapshots.some((one) => loggedIn(one) && one.runnerId === parent.runnerId)) {
          return yield* Effect.fail(invalidState(NO_PLACEMENT));
        }

        return yield* opening({
          permissionProfileId: parent.permissionProfileId,
          runnerId: parent.runnerId,
          requestedAccessMode: parent.requestedAccessMode,
          // A resume is the same conversation carried on: the same native
          // session, and so no parent to point at. Only a fork branches off
          // one, and the machine names the branch it makes.
          nativeSessionId: mode === "resume" ? parent.nativeSessionId : undefined,
          parentSessionId: mode === "fork" ? parent.id : undefined,
          spec: {
            instanceId: parent.instanceId,
            workspaceId: parent.workspaceId,
            modelSelection: parent.modelSelection,
            accessMode: parent.accessMode,
            continue: { nativeSessionId: parent.nativeSessionId, mode },
          },
          instance,
          prompt,
          kind: "session.continued",
          payload: { parentSessionId: parent.id, mode },
        });
      }),

    /** Every input this session was ever given, oldest first, whatever became of each. */
    queryInputs: (input: InputQueryInput): Effect.Effect<InputPage, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("input.query");
        const { id, limit, cursor, sort } = yield* Effect.mapError(
          decodeInputQuery(input),
          validationOf,
        );
        yield* one(id);
        const listing = yield* refuseCursor(
          inputs.list({
            sessionId: id,
            limit: limit ?? DEFAULT_PAGE_LIMIT,
            cursor,
            direction: sort?.direction ?? INPUT_DIRECTION,
          }),
        );
        return pageOut(listing);
      }),

    updateInput: (input: InputUpdate): Effect.Effect<Input, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.update");
        const { id, inputId, text } = yield* Effect.mapError(
          decodeInputUpdate(input),
          validationOf,
        );
        yield* one(id);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const row = yield* queuedInput(id, inputId);
            yield* inputs.rewrite(inputId, text);
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            return { ...row, text };
          }),
        );
      }),

    cancelInput: (input: InputIdentified): Effect.Effect<Input, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("input.cancel");
        const { id, inputId } = yield* Effect.mapError(decodeInputIdentified(input), validationOf);
        yield* one(id);
        return yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const row = yield* queuedInput(id, inputId);
            yield* inputs.cancel(inputId);
            yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
            return { ...row, status: "cancelled" as const };
          }),
        );
      }),

    /**
     * The ingest driver. One fiber, so a session's events are applied in the
     * order the machine numbered them; each absorbs its own failure, because
     * one report that will not write must not stop the fleet's traffic.
     */
    ingesting: Stream.runForEach(presence.sessionTraffic, (traffic) =>
      absorbing("A session report could not be recorded", applying(traffic)),
    ),
  };
});

export class SessionService extends Context.Service<SessionService, Effect.Success<typeof make>>()(
  "hydra/controller/sessions/SessionService",
) {}

export const SessionServiceLayer: Layer.Layer<
  SessionService,
  never,
  SqlClient.SqlClient | RunnerPresence | PluginHost | AuditLog | Settings | PermissionProfiles
> = Layer.effect(SessionService)(make);

/**
 * `inputRepository.cancelStranded`, run once at boot rather than folded into
 * `SessionServiceLayer`'s own construction: the boot builds every service's
 * layer before it runs a migration, so a query against a column a fresh
 * database does not have yet would fail there. Called explicitly, after
 * migrations and before anything is placed on a runner.
 */
export const cancelStrandedInputs: Effect.Effect<void, SqlError, SqlClient.SqlClient> =
  Effect.flatMap(inputRepository, (inputs) =>
    inputs.cancelStranded(
      "the controller restarted while this input was on its way to the runner; " +
        "whether the harness took it is unknown",
    ),
  );
