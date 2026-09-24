/**
 * Creates an in-memory `localStorage` for one test, filled from `seed`.
 *
 * Whether jsdom provides a `localStorage` depends on the Node version it runs
 * under, which is why the code under test wraps its storage access in a try.
 * With this stub both cases behave the same: every render starts from the
 * given seed, and nothing one test writes reaches the next. The web app's test
 * harness (`apps/web/src/app/testing.tsx`) imports it from this package's
 * `/testing` subpath, as it imports `@hercule/client-core/testing`.
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
