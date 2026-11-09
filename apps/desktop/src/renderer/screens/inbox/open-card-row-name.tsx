import { useEffect, useId, useRef, useState, type JSX } from "react";
import "../thread/menus.css";
import "./open-card-row-name.css";

/** How long, in milliseconds, the pointer rests on a name before its card shows. */
const REST_MS = 400;

/**
 * Renders the card that shows a name in full, anchored to the element
 * `anchor` that draws it cut off.
 *
 * While it is mounted, the card sets a CSS anchor name on `anchor` (through
 * the CSSOM, which the Content-Security-Policy allows) and removes it when it
 * unmounts. The card is a manual popover in the top layer, so the sheet's
 * clip does not cut it off too. It only shows the name, so it takes no
 * pointer and is hidden from assistive technology, whose row already carries
 * the whole name.
 */
function NameCard({
  name,
  anchor,
}: {
  readonly name: string;
  readonly anchor: HTMLElement;
}): JSX.Element {
  const card = useRef<HTMLSpanElement>(null);
  // The id `useId` returns holds characters a CSS ident may not, so they are stripped.
  const anchorName = `--open-card-name-${useId().replace(/\W/g, "")}`;
  useEffect(() => {
    anchor.style.setProperty("anchor-name", anchorName);
    card.current?.showPopover();
    return () => {
      anchor.style.removeProperty("anchor-name");
    };
  }, [anchor, anchorName]);
  return (
    <span
      ref={card}
      className="pop open-card-name-card"
      popover="manual"
      aria-hidden="true"
      style={{ positionAnchor: anchorName }}
    >
      {name}
    </span>
  );
}

/**
 * Renders the name of a workflow on a row of the open card, which ends with an
 * ellipsis at the edge of its column (`.open-card-name`). When the name is cut
 * off, a small card shows it in full:
 *
 * - while the pointer has rested on the name for a moment;
 * - while the row has the keyboard's focus (`:focus-visible`), at once.
 *
 * It shows only a name that is cut off, checked when the card is about to
 * show, so it follows the sheet's width and the Text size. A name that fits
 * never shows a card. The row is the closest `.open-card-row`, which is also
 * where the focus lands, so the name takes no focus of its own.
 */
export function OpenCardRowName({ name }: { readonly name: string }): JSX.Element {
  const label = useRef<HTMLSpanElement>(null);
  // The element the card is anchored to while it shows, or null while it does not.
  const [cardAnchor, setCardAnchor] = useState<HTMLElement | null>(null);
  useEffect(() => {
    const nameElement = label.current;
    const row = nameElement?.closest<HTMLElement>(".open-card-row");
    if (!nameElement || !row) return;
    let timer: number | undefined;
    const showIfCutOff = (): void => {
      if (nameElement.scrollWidth > nameElement.clientWidth) setCardAnchor(nameElement);
    };
    const hide = (): void => {
      window.clearTimeout(timer);
      setCardAnchor(null);
    };
    const waitForRest = (): void => {
      window.clearTimeout(timer);
      timer = window.setTimeout(showIfCutOff, REST_MS);
    };
    const showForKeyboard = (): void => {
      if (row.matches(":focus-visible")) showIfCutOff();
    };
    nameElement.addEventListener("pointerenter", waitForRest);
    nameElement.addEventListener("pointerleave", hide);
    row.addEventListener("pointerdown", hide);
    row.addEventListener("focus", showForKeyboard);
    row.addEventListener("blur", hide);
    return () => {
      window.clearTimeout(timer);
      nameElement.removeEventListener("pointerenter", waitForRest);
      nameElement.removeEventListener("pointerleave", hide);
      row.removeEventListener("pointerdown", hide);
      row.removeEventListener("focus", showForKeyboard);
      row.removeEventListener("blur", hide);
    };
  }, []);
  return (
    <>
      <span ref={label} className="open-card-name">
        {name}
      </span>
      {cardAnchor === null ? null : <NameCard name={name} anchor={cardAnchor} />}
    </>
  );
}
