/**
 * Finds the models pi ships for a provider, which the adapter must not declare
 * in `models.json`: a declaration with the id of a shipped model replaces pi's
 * own definition of it and loses its thinking levels, compatibility settings
 * and cost.
 */
import { statSync } from "node:fs";
import { join } from "node:path";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { PROBE_DEADLINE } from "../probe";
import { fetchCatalog } from "./probe";
import type { PiSpawn } from "./rpc";

/** How a listing ended, as the cache keeps it. */
type Listing =
  | { readonly _tag: "listed"; readonly ids: ReadonlySet<string> }
  | { readonly _tag: "failed"; readonly message: string };

interface CacheEntry {
  /** What the listing was made from. A different fingerprint makes the entry stale. */
  readonly fingerprint: string;
  /** The listing, finished or still running, so a start that arrives meanwhile shares it. */
  readonly listing: Promise<Listing>;
}

/** Returns the size and modification time of a file, or `absent` when it is missing or unreadable. */
const describeFile = (path: string): string => {
  try {
    const stat = statSync(path);
    return `${String(stat.size)}:${String(stat.mtimeMs)}`;
  } catch {
    return "absent";
  }
};

/**
 * Builds the function that lists the ids of the models pi ships for a
 * provider, with the cache that goes with it. One lister belongs to one
 * adapter, so the cache lives as long as the runner process.
 *
 * The returned function lists them the way the probe does (`fetchCatalog`): a
 * pi in a scratch agent directory that holds only a copy of the Harness Home's
 * `models-store.json`, given the account's credential through `env`, so it
 * lists the models of the provider and none the home declared. It fails with
 * a message when pi cannot be started or does not answer within
 * `PROBE_DEADLINE`.
 *
 * pi's list depends on its binary and on the home's `models-store.json` (the
 * list `pi update --models` refreshed). So the answer is cached per home and
 * provider, and used again while the size and modification time of both files
 * stay the same: a refreshed store or a new pi binary is picked up at the next
 * call. Starts that arrive while a listing runs share it. A failed listing and
 * an empty one are not kept, because an empty one means pi found no key for
 * the provider, and a later start may have one.
 *
 * Listing costs one pi process, about a second. A cached answer costs two
 * `stat` calls.
 */
export const makeNativeModelLister = (spawn: PiSpawn) => {
  const cache = new Map<string, CacheEntry>();

  const list = (
    binary: string,
    home: string,
    env: Readonly<Record<string, string | undefined>>,
    provider: string,
  ): Promise<Listing> =>
    Effect.runPromise(
      fetchCatalog(spawn, binary, home, env, provider).pipe(
        Effect.timeoutOption(PROBE_DEADLINE),
        Effect.map(
          Option.match({
            onNone: (): Listing => ({
              _tag: "failed",
              message: `pi did not list its models within ${Duration.format(PROBE_DEADLINE)}`,
            }),
            onSome: (models): Listing => ({
              _tag: "listed",
              ids: new Set(models.map((model) => model.slug)),
            }),
          }),
        ),
        Effect.catch((message) => Effect.succeed<Listing>({ _tag: "failed", message })),
      ),
    );

  return (
    binary: string,
    home: string,
    env: Readonly<Record<string, string | undefined>>,
    provider: string,
  ): Effect.Effect<ReadonlySet<string>, string> =>
    Effect.suspend(() => {
      const key = `${home}\0${provider}`;
      const fingerprint = `${binary}:${describeFile(binary)}|${describeFile(join(home, "models-store.json"))}`;
      const cached = cache.get(key);
      let entry: CacheEntry;
      if (cached !== undefined && cached.fingerprint === fingerprint) {
        entry = cached;
      } else {
        const started: CacheEntry = { fingerprint, listing: list(binary, home, env, provider) };
        cache.set(key, started);
        void started.listing.then((listing) => {
          const kept = listing._tag === "listed" && listing.ids.size > 0;
          if (!kept && cache.get(key) === started) cache.delete(key);
        });
        entry = started;
      }
      return Effect.promise(() => entry.listing).pipe(
        Effect.flatMap((listing) =>
          listing._tag === "listed" ? Effect.succeed(listing.ids) : Effect.fail(listing.message),
        ),
      );
    });
};
