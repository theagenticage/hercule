/**
 * How the app tells the user, outside its window, that a thread or an
 * assistant is waiting on them: the dock badge counts the threads and the
 * assistants that wait, and a Request that opens while the window is not
 * focused shows a native notification. Spec 17 (§Native behaviour) owns the
 * rules.
 *
 * The page holds the threads and the assistants, so it sends main every
 * thread and assistant waiting on the user, with its open Requests, each
 * time a Request opens or is answered. Main keeps everything else: the
 * notifications it has shown, the last list it was sent, whether the window
 * is focused, and whether the user is signed in.
 * Main's state outlives a reload of the page, and main learns of a sign-out
 * before the page can send another list.
 *
 * These are not the Notifications of Hercule's domain, the messages the
 * controller records for its user. They are macOS banners about Requests.
 *
 * This module imports no Electron: the layer is given Electron's
 * `Notification` class and the functions that set the badge and ask to
 * notify, so the service is unit tested with fakes.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type { WaitingRequest } from "../ipc/contract";
import { buildDestinationKey } from "../ipc/destination";
import { MainWindow } from "./main-window";

/** The part of Electron's `Notification` the service uses. */
export interface NativeNotification {
  show(): void;
  close(): void;
  once(event: "click", listener: () => void): unknown;
  once(event: "failed", listener: (event: unknown, error: string) => void): unknown;
}

/** What the service needs from the platform. */
export interface WaitingNotificationPlatform {
  /** Electron's `Notification` class, or a fake. */
  readonly Notification: new (options: {
    readonly title: string;
    readonly body: string;
  }) => NativeNotification;
  /** Sets the dock badge to `count`, or hides it at 0. */
  readonly setBadgeCount: (count: number) => void;
  /** Has macOS ask the user whether the app may notify, the first time only. */
  readonly askToNotify: () => void;
}

/** The dock badge and the native notifications of the Requests waiting on the user. */
export class WaitingNotifications extends Context.Service<
  WaitingNotifications,
  {
    /**
     * Records whether the user is signed in.
     *
     * - Signing in has macOS ask the user, the first time only, whether the
     *   app may notify. macOS shows the dock badge only to an app the user
     *   allows, so asking at the first waiting Request would lose its badge.
     * - Signing out hides the badge and removes every notification: they are
     *   about threads and assistants the app can no longer open. Until the
     *   user signs in again, the service ignores the lists it is sent.
     */
    readonly setSignedIn: (signedIn: boolean) => Effect.Effect<void>;

    /**
     * Takes `requests`, every thread and assistant waiting on the user now,
     * and brings the badge and the notifications in line with them. A
     * destination, the thread or the assistant that waits, has at most one
     * notification, about the Request it was shown for:
     *
     * - the badge counts the destinations;
     * - when a destination's newest Request was not open in the last list,
     *   the Request has just opened: it replaces the destination's
     *   notification while the window is not focused, and only removes it
     *   while the window is focused. A user who has the window in front sees
     *   it wait in the sidebar;
     * - when the Request of a notification is no longer open, wherever it was
     *   answered, the notification is removed, and no other takes its place;
     * - otherwise the notification stays, though the count of other Requests
     *   in its text may be out of date: showing it again would alert the
     *   user about a Request that is not new.
     *
     * The first list after signing in shows no notification, so that
     * launching the app or signing in does not repeat every Request that
     * already waits. A reload of the page keeps the last list, so a Request
     * that opens during the reload still gets its notification.
     *
     * Clicking a notification shows and focuses the window, and asks the page
     * to open its destination.
     */
    readonly setWaitingRequests: (requests: ReadonlyArray<WaitingRequest>) => Effect.Effect<void>;
  }
>()("hercule/desktop/WaitingNotifications") {}

/**
 * Builds the service on `platform`. A notification is kept by its
 * destination until it is removed: macOS removes a notification whose object
 * Electron has garbage collected, and its click would then do nothing.
 */
export const makeWaitingNotificationsLayer = (
  platform: WaitingNotificationPlatform,
): Layer.Layer<WaitingNotifications, never, MainWindow> =>
  Layer.effect(WaitingNotifications)(
    Effect.gen(function* () {
      const window = yield* MainWindow;
      const runFork = yield* FiberSet.makeRuntime();
      // Each notification shown, and the id of the Request it shows, keyed by
      // buildDestinationKey.
      const shown = new Map<
        string,
        { readonly notification: NativeNotification; readonly requestId: string }
      >();
      // Signed out until the page's first token read signs the user in, even
      // with a token stored: signing in is what asks macOS whether the app
      // may notify, and the page sends no list before that read. The menu
      // starts from the stored token instead, because its Sign Out shows
      // before the page loads.
      let signedIn = false;
      // The open Requests of each destination in the last list since the user
      // signed in, keyed by buildDestinationKey, or null before the first list.
      let lastOpenRequestIds: ReadonlyMap<string, ReadonlySet<string>> | null = null;

      const closeNotification = (key: string): void => {
        shown.get(key)?.notification.close();
        shown.delete(key);
      };

      const showNotification = ({ destination, requestId, title, body }: WaitingRequest): void => {
        const key = buildDestinationKey(destination);
        const notification = new platform.Notification({ title, body });
        notification.once("click", () => {
          // A notification already removed can still be clicked on screen:
          // its Request was answered, a newer Request of its destination
          // replaced it, or the user signed out.
          if (shown.get(key)?.notification !== notification) return;
          shown.delete(key);
          runFork(window.showAndSend("destination.open", destination));
        });
        // A notification macOS refuses, because the user has not allowed the
        // app's notifications, fails with no sign on screen.
        notification.once("failed", (_event, error) => {
          runFork(Effect.logWarning(`A waiting Request's notification did not show: ${error}`));
        });
        shown.set(key, { notification, requestId });
        notification.show();
      };

      /** Returns the open Requests of each destination of `requests`, by key. */
      const mapOpenRequestIdsByKey = (requests: ReadonlyArray<WaitingRequest>) =>
        new Map(
          requests.map((request) => [
            buildDestinationKey(request.destination),
            new Set(request.openRequestIds),
          ]),
        );

      return {
        setSignedIn: (next) =>
          Effect.sync(() => {
            // The page reads the token again after each reload, which signs
            // the user in again; that keeps the last list.
            if (next === signedIn) return;
            signedIn = next;
            if (next) return platform.askToNotify();
            lastOpenRequestIds = null;
            platform.setBadgeCount(0);
            for (const key of [...shown.keys()]) closeNotification(key);
          }),
        setWaitingRequests: (requests) =>
          Effect.gen(function* () {
            if (!signedIn) return;
            platform.setBadgeCount(requests.length);
            const previous = lastOpenRequestIds;
            const openRequestIds = mapOpenRequestIdsByKey(requests);
            lastOpenRequestIds = openRequestIds;
            if (previous === null) return;
            for (const [key, { requestId }] of [...shown]) {
              if (openRequestIds.get(key)?.has(requestId) !== true) closeNotification(key);
            }
            // Requests open in the order they are listed, so a Request that
            // has just opened is its destination's newest.
            const opened = requests.filter(
              (request) =>
                previous.get(buildDestinationKey(request.destination))?.has(request.requestId) !==
                true,
            );
            for (const request of opened) {
              closeNotification(buildDestinationKey(request.destination));
            }
            if (opened.length === 0 || (yield* window.isFocused)) return;
            for (const request of opened) showNotification(request);
          }),
      };
    }),
  );
