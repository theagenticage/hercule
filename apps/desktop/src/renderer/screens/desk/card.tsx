import {
  useLayoutEffect,
  useRef,
  useState,
  type HTMLAttributes,
  type JSX,
  type ReactNode,
  type Ref,
} from "react";
import { Colleague, type ColleaguePose } from "./colleague";
import { joinClassNames } from "../../app/join-class-names";
import type { Look } from "../../faces";
import { CheckIcon } from "../../icons/check";
import { FailedMark } from "./status-shape";
import "./card.css";

/** The colleague on a card: the props of `Colleague`. */
export interface CardColleague {
  readonly look: Look;
  readonly pose: ColleaguePose;
  readonly seed: string;
  readonly still: boolean;
}

/**
 * How the second line of a card reads: `summary` is the Task's summary in
 * `--muted`, `pending` is "Writing a summary" in `--faint`, `question` is what
 * a Thread asks, in `--you-ink`, and `failed` is what a run broke, in ink
 * after the failed mark.
 */
export type CardNowTone = "summary" | "pending" | "question" | "failed";

/** What each watched title calls with whether it takes two lines. */
const titleListeners = new Map<Element, (isLong: boolean) => void>();

/** The one observer that watches the titles of every card on the page, made on first use. */
let titleObserver: ResizeObserver | null = null;

/**
 * Tells each title in `entries` whether it takes two lines. The sizes come
 * from the observer's entries, so no layout is read. A title is clamped to two
 * lines, so a height above one and a half lines means two. Every title has
 * the same line height, so it is read once for the whole batch.
 */
const reportTitleSizes = (entries: ReadonlyArray<ResizeObserverEntry>): void => {
  const first = entries[0];
  if (first === undefined) return;
  const lineHeight = Number.parseFloat(getComputedStyle(first.target).lineHeight);
  for (const entry of entries) {
    titleListeners.get(entry.target)?.(entry.contentRect.height > lineHeight * 1.5);
  }
};

/**
 * Starts reporting to `onChange` whether `title` takes two lines, now and
 * whenever its size changes, such as when a narrower column wraps it again.
 * Returns the function that stops it.
 */
const watchTitle = (title: Element, onChange: (isLong: boolean) => void): (() => void) => {
  titleObserver ??= new ResizeObserver(reportTitleSizes);
  titleListeners.set(title, onChange);
  titleObserver.observe(title);
  return () => {
    titleListeners.delete(title);
    titleObserver?.unobserve(title);
  };
};

/**
 * Checks whether the title of a card takes two lines, so that the second
 * line then keeps to one. Only a card with a second line needs to know, so
 * the title is watched only while `hasSecondLine` is true, by one observer
 * shared by every card. A title that is not watched is not long.
 */
function useIsTitleLong(hasSecondLine: boolean): {
  readonly titleRef: Ref<HTMLParagraphElement>;
  readonly isLong: boolean;
} {
  const [isLong, setIsLong] = useState(false);
  const titleRef = useRef<HTMLParagraphElement>(null);
  useLayoutEffect(() => {
    const title = titleRef.current;
    if (!hasSecondLine || title === null) return;
    return watchTitle(title, setIsLong);
  }, [hasSecondLine]);
  return { titleRef, isLong: hasSecondLine && isLong };
}

/**
 * Renders a card: the same sheet for every Task, at one minimum height, with
 * a title, a second line and the age. The rest of the card's states belong to
 * the page that draws it, through `className` and the other attributes: it
 * sets `role`, `tabIndex`, `aria-label` and the handlers, and the state
 * classes `is-focus` and `is-carried`.
 *
 * - `title` is up to two lines. A long title leaves the second line one line.
 * - `now` is the second line, in the tone `nowTone` (`summary` when absent).
 *   A `failed` line gets the failed mark in front of it.
 * - `meta` holds what sits at the bottom right beside the age, as the caller
 *   draws it, such as a `<time>`.
 * - `also` is a short line at the bottom left, such as "In 2 repositories".
 *   `names` shows on hover.
 * - `colleague` stands behind the top edge. Only a live Thread has one.
 * - `landed` draws the card as only words, with no sheet.
 * - `selected` is for a page where cards can be selected: `true` draws the
 *   card with a 1.5px ink ring and a check in its top left corner that grows
 *   in, and `false` keeps the check ready, hidden, so it can grow in when the
 *   card is selected. Leave it out where cards cannot be selected, and while
 *   no card is: the card then draws no check at all. The caller names the
 *   selected state for assistive technology (`aria-pressed`).
 *
 * `data-now` holds the second line's tone while there is one, so the
 * stylesheet can shorten the title of a card that asks or failed without a
 * `:has()` rule, which the browser would test on every style recalculation.
 *
 * The words are hidden from assistive technology, because a card is a button
 * the caller names with `aria-label`. The sheet is a stable element, so a
 * redraw of the words never restarts its shadow transition.
 */
export function Card({
  title,
  now,
  nowTone: nowToneOrDefault,
  meta,
  also,
  colleague,
  landed,
  selected,
  className,
  ref,
  ...rest
}: Omit<HTMLAttributes<HTMLDivElement>, "title" | "children"> & {
  readonly title: string;
  readonly now?: ReactNode;
  readonly nowTone?: CardNowTone | undefined;
  readonly meta?: ReactNode;
  readonly also?: { readonly words: string; readonly names: string };
  readonly colleague?: CardColleague | null;
  readonly landed: boolean;
  readonly selected?: boolean | undefined;
  readonly ref?: Ref<HTMLDivElement>;
}): JSX.Element {
  const nowTone = nowToneOrDefault ?? "summary";
  const hasSecondLine = now !== null && now !== undefined;
  const { titleRef, isLong } = useIsTitleLong(hasSecondLine);
  const classes = joinClassNames(
    "desk-card",
    isLong && "has-long-title",
    selected === true && "is-selected",
    className,
  );
  return (
    <div
      {...rest}
      ref={ref}
      className={classes}
      data-state={landed ? "landed" : undefined}
      data-now={hasSecondLine ? nowTone : undefined}
    >
      <i className="card-stock" />
      {selected !== undefined && (
        <i className="card-check" aria-hidden="true">
          <CheckIcon size={12} />
        </i>
      )}
      <span className="card-body">
        {colleague !== null && colleague !== undefined && <Colleague {...colleague} />}
        <div className="card-words" aria-hidden="true">
          <p ref={titleRef} className="card-title">
            {title}
          </p>
          {hasSecondLine && (
            <p className={nowTone === "summary" ? "card-now" : `card-now card-${nowTone}`}>
              {nowTone === "failed" && <FailedMark />}
              {now}
            </p>
          )}
        </div>
        {also !== undefined && (
          <span className="card-also" title={also.names}>
            {also.words}
          </span>
        )}
        {meta !== null && meta !== undefined && <span className="card-meta">{meta}</span>}
      </span>
    </div>
  );
}
