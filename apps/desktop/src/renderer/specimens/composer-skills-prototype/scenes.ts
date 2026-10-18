/**
 * PROTOTYPE (#766). The scenes the switcher offers. Each one is a plain
 * data record: what the composer holds, which list is open on it, which
 * chip is selected or hovered, and what the thread adds to its transcript
 * and its queue. The components draw from the record and decide nothing.
 *
 * A scene is reachable by its `key` in the URL: `?scene=dollar-list`.
 */
import type { SkillRef } from "./fixture";

/** One run of the composer's content: plain text, or one skill chip. */
export type ComposerRun =
  | { readonly kind: "text"; readonly text: string }
  | { readonly kind: "skill"; readonly ref: SkillRef };

/** Where the caret sits: `offset` characters into the text run at index `run`. */
export interface ComposerCaret {
  readonly run: number;
  readonly offset: number;
}

/** What the message field holds. */
export interface SceneComposer {
  /** The content, in order. The field draws its placeholder when this is empty. */
  readonly runs: ReadonlyArray<ComposerRun>;
  /** Absent when the field draws no caret. */
  readonly caret?: ComposerCaret;
  /** Whether the focus is in the field. */
  readonly focused: boolean;
}

/** The list open above the composer card. */
export interface SceneList {
  /** `$` opens the skill list, `/` the command list. */
  readonly trigger: "$" | "/";
  /** What was typed after the trigger. */
  readonly query: string;
  /** The index of the one highlighted row, in the order the list shows its rows. `null` for none. */
  readonly activeRow: number | null;
  /** For `/`: also draws the commands that are not skills, see `ILLUSTRATIVE_COMMANDS`. */
  readonly withOtherKinds?: boolean;
}

/** A queued input the scene adds after the thread's own queued input. */
export interface SceneQueuedInput {
  readonly text: string;
  /**
   * The message that explains why the input cannot be steered. It is drawn
   * as the row's note (`Input.reason`), which stands in for the error a
   * refused Steer shows once the app builds it.
   */
  readonly refusal?: string;
}

export interface Scene {
  /** The kebab-case name in the URL. */
  readonly key: string;
  /** The name the switcher shows. */
  readonly name: string;
  readonly composer: SceneComposer;
  readonly list?: SceneList;
  /** The index of the chip, in `composer.runs`, that is selected. */
  readonly selectedChip?: number;
  /** The index of the chip, in `composer.runs`, that the pointer is on, which opens its hover card. */
  readonly hoveredChip?: number;
  /** Whether the transcript is scrolled away, which shrinks the composer. */
  readonly shrunk?: boolean;
  /** The text of a user message the transcript adds at its end, already sent. */
  readonly sentMessage?: string;
  readonly queuedInputs?: ReadonlyArray<SceneQueuedInput>;
}

const text = (value: string): ComposerRun => ({ kind: "text", text: value });
const library = (name: string): ComposerRun => ({
  kind: "skill",
  ref: { source: "library", name },
});
const repository = (name: string): ComposerRun => ({
  kind: "skill",
  ref: { source: "repository", checkout: "webshop", name },
});

/** A field that holds `value` as one run of text, with the caret after it and the focus in it. */
const typed = (value: string): SceneComposer => ({
  runs: [text(value)],
  caret: { run: 0, offset: value.length },
  focused: true,
});

/** The composer of the chip scenes: both kinds of chip, each at the start of a line and mid-sentence. */
const CHIPS_COMPOSER: SceneComposer = {
  runs: [
    library("implement"),
    text(" the fix for EU cards, then run the "),
    repository("release-checklist"),
    text(" before we ship.\n"),
    repository("stripe-fixtures"),
    text(" sets up the test cards, so use it before "),
    library("debug"),
    text("."),
  ],
  caret: { run: 7, offset: 1 },
  focused: true,
};

const TALL_TEXT = [
  "Checkout fails for EU cards that need 3-D Secure since deploy #1289.",
  "",
  "What I know so far:",
  "- the card is accepted by Stripe",
  "- the status comes back as requires_action",
  "- we show Card declined instead of opening the modal",
  "",
  "What I need from you:",
  "1. Find the cause.",
  "2. Write a test that reproduces it first.",
  "3. Fix it, and check the Apple Pay path too.",
  "",
  "Do not touch the refund flow.",
].join("\n");

const EDITOR_SENTENCE = "Also check the alt text on the gallery page";

export const SCENES: ReadonlyArray<Scene> = [
  {
    key: "editor-empty",
    name: "Editor: empty, placeholder",
    composer: { runs: [], focused: false },
  },
  { key: "editor-text", name: "Editor: one line, focused", composer: typed(EDITOR_SENTENCE) },
  {
    key: "editor-tall",
    name: "Editor: past the max height, scrolls",
    composer: typed(TALL_TEXT),
  },
  {
    key: "editor-shrunk",
    name: "Editor: shrunk, transcript scrolled away",
    composer: { runs: [text(EDITOR_SENTENCE)], focused: false },
    shrunk: true,
  },
  {
    key: "dollar-list",
    name: "$ list: $imp, first row active",
    composer: typed("$imp"),
    list: { trigger: "$", query: "imp", activeRow: 0 },
  },
  {
    key: "dollar-hover",
    name: "$ list: pointer on the third row",
    composer: typed("$imp"),
    list: { trigger: "$", query: "imp", activeRow: 2 },
  },
  {
    key: "dollar-empty",
    name: "$ list: no match",
    composer: typed("$zzz"),
    list: { trigger: "$", query: "zzz", activeRow: null },
  },
  {
    key: "dollar-long",
    name: "$ list: every skill, scrolls",
    composer: typed("$"),
    list: { trigger: "$", query: "", activeRow: 0 },
  },
  {
    key: "dollar-queued",
    name: "$ list: above a queued input and the Request",
    composer: typed("$imp"),
    list: { trigger: "$", query: "imp", activeRow: 0 },
  },
  {
    key: "slash-list",
    name: "/ list: today, only skills",
    composer: typed("/rev"),
    list: { trigger: "/", query: "rev", activeRow: 0 },
  },
  {
    key: "slash-kinds",
    name: "/ list: later, skills beside other commands",
    composer: typed("/"),
    list: { trigger: "/", query: "", activeRow: 0, withOtherKinds: true },
  },
  { key: "chips", name: "Chips: library and repository", composer: CHIPS_COMPOSER },
  {
    key: "chip-selected",
    name: "Chips: one selected",
    composer: CHIPS_COMPOSER,
    selectedChip: 2,
  },
  {
    key: "chip-hover",
    name: "Chips: hover card",
    composer: CHIPS_COMPOSER,
    hoveredChip: 2,
  },
  {
    key: "chip-same-name",
    name: "Chips: same name, library and repository",
    composer: {
      runs: [
        text("Run "),
        library("review"),
        text(" on the diff, and "),
        repository("review"),
        text(" on the checkout code."),
      ],
      caret: { run: 4, offset: 22 },
      focused: true,
    },
  },
  {
    key: "transcript",
    name: "Transcript: a sent message with two skills",
    composer: { runs: [], focused: false },
    sentMessage: "Please $review the 3-D Secure fix, then run the $webshop:release-checklist.",
  },
  {
    key: "refusal",
    name: "Queue: a skill that cannot be steered, refused",
    composer: { runs: [], focused: false },
    queuedInputs: [
      {
        text: "Then $review the diff",
        refusal:
          "Claude cannot take a skill into a running turn. It stays queued and runs when the turn ends.",
      },
    ],
  },
  {
    key: "queued-skill",
    name: "Queue: an input with a skill",
    composer: { runs: [], focused: false },
    queuedInputs: [{ text: "Then $review the diff" }],
  },
];

/** Returns the scene named `key`, or the first scene when none has that name. */
export const findScene = (key: string): Scene =>
  SCENES.find((each) => each.key === key) ?? SCENES[0]!;
