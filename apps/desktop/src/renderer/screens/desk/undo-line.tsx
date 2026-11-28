import { useLayoutEffect, useRef, type FocusEvent, type JSX } from "react";
import { joinClassNames } from "../../app/join-class-names";
import "./undo-line.css";

/** The shortest a title is cut to before it is left out of the line. */
const SHORTEST_TITLE = 12;

/**
 * Returns `title` cut to at most `length` letters, at a word when one ends at
 * 8 letters or later, without the punctuation and spaces the cut leaves at its
 * end. The caller adds the ellipsis.
 */
export function cutTitleAtWord(title: string, length: number): string {
  const head = title.slice(0, length);
  const space = head.lastIndexOf(" ");
  return (space >= 8 ? head.slice(0, space) : head).replace(/[\s,.:;–-]+$/, "");
}

/**
 * Renders the undo line at the foot of the page: `text` says what just
 * happened or why a move failed, and when `onUndo` is given, an Undo button
 * puts it back, with `undoKey` beside it, the words for the key that does the
 * same, such as "⌘Z". An `action` adds a second button beside it, such as
 * "See its Task".
 *
 * `title`, the title of the thing the move was on, comes last: `text`,
 * a colon, then the title in quotes. A line that does not fit gives up what
 * matters least, in this order:
 *
 * 1. The title is cut at a word, down to 12 letters.
 * 2. The title is left out.
 * 3. Undo drops its key hint.
 *
 * It measures when the line is shown or its words change, not when the window
 * is resized.
 *
 * `onHoldChange` is told when the pointer or the focus comes onto the line
 * (`true`) and when both have left it (`false`), so a page can keep the line
 * while the user is on it. Without it the line does not care.
 *
 * `isShown` fades the line in and out. While it is out, the line holds the
 * text it last showed, so the caller keeps passing that text until the line
 * is gone, and it takes neither the pointer nor the focus. How long it stays
 * is the caller's.
 */
export function UndoLine({
  text,
  title,
  onUndo,
  action,
  undoKey,
  isShown,
  onHoldChange,
}: {
  readonly text: string;
  readonly title?: string | null;
  readonly onUndo: (() => void) | null;
  readonly action: { readonly label: string; readonly act: () => void } | null;
  readonly undoKey: string;
  readonly isShown: boolean;
  readonly onHoldChange?: (isHeld: boolean) => void;
}): JSX.Element {
  const lineRef = useRef<HTMLDivElement>(null);
  const wordsRef = useRef<HTMLSpanElement>(null);
  const titleRef = useRef<HTMLSpanElement>(null);
  const presence = useRef({ isPointerOn: false, isFocusOn: false });

  // The title span and the line's `data-tight` belong to this effect, not to
  // React: it writes them while measuring, and React renders neither.
  useLayoutEffect(() => {
    const line = lineRef.current;
    const words = wordsRef.current;
    const titleElement = titleRef.current;
    if (!isShown || line === null || words === null || titleElement === null) return;
    const fits = (): boolean => words.scrollWidth <= words.clientWidth + 1;
    const write = (shown: string | null): void => {
      titleElement.textContent = shown === null ? "" : `: “${shown}”`;
    };
    line.removeAttribute("data-tight");
    const wanted = title ?? "";
    write(wanted === "" ? null : wanted);
    let length = wanted.length;
    while (!fits() && length > SHORTEST_TITLE) {
      length = Math.max(SHORTEST_TITLE, length - 3);
      write(`${cutTitleAtWord(wanted, length)}…`);
    }
    if (!fits()) write(null);
    if (!fits()) line.setAttribute("data-tight", "");
  }, [text, title, isShown, onUndo, action]);

  const setPresence = (change: Partial<typeof presence.current>): void => {
    Object.assign(presence.current, change);
    onHoldChange?.(presence.current.isPointerOn || presence.current.isFocusOn);
  };
  const leaveFocus = (event: FocusEvent<HTMLDivElement>): void => {
    if (event.relatedTarget instanceof Node && event.currentTarget.contains(event.relatedTarget)) {
      return;
    }
    setPresence({ isFocusOn: false });
  };

  return (
    <div
      ref={lineRef}
      className={joinClassNames(
        "undo-line",
        isShown && "is-on",
        // A line with nothing to press can wrap, where a page's CSS lets it.
        onUndo === null && action === null && "is-wrap",
      )}
      role="status"
      inert={!isShown}
      onPointerEnter={() => {
        setPresence({ isPointerOn: true });
      }}
      onPointerLeave={() => {
        setPresence({ isPointerOn: false });
      }}
      onFocus={() => {
        setPresence({ isFocusOn: true });
      }}
      onBlur={leaveFocus}
    >
      <span ref={wordsRef} className="undo-text">
        {text}
        <span ref={titleRef} />
      </span>
      {onUndo !== null && (
        <button type="button" className="undo-line-button" onClick={onUndo}>
          Undo <kbd>{undoKey}</kbd>
        </button>
      )}
      {action !== null && (
        <button type="button" className="undo-line-button" onClick={action.act}>
          {action.label}
        </button>
      )}
    </div>
  );
}
