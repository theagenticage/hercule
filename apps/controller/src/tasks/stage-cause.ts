/**
 * The words of a card's stage cause: why the card sits in its stage when a
 * fact about a linked thing placed it, such as "Pull request #6221 merged".
 */
import { MAX_STAGE_CAUSE_TEXT, type EntityLifecycle, type TaskStage } from "@hercule/contract";
import { cutTextAtWord } from "../text";

/** What is stored about the thing a fact is about. */
export interface StageCauseThing {
  /** The kind's noun, as the kind declared it ("Pull request"). */
  readonly noun: string;
  /** The thing's short name in its source ("#6221"), when the record has one. */
  readonly identifier: string | null;
  /** The lifecycle the record holds now. */
  readonly lifecycle: EntityLifecycle | null;
  /** The word of the status the record holds now ("Merged"), when it has a status. */
  readonly statusWord: string | null;
}

/** What `describeStageCause` needs: the fact's own lifecycles, and the thing when a record exists. */
export interface StageCauseFact {
  readonly lifecycle: EntityLifecycle;
  readonly previousLifecycle: EntityLifecycle | null;
  /** The record of the fact's ref, or `undefined` once Hercule no longer holds it. */
  readonly thing: StageCauseThing | undefined;
}

/** Names a thing that Hercule holds no record of any more. */
const UNKNOWN_THING = "A linked thing";

/**
 * Returns the verb that says what happened to the thing. It follows the
 * fact's own lifecycle, never the thing's latest one, so a pull request that
 * is reopened later does not change why the card moved.
 *
 * - `open`: "reopened" when the thing was finished before, else "opened".
 * - `completed` and `abandoned`: the word of the thing's status, lower case
 *   ("merged"), when the thing is still in the state the fact reported. Once
 *   it has moved on, its status word says something else, so the verb is
 *   "completed" or "closed".
 */
const chooseVerb = (fact: StageCauseFact): string => {
  const { lifecycle, previousLifecycle, thing } = fact;
  if (lifecycle === "open") {
    return previousLifecycle === "completed" || previousLifecycle === "abandoned"
      ? "reopened"
      : "opened";
  }
  if (thing !== undefined && thing.lifecycle === lifecycle && thing.statusWord !== null) {
    const word = thing.statusWord.trim().toLowerCase();
    if (word !== "") return word;
  }
  return lifecycle === "completed" ? "completed" : "closed";
};

/**
 * Returns the sentence that says why a fact moved a card, such as "Pull
 * request #6221 merged". The thing is named by its stored noun and identifier,
 * or "A linked thing" when no record is left. The text is cut at a word to
 * `MAX_STAGE_CAUSE_TEXT`.
 */
export const describeStageCause = (fact: StageCauseFact): string => {
  const { thing } = fact;
  const subject =
    thing === undefined
      ? UNKNOWN_THING
      : [thing.noun, thing.identifier].filter((word) => word !== null && word !== "").join(" ");
  return cutTextAtWord(`${subject} ${chooseVerb(fact)}`, MAX_STAGE_CAUSE_TEXT);
};

/** The name of each stage as the user reads it on the board. */
const STAGE_WORDS: Readonly<Record<TaskStage, string>> = {
  exploring: "Exploring",
  planned: "Planned",
  building: "Building",
  "in-review": "In review",
  landed: "Landed",
  done: "Done",
  dropped: "Dropped",
};

/** Returns the name of a stage as the user reads it on the board, such as "In review". */
export const describeStage = (stage: TaskStage): string => STAGE_WORDS[stage];

/**
 * The title of a Thread that has none. The Task made for such a Thread gets
 * the same words, because a Task's title has at least one character.
 */
export const UNTITLED_THREAD_TITLE = "Untitled thread";

/**
 * Returns the sentence that says why a Stage Report moved a card, such as
 * "\u201cPricing research\u201d says Planned". `stage` is the card's current stage,
 * which a Stage Report placed. A blank `sessionTitle` reads "Untitled
 * thread". Only the title is cut (at a word), so the whole text fits
 * `MAX_STAGE_CAUSE_TEXT` and always ends with the stage.
 */
export const describeStageReport = (sessionTitle: string, stage: TaskStage): string => {
  const title = sessionTitle.trim() === "" ? UNTITLED_THREAD_TITLE : sessionTitle.trim();
  const suffix = `\u201d says ${describeStage(stage)}`;
  const room = MAX_STAGE_CAUSE_TEXT - suffix.length - 1; // 1 for the opening quote
  return `\u201c${cutTextAtWord(title, room)}${suffix}`;
};
