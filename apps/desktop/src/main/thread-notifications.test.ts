import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WaitingThread } from "../ipc/contract";
import { type FakeMainWindow, makeFakeMainWindow } from "./testing";
import {
  makeThreadNotificationsLayer,
  type NativeNotification,
  ThreadNotifications,
} from "./thread-notifications";

/** A fake of Electron's `Notification` that records what is done to it. */
interface FakeNotification extends NativeNotification {
  readonly title: string;
  readonly body: string;
  state: "new" | "shown" | "closed";
  /** Clicks the notification, as the user does. */
  click(): void;
}

/** What the fakes of the platform and the window saw. */
interface Seen {
  /** Each notification created, in order. */
  readonly notifications: Array<FakeNotification>;
  /** Each count the badge was set to, in order. */
  readonly badgeCounts: Array<number>;
  /** How many times the service asked to notify. */
  asks: number;
  /** The fake window, with each call made to it; a test may change whether it has the focus. */
  readonly window: FakeMainWindow;
}

/**
 * Runs `use` against the service built on fakes of the platform and of a
 * window that starts with the focus when `focused` is true. Returns what the
 * fakes saw.
 */
const runWithNotifications = async (
  focused: boolean,
  use: (notifications: ThreadNotifications["Service"], seen: Seen) => Effect.Effect<unknown>,
): Promise<Seen> => {
  const window = makeFakeMainWindow();
  window.focused = focused;
  const seen: Seen = { notifications: [], badgeCounts: [], asks: 0, window };
  class Notification implements FakeNotification {
    readonly title: string;
    readonly body: string;
    state: "new" | "shown" | "closed" = "new";
    private clickListener: (...args: never[]) => void = () => undefined;
    constructor(options: { readonly title: string; readonly body: string }) {
      this.title = options.title;
      this.body = options.body;
      seen.notifications.push(this);
    }
    show() {
      this.state = "shown";
    }
    close() {
      this.state = "closed";
    }
    // Takes a listener of either event's type. Only the click's is kept, and
    // it is called with no argument, as the service's click listener takes
    // none.
    once(event: "click" | "failed", listener: (...args: never[]) => void): this {
      if (event === "click") this.clickListener = listener;
      return this;
    }
    click() {
      this.clickListener();
    }
  }
  const layer = makeThreadNotificationsLayer({
    Notification,
    setBadgeCount: (count) => seen.badgeCounts.push(count),
    askToNotify: () => {
      seen.asks += 1;
    },
  }).pipe(Layer.provide(window.layer));
  await Effect.runPromise(
    Effect.provide(
      ThreadNotifications.use((notifications) => use(notifications, seen)),
      layer,
    ),
  );
  return seen;
};

/** Returns the title, body and state of each notification created, in order. */
const describeNotifications = (seen: Seen) =>
  seen.notifications.map(({ title, body, state }) => ({ title, body, state }));

const LOGIN: WaitingThread = {
  sessionId: "session-1",
  requestId: "request-1",
  title: "Fix the login bug",
  question: "Run the migration?",
};
const CHECKOUT: WaitingThread = {
  sessionId: "session-2",
  requestId: "request-2",
  title: "Speed up checkout",
  question: "Run pnpm test?",
};

describe("ThreadNotifications", () => {
  it("counts the first list after signing in on the badge, and shows no notification for it", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([notifications.setSignedIn(true), notifications.setWaitingThreads([LOGIN])]),
    );
    expect(seen.badgeCounts).toEqual([1]);
    expect(seen.notifications).toEqual([]);
  });

  it("counts a thread that starts waiting and shows its notification while the window is not focused", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
      ]),
    );
    expect(seen.badgeCounts).toEqual([0, 1]);
    expect(describeNotifications(seen)).toEqual([
      { title: "Fix the login bug", body: "Run the migration?", state: "shown" },
    ]);
  });

  it("shows nothing while the window is focused", async () => {
    const seen = await runWithNotifications(true, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
      ]),
    );
    expect(seen.badgeCounts).toEqual([0, 1]);
    expect(seen.notifications).toEqual([]);
  });

  it("replaces a thread's notification when the thread waits on a new Request", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
        notifications.setWaitingThreads([
          { ...LOGIN, requestId: "request-3", question: "Deploy it?" },
        ]),
      ]),
    );
    expect(describeNotifications(seen).map(({ body, state }) => [body, state])).toEqual([
      ["Run the migration?", "closed"],
      ["Deploy it?", "shown"],
    ]);
  });

  it("removes a thread's old notification, and shows none, when its new Request comes while the window is focused", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
        Effect.sync(() => {
          seen.window.focused = true;
        }),
        notifications.setWaitingThreads([{ ...LOGIN, requestId: "request-3" }]),
      ]),
    );
    expect(describeNotifications(seen).map(({ state }) => state)).toEqual(["closed"]);
  });

  it("removes only the notification of the thread that no longer waits", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN, CHECKOUT]),
        notifications.setWaitingThreads([CHECKOUT]),
      ]),
    );
    expect(seen.badgeCounts).toEqual([0, 2, 1]);
    expect(describeNotifications(seen).map(({ title, state }) => [title, state])).toEqual([
      ["Fix the login bug", "closed"],
      ["Speed up checkout", "shown"],
    ]);
  });

  it("shows nothing twice for a list sent again, as after the page reloads", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
        // The reloaded page reads the token again, then sends its first list.
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([LOGIN, CHECKOUT]),
      ]),
    );
    expect(describeNotifications(seen).map(({ title, state }) => [title, state])).toEqual([
      ["Fix the login bug", "shown"],
      ["Speed up checkout", "shown"],
    ]);
  });

  it("shows the window and asks the page to open the thread when its notification is clicked", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
        Effect.sync(() => seen.notifications[0]?.click()),
      ]),
    );
    expect(seen.window.calls).toEqual(['showAndSend thread.open {"sessionId":"session-1"}']);
  });

  it("does nothing when a notification it removed is clicked", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
        notifications.setWaitingThreads([]),
        Effect.sync(() => seen.notifications[0]?.click()),
      ]),
    );
    expect(seen.window.calls).toEqual([]);
  });

  it("asks to notify on signing in, and asks no more while the user stays signed in", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([notifications.setSignedIn(true), notifications.setSignedIn(true)]),
    );
    expect(seen.asks).toBe(1);
  });

  it("does not ask to notify, and ignores the lists it is sent, while signed out", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(false),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN]),
      ]),
    );
    expect(seen.asks).toBe(0);
    expect(seen.badgeCounts).toEqual([]);
    expect(seen.notifications).toEqual([]);
  });

  it("hides the badge and removes every notification when the user signs out, and shows none for the first list after signing in again", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([]),
        notifications.setWaitingThreads([LOGIN, CHECKOUT]),
        notifications.setSignedIn(false),
        notifications.setWaitingThreads([LOGIN]),
        notifications.setSignedIn(true),
        notifications.setWaitingThreads([LOGIN, CHECKOUT]),
      ]),
    );
    expect(seen.badgeCounts).toEqual([0, 2, 0, 2]);
    expect(describeNotifications(seen).map(({ state }) => state)).toEqual(["closed", "closed"]);
  });
});
