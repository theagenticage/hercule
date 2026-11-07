import { useLayoutEffect, useRef, type JSX, type ReactNode } from "react";
import {
  createSheetController,
  type SheetController,
  type SheetPlaces,
} from "./opening-sheet-controller";
import "./opening-sheet.css";

export type { SheetOrigin, SheetPlaces } from "./opening-sheet-controller";

/**
 * Renders a sheet that opens out of a card and closes back into it, over a
 * page that stays where it is. `SideSheet` is the sheet that only slides in.
 * It knows nothing of the page: the caller says where the sheet grows from and
 * where it ends (`readPlaces`), and draws whatever else follows the opening
 * (`behind`, `head`).
 *
 * The caller keeps it mounted from the moment it opens until `onClosed`, and
 * its positioned parent is the layer's frame. `isOpen` is only what is
 * wanted. The sheet answers in motion, and tells when it has closed:
 *
 * - One number from 0 to 1, on the `travel` spring, drives all of it: the
 *   sheet's box and corner from the card's to the destination's, the card's
 *   words fading out by 0.55, the sheet's words fading in from 0.3 to 0.85
 *   and rising 10px. It is also written as the custom property
 *   `--sheet-progress` (0 to 1) on the layer, for what the caller draws to
 *   follow. Closing in the middle of the opening turns the same number round,
 *   from where it is, with its speed.
 * - Only the box is not a transform: a scaled sheet would stretch its corners
 *   and its shadow. It is an empty box, so the layout costs little. Nothing
 *   is painted by React while it moves: the frame is written to styles.
 * - The words are laid out once, at the destination's size, and the growing
 *   sheet reveals them, so a paragraph never wraps again during the opening.
 * - Under Reduce motion the sheet does not travel: it stands at its
 *   destination and fades in and out, with `behind`.
 * - A new `contentKey` while open swaps the words for the new ones in a short
 *   fade and takes the places again, but the sheet stays where it is.
 *
 * Props:
 *
 * - `isOpen`: whether the sheet is wanted.
 * - `contentKey`: names what the words are about. A change swaps them.
 * - `label`: names the dialog. The sheet is not modal, and `inert` while it
 *   closes.
 * - `readPlaces`: called when the sheet starts to open, to close, to swap, and
 *   when the window resizes. It reads the page then, so the sheet never grows
 *   toward a place that was measured earlier and has moved since.
 * - `onClosed`: called once the sheet has closed all the way. A sheet that is
 *   opened again while it closes never calls it.
 * - `className`: added to the sheet, so a page can style its head and parts.
 * - `behind`: drawn in the layer under the sheet, such as a dimming of the page.
 * - `head`: stands on the sheet's top edge, such as a colleague.
 * - `children`: the words. Opening never takes the focus from the page,
 *   because the page stays in use beside the sheet. On a swap, the element in
 *   the words that has `data-sheet-focus` gets the focus if it was in the
 *   sheet.
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
  const layerRef = useRef<HTMLDivElement>(null);
  const sheetRef = useRef<HTMLElement>(null);
  const ghostRef = useRef<HTMLDivElement>(null);
  const wordsRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const controllerRef = useRef<SheetController | null>(null);
  // The newest props, for the controller, which is made once.
  const latest = useRef({ readPlaces, onClosed });
  useLayoutEffect(() => {
    latest.current = { readPlaces, onClosed };
  });

  useLayoutEffect(() => {
    const layer = layerRef.current;
    const sheet = sheetRef.current;
    const ghost = ghostRef.current;
    const words = wordsRef.current;
    const content = contentRef.current;
    if (layer === null || sheet === null || ghost === null || words === null || content === null) {
      return;
    }
    const controller = createSheetController(
      { layer, sheet, ghost, words, content },
      {
        readPlaces: () => latest.current.readPlaces(),
        onClosed: () => {
          latest.current.onClosed();
        },
      },
    );
    controllerRef.current = controller;
    const onResize = (): void => {
      controller.remeasure();
    };
    window.addEventListener("resize", onResize);
    return () => {
      window.removeEventListener("resize", onResize);
      controller.dispose();
      controllerRef.current = null;
    };
  }, []);

  useLayoutEffect(() => {
    if (isOpen) controllerRef.current?.open();
    else controllerRef.current?.close();
  }, [isOpen]);

  // Another thing in the open sheet: the sheet stays, and the words swap.
  const shownKey = useRef(contentKey);
  useLayoutEffect(() => {
    if (shownKey.current === contentKey) return;
    shownKey.current = contentKey;
    controllerRef.current?.swap();
  }, [contentKey]);

  return (
    <div ref={layerRef} className="opening-layer">
      {behind}
      <section
        ref={sheetRef}
        className={className === undefined ? "opening-sheet" : `opening-sheet ${className}`}
        role="dialog"
        aria-label={label}
        aria-modal="false"
        inert={!isOpen}
      >
        {head}
        <div className="opening-clip">
          <div ref={ghostRef} className="opening-ghost" aria-hidden="true" inert />
          <div ref={wordsRef} className="opening-words">
            <div ref={contentRef} className="opening-content">
              {children}
            </div>
          </div>
        </div>
      </section>
    </div>
  );
}
