/**
 * The host side of a plugin's `entityLookup`: how the Add button on Work
 * recognizes pasted text, searches a source, and reads one thing at its source.
 *
 * - `recognize` is pure. It asks every active plugin's lookup what the text
 *   names, with no credentials and no request.
 * - `search` and `resolve` call one plugin's lookup through its eligible
 *   Connections: `connected` or `error`, of a plugin that is active, oldest
 *   first. Credentials are read by the plugin at the moment of each call, and
 *   no call runs inside a transaction.
 * - A Connection is eligible when its call starts, not only when the list was
 *   made: one call can take 8 seconds, and the user may disable a Connection
 *   or the plugin meanwhile. Such a Connection is not asked, and counts as a
 *   failed one. Its credentials are refused from then on.
 * - Each call to a plugin gets 8 seconds. The host never answers from the first
 *   Connection that happens to match: several Connections can see several
 *   things, so a resolution is decided over all of them (see `decideScoped`).
 */
import * as Cause from "effect/Cause";
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as Layer from "effect/Layer";
import * as Option from "effect/Option";
import * as SqlClient from "effect/sql/SqlClient";
import { summarizeCause } from "@hercule/contract";
import {
  AuthError,
  ConnectionUnavailable,
  PluginError,
  type EntityLookup,
  type EntityLookupContext,
  type EntityObservation,
  type EntityRecognition,
  type EntityMissing,
  type EntityResolution,
  type IngestConnection,
} from "@hercule/plugin-host";
import {
  connectionRepository,
  ConnectionTypes,
  canConnectionPoll,
  type StoredConnection,
} from "../connections";
import { decodeConnectionConfig } from "./connection-config";
import type { RegisteredEventSource } from "./event-sources";
import { PluginHost } from "./host";

/** How long one call to a plugin's lookup may run, in seconds. */
export const LOOKUP_TIMEOUT_SECONDS = 8;

/** The most Connections `resolve` asks. Eligible Connections beyond them are left out. */
export const MAX_RESOLVE_CONNECTIONS = 8;

/** The most Connections `search` asks. Eligible Connections beyond them are left out. */
export const MAX_SEARCH_CONNECTIONS = 4;

/** The most recognitions one plugin returns for a text. */
const MAX_RECOGNITIONS = 20;

/** One plugin's recognition of a text. The recognition's `kind`, when it has one, is qualified. */
export interface PluginRecognition {
  readonly pluginId: string;
  readonly recognition: EntityRecognition;
}

/** An observation a lookup read, with the Connection that read it. `observation.kind` is unqualified. */
export interface LookupObservation {
  readonly connectionId: string;
  readonly observation: EntityObservation;
}

/** What `search` returns. */
export interface SearchOutcome {
  /** One observation per ref, from the oldest Connection that returned it. */
  readonly observations: ReadonlyArray<LookupObservation>;
  /** True when a Connection failed, or eligible Connections were left out, so the list may be short. */
  readonly incomplete: boolean;
  /** `source-unavailable` when no Connection could be asked, or every one timed out. */
  readonly outcome: "results" | "source-unavailable";
}

/**
 * The one answer `resolve` gives for all of a plugin's eligible Connections.
 *
 * - `found`: exactly one thing, read by `connectionId`.
 * - `missing`: nothing was found; the firmest thing the sources said.
 * - `ambiguous`: the refs of two or more different things the text may name.
 * - `incomplete`: a Connection failed or was left out, so the answer is not sure.
 * - `unavailable`: no Connection could be asked, or every one timed out.
 */
export type DecidedResolution =
  | { readonly found: LookupObservation }
  | { readonly missing: EntityMissing }
  | { readonly ambiguous: ReadonlyArray<string> }
  | { readonly incomplete: true }
  | { readonly unavailable: true };

/** How one call to a lookup ended. */
type Asked<A> =
  | { readonly status: "answered"; readonly value: A }
  | { readonly status: "failed" | "timed-out" };

/** What one Connection said about a target. */
interface ConnectionAnswer {
  readonly connectionId: string;
  readonly asked: Asked<EntityResolution>;
}

/** The order of firmness of a `missing` answer, firmest first. */
const MISSING_FIRMEST_FIRST: ReadonlyArray<EntityMissing> = [
  "inaccessible",
  "unknown",
  "not-found",
];

/** Returns the firmest `missing` among the answers, or undefined when no Connection said one. */
const pickFirmestMissing = (
  answers: ReadonlyArray<ConnectionAnswer>,
): EntityMissing | undefined => {
  const said = new Set<EntityMissing>();
  for (const { asked } of answers) {
    if (asked.status === "answered" && "missing" in asked.value) said.add(asked.value.missing);
  }
  return MISSING_FIRMEST_FIRST.find((missing) => said.has(missing));
};

/**
 * Summarizes one round of asking Connections, for a resolve and for a search.
 * `skipped` is whether eligible Connections were left out, by the limit or by
 * the deadline.
 *
 * - `incomplete` when a Connection was left out, which wins over everything
 *   else: the one left out may be usable, so the round must not say
 *   `unavailable`, which would tell the user to add a Connection.
 * - `unavailable` when every Connection that was asked timed out.
 * - `incomplete` when one failed or timed out while another answered.
 * - `complete` when all of them answered.
 */
const summarizeRound = <A>(
  answers: ReadonlyArray<{ readonly asked: Asked<A> }>,
  skipped: boolean,
): "complete" | "incomplete" | "unavailable" => {
  if (skipped) return "incomplete";
  if (answers.every(({ asked }) => asked.status === "timed-out")) return "unavailable";
  return answers.some(({ asked }) => asked.status !== "answered") ? "incomplete" : "complete";
};

/**
 * Decides the answer for a `ref` recognition, after the Connections were
 * asked in turn and none found it.
 */
const decideUnfoundRef = (
  answers: ReadonlyArray<ConnectionAnswer>,
  skipped: boolean,
): DecidedResolution => {
  const round = summarizeRound(answers, skipped);
  if (round === "unavailable") return { unavailable: true };
  if (round === "incomplete") return { incomplete: true };
  return { missing: pickFirmestMissing(answers) ?? "unknown" };
};

/**
 * Decides the answer for a `scoped` recognition, after every Connection was
 * asked. What was found is grouped by canonical ref, so two accounts that see
 * one thing give one answer.
 *
 * - Two or more refs: `ambiguous`, even when a Connection failed.
 * - One ref: `found`, unless a Connection failed or was left out. That
 *   Connection may hold another answer, so the result is `incomplete`.
 * - No ref: `incomplete` after a failure, else the firmest `missing`. When
 *   every Connection was ruled out by the scope, nothing could be read, so the
 *   answer is `unknown`.
 */
const decideScoped = (
  answers: ReadonlyArray<ConnectionAnswer>,
  skipped: boolean,
): DecidedResolution => {
  const foundByRef = new Map<string, LookupObservation>();
  for (const { connectionId, asked } of answers) {
    if (asked.status !== "answered" || !("found" in asked.value)) continue;
    const { ref } = asked.value.found;
    if (!foundByRef.has(ref)) foundByRef.set(ref, { connectionId, observation: asked.value.found });
  }
  if (foundByRef.size >= 2) return { ambiguous: [...foundByRef.keys()] };
  const round = summarizeRound(answers, skipped);
  if (round === "unavailable") return { unavailable: true };
  if (round === "incomplete") return { incomplete: true };
  const [only] = foundByRef.values();
  if (only !== undefined) return { found: only };
  return { missing: pickFirmestMissing(answers) ?? "unknown" };
};

/** Returns the recognition as the plugin wrote it, with the plugin id taken off its qualified `kind`. */
const removeKindQualifier = (pluginId: string, target: EntityRecognition): EntityRecognition => {
  const prefix = `${pluginId}/`;
  if (target.kind === undefined || !target.kind.startsWith(prefix)) return target;
  return { ...target, kind: target.kind.slice(prefix.length) };
};

/** Returns the recognition with its `kind`, when it has one, qualified by the plugin id. */
const qualifyKind = (pluginId: string, recognition: EntityRecognition): EntityRecognition =>
  recognition.kind === undefined
    ? recognition
    : { ...recognition, kind: `${pluginId}/${recognition.kind}` };

const make = Effect.gen(function* () {
  const host = yield* PluginHost;
  const connections = yield* connectionRepository;
  const connectionTypes = yield* ConnectionTypes;

  /**
   * Returns the active event source of the plugin that offers a lookup, with
   * that lookup, if any. Registration allows one `entityLookup` per plugin, so
   * the first source with a lookup is the only one.
   */
  const findLookupSource = (
    pluginId: string,
  ): Effect.Effect<
    Option.Option<{ readonly source: RegisteredEventSource; readonly lookup: EntityLookup }>
  > =>
    Effect.map(host.listActiveEventSources(), (sources) => {
      for (const source of sources) {
        if (source.pluginId === pluginId && source.entityLookup !== undefined) {
          return Option.some({ source, lookup: source.entityLookup });
        }
      }
      return Option.none();
    });

  /** Lists the Connections a lookup may use for `source`, oldest first. */
  const listEligibleConnections = (
    source: RegisteredEventSource,
  ): Effect.Effect<ReadonlyArray<StoredConnection>> =>
    Effect.map(Effect.orDie(connections.ofPlugin(source.pluginId)), (all) =>
      all.filter(
        (connection) =>
          connection.type === source.connectionType && canConnectionPoll(connection.status, true),
      ),
    );

  /**
   * Checks that the Connection `connectionId` is still one the lookup of
   * `source` may use: it exists, has the source's type, is `connected` or
   * `error`, and its plugin is active. Reads the current rows, so a disable
   * that committed a moment ago counts. Holds no transaction.
   */
  const isStillEligible = (
    source: RegisteredEventSource,
    connectionId: string,
  ): Effect.Effect<boolean> =>
    Effect.gen(function* () {
      const current = Option.getOrUndefined(yield* Effect.orDie(connections.one(connectionId)));
      if (current === undefined || current.type !== source.connectionType) return false;
      return canConnectionPoll(current.status, yield* host.isActive(source.pluginId));
    });

  /**
   * Runs one call to a plugin's lookup for one Connection, with a timeout.
   * Never fails: a failure of any kind (including a rejected credential and a
   * plugin that throws) is `failed`, and running past the timeout is
   * `timed-out`. A Connection that is no longer eligible is not asked and is
   * `failed`, and its `credentials` refuse once it stops being eligible.
   * Interruption passes through, since the controller is stopping.
   */
  const ask = <A>(
    source: RegisteredEventSource,
    connection: StoredConnection,
    call: (
      connection: IngestConnection,
      context: EntityLookupContext,
    ) => Effect.Effect<A, AuthError | PluginError>,
  ): Effect.Effect<Asked<A>> =>
    Effect.gen(function* () {
      if (!(yield* isStillEligible(source, connection.id))) {
        yield* Effect.logWarning(
          `The entity lookup of ${source.pluginId} skipped the Connection ${connection.id}, which is no longer eligible.`,
        );
        return { status: "failed" };
      }
      const exit = yield* Effect.exit(
        Effect.timeoutOption(
          Effect.flatMap(decodeConnectionConfig(connectionTypes, connection), (config) =>
            Effect.suspend(() =>
              call(
                {
                  id: connection.id,
                  config,
                  accountId: connection.accountId,
                  displayName: connection.displayName,
                },
                {
                  credentials: () =>
                    Effect.flatMap(isStillEligible(source, connection.id), (eligible) =>
                      eligible
                        ? connectionTypes.runtimeFor(source.pluginId).credentials(connection.id)
                        : Effect.fail(
                            new ConnectionUnavailable({
                              message: `the connection ${connection.id} can no longer be used for a lookup: it was disabled, or its plugin stopped`,
                            }),
                          ),
                    ),
                },
              ),
            ),
          ),
          Duration.seconds(LOOKUP_TIMEOUT_SECONDS),
        ),
      );
      if (Exit.isSuccess(exit)) {
        return Option.isSome(exit.value)
          ? { status: "answered", value: exit.value.value }
          : { status: "timed-out" };
      }
      if (Cause.hasInterrupts(exit.cause)) return yield* Effect.interrupt;
      yield* Effect.logWarning(
        `The entity lookup of ${source.pluginId} failed on the Connection ${connection.id}: ${summarizeCause(exit.cause)}`,
      );
      return { status: "failed" };
    });

  return {
    /**
     * Returns what each active plugin's lookup recognizes in `text`, plugin by
     * plugin in registry order. Pure: no plugin gets credentials, and none
     * makes a request. A recognition's `kind`, when it has one, is qualified
     * with the plugin id. A lookup that throws recognizes nothing, and a warning
     * in the log names the plugin.
     */
    recognize: (text: string): Effect.Effect<ReadonlyArray<PluginRecognition>> =>
      Effect.flatMap(host.listActiveEventSources(), (sources) =>
        Effect.map(
          Effect.forEach(sources, (source) => {
            const lookup = source.entityLookup;
            if (lookup === undefined) return Effect.succeed<ReadonlyArray<PluginRecognition>>([]);
            try {
              return Effect.succeed(
                lookup
                  .recognize(text)
                  .slice(0, MAX_RECOGNITIONS)
                  .map((recognition) => ({
                    pluginId: source.pluginId,
                    recognition: qualifyKind(source.pluginId, recognition),
                  })),
              );
            } catch (error) {
              return Effect.as(
                Effect.logWarning(
                  `The entity lookup of ${source.pluginId} failed to recognize a text: ${String(error)}`,
                ),
                [] as ReadonlyArray<PluginRecognition>,
              );
            }
          }),
          (perSource) => perSource.flat(),
        ),
      ),

    /** Returns the ids of the active plugins whose lookup recognizes links, in registry order. */
    listLinkSources: (): Effect.Effect<ReadonlyArray<string>> =>
      Effect.map(host.listActiveEventSources(), (sources) => [
        ...new Set(
          sources.filter((source) => source.entityLookup !== undefined).map((s) => s.pluginId),
        ),
      ]),

    /**
     * Searches the source of `pluginId` through its eligible Connections, at
     * most 4, oldest first, all at once. The results are merged by ref, and the
     * oldest Connection that returned a ref names it. `incomplete` is true when
     * a Connection failed or eligible ones were left out. The outcome is
     * `source-unavailable` when the plugin has no lookup, no Connection is
     * eligible, or every eligible Connection was asked and timed out.
     */
    search: (
      pluginId: string,
      query: { readonly text: string; readonly scopeRef?: string; readonly limit: number },
    ): Effect.Effect<SearchOutcome> =>
      Effect.gen(function* () {
        const unavailable: SearchOutcome = {
          observations: [],
          incomplete: false,
          outcome: "source-unavailable",
        };
        const found = yield* findLookupSource(pluginId);
        if (Option.isNone(found)) return unavailable;
        const { source, lookup } = found.value;
        const eligible = yield* listEligibleConnections(source);
        if (eligible.length === 0) return unavailable;
        const asked = eligible.slice(0, MAX_SEARCH_CONNECTIONS);
        const answers = yield* Effect.forEach(
          asked,
          (connection) =>
            Effect.map(
              ask(source, connection, (ingestConnection, context) =>
                lookup.search(ingestConnection, context, query),
              ),
              (result) => ({ connectionId: connection.id, asked: result }),
            ),
          { concurrency: "unbounded" },
        );
        const round = summarizeRound(answers, eligible.length > asked.length);
        if (round === "unavailable") return unavailable;
        const byRef = new Map<string, LookupObservation>();
        for (const { connectionId, asked: result } of answers) {
          if (result.status !== "answered") continue;
          for (const observation of result.value) {
            if (!byRef.has(observation.ref))
              byRef.set(observation.ref, { connectionId, observation });
          }
        }
        return {
          observations: [...byRef.values()].slice(0, query.limit),
          incomplete: round === "incomplete",
          outcome: "results",
        };
      }),

    /**
     * Reads the thing `target` names through the eligible Connections of the
     * plugin `pluginId`, at most 8, oldest first, and returns one answer for
     * all of them. `target` is a recognition as `recognize` returned it, with
     * a qualified `kind`.
     *
     * - A `ref` recognition asks in turn, until one Connection finds it. It
     *   starts no new call once 8 seconds have passed since it began, so a
     *   row of slow Connections cannot hold the caller for a minute: the
     *   rest are left out, as the limit leaves out.
     * - A `scoped` recognition asks every Connection at once.
     *
     * The answer is `unavailable` when the plugin has no lookup, no
     * Connection is eligible, or every eligible Connection was asked and
     * timed out. A failed Connection (a rejected credential included) and
     * eligible Connections left out by the limit or the deadline make a
     * missing or single answer `incomplete`, even when every Connection that
     * was asked timed out.
     */
    resolve: (pluginId: string, target: EntityRecognition): Effect.Effect<DecidedResolution> =>
      Effect.gen(function* () {
        const found = yield* findLookupSource(pluginId);
        if (Option.isNone(found)) return { unavailable: true };
        const { source, lookup } = found.value;
        const eligible = yield* listEligibleConnections(source);
        if (eligible.length === 0) return { unavailable: true };
        const asking = eligible.slice(0, MAX_RESOLVE_CONNECTIONS);
        const skipped = eligible.length > asking.length;
        const plainTarget = removeKindQualifier(pluginId, target);
        const askConnection = (connection: StoredConnection): Effect.Effect<ConnectionAnswer> =>
          Effect.map(
            ask(source, connection, (ingestConnection, context) =>
              lookup.resolve(ingestConnection, context, plainTarget),
            ),
            (asked) => ({ connectionId: connection.id, asked }),
          );

        if (target.recognized === "scoped") {
          const answers = yield* Effect.forEach(asking, askConnection, {
            concurrency: "unbounded",
          });
          return decideScoped(answers, skipped);
        }

        const startedAt = yield* Clock.currentTimeMillis;
        const answers: Array<ConnectionAnswer> = [];
        for (const connection of asking) {
          const elapsed = (yield* Clock.currentTimeMillis) - startedAt;
          if (elapsed >= LOOKUP_TIMEOUT_SECONDS * 1000) {
            // Later Connections are left out, so the answer says it is not sure.
            return decideUnfoundRef(answers, true);
          }
          const answer = yield* askConnection(connection);
          if (answer.asked.status === "answered" && "found" in answer.asked.value) {
            return {
              found: { connectionId: answer.connectionId, observation: answer.asked.value.found },
            };
          }
          answers.push(answer);
        }
        return decideUnfoundRef(answers, skipped);
      }),
  };
});

/** Reads and searches the things plugins can find at their source, for the Add button on Work. */
export class EntityLookups extends Context.Service<EntityLookups, Effect.Success<typeof make>>()(
  "hercule/controller/plugins/EntityLookups",
) {}

export const EntityLookupsLayer: Layer.Layer<
  EntityLookups,
  never,
  SqlClient.SqlClient | PluginHost | ConnectionTypes
> = Layer.effect(EntityLookups)(make);
