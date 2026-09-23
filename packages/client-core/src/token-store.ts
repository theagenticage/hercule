/**
 * Where the bearer token lives between page loads.
 *
 * The token is kept in `localStorage` under `hercule:token:<origin>`, so a
 * browser that talks to two controllers keeps two separate tokens. The origin
 * is the controller's, exactly as the client's `baseUrl` spells it.
 *
 * The storage is passed in rather than read from the global, so the store can
 * run in a test with no DOM.
 *
 * Every access is wrapped in `try`. A browser that blocks site data (a private
 * window, a hardened profile, an embedded webview) throws as soon as
 * `localStorage` is touched, and the app must still load and offer a sign-in
 * rather than fail before React mounts. Then the token only lasts until the
 * page reloads.
 */

/** The slice of `localStorage` this module uses. */
export interface StorageLike {
  getItem(key: string): string | null;
  setItem(key: string, value: string): void;
  removeItem(key: string): void;
}

/** The bearer token for one controller, held across page loads. */
export interface TokenStore {
  /** Returns the stored token, or `null` if there is none. */
  read(): string | null;
  /** Stores `token`, replacing any earlier one; `null` removes it. */
  write(token: string | null): void;
}

export const buildTokenStorageKey = (origin: string): string => `hercule:token:${origin}`;

/** Returns the browser's `localStorage`, or `undefined` when accessing it throws. */
const findLocalStorage = (): StorageLike | undefined => {
  try {
    return globalThis.localStorage;
  } catch {
    return undefined;
  }
};

export const createTokenStore = (
  origin: string,
  storage: StorageLike | undefined = findLocalStorage(),
): TokenStore => {
  const key = buildTokenStorageKey(origin);
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
        // Nothing to do: the app keeps the token in memory for this page load
        // anyway, and there is nowhere else to store it.
      }
    },
  };
};
