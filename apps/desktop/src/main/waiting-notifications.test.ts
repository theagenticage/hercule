import { describe, expect, it } from "vitest";
import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";
import type { WaitingRequest } from "../ipc/contract";
import { type FakeMainWindow, makeFakeMainWindow } from "./testing";
import {
  makeWaitingNotificationsLayer,
  type NativeNotification,
  WaitingNotifications,
} from "./waiting-notifications";

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
  use: (notifications: WaitingNotifications["Service"], seen: Seen) => Effect.Effect<unknown>,
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
  const layer = makeWaitingNotificationsLayer({
    Notification,
    setBadgeCount: (count) => seen.badgeCounts.push(count),
    askToNotify: () => {
      seen.asks += 1;
    },
  }).pipe(Layer.provide(window.layer));
  await Effect.runPromise(
    Effect.provide(
      WaitingNotifications.use((notifications) => use(notifications, seen)),
      layer,
    ),
  );
  return seen;
};

/** Returns the title, body and state of each notification created, in order. */
const describeNotifications = (seen: Seen) =>
  seen.notifications.map(({ title, body, state }) => ({ title, body, state }));

const LOGIN: WaitingRequest = {
  destination: { kind: "thread", sessionId: "session-1" },
  requestId: "request-1",
  openRequestIds: ["request-1"],
  title: "Fix the login bug",
  body: "Run the migration?",
};
const CHECKOUT: WaitingRequest = {
  destination: { kind: "thread", sessionId: "session-2" },
  requestId: "request-2",
  openRequestIds: ["request-2"],
  title: "Speed up checkout",
  body: "Run pnpm test?",
};
const ADA: WaitingRequest = {
  destination: { kind: "assistant", assistantId: "assistant-1" },
  requestId: "request-5",
  openRequestIds: ["request-5"],
  title: "Ada",
  body: "Book the train to Utrecht?",
};

/**
 * Returns `waiting` once it waits on the Requests `openRequestIds`, oldest
 * first, with a notification about the newest, whose text is `body`.
 */
const waitOn = (
  waiting: WaitingRequest,
  openRequestIds: readonly string[],
  body: string,
): WaitingRequest => ({ ...waiting, requestId: openRequestIds.at(-1)!, openRequestIds, body });

describe("WaitingNotifications", () => {
  it("counts the first list after signing in on the badge, and shows no notification for it", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([notifications.setSignedIn(true), notifications.setWaitingRequests([LOGIN])]),
    );
    expect(seen.badgeCounts).toEqual([1]);
    expect(seen.notifications).toEqual([]);
  });

  it("counts a thread that starts waiting and shows its notification while the window is not focused", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
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
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
      ]),
    );
    expect(seen.badgeCounts).toEqual([0, 1]);
    expect(seen.notifications).toEqual([]);
  });

  it("replaces a thread's notification when the thread waits on a new Request", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
        notifications.setWaitingRequests([waitOn(LOGIN, ["request-3"], "Deploy it?")]),
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
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
        Effect.sync(() => {
          seen.window.focused = true;
        }),
        notifications.setWaitingRequests([waitOn(LOGIN, ["request-3"], "Deploy it?")]),
      ]),
    );
    expect(describeNotifications(seen).map(({ state }) => state)).toEqual(["closed"]);
  });

  it("removes only the notification of the thread that no longer waits", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN, CHECKOUT]),
        notifications.setWaitingRequests([CHECKOUT]),
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
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
        // The reloaded page reads the token again, then sends its first list.
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([LOGIN, CHECKOUT]),
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
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
        Effect.sync(() => seen.notifications[0]?.click()),
      ]),
    );
    expect(seen.window.calls).toEqual([
      'showAndSend destination.open {"kind":"thread","sessionId":"session-1"}',
    ]);
  });

  it("does nothing when a notification it removed is clicked", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
        notifications.setWaitingRequests([]),
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
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN]),
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
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([LOGIN, CHECKOUT]),
        notifications.setSignedIn(false),
        notifications.setWaitingRequests([LOGIN]),
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([LOGIN, CHECKOUT]),
      ]),
    );
    expect(seen.badgeCounts).toEqual([0, 2, 0, 2]);
    expect(describeNotifications(seen).map(({ state }) => state)).toEqual(["closed", "closed"]);
  });

  it("shows an assistant's notification with the title it is sent, and asks the page to open the assistant when it is clicked", async () => {
    const seen = await runWithNotifications(false, (notifications, seen) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([LOGIN]),
        notifications.setWaitingRequests([LOGIN, ADA]),
        Effect.sync(() => seen.notifications[0]?.click()),
      ]),
    );
    expect(seen.badgeCounts).toEqual([1, 2]);
    expect(describeNotifications(seen)).toEqual([
      { title: "Ada", body: "Book the train to Utrecht?", state: "shown" },
    ]);
    expect(seen.window.calls).toEqual([
      'showAndSend destination.open {"kind":"assistant","assistantId":"assistant-1"}',
    ]);
  });

  it("keeps an assistant's notification while it waits on the same Request, and replaces it for a new one", async () => {
    const seen = await runWithNotifications(false, (notifications) =>
      Effect.all([
        notifications.setSignedIn(true),
        notifications.setWaitingRequests([]),
        notifications.setWaitingRequests([ADA]),
        notifications.setWaitingRequests([ADA, LOGIN]),
        notifications.setWaitingRequests([LOGIN, waitOn(ADA, ["request-6"], "Book a hotel?")]),
      ]),
    );
    expect(describeNotifications(seen).map(({ title, state }) => [title, state])).toEqual([
      ["Ada", "closed"],
      ["Fix the login bug", "shown"],
      ["Ada", "shown"],
    ]);
  });

  describe("with several Requests open on one destination", () => {
    const LOGIN_TWO = waitOn(LOGIN, ["request-1", "request-3"], "Deploy it?\n+1 more waiting");
    const LOGIN_THREE = waitOn(LOGIN, ["request-3"], "Deploy it?");
    const LOGIN_ONE = waitOn(LOGIN, ["request-1"], "Run the migration?");

    it("replaces the notification with the newest Request's when another opens", async () => {
      const seen = await runWithNotifications(false, (notifications) =>
        Effect.all([
          notifications.setSignedIn(true),
          notifications.setWaitingRequests([]),
          notifications.setWaitingRequests([LOGIN]),
          notifications.setWaitingRequests([LOGIN_TWO]),
        ]),
      );
      expect(seen.badgeCounts).toEqual([0, 1, 1]);
      expect(describeNotifications(seen).map(({ body, state }) => [body, state])).toEqual([
        ["Run the migration?", "closed"],
        ["Deploy it?\n+1 more waiting", "shown"],
      ]);
    });

    it("keeps the newest Request's notification, and shows none again, when an older one is answered", async () => {
      const seen = await runWithNotifications(false, (notifications) =>
        Effect.all([
          notifications.setSignedIn(true),
          notifications.setWaitingRequests([]),
          notifications.setWaitingRequests([LOGIN]),
          notifications.setWaitingRequests([LOGIN_TWO]),
          notifications.setWaitingRequests([LOGIN_THREE]),
        ]),
      );
      expect(describeNotifications(seen).map(({ body, state }) => [body, state])).toEqual([
        ["Run the migration?", "closed"],
        ["Deploy it?\n+1 more waiting", "shown"],
      ]);
    });

    it("removes the notification, and shows none in its place, when its Request is answered and an older one stays open", async () => {
      const seen = await runWithNotifications(false, (notifications) =>
        Effect.all([
          notifications.setSignedIn(true),
          notifications.setWaitingRequests([]),
          notifications.setWaitingRequests([LOGIN]),
          notifications.setWaitingRequests([LOGIN_TWO]),
          notifications.setWaitingRequests([LOGIN_ONE]),
        ]),
      );
      expect(seen.badgeCounts).toEqual([0, 1, 1, 1]);
      expect(describeNotifications(seen).map(({ body, state }) => [body, state])).toEqual([
        ["Run the migration?", "closed"],
        ["Deploy it?\n+1 more waiting", "closed"],
      ]);
    });

    it("removes the notification, and shows none, when another Request opens while the window is focused", async () => {
      const seen = await runWithNotifications(false, (notifications, seen) =>
        Effect.all([
          notifications.setSignedIn(true),
          notifications.setWaitingRequests([]),
          notifications.setWaitingRequests([LOGIN]),
          Effect.sync(() => {
            seen.window.focused = true;
          }),
          notifications.setWaitingRequests([LOGIN_TWO]),
        ]),
      );
      expect(describeNotifications(seen).map(({ body, state }) => [body, state])).toEqual([
        ["Run the migration?", "closed"],
      ]);
    });

    it("follows the same rules for an assistant", async () => {
      const seen = await runWithNotifications(false, (notifications) =>
        Effect.all([
          notifications.setSignedIn(true),
          notifications.setWaitingRequests([]),
          notifications.setWaitingRequests([ADA]),
          notifications.setWaitingRequests([
            waitOn(ADA, ["request-5", "request-6"], "Book a hotel?\n+1 more waiting"),
          ]),
          notifications.setWaitingRequests([waitOn(ADA, ["request-6"], "Book a hotel?")]),
          notifications.setWaitingRequests([
            waitOn(ADA, ["request-6", "request-7"], "Pay the bill?\n+1 more waiting"),
          ]),
          notifications.setWaitingRequests([waitOn(ADA, ["request-6"], "Book a hotel?")]),
        ]),
      );
      expect(describeNotifications(seen).map(({ body, state }) => [body, state])).toEqual([
        ["Book the train to Utrecht?", "closed"],
        ["Book a hotel?\n+1 more waiting", "closed"],
        ["Pay the bill?\n+1 more waiting", "closed"],
      ]);
    });
  });
});
