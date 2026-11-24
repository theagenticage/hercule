/**
 * The port through which a sign-in catches the browser's return in the desktop
 * app. The dialogs of MCP servers added by URL and the setup of a Connection
 * whose redirect returns to the user's machine both use it.
 */
import { isWebLink } from "@hercule/client-core";
import type { BrowserSignInPort } from "@hercule/client-core/mcp-servers";
import type { Bridge } from "../../ipc/bridge";

/**
 * Returns the port through which a sign-in catches the browser's return, over
 * the main process's `signInReturn` channels and its `link.open`. Main opens
 * only web addresses, so the port refuses any other with a reason. When main
 * could not open the browser, `open` fails with main's own sentence, which
 * holds no part of the address.
 */
export const buildBrowserSignInPort = (bridge: Bridge): BrowserSignInPort => ({
  listen: async () => {
    const outcome = await bridge.signInReturn.listen();
    return outcome._tag === "listening"
      ? { kind: "listening", listenerId: outcome.listenerId, redirectUri: outcome.redirectUri }
      : { kind: "unavailable" };
  },
  wait: async (listenerId, authorizationUrl) => {
    const outcome = await bridge.signInReturn.wait({ listenerId, authorizationUrl });
    return outcome._tag === "received"
      ? { kind: "received", callbackQuery: outcome.callbackQuery }
      : { kind: outcome._tag };
  },
  cancel: (listenerId) => bridge.signInReturn.cancel({ listenerId }),
  open: async (url) => {
    // The refusal names no part of the address: its query holds the sign-in's one-time `state`.
    if (!isWebLink(url)) throw new Error("The sign-in page is not a web address.");
    const outcome = await bridge.link.open({ url });
    if (outcome._tag === "NotOpened") throw new Error(outcome.reason);
  },
});
