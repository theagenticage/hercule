import type { JSX } from "react";
import { ExternalIcon } from "../../icons/external";
import { MoreIcon } from "../../icons/more";
import { usePopoverMenu } from "../use-popover-menu";
import "../thread/menus.css";

/**
 * Renders the pane's "More" button and the menu it opens (spec 17 §The
 * pane): "Open on GitHub", when the signal's address on its source is known,
 * and "Ignore signals like this…", which calls `onIgnore`. The pane draws it
 * only for a signal the user can build an Ignore Rule from.
 *
 * The menu is the browser's own popover, as the side pane's surface picker
 * is, and its items are stepped through as `usePopoverMenu` describes.
 */
export function SignalPaneMenu({
  sourceName,
  sourceUrl,
  onIgnore,
}: {
  /** The name of the signal's source, such as "GitHub". */
  readonly sourceName: string;
  /** The signal's address on its source, or `null` when it is not known. */
  readonly sourceUrl: string | null;
  readonly onIgnore: () => void;
}): JSX.Element {
  const { triggerProps, menuProps, buildItemProps, close } = usePopoverMenu();

  return (
    <>
      <button
        type="button"
        className="icon-btn icon-btn--sm ad-more"
        {...triggerProps}
        aria-label="More"
        title="More"
      >
        <MoreIcon size={14} />
      </button>
      <div
        {...menuProps}
        popover="auto"
        role="menu"
        aria-label="More"
        className="pop popover-menu intake-menu ad-menu"
      >
        {sourceUrl !== null && (
          <a
            {...buildItemProps("open-on-source")}
            href={sourceUrl}
            target="_blank"
            rel="noreferrer"
            onClick={close}
          >
            <span>{`Open on ${sourceName}`}</span>
            <ExternalIcon size={13} />
          </a>
        )}
        <button
          type="button"
          {...buildItemProps("ignore")}
          onClick={() => {
            close();
            onIgnore();
          }}
        >
          <span>Ignore signals like this…</span>
        </button>
      </div>
    </>
  );
}
