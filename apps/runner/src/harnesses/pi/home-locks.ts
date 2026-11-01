import * as Effect from "effect/Effect";
import * as Semaphore from "effect/Semaphore";

/**
 * Runs `body` holding the launch lock of a Harness Home, and gives it
 * `release` to let go of the lock before `body` ends. The lock is released when
 * `body` ends in any way, so a failed or interrupted holder never keeps it.
 */
export type HoldHome = <A, E, R>(
  home: string,
  body: (release: Effect.Effect<void>) => Effect.Effect<A, E, R>,
) => Effect.Effect<A, E, R>;

/**
 * Builds the function that holds the launch lock of a Harness Home. One
 * adapter builds one, so the locks live as long as the runner process.
 *
 * The lock keeps the home's `models.json` and `models-store.json` still while
 * a pi process that depends on them starts. A launch holds it from before it
 * reads the store until its pi has loaded; a refresh of the model list holds it
 * only while it copies the refreshed store into the home. Taking the lock waits
 * for the holder before it, and can be interrupted while it waits.
 */
export const makeHomeLocks = (): HoldHome => {
  const locks = new Map<string, Semaphore.Semaphore>();
  return (home, body) => {
    let lock = locks.get(home);
    if (lock === undefined) {
      lock = Semaphore.makeUnsafe(1);
      locks.set(home, lock);
    }
    const homeLock = lock;
    return Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        yield* restore(homeLock.take(1));
        let holding = true;
        const release = Effect.suspend(() => {
          if (!holding) return Effect.void;
          holding = false;
          return Effect.asVoid(homeLock.release(1));
        });
        return yield* restore(body(release)).pipe(Effect.ensuring(release));
      }),
    );
  };
};
