import type { TokenStore } from "@hercule/client-core";
import type { Bridge } from "../../ipc/bridge";

/**
 * Creates the token store the client keeps its login token in. Main holds the
 * token, encrypted with the Keychain, and the store reaches it through the
 * bridge.
 *
 * - `read` returns `bootToken`, the token boot read from main. The client
 *   reads its store once, when it is created, and the bridge answers only
 *   asynchronously, so boot reads the token first.
 * - `write` sends the token to main and does not wait for the answer. The
 *   client already holds the new token, so nothing on the page depends on the
 *   write.
 *
 * A failed write is logged, not thrown. It means main refused the message or
 * failed, which is a bug the user cannot act on.
 */
export const createDesktopTokenStore = (
  bootToken: string | null,
  bridge: Pick<Bridge, "token">,
): TokenStore => ({
  read: () => bootToken,
  write: (token) => {
    bridge.token.write(token).catch((error: unknown) => {
      console.error("Could not save the login token:", error);
    });
  },
});
