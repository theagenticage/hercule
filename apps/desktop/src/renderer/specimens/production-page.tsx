/**
 * Boots the app's own router in a page, over a fake controller played inside
 * the page, for the specimens that draw the app as it really boots. Nothing is
 * seeded into the query cache: the app's loaders read, its live connection
 * subscribes, and its moves write and read again, all against the stubbed
 * requests of `handlers`.
 *
 * The counts page (perf-counts.tsx) and the MCP scenes (mcp-scene.ts) mount
 * through it. Two things differ from the app on purpose:
 *
 * - no `StrictMode`, which renders every component twice in development and
 *   would double every render count;
 * - the bridge is a stub that answers as a user signed in to the fake
 *   controller would be answered, on a Mac.
 */
import "../styles/base-layer.css";
import { createRoot } from "react-dom/client";
import { RouterProvider, type AnyRouter } from "@tanstack/react-router";
import {
  createApiStub,
  stubWebSocketInto,
  type Call,
  type Handler,
  type StubSocket,
} from "@hercule/client-core/testing";
import type { Bridge } from "../../ipc/bridge";
import type { Appearance } from "../../ipc/contract";
import { buildRouterContext } from "../app/context";
import type { RouterContext } from "../app/context";
import { createAppRouter } from "../app/router";

/** The address of the fake controller. Nothing listens there: the page's `fetch` answers. */
export const CONTROLLER_URL = "http://controller.invalid";

/** What a page booted through `mountProductionApp` offers its caller. */
export interface ProductionPage {
  /** The requests the app sent, oldest first. */
  readonly calls: readonly Call[];
  /** The live connections the app opened, oldest first. */
  readonly sockets: readonly StubSocket[];
  /** The context the app's routes read, which holds its query client. */
  readonly context: RouterContext;
  readonly router: AnyRouter;
  /** Returns the requests no handler answers, as `METHOD /path`. The stub answers them with 404. */
  readonly listUnknownRequests: () => readonly string[];
}

/** What a page is booted with. */
export interface ProductionPageOptions {
  /** The answers of the fake controller, keyed `METHOD /path`. */
  readonly handlers: Readonly<Record<string, Handler>>;
  /** The address the app opens at. */
  readonly path: string;
  /** The name of the Mac's user, which the first-run screens read. */
  readonly username: string;
  /** The Appearance the Mac holds. */
  readonly appearance: Appearance;
  /**
   * Runs once the app's context exists and before the first screen loads, to
   * put in place what the user had done before the page opened.
   */
  readonly prepare?: (context: RouterContext) => void;
  /**
   * How main answers the browser's return from a sign-in. By default main
   * cannot listen, so a sign-in that starts on the page shows its paste step.
   */
  readonly signInReturn?: Bridge["signInReturn"];
}

const refuse = (call: string) => (): Promise<never> =>
  Promise.reject(new Error(`The specimen page does not answer ${call}.`));

/** Main's answers when it cannot listen for the browser's return: the sign-in asks for the paste. */
const NO_SIGN_IN_RETURN: Bridge["signInReturn"] = {
  listen: () => Promise.resolve({ _tag: "unavailable" }),
  wait: refuse("signInReturn.wait"),
  cancel: () => Promise.resolve(undefined),
};

/**
 * Returns main's answers for a user signed in to the fake controller. What
 * the shell sends main (the Go menu, the dock badge, the notifications) is
 * accepted and ignored, and every other call fails, because the specimens
 * never make one.
 */
const buildBridge = (
  username: string,
  appearance: Appearance,
  signInReturn: Bridge["signInReturn"],
): Bridge => ({
  platform: "mac",
  hiddenWindowDraws: true,
  controllerUrl: {
    read: () => Promise.resolve(CONTROLLER_URL),
    save: refuse("controllerUrl.save"),
  },
  token: { read: () => Promise.resolve("bearer"), write: () => Promise.resolve(undefined) },
  runnerIdentity: { read: () => Promise.resolve(null) },
  firstScreen: { report: () => Promise.resolve(undefined) },
  goMenu: { set: () => Promise.resolve(undefined) },
  waiting: { set: () => Promise.resolve(undefined) },
  urgentSignals: { set: () => Promise.resolve(undefined) },
  localController: { find: refuse("localController.find"), start: refuse("localController.start") },
  logsFolder: { show: refuse("logsFolder.show") },
  setupToken: { read: refuse("setupToken.read") },
  macUser: { read: () => Promise.resolve({ username }) },
  folder: { pick: refuse("folder.pick") },
  skillFolders: { pick: refuse("skillFolders.pick") },
  skillArchive: { build: refuse("skillArchive.build") },
  firstRunProgress: { read: () => Promise.resolve(null), save: refuse("firstRunProgress.save") },
  appearance: { read: () => appearance, save: refuse("appearance.save") },
  // A specimen has no browser to open.
  link: { open: () => Promise.resolve({ _tag: "Opened" }) },
  signInReturn,
  menu: { onCommand: () => () => undefined },
  destination: { onOpen: () => () => undefined },
});

/**
 * Boots the app's router at `options.path` over the fake controller of
 * `options.handlers`, draws it into `#root`, and returns the page's parts.
 * Fails when the page has no `#root`, or when a loader of the first screen
 * fails.
 */
export async function mountProductionApp(options: ProductionPageOptions): Promise<ProductionPage> {
  const {
    handlers,
    path,
    username,
    appearance,
    prepare,
    signInReturn = NO_SIGN_IN_RETURN,
  } = options;
  const { fetch, calls } = createApiStub(handlers);
  globalThis.fetch = fetch as typeof globalThis.fetch;
  const sockets: StubSocket[] = [];
  const dial = stubWebSocketInto(sockets);
  // A function called with `new` that returns an object gives that object, so `new WebSocket(url)` returns the stub.
  globalThis.WebSocket = function (url: string) {
    return dial(url);
  } as unknown as typeof WebSocket;

  const context = await buildRouterContext(buildBridge(username, appearance, signInReturn));
  prepare?.(context);
  const router = createAppRouter(context);
  router.history.replace(path);
  await router.load();
  const root = document.getElementById("root");
  if (root === null) throw new Error("The specimen page is missing #root.");
  createRoot(root).render(<RouterProvider router={router} />);
  return {
    calls,
    sockets,
    context,
    router,
    listUnknownRequests: () =>
      calls
        .map((call) => `${call.method} ${call.path}`)
        .filter((key) => handlers[key] === undefined),
  };
}
