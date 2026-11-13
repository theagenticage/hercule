/**
 * The motion of the start-thread dialog. Every movement is a Web Animation or
 * a spring on the app's clock, started by script, so no stylesheet animates
 * here. Under Reduce motion nothing moves: every function returns at once, or
 * calls `done` at once.
 *
 * - Opening: the scrim fades in over 220ms; the dialog fades in over 100ms and
 *   rises from 14px low at 98% on `travel`; each thing's chip comes 6px from the
 *   left, 30ms after the one before, the first at 90ms.
 * - Closing: the dialog fades over 140ms and sinks 8px to 98.5% on `hand`; the
 *   scrim fades over 180ms. Both hold their last frame until `done` runs.
 * - Starting: the dialog's height springs on `travel` from the composer's to
 *   the transcript's, and the message rises from where the composer was.
 */
import { animateValue, buildSpringCurve, isMotionReduced } from "../../app/motion";
import { FIRST_MESSAGE_ATTRIBUTE } from "../thread/transcript";

const SCRIM_FADE_IN_MS = 220;
const SCRIM_FADE_OUT_MS = 180;
const DIALOG_FADE_IN_MS = 100;
const DIALOG_FADE_OUT_MS = 140;
const RISE_PX = 14;
const RISE_SCALE = 0.98;
const SINK_PX = 8;
const SINK_SCALE = 0.985;
const CHIPS_START_MS = 90;
const CHIP_STAGGER_MS = 30;
const CHIP_SLIDE_PX = 6;
const CHIP_MS = 200;
const BODY_FADE_MS = 180;
const BODY_FADE_START_MS = 90;

const FADE_IN: Keyframe[] = [{ opacity: 0 }, { opacity: 1 }];
const FADE_OUT: Keyframe[] = [{ opacity: 1 }, { opacity: 0 }];

/** Plays the dialog's opening on the modal `dialog`, which is already shown. */
export const playDialogOpening = (dialog: HTMLElement): void => {
  if (isMotionReduced()) return;
  const travel = buildSpringCurve("travel");
  dialog.animate(FADE_IN, { duration: DIALOG_FADE_IN_MS, easing: "ease-out" });
  dialog.animate(
    [
      { transform: `translateY(${String(RISE_PX)}px) scale(${String(RISE_SCALE)})` },
      { transform: "none" },
    ],
    { duration: travel.ms, easing: travel.ease },
  );
  dialog.animate(FADE_IN, {
    duration: SCRIM_FADE_IN_MS,
    easing: "ease-out",
    pseudoElement: "::backdrop",
  });
};

/**
 * Plays the dialog's closing, and calls `done` once every part has finished.
 * The dialog stays modal until then, so the caller closes it in `done`.
 */
export const playDialogClosing = (dialog: HTMLElement, done: () => void): void => {
  if (isMotionReduced()) {
    done();
    return;
  }
  const hand = buildSpringCurve("hand");
  const animations = [
    dialog.animate(FADE_OUT, { duration: DIALOG_FADE_OUT_MS, easing: "ease-in", fill: "forwards" }),
    dialog.animate(
      [
        { transform: "none" },
        { transform: `translateY(${String(SINK_PX)}px) scale(${String(SINK_SCALE)})` },
      ],
      { duration: hand.ms, easing: hand.ease, fill: "forwards" },
    ),
    dialog.animate(FADE_OUT, {
      duration: SCRIM_FADE_OUT_MS,
      easing: "ease-in",
      fill: "forwards",
      pseudoElement: "::backdrop",
    }),
  ];
  let pending = animations.length;
  for (const animation of animations) {
    animation.onfinish = () => {
      pending -= 1;
      if (pending === 0) done();
    };
  }
};

/**
 * Plays the arrival of the thing chips in `chips`, in order: each fades in
 * and comes 6px from the left, 30ms after the one before.
 */
export const playChipsArriving = (chips: readonly Element[]): void => {
  if (isMotionReduced()) return;
  chips.forEach((chip, index) => {
    chip.animate(
      [
        { opacity: 0, transform: `translateX(-${String(CHIP_SLIDE_PX)}px)` },
        { opacity: 1, transform: "none" },
      ],
      {
        duration: CHIP_MS,
        delay: CHIPS_START_MS + index * CHIP_STAGGER_MS,
        easing: "cubic-bezier(0.2, 0.8, 0.2, 1)",
        fill: "backwards",
      },
    );
  });
};

/** Where the writing was just before it became a thread, in pixels. */
export interface WritingSnapshot {
  /** The dialog's height. */
  readonly height: number;
  /** The top of the composer's card, measured from the top of the dialog. */
  readonly composerTop: number;
}

/**
 * Plays the change from writing to thread on `dialog`, whose `body` now holds
 * the transcript. The dialog's height springs from `before.height` to the
 * transcript's on `travel`. The first message, when the transcript has one,
 * rises from where the composer was to its place; otherwise the body fades in.
 */
export const playThreadStarting = (
  dialog: HTMLElement,
  body: HTMLElement,
  before: WritingSnapshot,
): void => {
  if (isMotionReduced()) return;
  const travel = buildSpringCurve("travel");
  dialog.style.height = "";
  const after = dialog.offsetHeight;
  if (after !== before.height) {
    dialog.style.height = `${String(before.height)}px`;
    animateValue(before.height, (height) => {
      dialog.style.height = `${String(height)}px`;
    }).to(after, "travel", () => {
      dialog.style.height = "";
    });
  }
  const message = body.querySelector(`[${FIRST_MESSAGE_ATTRIBUTE}]`);
  if (message === null) {
    body.animate(FADE_IN, {
      duration: BODY_FADE_MS,
      delay: BODY_FADE_START_MS,
      easing: "ease-out",
      fill: "backwards",
    });
    return;
  }
  const rise =
    dialog.getBoundingClientRect().top + before.composerTop - message.getBoundingClientRect().top;
  message.animate([{ transform: `translateY(${String(rise)}px)` }, { transform: "none" }], {
    duration: travel.ms,
    easing: travel.ease,
  });
};
