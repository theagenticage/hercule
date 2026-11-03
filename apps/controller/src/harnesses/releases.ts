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
  Schema.fromJsonString(
    Schema.Struct({
      version: Schema.NonEmptyString.check(Schema.isMaxLength(MAX_VERSION_LENGTH)),
    }),
  ),
);

/** What one read of the registry found. `error` is a sentence for the user. */
type ReleaseReadOutcome =
  | { readonly _tag: "read"; readonly version: string; readonly readAt: string }
  | { readonly _tag: "failed"; readonly error: string };

/** Returns the URL of the newest release of an npm package. The name is encoded so it cannot change the path. */
const buildLatestUrl = (source: HarnessReleaseSource): string =>
  `${NPM_REGISTRY_URL}/${encodeURIComponent(source.package)}/latest`;

/** Reads at most `MAX_BODY_BYTES` of the response body as text and ignores the rest. */
const readBoundedText = (
  response: HttpClientResponse.HttpClientResponse,
): Effect.Effect<string, unknown> =>
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
    return new TextDecoder().decode(Buffer.concat(chunks).subarray(0, MAX_BODY_BYTES));
  });

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
      const unreachable: ReleaseReadOutcome = {
        _tag: "failed",
        error: "Could not reach the npm registry.",
      };
      return yield* Effect.gen(function* () {
        const response = yield* client.get(buildLatestUrl(source));
        if (response.status !== 200) {
          return {
            _tag: "failed",
            error: `The npm registry answered ${response.status}.`,
          } satisfies ReleaseReadOutcome;
        }
        const body = decodeLatestBody(yield* readBoundedText(response));
        if (Option.isNone(body)) {
          return {
            _tag: "failed",
            error: "The npm registry's answer had no version.",
          } satisfies ReleaseReadOutcome;
        }
        const readAt = new Date(yield* Clock.currentTimeMillis).toISOString();
        return { _tag: "read", version: body.value.version, readAt } satisfies ReleaseReadOutcome;
      }).pipe(
        Effect.scoped,
        // The registry is a third party: no trace headers go to it.
        Effect.provideService(HttpClient.TracerPropagationEnabled, false),
        Effect.timeoutOrElse({
          duration: RELEASE_READ_TIMEOUT,
          orElse: () =>
            Effect.succeed<ReleaseReadOutcome>({
              _tag: "failed",
              error: "The npm registry did not answer in time.",
            }),
        }),
        Effect.catch(() => Effect.succeed(unreachable)),
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
     * outcomes starts, so no transaction waits on the network. When the
     * transaction commits, it announces one update on the `provider` topic,
     * for a successful read and a failed one alike, because both change what
     * `harness.query` answers. That topic is the one whose update makes
     * clients read the harness list again.
     */
    refreshLatestReleases: (): Effect.Effect<void, SqlError> =>
      Effect.gen(function* () {
        const definitions = yield* host.harnesses();
        const outcomes = yield* Effect.forEach(
          definitions,
          (definition) =>
            Effect.map(
              readLatestRelease(definition.releaseSource),
              (outcome) => [definition.id, outcome] as const,
            ),
          { concurrency: "unbounded" },
        );
        if (outcomes.length === 0) return;
        yield* withTransaction(
          sql,
          Effect.gen(function* () {
            for (const [harnessId, outcome] of outcomes) {
              yield* outcome._tag === "read"
                ? releases.recordReleaseRead(harnessId, outcome.version, outcome.readAt)
                : releases.recordReleaseReadFailure(harnessId, outcome.error);
              // Clients ignore the ids of a `provider` update. The changes of
              // one transaction are sent together, as one push.
              yield* announce({
                _tag: "record",
                topic: "provider",
                id: harnessId,
                kind: "updated",
              });
            }
          }),
        );
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
