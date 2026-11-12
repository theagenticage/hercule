import {
  useEffect,
  useEffectEvent,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ChangeEvent,
  type JSX,
  type KeyboardEvent,
  type Ref,
} from "react";
import { createPortal } from "react-dom";
import type { PluginIdentity } from "@hercule/client-core";
import {
  commitInboxSearch,
  describeInboxClause,
  listInboxSuggestions,
  removeInboxClause,
  takeInboxSuggestion,
  typeInboxSearch,
  type InboxSearch,
  type InboxSearchContext,
  type InboxSuggestion,
} from "@hercule/client-core/inbox";
import { CloseIcon } from "../../icons/close";
import { FilterIcon } from "../../icons/filter";
import { SearchIcon } from "../../icons/search";
import { PluginMark } from "../../marks/plugin-mark";
import "./inbox-search.css";

/** What the orchestrator can ask of the field through its `ref`. */
export interface InboxSearchHandle {
  /** Puts the focus in the text field, so typing searches. The `/` key calls it. */
  focus: () => void;
}

/**
 * The placeholder texts, longest first. The field shows the first one that
 * fits whole, so a narrow field says less instead of cutting a word.
 */
const PLACEHOLDERS = [
  "Search, or type a field: team:, from:, waiting:>2d",
  "Search, or type team:, from:",
  "Search",
];

/** The gap between the field and the suggestions under it, in pixels. */
const MENU_GAP = 6;

/**
 * Renders the Inbox search field: the clauses as tokens, the text being
 * typed, and a menu of suggestions under it.
 *
 * - `search` is the field's state and `onChange` receives its next state. All
 *   the rules (which text becomes a token, what a suggestion offers, what
 *   leaving the field takes) are `@hercule/client-core/inbox`'s; the field
 *   only passes keys and text to them. `context` holds the declared fields and
 *   the suggested values.
 * - `onOpenClauseChange` is called when the clause being typed changes, with
 *   its field key (or null when none) and the value typed so far. The caller
 *   reads that field's values from the server and passes them back in
 *   `context.suggestedValues`: the field reads nothing itself.
 * - The scope token "in {scopeTitle}" leads the field while the field is
 *   focused or holds a search, unless the scope is Everything. Its × calls
 *   `onWiden`. Backspace never removes it.
 * - `onLeaveToResults` is called after ↩ on free text, or ↓ past the last
 *   suggestion. `onLeave` is called after Esc. In both the clause being typed
 *   is taken first, as ↩ would, and the search is kept. Tab, F6 and a click
 *   elsewhere take it too, and call neither.
 * - `plugins` draws the mark of a token picked from a source.
 * - `resultsText` is spoken through a live region, such as "3 things match in
 *   Mine."
 */
export function InboxSearchField({
  search,
  context,
  scopeTitle,
  scopeIsEverything,
  plugins,
  resultsText,
  onChange,
  onOpenClauseChange,
  onWiden,
  onLeaveToResults,
  onLeave,
  ref,
}: {
  readonly search: InboxSearch;
  readonly context: InboxSearchContext;
  readonly scopeTitle: string;
  readonly scopeIsEverything: boolean;
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly resultsText: string;
  readonly onChange: (search: InboxSearch) => void;
  readonly onOpenClauseChange: (key: string | null, typed: string) => void;
  readonly onWiden: () => void;
  readonly onLeaveToResults: () => void;
  readonly onLeave: () => void;
  readonly ref?: Ref<InboxSearchHandle>;
}): JSX.Element {
  const id = useId();
  const listId = `${id}-list`;
  const fieldRef = useRef<HTMLDivElement>(null);
  const chipsRef = useRef<HTMLSpanElement>(null);
  const moreRef = useRef<HTMLSpanElement>(null);
  const inputRef = useRef<HTMLInputElement>(null);
  const probeRef = useRef<HTMLSpanElement>(null);
  const menuRef = useRef<HTMLDivElement>(null);
  /** Set when a key left the field and took the clause: the blur that follows takes nothing more. */
  const leftByKey = useRef(false);
  const [inputFocused, setInputFocused] = useState(false);
  const [focusWithin, setFocusWithin] = useState(false);
  const [menuOpen, setMenuOpen] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [foldedCount, setFoldedCount] = useState(0);
  const [placeholder, setPlaceholder] = useState(PLACEHOLDERS[0]!);
  // Bumped when the field's width or the loaded fonts change, so the layout effect fits again.
  const [fit, refit] = useReducer((count: number) => count + 1, 0);

  useImperativeHandle(ref, () => ({ focus: () => inputRef.current?.focus() }), []);

  const menu = listInboxSuggestions(search, context);
  const activeIndex = Math.min(highlight, menu.items.length - 1);
  const activeItem = activeIndex >= 0 ? menu.items[activeIndex] : undefined;
  const open = inputFocused && menuOpen && menu.items.length > 0;
  const searching = search.text !== "" || search.clauses.length > 0 || focusWithin;
  const showScope = searching && !scopeIsEverything;

  const reportOpenClause = useEffectEvent((key: string | null, typed: string) => {
    onOpenClauseChange(key, typed);
  });
  const openKey = search.open?.key ?? null;
  const openTyped = search.open?.typed ?? "";
  useEffect(() => {
    reportOpenClause(openKey, openTyped);
  }, [openKey, openTyped]);

  // The field's width changes with the window and the list's column, and a hint measured before
  // the font loaded was measured in the fallback font.
  useEffect(() => {
    const field = fieldRef.current;
    if (field === null) return;
    const observer = new ResizeObserver(refit);
    observer.observe(field);
    document.fonts.addEventListener("loadingdone", refit);
    return () => {
      observer.disconnect();
      document.fonts.removeEventListener("loadingdone", refit);
    };
  }, []);

  // Fits what the field holds to the room it has: tokens that do not fit fold, oldest first, whole
  // into a +N token, and the placeholder is the longest text that fits. While measuring, tokens are
  // shown and hidden on the elements themselves; the state set at the end says the same thing, so
  // React draws what was measured.
  useLayoutEffect(() => {
    const chips = chipsRef.current;
    const more = moreRef.current;
    const input = inputRef.current;
    const probe = probeRef.current;
    if (chips === null || more === null || input === null || probe === null) return;
    const tokens = [...chips.querySelectorAll<HTMLElement>("[data-token]")];
    for (const token of tokens) token.hidden = false;
    more.hidden = true;
    let folded = 0;
    while (folded < tokens.length && chips.scrollWidth > chips.clientWidth + 1) {
      tokens[folded]!.hidden = true;
      folded += 1;
      more.hidden = false;
      more.textContent = `+${String(folded)}`;
    }
    setFoldedCount(folded);

    const room = input.clientWidth - 2;
    const fitting = PLACEHOLDERS.find((text) => {
      probe.textContent = text;
      return probe.offsetWidth <= room;
    });
    setPlaceholder(search.clauses.length > 0 ? "" : (fitting ?? ""));
  }, [search.clauses, showScope, scopeTitle, fit]);

  // The suggestions are a popover in the top layer, so the field's glass (a backdrop root) cannot
  // blur them. They sit level with the field and 6px under it.
  useLayoutEffect(() => {
    if (open) menuRef.current?.showPopover();
  }, [open]);
  useLayoutEffect(() => {
    const popover = menuRef.current;
    const field = fieldRef.current;
    if (!open || popover === null || field === null) return;
    const box = field.getBoundingClientRect();
    popover.style.left = `${String(box.left)}px`;
    popover.style.top = `${String(box.bottom + MENU_GAP)}px`;
    popover.style.width = `${String(box.width)}px`;
  });

  /** Takes the clause being typed as ↩ would, and keeps the search. */
  const takeTyped = (): void => {
    onChange(commitInboxSearch(search, context, activeItem));
  };

  /** Leaves the field by a key: takes the clause being typed and closes the suggestions. */
  const leave = (): void => {
    leftByKey.current = true;
    takeTyped();
    setMenuOpen(false);
  };

  const type = (input: string): void => {
    const next = typeInboxSearch(search, input, context);
    setMenuOpen(true);
    setHighlight(listInboxSuggestions(next, context).highlighted);
    onChange(next);
  };

  const take = (item: InboxSuggestion): void => {
    if (item.kind === "text") {
      leave();
      onLeaveToResults();
      return;
    }
    const next = takeInboxSuggestion(search, item, context);
    setHighlight(listInboxSuggestions(next, context).highlighted);
    // A picked field goes on into its values; a picked value is done.
    if (item.kind === "value") setMenuOpen(false);
    onChange(next);
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>): void => {
    // The field owns its keys: the page's shortcuts never see them.
    event.stopPropagation();
    switch (event.key) {
      case "Tab":
      case "F6":
        leave();
        return;
      case "ArrowDown":
        event.preventDefault();
        if (!open || activeIndex >= menu.items.length - 1) {
          leave();
          onLeaveToResults();
        } else {
          setHighlight(activeIndex + 1);
        }
        return;
      case "ArrowUp":
        event.preventDefault();
        setHighlight(Math.max(activeIndex < 0 ? -1 : 0, activeIndex - 1));
        return;
      case "Enter":
        event.preventDefault();
        if (open && activeItem !== undefined && activeItem.kind !== "text") {
          take(activeItem);
        } else if (search.open !== null && search.open.typed.trim() !== "") {
          // A typed `key:value` becomes a token and the cursor stays, ready for the next one.
          takeTyped();
          setMenuOpen(false);
        } else {
          leave();
          onLeaveToResults();
        }
        return;
      case "Backspace":
        // In an empty field Backspace removes the last token, and stops there: the scope is not one.
        if (search.input === "") {
          event.preventDefault();
          if (search.clauses.length > 0) {
            onChange(removeInboxClause(search, search.clauses.length - 1));
            setHighlight(-1);
          }
        }
        return;
      case "Escape":
        event.preventDefault();
        leave();
        onLeave();
        return;
    }
  };

  const clauseWords = search.clauses.map((clause) => describeInboxClause(clause, context.fields));

  return (
    <div
      ref={fieldRef}
      role="search"
      className="ib-sx"
      data-focus={inputFocused ? "" : undefined}
      data-chips={search.clauses.length > 0 ? "" : undefined}
      onFocus={() => {
        setFocusWithin(true);
      }}
      onBlur={(event) => {
        if (!event.currentTarget.contains(event.relatedTarget)) setFocusWithin(false);
      }}
    >
      <span className="ib-sx-icon">
        <SearchIcon size={14} />
      </span>
      <span ref={chipsRef} className="ib-sx-chips">
        {showScope && (
          <span
            className="ib-sx-chip ib-sx-chip-scope"
            title={`Searching in ${scopeTitle}. × searches Everything.`}
          >
            in<b>{scopeTitle}</b>
            <button type="button" aria-label="Search Everything instead" onClick={onWiden}>
              <CloseIcon size={10} />
            </button>
          </span>
        )}
        <span
          ref={moreRef}
          className="ib-sx-chip ib-sx-more"
          hidden={foldedCount === 0}
          title={clauseWords.slice(0, foldedCount).join(", ")}
        >
          +{foldedCount}
        </span>
        {search.clauses.map((clause, index) => {
          const words = clauseWords[index]!;
          const colon = words.indexOf(":");
          return (
            <span key={index} className="ib-sx-chip" data-token="" hidden={index < foldedCount}>
              {clause.source !== undefined && (
                <PluginMark pluginId={clause.source} plugins={plugins} size={12} />
              )}
              <span>{words.slice(0, colon + 1)}</span>
              <b>{words.slice(colon + 1)}</b>
              <button
                type="button"
                aria-label={`Remove ${words}`}
                onClick={() => {
                  onChange(removeInboxClause(search, index));
                }}
              >
                <CloseIcon size={10} />
              </button>
            </span>
          );
        })}
      </span>
      <input
        ref={inputRef}
        type="text"
        role="combobox"
        aria-label="Search the Inbox"
        aria-autocomplete="list"
        aria-keyshortcuts="/"
        aria-expanded={open ? "true" : "false"}
        aria-controls={listId}
        aria-activedescendant={
          open && activeIndex >= 0 ? `${id}-o${String(activeIndex)}` : undefined
        }
        autoComplete="off"
        spellCheck={false}
        placeholder={placeholder}
        value={search.input}
        onChange={(event: ChangeEvent<HTMLInputElement>) => {
          type(event.target.value);
        }}
        onFocus={() => {
          leftByKey.current = false;
          setInputFocused(true);
          setMenuOpen(true);
          setHighlight(menu.highlighted);
        }}
        onBlur={() => {
          setInputFocused(false);
          setMenuOpen(false);
          if (!leftByKey.current) takeTyped();
        }}
        onKeyDown={handleKeyDown}
      />
      <kbd className="ib-sx-kbd">/</kbd>
      <span ref={probeRef} className="ib-sx-probe" aria-hidden="true" />
      <span className="ib-sx-live" role="status">
        {resultsText}
      </span>
      {open &&
        createPortal(
          <div
            ref={menuRef}
            popover="manual"
            className="ib-sx-menu"
            // The suggestions never take the focus from the field.
            onMouseDown={(event) => {
              event.preventDefault();
            }}
          >
            {search.input.trim() === "" && <p className="ib-sx-heading">Search by a field</p>}
            <div id={listId} role="listbox" aria-label="Suggestions">
              {menu.items.map((item, index) => (
                <div
                  key={`${item.kind}:${suggestionLabel(item)}`}
                  id={`${id}-o${String(index)}`}
                  role="option"
                  aria-selected={index === activeIndex ? "true" : "false"}
                  className="ib-sx-item"
                  data-active={index === activeIndex ? "" : undefined}
                  onClick={() => {
                    take(item);
                  }}
                >
                  <span className="ib-sx-key">
                    {item.kind === "text" && <SearchIcon size={14} />}
                    {item.kind === "field" && <FilterIcon size={14} />}
                  </span>
                  <span className="ib-sx-label">
                    {item.kind === "text" ? (
                      <span className="ib-sx-words">“{item.text}”</span>
                    ) : (
                      <code>{suggestionLabel(item)}</code>
                    )}
                    {item.hint !== undefined && <small>{item.hint}</small>}
                  </span>
                  {item.kind === "value" && item.count !== undefined && (
                    <span className="ib-sx-count">{item.count.toLocaleString("en-US")}</span>
                  )}
                </div>
              ))}
            </div>
            <p className="ib-sx-foot">
              <kbd>↩</kbd> add <kbd>↓</kbd> to the results <kbd>⌫</kbd> remove the last{" "}
              <kbd>Esc</kbd> leave, keeping the search
            </p>
          </div>,
          document.body,
        )}
    </div>
  );
}

/** Returns the words a suggestion shows in code type: `team:` for a field, `team:Checkout` for a value. */
function suggestionLabel(item: InboxSuggestion): string {
  return item.kind === "text" ? item.text : item.label;
}
