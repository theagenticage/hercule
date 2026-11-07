import type { ButtonHTMLAttributes, JSX, KeyboardEvent, ReactNode, Ref } from "react";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { CloseIcon } from "../../icons/close";
import { SearchIcon } from "../../icons/search";
import "./toolbar.css";

/**
 * Renders a control of the toolbar: a 36px button on glass, such as Group by
 * and Filter. The button's other attributes go to the `<button>`, so a button
 * that opens a menu spreads the `triggerProps` of `usePopoverMenu`.
 *
 * - `name` is the control's word, in medium weight.
 * - `caption` is a quiet word before it: "Group by" before "Project".
 * - `icon` goes before the words.
 * - `hasMenu` adds the chevron of a control that opens a menu.
 * - `isFilled` draws the page's one filled button, Add, in the answer colour.
 */
export function ToolButton({
  name,
  caption,
  icon,
  hasMenu,
  isFilled,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type"> & {
  readonly name: string;
  readonly caption?: string;
  readonly icon?: ReactNode;
  readonly hasMenu: boolean;
  readonly isFilled: boolean;
}): JSX.Element {
  return (
    <button {...button} type="button" className={isFilled ? "tool tool--add" : "tool"}>
      {icon}
      {caption !== undefined && <span className="tool-key">{caption}</span>}
      <b>{name}</b>
      {hasMenu && <ChevronDownIcon size={12} />}
    </button>
  );
}

/**
 * Renders a square button on glass that holds one icon or one character, such
 * as Display or "?". It is named by `label`, which is also its tooltip unless
 * `title` gives another, such as one that names the key. The button's other
 * attributes go to the `<button>`.
 */
export function IconPill({
  label,
  children,
  ...button
}: Omit<ButtonHTMLAttributes<HTMLButtonElement>, "children" | "type" | "aria-label"> & {
  readonly label: string;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <button
      {...button}
      type="button"
      className="icon-pill"
      aria-label={label}
      title={button.title ?? label}
    >
      {children}
    </button>
  );
}

/**
 * Renders a removable filter: its value in medium weight, after a quiet
 * caption such as "Linear project", or none when `caption` is empty. Pressing it
 * calls `onRemove`. Assistive technology reads it as "Remove filter" and the
 * caption and the value, because the caption is hidden when room runs out.
 */
export function FilterChip({
  caption,
  name,
  onRemove,
}: {
  readonly caption: string;
  readonly name: string;
  readonly onRemove: () => void;
}): JSX.Element {
  return (
    <button
      type="button"
      className="desk-chip"
      title="Remove this filter"
      aria-label={`Remove filter ${caption === "" ? "" : `${caption} `}${name}`}
      onClick={onRemove}
    >
      {caption !== "" && <small>{caption}</small>}
      <b>{name}</b>
      <CloseIcon size={11} />
    </button>
  );
}

/** Renders the Clear button that follows two or more chips and calls `onClear`. */
export function ClearChipsButton({ onClear }: { readonly onClear: () => void }): JSX.Element {
  return (
    <button type="button" className="chip-clear" onClick={onClear}>
      Clear
    </button>
  );
}

/**
 * Renders the toolbar row that floats over the top of a page, 10px from the
 * top and 14px from the sides, and stays while the page scrolls:
 *
 * - `start` is the left end, the view pill;
 * - `children` are the controls and the chips of what is on, which share the
 *   room between the two ends. When `isCrowded` is true the chips drop their
 *   captions, so each keeps its value and Clear stays in reach;
 * - `end` is the right end: Find, Display and Add.
 *
 * Only the controls take the pointer. The gaps between them let it through to
 * the page.
 */
export function Toolbar({
  start,
  children,
  end,
  isCrowded,
}: {
  readonly start: ReactNode;
  readonly children: ReactNode;
  readonly end: ReactNode;
  readonly isCrowded: boolean;
}): JSX.Element {
  return (
    <div className="desk-toolbar">
      {start}
      <div className="tools">
        <div className={isCrowded ? "tools-main has-many" : "tools-main"}>{children}</div>
      </div>
      <div className="tools-end">{end}</div>
    </div>
  );
}

/** One match listed under a find box: what to open, its title, and a quiet line about where it is. */
export interface FindMatch {
  readonly id: string;
  readonly title: string;
  readonly detail: string;
}

/**
 * Renders the find box: a glass button with a lens that opens into a text
 * field, and under it, while `value` is not empty, the list of the best
 * matches.
 *
 * - `value` and `onChange` are the text. `inputRef` lets the page focus the
 *   field, such as on `/`. `onKeyDown` takes the keys of the field, so the
 *   page decides what the arrows, Return and Esc do.
 * - `matches` are the best few, `totalCount` is how many there are, and
 *   `activeId` is the one the arrows are on, or null. A match is opened with
 *   `onOpen`. Two words say what the list holds: `placeholder` for the empty
 *   field, and `noMatchText` for a list with no match.
 */
export function FindBox({
  value,
  onChange,
  onKeyDown,
  inputRef,
  placeholder,
  noMatchText,
  matches,
  totalCount,
  activeId,
  onOpen,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void;
  readonly inputRef: Ref<HTMLInputElement>;
  readonly placeholder: string;
  readonly noMatchText: string;
  readonly matches: ReadonlyArray<FindMatch>;
  readonly totalCount: number;
  readonly activeId: string | null;
  readonly onOpen: (id: string) => void;
}): JSX.Element {
  const isOpen = value !== "";
  return (
    <div className="find-wrap">
      <label className={isOpen ? "find is-on" : "find"}>
        <SearchIcon size={16} />
        <input
          ref={inputRef}
          value={value}
          placeholder={placeholder}
          aria-label={placeholder}
          role="combobox"
          aria-expanded={isOpen}
          aria-controls="desk-find-list"
          aria-activedescendant={activeId === null ? undefined : `desk-find-${activeId}`}
          onChange={(event) => {
            onChange(event.target.value);
          }}
          onKeyDown={onKeyDown}
        />
      </label>
      <div
        id="desk-find-list"
        className={isOpen ? "find-list is-on" : "find-list"}
        role="listbox"
        aria-label="Matches"
        inert={!isOpen}
      >
        {matches.length === 0 && <p className="find-none">{noMatchText}</p>}
        {matches.map((match) => (
          <button
            key={match.id}
            type="button"
            id={`desk-find-${match.id}`}
            className={match.id === activeId ? "find-row is-on" : "find-row"}
            role="option"
            aria-selected={match.id === activeId}
            tabIndex={-1}
            onClick={() => {
              onOpen(match.id);
            }}
          >
            <b>{match.title}</b>
            <small>{match.detail}</small>
          </button>
        ))}
        {totalCount > matches.length && <p className="find-more">{totalCount} in all</p>}
      </div>
    </div>
  );
}
