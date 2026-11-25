/**
 * Reads the newest release of each registered harness from the place that
 * publishes it, and stores what it found, so `harness.query` can tell the
 * user that a newer release exists (spec 06 section 2).
 *
 * A harness is published on the public npm registry or as GitHub releases.
 * The read is one HTTPS GET per harness to that publisher. The answer
 * describes the newest release, and only the field that holds its version is
 * used. A failed read keeps the last good version and stores why it failed.
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
import { capitalize } from "../text";
import { harnessRepository } from "./repository";

const NPM_REGISTRY_URL = "https://registry.npmjs.org";
const GITHUB_API_URL = "https://api.github.com";

/** How long a publisher has to answer. A hung publisher must not hold the hourly read open. */
const RELEASE_READ_TIMEOUT: Duration.Duration = Duration.seconds(10);

/**
 * The most bytes of a publisher's answer that are read. The npm registry's
 * answers are about 5 kB and GitHub's about 18 kB today. A body that never
 * ends must not fill memory.
 */
const MAX_BODY_BYTES = 256 * 1024;

/** The longest version that is stored. A real one is under 50 characters. */
const MAX_VERSION_LENGTH = 100;

/** Parses a publisher's answer into its fields, which are looked up by name. A body that is not a JSON object is `None`. */
const decodeLatestBody = Schema.decodeUnknownOption(
  Schema.fromJsonString(Schema.Record(Schema.String, Schema.Unknown)),
);

/** Three numbers, then an optional `-prerelease` and an optional `+build`. */
const SEMANTIC_VERSION = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/;

/** Checks that a value is a semantic version of at most `MAX_VERSION_LENGTH` characters. */
const isSemanticVersion = (value: unknown): value is string =>
  typeof value === "string" && value.length <= MAX_VERSION_LENGTH && SEMANTIC_VERSION.test(value);

/** What one read of a publisher found. `error` is a sentence for the user. */
type ReleaseReadOutcome =
  | { readonly _tag: "read"; readonly version: string; readonly checkedAt: string }
  | { readonly _tag: "failed"; readonly error: string };

/** Builds the outcome of a read that failed, with the sentence to show the user. */
const buildFailedRead = (error: string): ReleaseReadOutcome => ({ _tag: "failed", error });

/** What differs between publishers in the request for the newest release and in reading the answer. */
interface ReleaseRequest {
  /** The publisher's name as it is written inside a sentence, such as "the npm registry". */
  readonly publisher: string;
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  /** The field of the answer that holds the version. */
  readonly versionField: string;
}

/**
 * Builds the request for the newest release of a harness, from where the
 * harness says it is published.
 *
 * - npm: the name of the package is encoded so that it cannot change the
 *   path, and the answer's `version` is read.
 * - GitHub: the repository is checked at registration, and the answer's
 *   `tag_name` is read. GitHub refuses a request that has no `user-agent`,
 *   so one is sent, with the product name only. No credential is sent.
 */
const buildReleaseRequest = (source: HarnessReleaseSource): ReleaseRequest => {
  switch (source.kind) {
    case "npm":
      return {
        publisher: "the npm registry",
        url: `${NPM_REGISTRY_URL}/${encodeURIComponent(source.package)}/latest`,
        headers: {},
        versionField: "version",
      };
    case "github-releases":
      return {
        publisher: "GitHub",
        url: `${GITHUB_API_URL}/repos/${source.repository}/releases/latest`,
        headers: { "user-agent": "Hercule" },
        versionField: "tag_name",
      };
  }
};

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
      announce:
        stored === undefined ||
        stored.lastGoodRead?.version !== outcome.version ||
        stored.error !== null,
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

  /** Reads the newest release of one harness. Never fails: every problem is a `failed` outcome. */
  const readLatestRelease = (
    source: HarnessReleaseSource,
  ): Effect.Effect<ReleaseReadOutcome, never, never> => {
    const { publisher, url, headers, versionField } = buildReleaseRequest(source);
    const sentenceSubject = capitalize(publisher);
    return Effect.gen(function* () {
      const response = yield* client.get(url, { headers });
      if (response.status !== 200)
        return buildFailedRead(`${sentenceSubject} answered ${response.status}.`);
      const text = yield* readBoundedText(response);
      const body = Option.flatMap(text, decodeLatestBody);
      if (Option.isNone(body))
        return buildFailedRead(`${sentenceSubject}'s answer could not be read.`);
      const version = body.value[versionField];
      if (version === undefined)
        return buildFailedRead(`${sentenceSubject}'s answer had no version.`);
      if (!isSemanticVersion(version)) {
        return buildFailedRead(`${sentenceSubject}'s answer could not be read.`);
      }
      const checkedAt = new Date(yield* Clock.currentTimeMillis).toISOString();
      return { _tag: "read" as const, version, checkedAt };
    }).pipe(
      Effect.scoped,
      // The publisher is a third party: no trace headers go to it.
      Effect.provideService(HttpClient.TracerPropagationEnabled, false),
      Effect.timeoutOrElse({
        duration: RELEASE_READ_TIMEOUT,
        orElse: () => Effect.succeed(buildFailedRead(`${sentenceSubject} did not answer in time.`)),
      }),
      Effect.catch(() => Effect.succeed(buildFailedRead(`Could not reach ${publisher}.`))),
    );
  };

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
