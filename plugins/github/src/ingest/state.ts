/**
 * The feeds' own state in the Connection's key-value store: cursors, ETags
 * and snapshots. Every key belongs to one feed, and to one repository for the
 * per-repository feeds, such as `repos/octocat/hello-world`.
 *
 * The host deletes all of it when the Connection is deleted or the plugin's
 * state is reset, and a feed with no state baselines again, so deleting state
 * is always safe.
 */
import { Effect, Option, Schema } from "effect";
import { PluginError, type IngestContext, type KeyValueStore } from "@hercule/plugin-host";

/** The work of one per-repository feed on one repository in one poll: what it needs and where its events go. */
export interface RepoPoll {
  /** The repository, as lowercase `owner/repo`. */
  readonly repo: string;
  readonly token: string;
  readonly emit: IngestContext["emit"];
}

/**
 * Reads one key and decodes it against the shape the feed writes. Returns
 * `Option.none()` when the key is absent. Fails with a `PluginError` when the
 * stored value has another shape, which only a different version of this
 * plugin could have written: the feed stops rather than guess, and the
 * message tells the user how to start the feed afresh.
 */
export const readFeedState = <S extends Schema.ConstraintDecoder<unknown>>(
  store: KeyValueStore,
  key: string,
  schema: S,
): Effect.Effect<Option.Option<S["Type"]>, PluginError> =>
  Effect.flatMap(store.get(key), (stored) => {
    if (Option.isNone(stored)) return Effect.succeed(Option.none());
    return Schema.decodeUnknownEffect(schema)(stored.value).pipe(
      Effect.map(Option.some),
      Effect.mapError(
        (error) =>
          new PluginError({
            message:
              `The GitHub plugin could not read its stored state "${key}": ${error.message}. ` +
              "Reset the plugin's state in Settings to start its feeds again from now.",
          }),
      ),
    );
  });

/**
 * Deletes the state of every repository that left the watch list. The keys
 * are `<prefix><owner>/<repo>`. A repository added back later then baselines
 * again, instead of diffing against a snapshot that may be weeks old and
 * emitting everything that changed in between.
 */
const deleteDepartedRepoState = (
  store: KeyValueStore,
  prefix: string,
  watchList: ReadonlyArray<string>,
): Effect.Effect<void> =>
  Effect.flatMap(store.list(), (keys) => {
    const watched = new Set(watchList.map((repo) => `${prefix}${repo}`));
    const departed = keys.filter((key) => key.startsWith(prefix) && !watched.has(key));
    return Effect.forEach(departed, (key) => store.delete(key), { discard: true });
  });

/**
 * Polls every repository on the watch list in turn for one per-repository
 * feed, keeping each repository's state under `<feed>/<owner>/<repo>`.
 * `pollRepo` receives the stored state, or `Option.none()` for a repository
 * polled for the first time, and returns the state to store. The state of a
 * repository that left the watch list is deleted first.
 *
 * One repository failing with a `PluginError`, such as one the token cannot
 * see, does not stop the others: their events are emitted and their state
 * stored, and then this fails with one `PluginError` naming every repository
 * that failed and saying how to stop watching one that is gone. Any other error, a rejected token or a rate limit, applies to
 * every repository alike, so it stops the poll at once.
 */
export const pollWatchedRepos = <A extends Schema.Json, E, R>(
  feed: string,
  store: KeyValueStore,
  watchList: ReadonlyArray<string>,
  schema: Schema.ConstraintDecoder<A>,
  pollRepo: (repo: string, stored: Option.Option<A>) => Effect.Effect<A, E, R>,
): Effect.Effect<void, E | PluginError, R> =>
  Effect.gen(function* () {
    const prefix = `${feed}/`;
    yield* deleteDepartedRepoState(store, prefix, watchList);
    const failures: Array<string> = [];
    for (const repo of watchList) {
      const key = `${prefix}${repo}`;
      yield* Effect.gen(function* () {
        const stored = yield* readFeedState(store, key, schema);
        const next = yield* pollRepo(repo, stored);
        yield* store.set(key, next);
      }).pipe(
        Effect.catchIf(
          (error): error is PluginError => error instanceof PluginError,
          // The failures are joined into one sentence, so a message's own
          // closing period is dropped.
          (error) =>
            Effect.sync(() => failures.push(`${repo}: ${error.message.replace(/\.$/, "")}`)),
        ),
      );
    }
    if (failures.length > 0) {
      return yield* new PluginError({
        message:
          `The ${feed} feed could not poll ${failures.join("; ")}. ` +
          "The other repositories on the watch list were polled. " +
          "If a repository was deleted, renamed or hidden from the Connection's account, " +
          "unlink its repo Resource or remove it from the Connection's extra repositories.",
      });
    }
  });
