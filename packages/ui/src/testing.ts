/**
 * A `localStorage` that lives in memory for one test.
 *
 * Whether a jsdom has a `localStorage` of its own depends on the Node it runs
 * under, which is why the code under test reaches the real one through a try.
 * A stub makes both read the same: every render starts from the seed it was
 * given and nothing one test writes reaches the next. The app's own test
 * harness (`apps/web/src/app/testing.tsx`) reaches for this through the
 * package's `/testing` subpath, the way `@hercule/client-core/testing` is
 * reached for.
 */
export const createMemoryStorage = (seed: Readonly<Record<string, string>> = {}): Storage => {
  const held = new Map(Object.entries(seed));
  return {
    getItem: (key) => held.get(key) ?? null,
    setItem: (key, value) => {
      held.set(key, String(value));
    },
    removeItem: (key) => {
      held.delete(key);
    },
    clear: () => {
      held.clear();
    },
    key: (index) => [...held.keys()][index] ?? null,
    get length() {
      return held.size;
    },
  };
};
