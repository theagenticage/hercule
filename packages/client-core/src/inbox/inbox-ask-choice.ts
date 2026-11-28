/**
 * The pane's choices among the asks of a thing: which ask is current (the one
 * Return answers), which is folded, and which reply box is open. Pure rules.
 * The state holds only what the user decided. What became of an answer that
 * was given is not here: the held answers own that.
 *
 * The pane keeps the state with a reducer: `reducePaneAskChoice(state, move)`.
 */
import type { EntitySignalLine } from "@hercule/contract";

/** The reply box that is open in the pane, and for which signal. The words in it are not here. */
export interface PaneReply {
  readonly signalId: string;
  readonly actionId: string;
}

/** The ask the user chose last for a thing, and whether they folded it. */
interface ChosenAsk {
  readonly signalId: string;
  readonly isFolded: boolean;
}

/** What the user has decided in the pane, for every thing they walked through. */
export interface PaneAskChoice {
  readonly chosen: ReadonlyMap<string, ChosenAsk>;
  readonly reply: PaneReply | null;
}

/** The state before the user decided anything. */
export const NO_PANE_ASK_CHOICE: PaneAskChoice = { chosen: new Map(), reply: null };

/** What a move needs to know about the thing it is made on. */
interface PaneAskTarget {
  readonly thingId: string;
  /** The asks of the thing, newest first. */
  readonly sections: readonly EntitySignalLine[];
  /** The signal kinds of the saved query the user is on. */
  readonly savedQueryKinds: readonly string[];
}

/** The moves the user makes in the pane's asks. */
export type PaneAskMove =
  /** Clicks the head of the ask `signalId`: the current open ask folds, any other becomes current and open. */
  | ({ readonly kind: "toggle"; readonly signalId: string } & PaneAskTarget)
  /** Makes the current ask current again and unfolds it, which Return does on a folded ask. */
  | ({ readonly kind: "unfold" } & PaneAskTarget)
  /** Steps to the ask before (`-1`) or after (`1`) the current one, and unfolds it. */
  | ({ readonly kind: "step"; readonly by: -1 | 1 } & PaneAskTarget)
  /** Opens the reply box of `actionId` on the current ask. */
  | ({ readonly kind: "open-reply"; readonly actionId: string } & PaneAskTarget)
  /** Opens the reply box of `actionId` on the ask `signalId` of the thing, unfolded. Undo of a held reply does this. */
  | {
      readonly kind: "reopen-reply";
      readonly thingId: string;
      readonly signalId: string;
      readonly actionId: string;
    }
  /** Closes the reply box: the answer was accepted, or the user cancelled. */
  | { readonly kind: "close-reply" };

/** What the pane draws of the asks of one thing. */
export interface PaneAsk {
  /** The id of the current ask, or `undefined` when the thing has no ask. */
  readonly currentId: string | undefined;
  /** True when the current ask is drawn open and read in full. */
  readonly isOpen: boolean;
  /** The reply box that is open on the current ask, else `null`. */
  readonly reply: PaneReply | null;
}

/**
 * Returns the id of the current ask: the one the user chose while it is
 * still a section, else the newest section whose kind is in `savedQueryKinds`,
 * else the newest. Returns `undefined` with no sections.
 */
const chooseCurrentAsk = (
  sections: readonly EntitySignalLine[],
  savedQueryKinds: readonly string[],
  chosenId: string | undefined,
): string | undefined => {
  if (chosenId !== undefined && sections.some((line) => line.id === chosenId)) return chosenId;
  const named = sections.find((line) => savedQueryKinds.includes(line.kind));
  return (named ?? sections[0])?.id;
};

/**
 * Returns what the pane draws of the asks of the thing `thingId`.
 *
 * A fold belongs to the ask the user folded: another ask that became current
 * is drawn open.
 */
export const decidePaneAsk = (
  choice: PaneAskChoice,
  thingId: string,
  sections: readonly EntitySignalLine[],
  savedQueryKinds: readonly string[],
): PaneAsk => {
  const chosen = choice.chosen.get(thingId);
  const currentId = chooseCurrentAsk(sections, savedQueryKinds, chosen?.signalId);
  const isFolded = chosen?.isFolded === true && currentId === chosen.signalId;
  return {
    currentId,
    isOpen: currentId !== undefined && !isFolded,
    reply: currentId !== undefined && choice.reply?.signalId === currentId ? choice.reply : null,
  };
};

/** Returns `choice` with the ask `signalId` chosen for the thing. */
const choose = (
  choice: PaneAskChoice,
  thingId: string,
  signalId: string,
  isFolded: boolean,
): PaneAskChoice => ({
  ...choice,
  chosen: new Map(choice.chosen).set(thingId, { signalId, isFolded }),
});

/**
 * Returns the state after `move`. A step stops at the first and last ask and
 * does not wrap. A move that changes nothing returns `choice` itself, so a
 * reducer built on this does not render again.
 */
export const reducePaneAskChoice = (choice: PaneAskChoice, move: PaneAskMove): PaneAskChoice => {
  if (move.kind === "close-reply")
    return choice.reply === null ? choice : { ...choice, reply: null };
  if (move.kind === "reopen-reply") {
    return {
      ...choose(choice, move.thingId, move.signalId, false),
      reply: { signalId: move.signalId, actionId: move.actionId },
    };
  }
  const { currentId, isOpen } = decidePaneAsk(
    choice,
    move.thingId,
    move.sections,
    move.savedQueryKinds,
  );
  if (currentId === undefined) return choice;
  switch (move.kind) {
    case "toggle":
      return choose(choice, move.thingId, move.signalId, move.signalId === currentId && isOpen);
    case "unfold":
      return choose(choice, move.thingId, currentId, false);
    case "open-reply":
      return { ...choice, reply: { signalId: currentId, actionId: move.actionId } };
    case "step": {
      const at = move.sections.findIndex((line) => line.id === currentId);
      const next = Math.min(move.sections.length - 1, Math.max(0, at + move.by));
      return choose(choice, move.thingId, move.sections[next]!.id, false);
    }
  }
};

/** What Return does in the pane. */
export type PaneReturnPress =
  /** Unfolds the folded current ask: the next press answers it. */
  | "unfold"
  /** Gives the suggested answer. */
  | "answer"
  /** Opens the reply box of the suggested answer. */
  | "open-reply"
  /** Moves the focus to the first answer, because the ask suggests none. */
  | "focus-answers"
  | "nothing";

/**
 * Decides what Return does on the current ask.
 *
 * - `isShowing` is false while the pane shows no thing the answer may go to
 *   (it is hidden, or still draws the thing before). Nothing happens then.
 * - `canAnswer` is false while the ask is not read yet or already has an
 *   answer on its way. A folded ask is still unfolded then.
 * - `suggested` is the suggested answer, `undefined` when the ask suggests
 *   none. Only its style matters here.
 */
export const decideReturnPress = (
  ask: Pick<PaneAsk, "currentId" | "isOpen">,
  input: {
    readonly isShowing: boolean;
    readonly canAnswer: boolean;
    readonly suggested: { readonly style: string } | undefined;
  },
): PaneReturnPress => {
  if (ask.currentId === undefined || !input.isShowing) return "nothing";
  if (!ask.isOpen) return "unfold";
  if (!input.canAnswer) return "nothing";
  if (input.suggested === undefined) return "focus-answers";
  return input.suggested.style === "reply" ? "open-reply" : "answer";
};
