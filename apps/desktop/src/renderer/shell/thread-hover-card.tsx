/**
 * The card of details that shows beside the sidebar while the pointer rests
 * on a thread row: the thread's full title, its project, its machine, its
 * branch and its model, as T3 Code's sidebar shows them.
 *
 * The list draws one card for all its rows. The card is a popover, so it
 * sits in the top layer above the main pane, and the sidebar's scrolling
 * box does not clip it. It only shows details: it takes no pointer events
 * and no focus, and is hidden from assistive technology, because each row's
 * accessible description already carries the same details.
 */
import { useLayoutEffect, useRef, type JSX, type ReactNode } from "react";
import { BranchIcon } from "../icons/branch";
import { LaptopIcon } from "../icons/laptop";
import { ProjectTile, type ProjectTint } from "../screens/project-tile";
import { ProviderLogo } from "../screens/thread/provider-logo";
import "./thread-hover-card.css";

/** What the card shows about one thread. */
export interface ThreadHoverDetails {
  /** The thread's title, in full. */
  readonly title: string;
  /** The project's name, or "No project". */
  readonly projectName: string;
  /** The project's tint, or `null` for a thread in no project, whose tile is an outline. */
  readonly tint: ProjectTint | null;
  /** The name of the machine the thread runs on, or `null` when it has none. */
  readonly machine: string | null;
  /** The branch the thread works on, or `null` when it works on none. */
  readonly branch: string | null;
  /** The model's name, or `null` when it is not known. */
  readonly model: string | null;
  /** The id of the model's provider, whose mark shows before the model's name. */
  readonly providerId: string | null;
}

/** Where the card shows, and for which row. */
export interface ThreadHoverPlacement {
  /** The `data-key` of the thread row the card shows beside. */
  readonly key: string;
  /** The card's left edge, in CSS pixels from the window's left edge. */
  readonly left: number;
  /** Where the card's top edge goes, in CSS pixels from the window's top, before it is kept inside the window. */
  readonly top: number;
}

/** The space the card keeps from the window's top and bottom edges, in CSS pixels. */
const WINDOW_MARGIN = 8;

/** The size of each row's icon, in CSS pixels. */
const ICON_SIZE = 12;

/** Renders one line of the card: an icon, then the text beside it. */
function DetailRow({
  icon,
  children,
}: {
  readonly icon: ReactNode;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <div className="thread-hover-row">
      <span className="thread-hover-icon">{icon}</span>
      <span className="thread-hover-text">{children}</span>
    </div>
  );
}

/**
 * Renders the card of `details`, shown at `placement`, or hidden while
 * `placement` is `null`. The machine, the branch and the model each have a
 * row only when they are known.
 *
 * The card's top is moved up when the card would reach past the window's
 * bottom edge, so a card for a row near the bottom stays in view. The card
 * lays itself out only when `placement` changes, not when `details` does.
 */
export function ThreadHoverCard({
  placement,
  details,
}: {
  readonly placement: ThreadHoverPlacement | null;
  readonly details: ThreadHoverDetails | null;
}): JSX.Element {
  const cardRef = useRef<HTMLDivElement>(null);

  // Shown and placed before the browser paints, so the card never shows at
  // the place it had for the previous row. Its height is known only once it
  // shows, so the top is kept inside the window after that.
  useLayoutEffect(() => {
    const card = cardRef.current!;
    if (placement === null) {
      card.togglePopover(false);
      return;
    }
    card.style.left = `${String(placement.left)}px`;
    card.togglePopover(true);
    const lowestTop = window.innerHeight - WINDOW_MARGIN - card.offsetHeight;
    const top = Math.max(WINDOW_MARGIN, Math.min(placement.top, lowestTop));
    card.style.top = `${String(top)}px`;
  }, [placement]);

  return (
    <div ref={cardRef} popover="manual" className="thread-hover" aria-hidden="true">
      {details === null ? null : (
        <>
          <p className="thread-hover-title">{details.title}</p>
          <div className="thread-hover-row">
            <ProjectTile tint={details.tint} name={details.projectName} />
          </div>
          {details.machine === null ? null : (
            <DetailRow icon={<LaptopIcon size={ICON_SIZE} />}>{details.machine}</DetailRow>
          )}
          {details.branch === null ? null : (
            <DetailRow icon={<BranchIcon size={ICON_SIZE} />}>{details.branch}</DetailRow>
          )}
          {details.model === null ? null : (
            <DetailRow
              icon={
                details.providerId === null ? null : (
                  <ProviderLogo providerId={details.providerId} size={ICON_SIZE} />
                )
              }
            >
              {details.model}
            </DetailRow>
          )}
        </>
      )}
    </div>
  );
}
