import {
  useEffect,
  useEffectEvent,
  useLayoutEffect,
  useRef,
  type JSX,
  type ReactNode,
} from "react";
import { createPortal } from "react-dom";
import { isMotionReduced } from "../../app/motion";
import { SheetController, type SheetPlaces } from "./opening-sheet-controller";
import "./opening-sheet.css";

/** How long the words take to change when the sheet moves to another card, in milliseconds. */
const SWAP_MILLISECONDS = 200;

/** How far below its place the new words start, in pixels. */
const SWAP_RISE = 6;

/**
 * Renders the sheet a card opens into: it grows from where the card lies,
 * with the card's corner staying put, to a destination in the window. It
 * knows nothing about what the card is, so the Inbox and Work share it.
 *
 * - `isOpen` opens the sheet, and false folds it back home. After it has
 *   folded, `onClosed` is called, and the caller stops drawing the sheet.
 *   Until then the sheet stays drawn, so the caller keeps its words too.
 * - `contentKey` names what the sheet shows. A change swaps the words in
 *   place: they rise 6px and fade in over 200ms, and the sheet's height
 *   follows.
 * - `label` is the name of the dialog for a screen reader.
 * - `readPlaces` returns where the card lies and where the sheet stands open
 *   (see `SheetPlaces`). It is called when the sheet opens, closes, swaps and
 *   resizes, and when its words change size, so the card is found where it
 *   lies then. The sheet's height is the destination's, so the caller sizes
 *   the destination to the words.
 * - `behind` is drawn under the sheet over the whole window, such as a veil.
 * - `head` rides the sheet's top edge, outside its clip.
 * - `className` is added to the sheet.
 *
 * The sheet is one object on one number. Folding it halfway and opening it
 * again turns it round with its speed; Reduce motion keeps it at its
 * destination and fades it. The moves in it take no pointer for the first
 * 420ms, and focus goes to the sheet, not to a move. It writes `--sheet-progress`
 * (0 to 1) on itself for the caller's stylesheet. The value is reset to 0 on
 * the clip: the paper and `head` can use it, but the words inside the sheet
 * cannot, because passing it down would restyle them on every frame.
 *
 * The sheet is drawn in a portal on the page, so it lies over the sidebar
 * too.
 */
export function OpeningSheet({
  isOpen,
  contentKey,
  label,
  readPlaces,
  onClosed,
  className,
  behind,
  head,
  children,
}: {
  readonly isOpen: boolean;
  readonly contentKey: string;
  readonly label: string;
  readonly readPlaces: () => SheetPlaces;
  readonly onClosed: () => void;
  readonly className?: string;
  readonly behind?: ReactNode;
  readonly head?: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  const fadeRef = useRef<HTMLDivElement>(null);
  const layerRef = useRef<HTMLDivElement>(null);
  const paperRef = useRef<HTMLDivElement>(null);
  const innerRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const wordsRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SheetController | null>(null);
  const shownKeyRef = useRef(contentKey);
  const readLatestPlaces = useEffectEvent(readPlaces);
  const reportClosed = useEffectEvent(onClosed);

  useLayoutEffect(() => {
    const controller = new SheetController({
      fade: fadeRef.current!,
      layer: layerRef.current!,
      paper: paperRef.current!,
      inner: innerRef.current!,
      content: contentRef.current!,
    });
    controllerRef.current = controller;
    return () => {
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  // Opens and folds the sheet. Focus goes to the sheet itself, so Enter never
  // lands on a move.
  useLayoutEffect(() => {
    const controller = controllerRef.current!;
    if (isOpen) {
      controller.open(readLatestPlaces());
      layerRef.current!.focus({ preventScroll: true });
    } else {
      controller.close(readLatestPlaces(), reportClosed);
    }
  }, [isOpen]);

  // Moves the sheet to what its words are about now: the words rise in, and
  // the height follows.
  useLayoutEffect(() => {
    if (shownKeyRef.current === contentKey) return;
    shownKeyRef.current = contentKey;
    controllerRef.current!.retarget(readLatestPlaces(), true);
    wordsRef.current!.animate(
      isMotionReduced()
        ? [{ opacity: 0 }, { opacity: 1 }]
        : [
            { opacity: 0, transform: `translateY(${String(SWAP_RISE)}px)` },
            { opacity: 1, transform: "none" },
          ],
      { duration: SWAP_MILLISECONDS, easing: "cubic-bezier(0.22, 0.9, 0.24, 1)" },
    );
  }, [contentKey]);

  // Keeps the sheet in the window when the window changes size, and the
  // height right when the words change size (an answer that arrives).
  useEffect(() => {
    const onResize = (): void => {
      controllerRef.current?.retarget(readLatestPlaces(), false);
    };
    window.addEventListener("resize", onResize);
    const observer = new ResizeObserver(() => {
      controllerRef.current?.retarget(readLatestPlaces(), true);
    });
    observer.observe(wordsRef.current!);
    return () => {
      window.removeEventListener("resize", onResize);
      observer.disconnect();
    };
  }, []);

  return createPortal(
    <>
      {behind}
      <div ref={fadeRef} className="opening-sheet-fade">
        <div
          ref={layerRef}
          className={className === undefined ? "opening-sheet" : `opening-sheet ${className}`}
          role="dialog"
          aria-label={label}
          tabIndex={-1}
        >
          <div ref={paperRef} className="opening-sheet-paper" />
          {head !== undefined && <div className="opening-sheet-head">{head}</div>}
          <div className="opening-sheet-clip">
            <div ref={innerRef} className="opening-sheet-inner">
              <div ref={contentRef} className="opening-sheet-content">
                <div ref={wordsRef} className="opening-sheet-words">
                  {children}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>
    </>,
    document.body,
  );
}
