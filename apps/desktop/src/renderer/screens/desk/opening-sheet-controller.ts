/**
 * The motion of an opening sheet. One number, `travel`, runs from 0 where the
 * card lies to 1 where the sheet stands open, on the `travel` spring, and
 * every frame is drawn from it (see `opening-sheet-geometry.ts`). Because the
 * number is the whole state, closing, opening again halfway, and closing
 * again all start from where the sheet is, with the speed it has.
 *
 * Under Reduce motion, or when the card is not on the page, nothing travels:
 * the sheet stands at its destination and fades.
 */
import { animateValue, isMotionReduced, trackBody, type MotionValue } from "../../app/motion";
import { blendRects, isSameRect, readSheetFrame, type SheetRect } from "./opening-sheet-geometry";

/** Where a sheet opens from: the visible part of its card, and the card's own words. */
export interface SheetOrigin {
  /** The visible part of the card in window pixels, or `null` when the card is not on the page. */
  readonly rect: SheetRect | null;
  /** The element that holds the card's words. It fades out as the sheet covers it, and back in as it folds home. */
  readonly words: HTMLElement | null;
}

/** The two places a sheet travels between, both in window pixels. */
export interface SheetPlaces {
  readonly origin: SheetOrigin;
  readonly destination: SheetRect;
}

/** The elements of the sheet that the controller draws on. */
export interface SheetParts {
  /** Wraps the sheet, and carries its opacity when it fades. */
  readonly fade: HTMLElement;
  /** The sheet's window: it grows from the card to the destination. */
  readonly layer: HTMLElement;
  /** The sheet's paper and shadow. */
  readonly paper: HTMLElement;
  /** What stays at the destination in the page while the window grows round it. */
  readonly inner: HTMLElement;
  /** The words and rows, which fade in once the sheet is mostly open. */
  readonly content: HTMLElement;
}

/** How long the moves take no pointer after the sheet opens, so the second click of a double click lands on nothing. */
const ARMING_MILLISECONDS = 420;

/** The travel below which the card is back under the sheet, and the sheet dissolves into it. */
const DISSOLVE_BELOW = 0.02;

/** How long the sheet takes to dissolve into the card. */
const DISSOLVE_MILLISECONDS = 80;

const NOWHERE: SheetRect = { left: 0, top: 0, width: 0, height: 0 };

const toPixels = (value: number): string => `${value.toFixed(2)}px`;

/** Draws the sheet's frames and plays its opening, closing and moving. */
export class SheetController {
  private readonly parts: SheetParts;
  private readonly travel: MotionValue;
  private readonly follow: MotionValue;
  private from: SheetRect | null = null;
  private words: HTMLElement | null = null;
  /** Where the destination was before the last time it moved, and where it is going. `follow` runs between them. */
  private previous: SheetRect = NOWHERE;
  private target: SheetRect = NOWHERE;
  private isShown = false;
  private isClosing = false;
  private isFading = false;
  private isDisposed = false;
  private dissolve: Animation | null = null;
  private armingTimer: ReturnType<typeof setTimeout> | null = null;
  private onClosed: (() => void) | null = null;

  constructor(parts: SheetParts) {
    this.parts = parts;
    this.travel = animateValue(0, () => {
      this.draw();
    });
    this.follow = animateValue(1, () => {
      this.draw();
    });
  }

  /**
   * Opens the sheet from `places`. Called while the sheet is shown, as when
   * the card is asked to open again on its way home, it turns round from
   * where it is.
   */
  open(places: SheetPlaces): void {
    this.cancelDissolve();
    this.isClosing = false;
    this.onClosed = null;
    const wasShown = this.isShown;
    this.isShown = true;
    this.adoptOrigin(places.origin);
    this.isFading = isMotionReduced() || places.origin.rect === null;
    if (wasShown) this.moveDestination(places.destination, false);
    else this.placeDestination(places.destination);
    this.arm();
    if (this.isFading) {
      this.travel.set(1);
      this.restoreWords();
      const fade = trackBody(this.parts.fade);
      if (!wasShown) fade.set({ o: 0 });
      fade.to({ o: 1 }, "travel", { done: () => this.hideWords() });
      return;
    }
    if (trackBody(this.parts.fade).values.o !== 1) trackBody(this.parts.fade).set({ o: 1 });
    if (!wasShown) this.travel.set(0);
    this.travel.to(1, "travel");
  }

  /**
   * Folds the sheet back to where its card lies now, as read in `places`, and
   * calls `onClosed` once it has gone. The card may have moved while the
   * sheet was open, which is why the origin is read again.
   */
  close(places: SheetPlaces, onClosed: () => void): void {
    this.onClosed = onClosed;
    if (!this.isShown) {
      this.finish();
      return;
    }
    this.cancelDissolve();
    this.isClosing = true;
    this.adoptOrigin(places.origin);
    this.moveDestination(places.destination, false);
    this.isFading = isMotionReduced() || places.origin.rect === null;
    if (this.isFading) {
      this.restoreWords();
      this.travel.set(1);
      trackBody(this.parts.fade).to({ o: 0 }, "travel", { done: () => this.finish() });
      return;
    }
    if (trackBody(this.parts.fade).values.o !== 1) trackBody(this.parts.fade).set({ o: 1 });
    this.travel.to(0, "travel", () => {
      // A dissolve that is cancelled means the sheet was opened again, so there is nothing to finish.
      Promise.resolve(this.dissolve?.finished).then(
        () => {
          this.finish();
        },
        () => {},
      );
    });
  }

  /**
   * Moves the sheet to a new origin and destination where it stands, as when
   * its words change or the window is resized. With `isAnimated` the
   * destination follows on a spring, which is how the height follows the
   * words.
   */
  retarget(places: SheetPlaces, isAnimated: boolean): void {
    if (!this.isShown || this.isClosing) return;
    this.adoptOrigin(places.origin);
    this.moveDestination(places.destination, isAnimated);
    this.draw();
  }

  /** Stops everything and gives the card its words back. */
  dispose(): void {
    this.isDisposed = true;
    this.cancelDissolve();
    this.travel.set(this.travel.current);
    this.follow.set(1);
    trackBody(this.parts.fade).clear();
    if (this.armingTimer !== null) clearTimeout(this.armingTimer);
    this.restoreWords();
  }

  /** Puts the destination at `destination` with no movement, for the first frame. */
  private placeDestination(destination: SheetRect): void {
    this.previous = destination;
    this.target = destination;
    this.follow.set(1);
  }

  /** Sends the destination to `destination`, from wherever it is drawn now. Does nothing when it is already there. */
  private moveDestination(destination: SheetRect, isAnimated: boolean): void {
    if (isSameRect(destination, this.target) && this.follow.current === 1) return;
    const shown = blendRects(this.previous, this.target, this.follow.current);
    this.target = destination;
    if (isAnimated && !isMotionReduced()) {
      this.previous = shown;
      this.follow.set(0);
      this.follow.to(1, "hand");
    } else {
      this.previous = destination;
      this.follow.set(1);
    }
  }

  /** Takes the card the sheet grows from, giving the words of the card it leaves theirs back. */
  private adoptOrigin(origin: SheetPlaces["origin"]): void {
    if (this.words !== null && this.words !== origin.words) this.restoreWords();
    this.from = origin.rect;
    this.words = origin.words;
  }

  /** Makes the moves take no pointer for a moment. */
  private arm(): void {
    const { layer } = this.parts;
    layer.dataset["arming"] = "";
    if (this.armingTimer !== null) clearTimeout(this.armingTimer);
    this.armingTimer = setTimeout(() => {
      delete layer.dataset["arming"];
    }, ARMING_MILLISECONDS);
  }

  private hideWords(): void {
    if (this.words !== null && !this.isClosing) this.words.style.opacity = "0";
  }

  private restoreWords(): void {
    if (this.words !== null) this.words.style.opacity = "";
  }

  private cancelDissolve(): void {
    this.dissolve?.cancel();
    this.dissolve = null;
  }

  /** Ends a closing sheet: the card has its words, and whoever drew the sheet is told it is gone. */
  private finish(): void {
    this.isShown = false;
    this.isClosing = false;
    this.restoreWords();
    const done = this.onClosed;
    this.onClosed = null;
    done?.();
  }

  /** Writes the frame at the current travel to the elements. */
  private draw(): void {
    if (this.isDisposed) return;
    const travel = this.travel.current;
    const destination = blendRects(this.previous, this.target, this.follow.current);
    const frame = readSheetFrame(this.fromRect(), destination, travel);
    const { layer, paper, inner, content } = this.parts;
    const { rect } = frame;
    layer.style.left = toPixels(rect.left);
    layer.style.top = toPixels(rect.top);
    layer.style.width = toPixels(rect.width);
    layer.style.height = toPixels(rect.height);
    layer.style.borderRadius = toPixels(frame.radius);
    layer.style.setProperty("--sheet-progress", travel.toFixed(3));
    paper.style.opacity = frame.paperOpacity >= 1 ? "" : frame.paperOpacity.toFixed(3);
    inner.style.width = toPixels(destination.width);
    inner.style.height = toPixels(destination.height);
    inner.style.transform = `translate(${toPixels(frame.contentOffset.x)}, ${toPixels(frame.contentOffset.y)})`;
    content.style.opacity = frame.contentOpacity >= 1 ? "" : frame.contentOpacity.toFixed(3);
    content.style.transform =
      frame.contentRise > 0 ? `translateY(${toPixels(frame.contentRise)})` : "";
    if (this.words !== null && !this.isFading) {
      this.words.style.opacity = frame.wordsOpacity >= 1 ? "" : frame.wordsOpacity.toFixed(3);
    }
    if (this.isClosing && !this.isFading && travel < DISSOLVE_BELOW && this.dissolve === null) {
      this.restoreWords();
      this.dissolve = layer.animate([{ opacity: 1 }, { opacity: 0 }], {
        duration: DISSOLVE_MILLISECONDS,
        easing: "linear",
        fill: "forwards",
      });
    }
  }

  /** Returns where the sheet grows from, which is nowhere when it only fades. */
  private fromRect(): SheetRect | null {
    return this.isFading ? null : this.from;
  }
}
