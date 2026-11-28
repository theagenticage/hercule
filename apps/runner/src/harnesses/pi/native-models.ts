/**
 * Finds the models pi ships for a provider, which the adapter must not declare
 * in `models.json`: a declaration with the id of a shipped model replaces pi's
 * own definition of it and loses its thinking levels, compatibility settings
 * and cost.
 */
import { createHash } from "node:crypto";
import { statSync } from "node:fs";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import { fetchCatalog } from "./probe";
import { STARTUP_DEADLINE, type PiSpawn } from "./rpc";

/** How a listing ended, as the cache keeps it. */
type Listing =
  | { readonly _tag: "listed"; readonly ids: ReadonlySet<string> }
  | { readonly _tag: "failed"; readonly message: string };

interface CacheEntry {
  /** What the listing was made from: the pi binary and the model store's content. A different fingerprint makes the entry stale. */
  readonly fingerprint: string;
  /** The listing, finished or still running, so a start that arrives meanwhile shares it. */
  readonly listing: Promise<Listing>;
}

/** Returns the size and modification time of the pi binary, or `absent` when it is missing or unreadable. */
const describeBinary = (path: string): string => {
  try {
    const stat = statSync(path);
    return `${String(stat.size)}:${String(stat.mtimeMs)}`;
  } catch {
    return "absent";
  }
};

/** Returns a hash of the model store's bytes, or `absent` when the home has no store. */
const hashModelStore = (store: Buffer | undefined): string =>
  store === undefined ? "absent" : createHash("sha256").update(store).digest("hex");

/**
 * Builds the function that lists the ids of the models pi ships for a
 * provider, with the cache that goes with it. One lister belongs to one
 * adapter, so the cache lives as long as the runner process.
 *
 * The returned function lists them the way the probe does (`fetchCatalog`): a
 * pi in a scratch agent directory that holds only `store`, the bytes of the
 * Harness Home's `models-store.json` (undefined when the home has none), given
 * the account's credential through `env`, so it lists the models of the
 * provider and none the home declared. The caller reads the store once and
 * passes the bytes, so the list is derived from exactly the store its own pi
 * will load. It fails with a message when pi cannot be started or does not
 * answer within `STARTUP_DEADLINE`, the same time a launch gives its pi to
 * answer its model check.
 *
 * pi's list depends on its binary and on the store (the list `pi update
 * --models` refreshed). So the answer is cached per home and provider, and used
 * again while the pi binary's size and modification time and the hash of the
 * store's bytes stay the same: a refreshed store or a new pi binary is picked
 * up at the next call. Starts that arrive while a listing runs share it. A
 * failed listing and an empty one are not kept, because an empty one means pi
 * found no key for the provider, and a later start may have one.
 *
 * Listing costs one pi process, about a second. A cached answer costs one
 * `stat` call and one hash of the store.
 */
export const makeNativeModelLister = (spawn: PiSpawn) => {
  const cache = new Map<string, CacheEntry>();

  const list = (
    binary: string,
    store: Buffer | undefined,
    env: Readonly<Record<string, string | undefined>>,
    provider: string,
  ): Promise<Listing> =>
    Effect.runPromise(
      fetchCatalog(spawn, binary, store, env, provider).pipe(
        Effect.timeoutOption(STARTUP_DEADLINE),
        Effect.map(
          Option.match({
            onNone: (): Listing => ({
              _tag: "failed",
              message: `pi did not list its models within ${Duration.format(STARTUP_DEADLINE)}`,
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
    store: Buffer | undefined,
    env: Readonly<Record<string, string | undefined>>,
    provider: string,
  ): Effect.Effect<ReadonlySet<string>, string> =>
    Effect.suspend(() => {
      const key = `${home}\0${provider}`;
      const fingerprint = `${binary}:${describeBinary(binary)}|${hashModelStore(store)}`;
      const cached = cache.get(key);
      let entry: CacheEntry;
      if (cached !== undefined && cached.fingerprint === fingerprint) {
        entry = cached;
      } else {
        const started: CacheEntry = { fingerprint, listing: list(binary, store, env, provider) };
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
