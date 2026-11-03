/**
 * Reads the newest release of each registered harness from the public npm
 * registry and stores what it found, so `harness.query` can tell the user
 * that a newer release exists (spec 06 section 2).
 *
 * The read is one HTTPS GET per harness to `<registry>/<package>/latest`. The
 * answer is the package's `package.json` for its newest release, of which
 * only `version` is used. A failed read keeps the last good version and
 * stores why it failed.
 */
import * as Clock from "effect/Clock";
import * as Context from "effect/Context";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import * as HttpClient from "effect/http/HttpClient";
import type * as HttpClientResponse from "effect/http/HttpClientResponse";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";
import * as SqlClient from "effect/sql/SqlClient";
import type { SqlError } from "effect/sql/SqlError";
import * as Stream from "effect/Stream";
import type { HarnessLatestRelease } from "@hercule/contract";
import type { HarnessReleaseSource } from "@hercule/plugin-host";
import { announce, withTransaction } from "../db";
import { PluginHost } from "../plugins";
import { harnessRepository } from "./repository";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";

/** How long the registry has to answer. A hung registry must not hold the hourly read open. */
const RELEASE_READ_TIMEOUT: Duration.Duration = Duration.seconds(10);

/**
 * The most bytes of the registry's answer that are read. The answers are
 * about 5 kB today. A body that never ends must not fill memory.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** The longest version that is stored. A real one is under 50 characters. */
const MAX_VERSION_LENGTH = 100;

/** The part of the registry's answer that is used. Other fields are ignored. */
const decodeLatestBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Struct({ version: Schema.optionalKey(Schema.Unknown) })),
);

/** Three numbers, then an optional `-prerelease` and an optional `+build`. */
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Checks that a value is a semantic version of at most `MAX_VERSION_LENGTH` characters. */
const isSemanticVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_VERSION_LENGTH && SEMANTIC_VERSION.test(value);

/** What one read of the registry found. `error` is a sentence for the user. */
type ReleaseReadOutcome =
  | { readonly _tag: "read"; readonly version: string; readonly checkedAt: string }
  | { readonly _tag: "failed"; readonly error: string };

/** Builds the outcome of a read that failed, with the sentence to show the user. */
const buildFailedRead = (error: string): ReleaseReadOutcome => ({ _tag: "failed", error });

/** Returns the URL of the newest release of an npm package. The name is encoded so it cannot change the path. */
const buildLatestUrl = (source: HarnessReleaseSource): string =>
  `${NPM_REGISTRY_URL}/${encodeURIComponent(source.package)}/latest`;

/**
 * Reads the response body as text, and returns `None` when it is longer than
 * `MAX_BODY_BYTES`. The rest of a body that is too long is not read.
 */
const readBoundedText = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<Option.Option<string>, unknown> =>
  Effect.gen(function* () {
    const chunks: Array<Uint8Array> = [];
    let size = 0;
    yield* Stream.runForEachWhile(response.stream, (chunk) =>
      Effect.sync(() => {
        chunks.push(chunk);
        size += chunk.length;
        return size <= MAX_BODY_BYTES;
      }),
    );
    return size > MAX_BODY_BYTES
      ? Option.none()
      : Option.some(new TextDecoder().decode(Buffer.concat(chunks)));
  });

/**
 * What one harness's read found, compared with what is stored for it.
 *
 * - A successful read is always stored, because it moves the time of the last
 *   check. It is announced only when the version or the error changed.
 * - A failed read is stored and announced only when its error is not the one
 *   already stored.
 */
const decideWrite = (
  outcome: ReleaseReadOutcome,
  stored: HarnessLatestRelease | undefined,
): { readonly write: boolean; readonly announce: boolean } => {
  if (outcome._tag === "read") {
    return {
      write: true,
      announce: stored === undefined || stored.version !== outcome.version || stored.error !== null,
    };
  }
  const changed = stored === undefined || stored.error !== outcome.error;
  return { write: changed, announce: changed };
};

const make = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient;
  const host = yield* PluginHost;
  const releases = yield* harnessRepository;
  // Each request runs in a scope of its own, and closing the scope aborts a
  // response body that nobody read.
  const client = (yield* HttpClient.HttpClient).pipe(HttpClient.withScope);

  /** Reads the newest release of one package. Never fails: every problem is a `failed` outcome. */
  const readLatestRelease = (
    source: HarnessReleaseSource,
  ): Effect.Effect<ReleaseReadOutcome, never, never> =>
    Effect.gen(function* () {
      const response = yield* client.get(buildLatestUrl(source));
      if (response.status !== 200) {
        return buildFailedRead(`The npm registry answered ${response.status}.`);
      }
      const text = yield* readBoundedText(response);
      const body = Option.flatMap(text, decodeLatestBody);
      if (Option.isNone(body))
        return buildFailedRead("The npm registry's answer could not be read.");
      if (body.value.version === undefined) {
        return buildFailedRead("The npm registry's answer had no version.");
      }
      if (!isSemanticVersion(body.value.version)) {
        return buildFailedRead("The npm registry's answer could not be read.");
      }
      const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return { _tag: "read" as const, version: body.value.version, checkedAt };
    }).pipe(
      Effect.scoped,
      // The registry is a third party: no trace headers go to it.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({
        duration: RELEASE_READ_TIMEOUT,
        orElse: () => Effect.succeed(buildFailedRead("The npm registry did not answer in time.")),
      }),
      Effect.catch(() => Effect.succeed(buildFailedRead("Could not reach the npm registry."))),
    );

  /**
   * Reads the newest release of each of the harnesses, all at once, and then
   * stores the outcomes in one transaction. The requests finish before the
   * transaction starts, so no transaction waits on the network.
   */
  const readAndStore = (
    definitions: ReadonlyArray<{
      readonly id: string;
      readonly releaseSource: HarnessReleaseSource;
    }>,
  ): Effect.Effect<void, SqlError> =>
    Effect.gen(function* () {
      if (definitions.length === 0) return;
      const outcomes = yield* Effect.forEach(
        definitions,
        (definition) =>
          Effect.map(
            readLatestRelease(definition.releaseSource),
            (outcome) => [definition.id, outcome] as const,
          ),
        { concurrency: "unbounded" },
      );
      yield* withTransaction(
        sql,
        Effect.gen(function* () {
          const stored = yield* releases.readLatestReleases();
          for (const [harnessId, outcome] of outcomes) {
            const { write, announce: changed } = decideWrite(outcome, stored.get(harnessId));
            if (write) {
              yield* outcome._tag === "read"
                ? releases.recordReleaseRead(harnessId, outcome.version, outcome.checkedAt)
                : releases.recordReleaseReadFailure(harnessId, outcome.error);
            }
            if (changed) {
              // Clients ignore the ids of a `provider` update. The changes of
              // one transaction are sent together, as one push.
              yield* announce({
                _tag: "record",
                topic: "provider",
                id: harnessId,
                kind: "updated",
              });
            }
          }
        }),
      );
    });

  return {
    /**
     * Reads the newest release of every registered harness from its
     * publisher, all at once, and stores what each read found. Fails only
     * with a `SqlError` when the outcomes cannot be stored. A read that fails
     * is not a failure of this method: it stores the error and keeps the
     * harness's last good version and the time it was read.
     *
     * The requests finish before the one transaction that stores the
     * outcomes starts, so no transaction waits on the network. A successful
     * read always stores its time. When the transaction commits, it announces
     * one update on the `provider` topic for each harness whose version or
     * error changed, because that is what `harness.query` answers
     * differently. A failed read is stored and announced only when its error
     * differs from the stored one. That topic is the one whose update makes
     * clients read the harness list again.
     */
    refreshLatestReleases: (): Effect.Effect<void, SqlError> =>
      Effect.flatMap(host.harnesses(), readAndStore),

    /**
     * Reads the newest release only of the registered harnesses that have no
     * stored result yet, which means a harness plugin added since the last
     * read. Stores and announces as `refreshLatestReleases` does. Makes no
     * request, no write and no announcement when every harness has a result.
     * Fails only with a `SqlError`.
     */
    readUnreadReleases: (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const definitions = yield* host.harnesses();
        const stored = yield* releases.readLatestReleases();
        yield* readAndStore(definitions.filter((definition) => !stored.has(definition.id)));
      }),
  };
});

export class HarnessReleases extends Context.Service<
  HarnessReleases,
  Effect.Success<typeof make>
>()("hercule/controller/harnesses/HarnessReleases") {}

export const HarnessReleasesLayer: Layer.Layer<
  HarnessReleases,
  never,
  SqlClient.SqlClient | PluginHost | HttpClient.HttpClient
> = Layer.effect(HarnessReleases)(make);
