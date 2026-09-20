/**
 * Where the bearer token lives between page loads.
 *
 * The token is kept in `localStorage` under `hercule:token:<origin>`, so one
 * browser talking to two controllers holds two tokens and neither sees the
 * other's. The origin is the controller's, exactly as the client's `baseUrl`
 * names it - the same string the app reaches the controller with.
 *
 * Storage is an injected seam rather than a reach for the global, so the store
 * runs in a test with no DOM.
 *
 * Every access is guarded. A browser that denies site data - a private window,
 * a hardened profile, an embedded webview - throws on the reach itself, and the
 * app has to load and offer a sign-in rather than fail before React mounts. The
 * cost of a denied store is that the token does not survive a page load.
 */

/** The slice of `localStorage` this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The bearer token for one controller, held across page loads. */
export interface TokenStore {
  /** The token held, or `null` if there is none. */
  read(): string | null;
  /** Hold this token from now on; `null` removes it. */
  write(token: string | null): void;
}

export const tokenStorageKey = (origin: string): string => `hercule:token:${origin}`;

/** The browser's `localStorage`, or nothing where reaching it throws. */
const localStorageOrNone = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export const createTokenStore = (
  origin: string,
  storage: StorageLike | undefined = localStorageOrNone(),
): TokenStore => {
  const key = tokenStorageKey(origin);
  return {
    read: () => {
      try {
        return storage?.getItem(key) ?? null;
      } catch {
        return null;
      }
    },
    write: (token) => {
      try {
        if (token === null) storage?.removeItem(key);
        else storage?.setItem(key, token);
      } catch {
        // Nothing to do: the token is held in memory for this page load either
        // way, and there is no other place to put it.
      }
    },
  };
};
