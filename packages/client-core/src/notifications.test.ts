import { assert, describe, it } from "vitest";
import type { Notification, Resolution } from "@hercule/contract";
import {
  chooseNotificationMark,
  describeProducer,
  describeResolution,
  formatUnseenCount,
  isNotificationMuted,
  parseMuteKind,
  toggleMuteKey,
} from "./notifications";

const ID = "01a06d02-c111-7a0e-8b3d-9c1f7c82ebeb";

const informational: Notification = {
  id: ID,
  kind: "triage.fyi",
  title: "Three new issues",
  producer: { type: "run", runId: ID, stepId: "notify" },
  muteKey: `workflow:${ID}`,
  subject: [],
  actions: [],
  status: "resolved",
  createdAt: "2026-09-28T09:00:00.000Z",
};

const decision: Notification = {
  ...informational,
  kind: "triage.proposal",
  actions: [{ id: "start", label: "Start", operation: null }],
  status: "open",
};

const resolution = (overrides: Partial<Resolution>): Resolution => ({
  kind: "decided",
  actor: "user",
  origin: "web",
  at: "2026-09-28T10:00:00.000Z",
  ...overrides,
});

describe("describeProducer", () => {
  it("names the core as the product", () => {
    assert.strictEqual(describeProducer({ type: "core" }), "Hercule");
  });

  it("names a workflow step as a workflow run", () => {
    assert.strictEqual(
      describeProducer({ type: "run", runId: ID, stepId: "notify" }),
      "Workflow run",
    );
  });

  it("names a session as a session", () => {
    assert.strictEqual(describeProducer({ type: "session", sessionId: ID }), "Session");
  });

  it("names a plugin by its id", () => {
    assert.strictEqual(describeProducer({ type: "plugin", pluginId: "gmail" }), "gmail");
  });
});

describe("chooseNotificationMark", () => {
  it("marks an open decision as a decision", () => {
    assert.strictEqual(chooseNotificationMark(decision), "decision");
  });

  it("marks the core's run failure as failed", () => {
    assert.strictEqual(
      chooseNotificationMark({ ...informational, kind: "core.run-failed" }),
      "failed",
    );
  });

  it("gives any other informational notification no mark", () => {
    assert.strictEqual(chooseNotificationMark(informational), "none");
  });

  it("marks a decided or handled decision as done", () => {
    for (const kind of ["decided", "handled"] as const) {
      assert.strictEqual(
        chooseNotificationMark({
          ...decision,
          status: "resolved",
          resolution: resolution({ kind }),
        }),
        "done",
      );
    }
  });

  it("marks a withdrawn decision as withdrawn", () => {
    assert.strictEqual(
      chooseNotificationMark({
        ...decision,
        status: "resolved",
        resolution: resolution({ kind: "withdrawn", origin: "core", reason: "gone" }),
      }),
      "withdrawn",
    );
  });
});

describe("describeResolution", () => {
  it("says a decision was decided in the web app", () => {
    assert.strictEqual(describeResolution(resolution({})), "decided in the web app");
  });

  it("says a decision was decided in a chat channel, without naming the Connection", () => {
    assert.strictEqual(
      describeResolution(resolution({ origin: `connection:${ID}` })),
      "decided in a chat channel",
    );
  });

  it("names a session by its id tail", () => {
    assert.strictEqual(
      describeResolution(resolution({ origin: `session:${ID}` })),
      "decided in session 7c82ebeb",
    );
  });

  it("names a plugin by its id", () => {
    assert.strictEqual(
      describeResolution(resolution({ origin: "plugin:gmail" })),
      "decided in the gmail plugin",
    );
  });

  it("says the core decided", () => {
    assert.strictEqual(describeResolution(resolution({ origin: "core" })), "decided by Hercule");
  });

  it("says an assistant handled it", () => {
    assert.strictEqual(
      describeResolution(resolution({ kind: "handled", origin: `connection:${ID}` })),
      "handled by an assistant",
    );
  });

  it("gives the reason a decision was withdrawn", () => {
    assert.strictEqual(
      describeResolution(resolution({ kind: "withdrawn", reason: "token refreshed" })),
      "withdrawn: token refreshed",
    );
  });

  it("says withdrawn alone when there is no reason", () => {
    assert.strictEqual(describeResolution(resolution({ kind: "withdrawn" })), "withdrawn");
  });
});

describe("parseMuteKind", () => {
  it("parses the kind before the colon", () => {
    assert.strictEqual(parseMuteKind(`workflow:${ID}`), "workflow");
    assert.strictEqual(parseMuteKind("plugin:gmail"), "plugin");
    assert.strictEqual(parseMuteKind(`assistant:${ID}`), "assistant");
  });
});

describe("isNotificationMuted", () => {
  it("is true when the notification's mute key is in the list", () => {
    assert.isTrue(isNotificationMuted(informational, [`workflow:${ID}`]));
  });

  it("is false when the key is not in the list", () => {
    assert.isFalse(isNotificationMuted(informational, ["plugin:gmail"]));
  });

  it("is false for a notification without a mute key", () => {
    const core: Notification = {
      id: ID,
      kind: "core.run-failed",
      title: "Nightly failed",
      producer: { type: "core" },
      subject: [],
      actions: [],
      status: "resolved",
      createdAt: "2026-09-28T09:00:00.000Z",
    };
    assert.isFalse(isNotificationMuted(core, [`workflow:${ID}`]));
  });
});

describe("toggleMuteKey", () => {
  it("adds a key that is not in the list at the end", () => {
    assert.deepStrictEqual(toggleMuteKey(["plugin:gmail"], `workflow:${ID}`), [
      "plugin:gmail",
      `workflow:${ID}`,
    ]);
  });

  it("removes a key that is in the list and keeps the others", () => {
    assert.deepStrictEqual(toggleMuteKey(["plugin:gmail", `workflow:${ID}`], "plugin:gmail"), [
      `workflow:${ID}`,
    ]);
  });
});

describe("formatUnseenCount", () => {
  it("shows no count for none", () => {
    assert.isUndefined(formatUnseenCount(0));
  });

  it("shows the number up to 99", () => {
    assert.strictEqual(formatUnseenCount(1), "1");
    assert.strictEqual(formatUnseenCount(99), "99");
  });

  it("shows 99+ above 99", () => {
    assert.strictEqual(formatUnseenCount(100), "99+");
  });
});
