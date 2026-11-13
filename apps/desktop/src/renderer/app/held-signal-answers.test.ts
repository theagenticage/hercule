/** Tests the Inbox's held answers through their interface, with a fake row, undo line and pane. */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { REFUSED_OFFLINE, SIGNAL_ANSWER_HOLD_MS } from "@hercule/client-core/inbox";
import type { CardMover } from "./card-mover";
import {
  createHeldSignalAnswers,
  type AnswerPresentation,
  type HeldSignalAnswer,
} from "./held-signal-answers";
import { createPendingIntents, type IntentStorage } from "./pending-intents";
import type { Gesture } from "./undo-stack";

beforeEach(() => {
  vi.useFakeTimers();
});
afterEach(() => {
  vi.useRealTimers();
});

const createMemoryStorage = (): IntentStorage => {
  const items = new Map<string, string>();
  return {
    getItem: (key) => items.get(key) ?? null,
    setItem: (key, value) => void items.set(key, value),
    removeItem: (key) => void items.delete(key),
  };
};

const ANSWER: HeldSignalAnswer = {
  thing: { ref: "row-1", id: "entity-1", identifier: "ENG-1" },
  signalId: "signal-1",
  actionId: "approve",
  label: "Approve",
  sourceName: "GitHub",
};

const REPLY: HeldSignalAnswer = { ...ANSWER, actionId: "reply", label: "Reply", text: "On it" };

interface SendCall {
  readonly resolve: () => void;
  readonly reject: (error: Error) => void;
}

const setUp = (storage = createMemoryStorage()) => {
  const calls: SendCall[] = [];
  const send = vi.fn(
    () =>
      new Promise<void>((resolve, reject) => {
        calls.push({ resolve, reject });
      }),
  );
  const store = createPendingIntents({ storage, storageKey: "key", send });
  const held = createHeldSignalAnswers(store);

  const events: string[] = [];
  let gesture: Gesture<CardMover> | undefined;
  let isOnStack = false;
  let isOffline = false;
  const presentation: AnswerPresentation = {
    line: {
      sayWithUndo: (text, offered) => {
        gesture = offered;
        isOnStack = true;
        events.push(`say: ${text}`);
        return () => {
          isOnStack = false;
        };
      },
      restate: (offered, update) => {
        if (offered !== gesture) return;
        events.push(`restate: ${update.text} undo=${String(update.offersUndo)}`);
      },
    },
    takeRow: () => {
      events.push("row taken");
      return {
        confirm: () => events.push("row confirmed"),
        putBack: () => events.push("row put back"),
        fail: () => events.push("row failed"),
      };
    },
    moved: () => events.push("moved"),
    showThing: (ref) => events.push(`show ${ref}`),
    say: (text) => events.push(`said: ${text}`),
    isOffline: () => isOffline,
  };
  const detach = held.attach(presentation);
  return {
    held,
    store,
    send,
    calls,
    events,
    detach,
    presentation,
    isOnStack: () => isOnStack,
    undo: () => gesture?.undo(null as never),
    setOffline: (value: boolean) => {
      isOffline = value;
    },
  };
};

describe("a held answer", () => {
  it("on Undo during the hold, puts the row back, reopens the reply with its words and says so", async () => {
    const { held, events, undo, send } = setUp();
    const reopenReply = vi.fn();
    held.hold({ ...REPLY, reopenReply });

    await expect(undo()).resolves.toEqual({ text: "Not sent. The ask is open again." });

    expect(events).toContain("row put back");
    expect(events).toContain("show row-1");
    expect(reopenReply).toHaveBeenCalledTimes(1);
    expect(held.readDraft("signal-1", "reply")).toBe("On it");
    await vi.advanceTimersByTimeAsync(SIGNAL_ANSWER_HOLD_MS);
    expect(send).not.toHaveBeenCalled();
  });

  it("says what the line shows while waiting and once sent, and Undo after it says it is too late", async () => {
    const { held, events, calls, undo, isOnStack } = setUp();
    held.hold(ANSWER);

    await vi.advanceTimersByTimeAsync(SIGNAL_ANSWER_HOLD_MS);
    expect(JSON.stringify(await undo())).toContain("being sent");
    calls[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContain("restate: Sent to GitHub. undo=false");
    expect(events).toContain("row confirmed");
    expect(isOnStack()).toBe(true);
    expect(JSON.stringify(await undo())).toContain("Already sent");
  });

  it("held past its deadline by the line, waits, says so, and sends when let go", async () => {
    const { held, store, events, send, calls } = setUp();
    held.hold(ANSWER);
    const [intent] = store.getSnapshot();
    store.setHeld(intent!.intentId, true);

    await vi.advanceTimersByTimeAsync(SIGNAL_ANSWER_HOLD_MS * 2);
    expect(send).not.toHaveBeenCalled();
    expect(events).toContain("restate: Approve ENG-1 on GitHub. Sends when you let go. undo=true");

    store.setHeld(intent!.intentId, false);
    calls[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);
    expect(events).toContain("row confirmed");
    expect(store.getSnapshot()).toEqual([]);
  });

  it("when the send fails, puts the row back, takes the gesture off the stack and lists it as unsent", async () => {
    const { held, events, calls, isOnStack } = setUp();
    held.hold(ANSWER);
    await vi.advanceTimersByTimeAsync(SIGNAL_ANSWER_HOLD_MS);
    calls[0]?.reject(new Error("The source refused."));
    await vi.advanceTimersByTimeAsync(0);

    expect(events).toContain("row failed");
    expect(isOnStack()).toBe(false);
    expect(held.getSnapshot().readChosen("signal-1")).toEqual({
      actionId: "approve",
      state: "unsent",
    });
    const [unsent] = held.getSnapshot().listUnsent("entity-1");
    expect(unsent?.signalId).toBe("signal-1");
    expect(unsent?.sentence).toContain("The source refused.");
  });

  it("draws nothing for a late completion once another screen is attached, but still finishes", async () => {
    const { held, events, calls, detach, presentation, store } = setUp();
    held.hold(ANSWER);
    detach();
    held.attach({
      ...presentation,
      takeRow: () => ({ confirm: vi.fn(), putBack: vi.fn(), fail: vi.fn() }),
    });
    const before = events.length;

    await vi.advanceTimersByTimeAsync(SIGNAL_ANSWER_HOLD_MS);
    calls[0]?.resolve();
    await vi.advanceTimersByTimeAsync(0);

    expect(events.length).toBe(before);
    expect(store.getSnapshot()).toEqual([]);
  });

  it("refuses offline and holds nothing", () => {
    const { held, events, store, setOffline } = setUp();
    setOffline(true);

    expect(held.hold(ANSWER)).toBe(false);
    expect(events).toEqual([`said: ${REFUSED_OFFLINE}`]);
    expect(store.getSnapshot()).toEqual([]);
  });
});

describe("with no presentation attached", () => {
  it("holds nothing, so no answer is sent without an Undo", () => {
    const { held, store, detach } = setUp();
    detach();

    expect(held.hold(ANSWER)).toBe(false);
    expect(store.getSnapshot()).toEqual([]);
  });
});

describe("unsent answers after the app restarted", () => {
  const restart = () => {
    const storage = createMemoryStorage();
    const first = setUp(storage);
    first.held.hold(REPLY);
    first.store.dispose();
    return setUp(storage);
  };

  it("lists the answer as not sent, and Send again holds it anew", async () => {
    const { held, events, send, calls } = restart();
    const [unsent] = held.getSnapshot().listUnsent("entity-1");
    expect(unsent).toMatchObject({ isInterrupted: true, words: "On it", actionId: "reply" });

    const isAccepted = held.sendAgain(unsent!.id, { thing: ANSWER.thing });
    expect(isAccepted).toBe(true);
    expect(held.getSnapshot().listUnsent("entity-1")).toEqual([]);
    expect(events).toContain("say: Reply ENG-1 on GitHub. Sends in 8s.");

    await vi.advanceTimersByTimeAsync(SIGNAL_ANSWER_HOLD_MS);
    expect(send).toHaveBeenCalledTimes(1);
    calls[0]?.resolve();
  });

  it("keeps the answer when Send again is pressed offline, and Discard removes it", () => {
    const { held, events, setOffline } = restart();
    const [unsent] = held.getSnapshot().listUnsent("entity-1");
    setOffline(true);

    expect(held.sendAgain(unsent!.id, { thing: ANSWER.thing })).toBe(false);
    expect(held.getSnapshot().listUnsent("entity-1")).toHaveLength(1);
    expect(events.at(-1)).toBe(`said: ${REFUSED_OFFLINE}`);

    held.discard(unsent!.id);
    expect(held.getSnapshot().listUnsent("entity-1")).toEqual([]);
  });
});

describe("the reply drafts", () => {
  it("gives back what was written per signal and answer, and drops it when empty or cleared", () => {
    const { held } = setUp();
    held.writeDraft("s1", "reply", "On it");
    held.writeDraft("s1", "comment", "Other");

    expect(held.readDraft("s1", "reply")).toBe("On it");
    expect(held.readDraft("s2", "reply")).toBe("");
    held.writeDraft("s1", "reply", "");
    expect(held.readDraft("s1", "reply")).toBe("");
    held.clear();
    expect(held.readDraft("s1", "comment")).toBe("");
  });
});
