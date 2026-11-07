/**
 * The router context: what every route receives.
 *
 * Boot builds everything here once and passes it to the router, rather than
 * leaving it in module-level singletons. That way a test can build its own
 * set, with a fake bridge, and run the same routes.
 */
import type { QueryClient } from "@tanstack/react-query";
import {
  createLive,
  createUploadQueue,
  type HerculeClient,
  type Live,
  type UploadQueue,
  UPLOAD_CONCURRENCY,
} from "@hercule/client-core";
import type { Bridge } from "../../ipc/bridge";
import { createAppearanceStore, type AppearanceStore } from "./appearance";
import { createControllerClient } from "./controller-client";
import { createPendingCardMoves, type PendingCardMoves } from "./pending-card-moves";
import { createPendingIntentsHolder, type PendingIntentsHolder } from "./pending-intents";
import { createPendingSubmissions, type PendingSubmissions } from "./pending-submissions";
import { createQueryClient } from "./query-client";
import { createThreadCopies, type ThreadCopies } from "./thread-copies";
import { createDesktopTokenStore } from "./token-store";
import type { CardMover } from "./card-mover";
import { createUndoStack, type UndoStack } from "./undo-stack";

/**
 * The controller whose URL is saved in the app's settings, a client for it,
 * the live connection to it, what the user has not sent yet in each of its
 * threads, the uploads of the images attached to those, and the saved copies
 * of the threads opened lately.
 */
export interface SavedController {
  /** The controller's origin, for example `http://127.0.0.1:4937`. */
  readonly url: string;
  readonly client: HerculeClient;
  /**
   * The live connection to the controller. It is created here and does not
   * connect until the shell starts it (see `useLiveConnection`). Most screens
   * never touch it: pushes invalidate query keys. An agent's page on a thread
   * and an assistant's Conversation are the exceptions: each subscribes to its
   * agent's stream and tap through `useSessionLive`.
   */
  readonly live: Live;
  /** What each thread's, Draft Thread's and assistant's composer holds and has not sent yet. */
  readonly pendingSubmissions: PendingSubmissions;
  /**
   * The uploads of the images on every composer's shelf, three at a time
   * across the whole app. It lives here, beside the pending submissions, so
   * an upload keeps running when the user leaves the thread it was attached
   * in, and its result still reaches that thread's shelf.
   */
  readonly uploads: UploadQueue;
  /**
   * The saved copies of the threads opened lately, which let a thread open
   * from disk. The copies belong to this controller: they hold what it
   * answered, and no other controller knows those threads. They live here,
   * beside the client, so sign-out can delete them (see `createAppRouter`).
   * Main reloads the window when the user switches to another controller, and
   * the store built for the new URL deletes the copies when it opens.
   */
  readonly threadCopies: ThreadCopies;
  /**
   * The gestures the user made on Work and the Inbox in this window, which
   * Undo reverses one at a time. They belong to this controller and this user:
   * main reloads the window for another controller, which builds a new stack,
   * and the router clears this one when the user signs out (see
   * `createAppRouter`). Nothing is saved.
   */
  readonly undoStack: UndoStack<CardMover>;
  /**
   * The card moves the controller has not answered yet. They live here, not in
   * the Work screen, so a screen opened again after a visit elsewhere still
   * draws a card as Done while its update is on the way, and Undo can queue
   * its inverse behind that update. Like the undo stack, the router clears
   * them when the user signs out.
   */
  readonly pendingCardMoves: PendingCardMoves;
  /**
   * The answers the user gave from the Work pane and the merges the user asked
   * for, which the app holds back for the undo line before it sends them. They
   * belong to this controller and this user, so the store opens once the shell
   * knows the user, and the router closes it when the user signs out (see
   * `createAppRouter`).
   */
  readonly pendingIntents: PendingIntentsHolder;
}

export interface RouterContext {
  /** The functions main offers the page. */
  readonly bridge: Bridge;
  /** The saved controller, or `null` until the user has connected to one. */
  readonly controller: SavedController | null;
  readonly queryClient: QueryClient;
  /** The Appearance the page shows, which the Appearance page changes. */
  readonly appearance: AppearanceStore;
}

/**
 * Returns the saved controller at `url`: a client that sends `token` and
 * stores any change to it through main, a live connection that is not
 * started yet, no pending submissions, no uploads, and the store of saved
 * thread copies, which opens its database when first used.
 */
const buildSavedController = (
  url: string,
  token: string | null,
  bridge: Bridge,
): SavedController => {
  const client = createControllerClient(url, createDesktopTokenStore(token, bridge));
  return {
    url,
    client,
    live: createLive({ client, baseUrl: url }),
    pendingSubmissions: createPendingSubmissions(),
    uploads: createUploadQueue({
      upload: client.uploadAttachment,
      deleteAttachment: client.deleteAttachment,
      concurrency: UPLOAD_CONCURRENCY,
    }),
    threadCopies: createThreadCopies(url),
    undoStack: createUndoStack(),
    pendingCardMoves: createPendingCardMoves(),
    pendingIntents: createPendingIntentsHolder(url, localStorage),
  };
};

/**
 * Reads the saved controller URL and the login token from main, and returns
 * the router context built from them. Fails when main refuses either read,
 * which is a bug.
 *
 * Both reads go to main at once. The client needs the token when it is
 * created, so the app cannot start before both have answered.
 */
export const buildRouterContext = async (bridge: Bridge): Promise<RouterContext> => {
  const [controllerUrl, token] = await Promise.all([
    bridge.controllerUrl.read(),
    bridge.token.read(),
  ]);
  return {
    bridge,
    controller: controllerUrl === null ? null : buildSavedController(controllerUrl, token, bridge),
    queryClient: createQueryClient(),
    appearance: createAppearanceStore(bridge),
  };
};
