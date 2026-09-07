/**
 * Sessions as the API sees them, and the one place the fleet's session traffic
 * is turned into rows.
 *
 * Only a Thread can be spawned in this build: there are no Agents, so every
 * value comes from the user's `thread.*` settings plus this call's overrides,
 * and the operation is the user's alone (spec 02 Thread). When session, run and
 * plugin actors arrive, they are refused here rather than reaching the thread
 * defaults, which would make the thread profile an escalation path.
 *
 * `ingesting` is the driver: one fiber, reading what the fleet reported in the
 * order it arrived. Each event's stream rows and the status change they cause
 * commit together (spec 04 Truth model), and an event under a sequence number
 * this session has already applied writes nothing.
 */
import * as Context from "effect/Context";
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
  type ProviderEvent,
  type SessionBinding,
  type SessionStart,
} from "@hydra/protocol";
import {
  DEFAULT_PAGE_LIMIT,
  Id,
  invalidState,
  notFound,
  SESSION_SORT_FIELDS,
  SessionFilter,
  SESSION_INPUT_FIELDS,
  SessionSpawnInput,
  validation,
  validationOf,
  type Forbidden,
  type InvalidState,
  type NotFound,
  type Session,
  type SessionInputResult,
  type SortDirection,
  type Unauthenticated,
  type Validation,
} from "@hydra/contract";
import { currentUser, requireGrant, USER_ACTOR } from "../actor";
import { announce, nowIso, pageInput, refuseCursor, withTransaction } from "../db";
import { AuditLog } from "../events";
import { PermissionProfiles, type GrantsError } from "../permissions";
import { PluginHost } from "../plugins";
import { providerRepository, type StoredInstance, type StoredSnapshot } from "../providers";
import { RunnerPresence, runnerRepository, type SessionTraffic } from "../runners";
import { Settings, type SettingError } from "../settings";
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

export interface SessionPage {
  readonly items: ReadonlyArray<Session>;
  readonly nextCursor?: string;
}

const decodeQuery = Schema.decodeUnknownEffect(QueryInput);
const decodeIdentified = Schema.decodeUnknownEffect(Identified);
const decodeSpawn = Schema.decodeUnknownEffect(SessionSpawnInput);
const decodeInput = Schema.decodeUnknownEffect(InputInput);
const encodeSpec = Schema.encodeUnknownSync(SessionSpec);

/** Newest first: a session list is read as a history. */
const DEFAULT_DIRECTION: SortDirection = "desc";

const NO_SUCH_SESSION = "no such session";

const NOT_STARTED = "that session has not started yet";

const HAS_EXITED = "that session has exited";

const GONE = "that session's runner is no longer connected";

const NO_PLACEMENT =
  "no connected runner is logged in to that provider instance; log in on a machine first";

/** The shipped profile a thread takes when the user has chosen none (spec 02 Thread). */
const DEFAULT_PROFILE = "unrestricted";

const DEFAULT_ACCESS_MODE: AccessMode = "approval-required";

/**
 * Least permissive first. The fallback of spec 06 section 8.4 walks this list
 * downward from what was asked for and stops at the first mode the provider
 * declares native, so a substitution is never more permissive than the request.
 * It is never silent either: the row keeps both modes and every read hands back
 * both, which is where the caller sees what it actually got.
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
 * Where the provider-native id rides on the event that announces the harness.
 * The key is `SessionBinding`'s own field name, because it is the same fact:
 * `providerRefs` is the generic bag of native ids (spec 06 section 4.1), and a
 * second spelling for this one would be a second vocabulary.
 *
 * A `session.started` that carries none leaves the id null until the machine's
 * next sessions report, which is the other place a binding reaches here.
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
  const instances = yield* providerRepository;
  const runners = yield* runnerRepository;
  const presence = yield* RunnerPresence;
  const profiles = yield* PermissionProfiles;
  const settings = yield* Settings;
  const host = yield* PluginHost;
  const audit = yield* AuditLog;

  /**
   * One session's ingest state: where its sequence stands and what delta text
   * is held for it. Process memory, like the runner's own sequence: a restart
   * re-reads the sequence from the rows and starts holding nothing.
   *
   * An entry is dropped when the session exits. A session whose machine
   * vanished never says so, and its entry is held until the restart
   * reconciliation of spec 06 section 4.1 marks it exited - which this build
   * does not have, so such an entry outlives the process it was made in.
   */
  const tracking = new Map<string, Tracked>();

  /**
   * The first prompt of a spawned session, waiting for its harness to come up.
   * Held in memory only: this is the handover between `spawn` and
   * `session.started`, not the Queued Input of spec 06 section 5, which is a
   * row family this build does not have. A controller restarted inside that
   * window loses the prompt and leaves the session idle with nothing to do.
   */
  const opening = new Map<string, string>();

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
   * Which machine hosts the session. A capability snapshot is what says a
   * machine has this instance's harness and a usable login for it, so placement
   * is the first such machine that is online and active.
   *
   * The "local" alias of spec 03 section 5.4 is the client's to resolve and
   * reaches the controller as a named runner; naming one on spawn is not built
   * yet, so a single-machine install places on its own machine because that is
   * the only candidate there is.
   */
  const placement = (
    snapshots: ReadonlyArray<StoredSnapshot>,
  ): Effect.Effect<StoredSnapshot, InvalidState | SqlError> =>
    Effect.gen(function* () {
      const placeable = yield* runners.placeable();
      const found = snapshots.find(
        (snapshot) => snapshot.auth.status === "ok" && placeable.has(snapshot.runnerId),
      );
      if (found === undefined) return yield* Effect.fail(invalidState(NO_PLACEMENT));
      return found;
    });

  /**
   * The shipped thread default: the first provider instance somebody is logged
   * in to somewhere (spec 02 Thread). It stands in only until the user has a
   * `thread.instanceId`, which the onboarding writes.
   */
  const firstLoggedIn = (): Effect.Effect<string, InvalidState | SqlError | Schema.SchemaError> =>
    Effect.gen(function* () {
      for (const snapshot of yield* instances.snapshots()) {
        if (snapshot.auth.status === "ok") return snapshot.instanceId;
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

  /** Sends the prompt `spawn` was given, now that there is a harness to take it. */
  const openWith = (sessionId: string, runnerId: string): Effect.Effect<void> => {
    const prompt = opening.get(sessionId);
    if (prompt === undefined) return Effect.void;
    opening.delete(sessionId);
    return Effect.flatMap(
      presence.tell(runnerId, { _tag: "sessionInput", sessionId, input: { text: prompt } }),
      (sent) =>
        // The machine went in the moment between coming up and being spoken to.
        // Said rather than swallowed: the session is idle and the user is
        // waiting for a reply to a prompt nothing received.
        sent
          ? Effect.void
          : Effect.logWarning(
              `The prompt for session ${sessionId} was not delivered: its runner disconnected.`,
            ),
    );
  };

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
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const at = yield* nowIso;
          for (const row of folded.rows) yield* sessions.append(id, row);
          // The binding arrives on the event that announces the harness, and is
          // written with the move that event causes: a session that reads
          // `idle` has the provider-native id that made it so.
          const native = nativeIdIn(event);
          if (native !== undefined) {
            yield* sessions.bind(id, runnerId, found.value.instanceId, native);
          }
          // `exited` is final (spec 06 section 4.1), so a stray event after it
          // is still recorded but never brings the session back to life.
          if (folded.status === undefined || folded.status === before || before === "exited") {
            // No announce: an event that moves nothing is most of the traffic,
            // and nudging a refetch per delta would be a firehose. The record's
            // watchers hear about it at the next move.
            yield* sessions.touched(id, at);
            return;
          }
          yield* sessions.moved(id, folded.status, at);
          yield* announce({ _tag: "record", topic: "session", id, kind: "updated" });
        }),
      );
      // Only once it is durable: a transaction that failed leaves the held text
      // and the sequence where they were, so nothing is half-applied. Nothing
      // resends the frame either - there is no outbox yet (spec 03 section
      // 2.3) - so what that write would have recorded is lost.
      // On the transition and on anything after it: an event that reaches an
      // already-exited session would otherwise put its entry back, and nothing
      // would ever take it away again.
      if (folded.status === "exited" || before === "exited") {
        tracking.delete(id);
        opening.delete(id);
      } else {
        tracking.set(id, folded.next);
      }
      if (event._tag === "session.started") yield* openWith(id, runnerId);
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
        return {
          items: listing.items,
          ...(listing.nextCursor === undefined ? {} : { nextCursor: listing.nextCursor }),
        };
      }),

    read: (input: Identified): Effect.Effect<Session, ReadError | NotFound> =>
      Effect.gen(function* () {
        yield* requireGrant("session.read");
        const { id } = yield* Effect.mapError(decodeIdentified(input), validationOf);
        return yield* one(id);
      }),

    spawn: (input: SessionSpawnInput): Effect.Effect<Session, SpawnError> =>
      Effect.gen(function* () {
        // A Thread carries the user's own thread profile, so only the user may
        // open one; every other actor kind is refused here (spec 02 Thread).
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
        // The user's thread defaults, which this call may override for this one
        // session; an override is never written back to the store.
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

        const stored = yield* withTransaction(
          sql,
          Effect.gen(function* () {
            const at = yield* nowIso;
            const row = yield* sessions.insert({
              permissionProfileId: profileId,
              instanceId,
              runnerId: hosting.runnerId,
              requestedAccessMode,
              accessMode,
              // Byte for byte: the row holds the exact document the runner is
              // told, not a re-encode of an object that resembles it.
              spec: JSON.stringify(encodeSpec(spec)),
              at,
            });
            yield* audit.append({
              kind: "session.spawned",
              actor: USER_ACTOR,
              record: { topic: "session", id: row.id },
              payload: {
                sessionId: row.id,
                instanceId,
                runnerId: hosting.runnerId,
                requestedAccessMode,
                accessMode,
              },
              at,
            });
            return row;
          }),
        );

        // After the commit, because the frame carries the session id and the
        // machine starts reporting against it as soon as it has one.
        opening.set(stored.id, decoded.prompt);
        const start: SessionStart = {
          _tag: "sessionStart",
          sessionId: stored.id,
          providerId: instance.providerId,
          config: instance.config,
          spec,
        };
        if (!(yield* presence.tell(hosting.runnerId, start))) {
          opening.delete(stored.id);
          // The row exists and nothing will ever start it, so it is ended here
          // rather than left reading `starting` for good - and said, because a
          // client was told a moment ago that a session had been created.
          yield* withTransaction(
            sql,
            Effect.gen(function* () {
              yield* sessions.moved(stored.id, "exited", yield* nowIso);
              yield* announce({ _tag: "record", topic: "session", id: stored.id, kind: "updated" });
            }),
          );
          return yield* Effect.fail(invalidState(GONE));
        }
        return stored;
      }),

    /**
     * One turn's input. Input to a running turn is steering, which only some
     * providers do natively; where one does not the controller would queue it,
     * and Queued Input is not built, so it is refused rather than dropped.
     */
    input: (input: InputInput): Effect.Effect<SessionInputResult, InputError> =>
      Effect.gen(function* () {
        yield* requireGrant("session.input");
        const { id, text } = yield* Effect.mapError(decodeInput(input), validationOf);
        const session = yield* one(id);
        if (session.status === "exited") return yield* Effect.fail(invalidState(HAS_EXITED));
        if (session.status !== "idle" && session.status !== "busy") {
          return yield* Effect.fail(invalidState(NOT_STARTED));
        }
        if (session.status === "busy") {
          const { definition } = yield* resolved(session.instanceId);
          if (definition.declared.steering !== "native") {
            return yield* Effect.fail(
              invalidState(
                `${definition.displayName} takes no input mid-turn, and queued input is not built yet`,
              ),
            );
          }
        }
        const sent = yield* presence.tell(session.runnerId, {
          _tag: "sessionInput",
          sessionId: id,
          input: { text },
        });
        if (!sent) return yield* Effect.fail(invalidState(GONE));
        return { result: session.status === "busy" ? "steered" : "opened" };
      }),

    /**
     * The ingest driver. One fiber, so a session's events are applied in the
     * order the machine numbered them; each application absorbs its own
     * failure, because one report that will not write must not take the whole
     * fleet's traffic with it.
     */
    ingesting: Stream.runForEach(presence.sessionTraffic, (traffic) =>
      Effect.ignore(
        Effect.tapCause(applying(traffic), (cause) =>
          Effect.logError("A session report could not be recorded", cause),
        ),
      ),
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
