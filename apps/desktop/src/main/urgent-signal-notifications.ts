/**
 * How the app tells the user, outside its window, that an urgent signal has
 * arrived: a signal of priority `urgent` that opens on Intake's To do, under
 * Now, shows a native notification while the window is not focused. Spec 17
 * (§Native behaviour) owns the rules.
 *
 * The page holds the signals, so it sends main every urgent signal open on
 * To do each time that list changes. Main keeps everything else: the
 * notifications it has shown, the last list it was sent, whether the window
 * is focused, and whether the user is signed in. Main's state outlives a
 * reload of the page, and main learns of a sign-out before the page can send
 * another list.
 *
 * This is a service of its own, beside WaitingNotifications, because an
 * urgent signal is not an agent waiting on the user:
 *
 * - it never counts on the dock badge, which means only that an agent is
 *   blocked on the user, so this service has no way to set the badge;
 * - its notification is keyed by the signal's id, and a signal has no
 *   Requests that open and close under it;
 * - it does not ask macOS whether the app may notify: WaitingNotifications
 *   asks when the user signs in.
 *
 * This module imports no Electron: the layer is given Electron's
 * `Notification` class, so the service is unit tested with a fake.
 */
import * as Context from "effect/Context";
import * as Effect from "effect/Effect";
import * as FiberSet from "effect/FiberSet";
import * as Layer from "effect/Layer";
import type { UrgentSignal } from "../ipc/contract";
import { MainWindow } from "./main-window";
import type { NativeNotification, WaitingNotificationPlatform } from "./waiting-notifications";

/** What the service needs from the platform: only Electron's `Notification` class, or a fake. */
export type UrgentSignalNotificationPlatform = Pick<WaitingNotificationPlatform, "Notification">;

/** The native notifications of the urgent signals open on To do. */
export class UrgentSignalNotifications extends Context.Service<
  UrgentSignalNotifications,
  {
    /**
     * Records whether the user is signed in. Signing out removes every
     * notification, because they are about signals the app can no longer
     * open. Until the user signs in again, the service ignores the lists it
     * is sent.
     */
    readonly setSignedIn: (signedIn: boolean) => Effect.Effect<void>;

    /**
     * Takes `signals`, every urgent signal open on To do now, and brings the
     * notifications in line with them. A signal has at most one
     * notification:
     *
     * - a signal that was not in the last list shows a notification while
     *   the window is not focused. A user who has the window in front sees
     *   it arrive on Intake. A signal back from snooze is not in the last
     *   list, so it notifies again;
     * - a notification whose signal is no longer in the list, because it was
     *   resolved, snoozed or lowered anywhere, is removed;
     * - otherwise the notification stays as it is.
     *
     * The first list after signing in shows no notification, so that
     * launching the app or signing in does not repeat every urgent signal
     * already open. A reload of the page keeps the last list, so a signal
     * that arrives during the reload still gets its notification.
     *
     * Clicking a notification shows and focuses the window, and asks the
     * page to open Intake with the signal selected.
     */
    readonly setUrgentSignals: (signals: ReadonlyArray<UrgentSignal>) => Effect.Effect<void>;
  }
>()("hercule/desktop/UrgentSignalNotifications") {}

/**
 * Builds the service on `platform`. A notification is kept by its signal's
 * id until it is removed: macOS removes a notification whose object Electron
 * has garbage collected, and its click would then do nothing.
 */
export const makeUrgentSignalNotificationsLayer = (
  platform: UrgentSignalNotificationPlatform,
): Layer.Layer<UrgentSignalNotifications, never, MainWindow> =>
  Layer.effect(UrgentSignalNotifications)(
    Effect.gen(function* () {
      const window = yield* MainWindow;
      const runFork = yield* FiberSet.makeRuntime();
      // Each notification shown, keyed by its signal's id.
      const shown = new Map<string, NativeNotification>();
      // Signed out until the page's first token read signs the user in, as
      // WaitingNotifications is: the page sends no list before that read.
      let signedIn = false;
      // The ids of the signals in the last list since the user signed in, or
      // null before the first list.
      let lastSignalIds: ReadonlySet<string> | null = null;

      const closeNotification = (signalId: string): void => {
        shown.get(signalId)?.close();
        shown.delete(signalId);
      };

      const showNotification = ({ signalId, title, body }: UrgentSignal): void => {
        const notification = new platform.Notification({ title, body });
        notification.once("click", () => {
          // A notification already removed can still be clicked on screen:
          // its signal left the list, or the user signed out.
          if (shown.get(signalId) !== notification) return;
          shown.delete(signalId);
          runFork(window.showAndSend("destination.open", { kind: "signal", signalId }));
        });
        // A notification macOS refuses, because the user has not allowed the
        // app's notifications, fails with no sign on screen.
        notification.once("failed", (_event, error) => {
          runFork(Effect.logWarning(`An urgent signal's notification did not show: ${error}`));
        });
        shown.set(signalId, notification);
        notification.show();
      };

      return {
        setSignedIn: (next) =>
          Effect.sync(() => {
            // The page reads the token again after each reload, which signs
            // the user in again; that keeps the last list.
            if (next === signedIn) return;
            signedIn = next;
            if (next) return;
            lastSignalIds = null;
            for (const signalId of [...shown.keys()]) closeNotification(signalId);
          }),
        setUrgentSignals: (signals) =>
          Effect.gen(function* () {
            if (!signedIn) return;
            const previous = lastSignalIds;
            const signalIds = new Set(signals.map((signal) => signal.signalId));
            lastSignalIds = signalIds;
            if (previous === null) return;
            for (const signalId of [...shown.keys()]) {
              if (!signalIds.has(signalId)) closeNotification(signalId);
            }
            const arrived = signals.filter((signal) => !previous.has(signal.signalId));
            if (arrived.length === 0 || (yield* window.isFocused)) return;
            for (const signal of arrived) showNotification(signal);
          }),
      };
    }),
  );
