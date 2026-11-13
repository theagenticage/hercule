import { useId, useLayoutEffect, useRef, type JSX, type KeyboardEvent } from "react";
import type { PluginIdentity } from "@hercule/client-core";
import { LinkIcon } from "../../icons/link";
import { PluginMark } from "../../marks/plugin-mark";
import { useInboxPopover } from "./inbox-popover";
import "./inbox-link-to.css";

/** One thing the user can link to: what the row of the results draws. */
export interface InboxLinkToResult {
  /** The thing's ref, which `onPick` returns. */
  readonly ref: string;
  /** The thing's identifier in its source, such as "#6213" or "STOREFRONT-1Z9". */
  readonly identifier: string;
  readonly title: string;
  /** The plugin that reports the thing, whose mark leads the row. */
  readonly source: string;
}

/** The gap between the anchor row and the popover under it, in pixels. */
const GAP = 4;

/**
 * The height the popover keeps clear below the window's top when it opens
 * near the bottom edge: its tallest, 287px (the field, six rows and a
 * foot of one line at the width of a row), and 13px of margin.
 */
const ROOM_BELOW = 300;

/** The narrowest the popover is drawn, in pixels, for an anchor narrower than this. */
const MIN_WIDTH = 320;

/**
 * Places the popover `menu` under `anchor`: its left edge and width are the
 * anchor's, 4px below it. Near the bottom of the window it moves up so that
 * its whole height fits, and it never leaves the window.
 */
const placeMenu = (menu: HTMLElement, anchor: HTMLElement): void => {
  const target = anchor.getBoundingClientRect();
  const width = Math.min(Math.max(Math.round(target.width), MIN_WIDTH), window.innerWidth - 24);
  const left = Math.max(12, Math.min(Math.round(target.left), window.innerWidth - width - 12));
  menu.style.width = `${String(width)}px`;
  menu.style.left = `${String(left)}px`;
  menu.style.top = `${String(Math.max(12, Math.min(Math.round(target.bottom + GAP), window.innerHeight - ROOM_BELOW)))}px`;
};

/** Returns the sentence a screen reader hears when the results change. */
const describeResults = (count: number): string =>
  count === 0
    ? "Nothing matches."
    : `${String(count)} ${count === 1 ? "thing" : "things"} to link to.`;

/**
 * Renders "Link to...": a search over the Inbox for the thing to link
 * another thing to, as a popover under `anchor` (the row it opens from). The
 * parent renders it only while it is open, and removes it when `onPick` or
 * `onClose` is called.
 *
 * - It is a combobox. The field holds the focus and `aria-activedescendant`
 *   points at the highlighted result; each result is an option with
 *   `aria-selected`. The result count is spoken through a live region.
 * - `fromLabel` names what is being linked, such as "#6213": the field's
 *   placeholder reads "Link #6213 to...".
 * - `query` is the text typed and `results` are what it found, in the order
 *   to show. `highlighted` is the index of the highlighted result, and the
 *   parent keeps it in range. The up and down arrow keys call
 *   `onHighlightChange`, and so does the pointer entering a result.
 * - Return and a click call `onPick` with a result's ref. Esc calls `onClose`.
 * - Its popover behaviour (Esc, a click outside, the focus) is
 *   `useInboxPopover`'s.
 * - `plugins` draws the mark of each result's source.

 */
export function InboxLinkTo({
  anchor,
  fromLabel,
  query,
  results,
  highlighted,
  plugins,
  onQueryChange,
  onHighlightChange,
  onPick,
  onClose,
}: {
  readonly anchor: HTMLElement;
  readonly fromLabel: string;
  readonly query: string;
  readonly results: readonly InboxLinkToResult[];
  readonly highlighted: number;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly onQueryChange: (query: string) => void;
  readonly onHighlightChange: (index: number) => void;
  readonly onPick: (ref: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const inputRef = useRef<HTMLInputElement>(null);
  const ids = useId();
  const optionId = (index: number): string => `${ids}-${String(index)}`;
  const hasHighlight = highlighted >= 0 && highlighted < results.length;

  const handleKey = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : results.length - 1;
      onHighlightChange((highlighted + step) % Math.max(results.length, 1));
    } else if (event.key === "Enter") {
      event.preventDefault();
      const picked = results[highlighted];
      if (picked !== undefined) onPick(picked.ref);
    }
  };
  const { ref: menuRef, ...popover } = useInboxPopover({
    anchor,
    place: placeMenu,
    onKey: handleKey,
    onClose,
  });

  // The field takes the focus once the popover is shown.
  useLayoutEffect(() => {
    inputRef.current?.focus({ preventScroll: true });
  }, []);

  return (
    <div ref={menuRef} {...popover} className="inbox-popover link-to">
      <div className="link-to-field">
        <LinkIcon size={14} />
        <input
          ref={inputRef}
          type="text"
          role="combobox"
          aria-expanded="true"
          aria-controls={`${ids}-list`}
          aria-autocomplete="list"
          aria-activedescendant={hasHighlight ? optionId(highlighted) : undefined}
          aria-label={`Search for a thing to link ${fromLabel} to`}
          placeholder={`Link ${fromLabel} to…`}
          autoComplete="off"
          value={query}
          onChange={(event) => {
            onQueryChange(event.currentTarget.value);
          }}
        />
      </div>
      <div
        id={`${ids}-list`}
        role="listbox"
        aria-label="Things to link to"
        className="link-to-list"
      >
        {results.map((result, index) => (
          <div
            key={result.ref}
            id={optionId(index)}
            role="option"
            aria-selected={index === highlighted}
            className={index === highlighted ? "link-to-item is-active" : "link-to-item"}
            onPointerEnter={() => {
              onHighlightChange(index);
            }}
            onClick={() => {
              onPick(result.ref);
            }}
          >
            <PluginMark pluginId={result.source} plugins={plugins} size={14} />
            <span className="link-to-title">{result.title}</span>
            <span className="link-to-id">{result.identifier}</span>
          </div>
        ))}
        {results.length === 0 && <p className="link-to-none">Nothing matches.</p>}
      </div>
      <p className="link-to-foot">Linking makes them one group here. The sources are not told.</p>
      <span className="visually-hidden" role="status">
        {describeResults(results.length)}
      </span>
    </div>
  );
}
