import { describe, expect, it } from "vitest";
import { buildSignalLine } from "./cards.testing";
import {
  NO_PANE_ASK_CHOICE,
  decidePaneAsk,
  decideReturnPress,
  reducePaneAskChoice,
  type PaneAskChoice,
  type PaneAskMove,
} from "./inbox-ask-choice";

const line = (id: string, createdAt: string, overrides = {}) =>
  buildSignalLine(id, id, { createdAt, ...overrides });

const sections = [
  line("new", "2026-11-07T12:00:00.000Z", { kind: "acme/mention" }),
  line("mid", "2026-11-07T11:00:00.000Z", { kind: "acme/review-requested" }),
  line("old", "2026-11-07T10:00:00.000Z", { kind: "acme/review-requested" }),
];
const target = { thingId: "t1", sections, savedQueryKinds: [] as readonly string[] };

const play = (...moves: PaneAskMove[]): PaneAskChoice =>
  moves.reduce(reducePaneAskChoice, NO_PANE_ASK_CHOICE);

describe("decidePaneAsk", () => {
  it.each([
    ["the chosen ask while it is a section", ["acme/review-requested"], "old", "old"],
    [
      "the newest of the saved query's kinds with no choice",
      ["acme/review-requested"],
      undefined,
      "mid",
    ],
    ["the saved query's kind over a stale choice", ["acme/review-requested"], "gone", "mid"],
    ["the newest when the saved query names no kind here", ["acme/other"], undefined, "new"],
    ["the newest when the saved query names none", [], "gone", "new"],
  ])("makes current %s", (_name, kinds, chosen, expected) => {
    const choice =
      chosen === undefined
        ? NO_PANE_ASK_CHOICE
        : {
            ...NO_PANE_ASK_CHOICE,
            chosen: new Map([["t1", { signalId: chosen, isFolded: false }]]),
          };
    expect(decidePaneAsk(choice, "t1", sections, kinds).currentId).toBe(expected);
  });

  it("has no current ask without sections", () => {
    expect(decidePaneAsk(NO_PANE_ASK_CHOICE, "t1", [], [])).toEqual({
      currentId: undefined,
      isOpen: false,
      reply: null,
    });
  });
});

describe("the moves", () => {
  it("fold the current ask on a click, and unfold it on the next", () => {
    const folded = play({ kind: "toggle", signalId: "new", ...target });
    expect(decidePaneAsk(folded, "t1", sections, [])).toMatchObject({
      currentId: "new",
      isOpen: false,
    });
    const open = reducePaneAskChoice(folded, { kind: "toggle", signalId: "new", ...target });
    expect(decidePaneAsk(open, "t1", sections, []).isOpen).toBe(true);
  });

  it("make another ask current and open on a click", () => {
    const choice = play({ kind: "toggle", signalId: "old", ...target });
    expect(decidePaneAsk(choice, "t1", sections, [])).toMatchObject({
      currentId: "old",
      isOpen: true,
    });
  });

  it("draw a newly current ask open: the fold belongs to the ask that was folded", () => {
    const folded = play({ kind: "toggle", signalId: "new", ...target });
    const choice = decidePaneAsk(folded, "t1", sections.slice(1), []);
    expect(choice).toMatchObject({ currentId: "mid", isOpen: true });
  });

  it("unfold the current ask for Return", () => {
    const choice = play(
      { kind: "toggle", signalId: "new", ...target },
      { kind: "unfold", ...target },
    );
    expect(decidePaneAsk(choice, "t1", sections, []).isOpen).toBe(true);
  });

  it("step without wrapping, and unfold the ask stepped to", () => {
    const down = play({ kind: "step", by: 1, ...target }, { kind: "step", by: 1, ...target });
    expect(decidePaneAsk(down, "t1", sections, []).currentId).toBe("old");
    const end = reducePaneAskChoice(down, { kind: "step", by: 1, ...target });
    expect(decidePaneAsk(end, "t1", sections, []).currentId).toBe("old");
    const folded = play(
      { kind: "toggle", signalId: "new", ...target },
      { kind: "step", by: -1, ...target },
    );
    expect(decidePaneAsk(folded, "t1", sections, [])).toMatchObject({
      currentId: "new",
      isOpen: true,
    });
  });

  it("keep a choice for each thing", () => {
    const choice = play(
      { kind: "step", by: 1, ...target },
      { kind: "step", by: 1, ...target, thingId: "t2" },
    );
    expect(decidePaneAsk(choice, "t1", sections, []).currentId).toBe("mid");
    expect(decidePaneAsk(choice, "t2", sections, []).currentId).toBe("mid");
  });

  it("step on nothing when there are no asks", () => {
    expect(
      reducePaneAskChoice(NO_PANE_ASK_CHOICE, { kind: "step", by: 1, ...target, sections: [] }),
    ).toBe(NO_PANE_ASK_CHOICE);
  });

  it("open the reply box on the current ask and close it", () => {
    const open = play({ kind: "open-reply", actionId: "reply", ...target });
    expect(decidePaneAsk(open, "t1", sections, []).reply).toEqual({
      signalId: "new",
      actionId: "reply",
    });
    const closed = reducePaneAskChoice(open, { kind: "close-reply" });
    expect(decidePaneAsk(closed, "t1", sections, []).reply).toBeNull();
    expect(reducePaneAskChoice(closed, { kind: "close-reply" })).toBe(closed);
  });

  it("reopen the reply box of a taken-back answer on an ask that was folded", () => {
    const choice = play(
      { kind: "toggle", signalId: "old", ...target },
      { kind: "toggle", signalId: "old", ...target },
      { kind: "reopen-reply", thingId: "t1", signalId: "old", actionId: "reply" },
    );
    expect(decidePaneAsk(choice, "t1", sections, [])).toEqual({
      currentId: "old",
      isOpen: true,
      reply: { signalId: "old", actionId: "reply" },
    });
  });

  it("draw the reply box only on the ask it was opened for", () => {
    const open = play({ kind: "open-reply", actionId: "reply", ...target });
    const other = reducePaneAskChoice(open, { kind: "toggle", signalId: "mid", ...target });
    expect(decidePaneAsk(other, "t1", sections, []).reply).toBeNull();
  });
});

describe("decideReturnPress", () => {
  const ready = { isShowing: true, canAnswer: true };
  const open = { currentId: "a", isOpen: true };

  it.each([
    [
      "nothing with no ask",
      { currentId: undefined, isOpen: false },
      { ...ready, suggested: undefined },
      "nothing",
    ],
    [
      "nothing while the pane does not show the thing",
      open,
      { ...ready, isShowing: false, suggested: { style: "plain" } },
      "nothing",
    ],
    [
      "unfold on a folded ask",
      { currentId: "a", isOpen: false },
      { ...ready, canAnswer: false, suggested: undefined },
      "unfold",
    ],
    [
      "nothing while the ask is not read or has an answer on its way",
      open,
      { ...ready, canAnswer: false, suggested: { style: "plain" } },
      "nothing",
    ],
    [
      "focus the answers when none is suggested",
      open,
      { ...ready, suggested: undefined },
      "focus-answers",
    ],
    [
      "open the reply box for a suggested reply",
      open,
      { ...ready, suggested: { style: "reply" } },
      "open-reply",
    ],
    [
      "answer for any other suggested answer",
      open,
      { ...ready, suggested: { style: "plain" } },
      "answer",
    ],
  ] as const)("does %s", (_name, ask, input, expected) => {
    expect(decideReturnPress(ask, input)).toBe(expected);
  });
});
