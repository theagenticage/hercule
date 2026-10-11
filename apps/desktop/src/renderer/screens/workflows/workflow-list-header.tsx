/**
 * The workflow list's floating header and its search field (spec 17
 * §Workflows, "The filters and search").
 *
 * - Over the table, the header holds the page's name and the filters in one
 *   pill, and the search field in another at the far end.
 * - Over an open workflow, it holds the button that hides or shows the list,
 *   and the page's name as a tab back to the table. The search field sits at
 *   the top of the column instead.
 */
import { useEffect, useRef, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { WORKFLOW_LIST_FILTERS, type WorkflowListFilter } from "@hercule/client-core/workflow-rows";
import { SearchIcon } from "../../icons/search";
import { SidebarIcon } from "../../icons/sidebar";
import "../session/floating-header.css";
import "./workflow-list.css";

/**
 * Renders the header over the table. `filter` is the pressed filter, and
 * `counts` holds how many workflows each filter keeps. `search` is the
 * search field's text. Pressing a filter calls `onFilterChange`, and typing
 * calls `onSearchChange`.
 */
export function WorkflowListHeader({
  filter,
  counts,
  search,
  onFilterChange,
  onSearchChange,
}: {
  readonly filter: WorkflowListFilter;
  readonly counts: Readonly<Record<WorkflowListFilter, number>>;
  readonly search: string;
  readonly onFilterChange: (filter: WorkflowListFilter) => void;
  readonly onSearchChange: (search: string) => void;
}): JSX.Element {
  return (
    <div className="top">
      <nav className="pill filters" aria-label="Filter workflows">
        <h1 className="pill-title">Workflows</h1>
        {WORKFLOW_LIST_FILTERS.map(({ filter: each, label }) => (
          <button
            key={each}
            type="button"
            className={each === filter ? "ptab is-on" : "ptab"}
            aria-pressed={each === filter}
            onClick={() => onFilterChange(each)}
          >
            {label} <small>{counts[each]}</small>
          </button>
        ))}
      </nav>
      <span className="spacer" />
      <WorkflowSearchField search={search} onSearchChange={onSearchChange} isBoxed={false} />
    </div>
  );
}

/**
 * Renders the header over an open workflow: the button that hides the list
 * when `isListShown` and shows it otherwise, calling `onToggleList`, then
 * the page's name as a tab that leads back to the table, with the count of
 * All. `counts` holds how many workflows each filter keeps. While `filter`
 * is not All, the filter follows the name with its count, so the column
 * does not pass for the whole list.
 */
export function WorkflowColumnHeader({
  filter,
  counts,
  isListShown,
  onToggleList,
}: {
  readonly filter: WorkflowListFilter;
  readonly counts: Readonly<Record<WorkflowListFilter, number>>;
  readonly isListShown: boolean;
  readonly onToggleList: () => void;
}): JSX.Element {
  const toggleLabel = isListShown ? "Hide the list" : "Show the list";
  const filterLabel = WORKFLOW_LIST_FILTERS.find((each) => each.filter === filter)!.label;
  return (
    <div className="top">
      <nav className="pill" aria-label="Workflow list">
        <button
          type="button"
          className="icon-btn list-btn"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleList}
        >
          <SidebarIcon />
        </button>
        {/* Exact, so the tab is not marked as the current page while a
            workflow under /workflows is open. */}
        <Link to="/workflows" className="ptab pill-back" activeOptions={{ exact: true }}>
          Workflows <small>{counts.all}</small>
        </Link>
        {filter === "all" ? null : (
          <span className="ptab is-on">
            {filterLabel} <small>{counts[filter]}</small>
          </span>
        )}
      </nav>
    </div>
  );
}

/**
 * Renders the search field: in a pill of its own at the header's far end,
 * or, when `isBoxed`, boxed at the top of the column. `search` is its text,
 * and typing calls `onSearchChange`.
 *
 * While the field is mounted, ⌘F focuses it and selects its text, so typing
 * replaces the last search. ⌘F does nothing while a dialog is open, or when
 * something else has already handled the key press.
 */
export function WorkflowSearchField({
  search,
  onSearchChange,
  isBoxed,
}: {
  readonly search: string;
  readonly onSearchChange: (search: string) => void;
  readonly isBoxed: boolean;
}): JSX.Element {
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (event.defaultPrevented) return;
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      // Caps Lock turns the key into "F".
      if (event.key.toLowerCase() !== "f") return;
      // An open dialog is modal, and the search field behind it cannot take focus.
      if (document.querySelector("dialog[open]") !== null) return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

  return (
    <label className={isBoxed ? "find find--box" : "pill find"}>
      <SearchIcon size={14} />
      <input
        ref={searchRef}
        type="search"
        placeholder="Search names, triggers"
        aria-label="Search workflows"
        value={search}
        onChange={(event) => onSearchChange(event.target.value)}
      />
      <kbd>⌘F</kbd>
    </label>
  );
}
