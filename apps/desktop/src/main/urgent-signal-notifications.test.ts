import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { UrgentSignal } from "../ipc/contract";
import {
  type FakeMainWindow,
  type FakeNotification,
  makeFakeMainWindow,
  makeFakeNotificationClass,
} from "./testing";
import {
  makeUrgentSignalNotificationsLayer,
  UrgentSignalNotifications,
} from "./urgent-signal-notifications";

/** What the fakes of the platform and the window saw. */
interface Seen {
  /** Each notification created, in order. */
  readonly notifications: Array<FakeNotification>;
  /** The fake window, with each call made to it; a test may change whether it has the focus. */
  readonly window: FakeMainWindow;
}

/**
 * Runs `use` against the service built on a fake `Notification` class and a
 * fake window that starts with the focus when `focused` is true. Returns what
 * the fakes saw.
 */
const runWithNotifications = async (
  focused: boolean,
  use: (notifications: UrgentSignalNotifications["Service"], seen: Seen) => Effect.Effect<unknown>,
): Promise<Seen> => {
  const window = makeFakeMainWindow();
  window.focused = focused;
  const { Notification, notifications } = makeFakeNotificationClass();
  const seen: Seen = { notifications, window };
  const layer = makeUrgentSignalNotificationsLayer({ Notification }).pipe(
    Layer.provide(window.layer),
  );
  await Effect.runPromise(
    Effect.provide(
      UrgentSignalNotifications.use((notifications) => use(notifications, seen)),
      layer,
    ),
  );
  return seen;
};

/** Returns the title and state of each notification created, in order. */
const describeNotifications = (seen: Seen) =>
  seen.notifications.map(({ title, state }) => [title, state]);

const OUTAGE: UrgentSignal = {
  signalId: "signal-1",
  title: "PagerDuty",
  body: "Checkout error rate above 5%",
};
const BREACH: UrgentSignal = {
  signalId: "signal-2",
  title: "Sentry",
  body: "Unhandled error in payments",
};

describe("UrgentSignalNotifications", () => {
  it("shows no notification for the first list after signing in", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([notifications.setSignedIn(true), notifications.setUrgentSignals([OUTAGE])]),
    );
    expect(seen.notifications).toEqual([]);
  });

  it("shows a notification, with the title and body it is sent, for a signal that arrives while the window is not focused", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
      ]),
    );
    expect(seen.notifications.map(({ title, body, state }) => ({ title, body, state }))).toEqual([
      { title: "PagerDuty", body: "Checkout error rate above 5%", state: "shown" },
    ]);
  });

  it("shows nothing while the window is focused", async () => {
    const seen = await runWithNotifications(true, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
      ]),
    );
    expect(seen.notifications).toEqual([]);
  });

  it("keeps a signal's notification while the signal stays in the list", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
        notifications.setUrgentSignals([OUTAGE, BREACH]),
      ]),
    );
    expect(describeNotifications(seen)).toEqual([
      ["PagerDuty", "shown"],
      ["Sentry", "shown"],
    ]);
  });

  it("removes only the notification of the signal that left the list", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE, BREACH]),
        notifications.setUrgentSignals([BREACH]),
      ]),
    );
    expect(describeNotifications(seen)).toEqual([
      ["PagerDuty", "closed"],
      ["Sentry", "shown"],
    ]);
  });

  it("removes a signal's notification when it leaves the list while the window is focused", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
        Effect.sync(() => {
          seen.window.focused = true;
        }),
        notifications.setUrgentSignals([]),
      ]),
    );
    expect(describeNotifications(seen)).toEqual([["PagerDuty", "closed"]]);
  });

  it("notifies again for a signal that comes back to the list, as from snooze", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
      ]),
    );
    expect(describeNotifications(seen)).toEqual([
      ["PagerDuty", "closed"],
      ["PagerDuty", "shown"],
    ]);
  });

  it("shows nothing twice for a list sent again, as after the page reloads", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
        // The reloaded page reads the token again, then sends its first list.
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([OUTAGE, BREACH]),
      ]),
    );
    expect(describeNotifications(seen)).toEqual([
      ["PagerDuty", "shown"],
      ["Sentry", "shown"],
    ]);
  });

  it("shows the window and asks the page to open the signal when its notification is clicked", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
        Effect.sync(() => seen.notifications[0]?.click()),
      ]),
    );
    expect(seen.window.calls).toEqual([
      'showAndSend destination.open {"kind":"signal","signalId":"signal-1"}',
    ]);
  });

  it("does nothing when a notification it removed is clicked", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
        notifications.setUrgentSignals([]),
        Effect.sync(() => seen.notifications[0]?.click()),
      ]),
    );
    expect(seen.window.calls).toEqual([]);
  });

  it("ignores the lists it is sent while signed out", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(false),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE]),
      ]),
    );
    expect(seen.notifications).toEqual([]);
  });

  it("removes every notification when the user signs out, and shows none for the first list after signing in again", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([]),
        notifications.setUrgentSignals([OUTAGE, BREACH]),
        notifications.setSignedIn(false),
        notifications.setUrgentSignals([OUTAGE]),
        notifications.setSignedIn(true),
        notifications.setUrgentSignals([OUTAGE, BREACH]),
      ]),
    );
    expect(describeNotifications(seen)).toEqual([
      ["PagerDuty", "closed"],
      ["Sentry", "closed"],
    ]);
  });
});
