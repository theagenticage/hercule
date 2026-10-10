/**
 * PROTOTYPE. The pills that float over the workflow list, and its search
 * field. They follow the Office's header in the Bureau book
 * (desktop/office.html): the page's name in bold, then its views as tabs.
 *
 * - Over the table, the name is followed by the filters, each with how many
 *   workflows it keeps, and the search field floats at the far end.
 * - Over an open workflow, there is room for the name only: it leads back
 *   to the table, and the button before it hides or shows the list. The
 *   search field sits at the top of the column itself.
 */
import type { JSX, RefObject } from "react";
import { Link } from "@tanstack/react-router";
import { SearchIcon } from "../../icons/search";
import { SidebarIcon } from "../../icons/sidebar";
import { WORKFLOW_LIST_FILTERS, type WorkflowListFilter } from "./workflow-rows";
import "../session/floating-header.css";
import "./workflow-list-header.css";

/** What the search field takes: its text, what to do when the text changes, and its element. */
interface SearchProps {
  readonly search: string;
  readonly onSearch: (search: string) => void;
  /** The input, which ⌘F focuses. */
  readonly searchRef: RefObject<HTMLInputElement | null>;
}

/** The search field's placeholder, which says what a search matches. */
const SEARCH_PLACEHOLDER = "Search names, triggers";

/**
 * Renders the header over the table: the name and the filters in one pill,
 * and the search field in another.
 */
export function WorkflowTableTop({
  filter,
  counts,
  onPickFilter,
  search,
  onSearch,
  searchRef,
}: SearchProps & {
  readonly filter: WorkflowListFilter;
  /** How many workflows each filter keeps. */
  readonly counts: Readonly<Record<WorkflowListFilter, number>>;
  readonly onPickFilter: (filter: WorkflowListFilter) => void;
}): JSX.Element {
  return (
    <header className="top">
      <nav className="pill wf-filters" aria-label="Filter workflows">
        <h1 className="pill-title">Workflows</h1>
        {WORKFLOW_LIST_FILTERS.map((each) => (
          <button
            key={each.filter}
            type="button"
            className={each.filter === filter ? "ptab is-on" : "ptab"}
            aria-pressed={each.filter === filter}
            onClick={() => onPickFilter(each.filter)}
          >
            {each.label}
            <small>{counts[each.filter]}</small>
          </button>
        ))}
      </nav>
      <span className="spacer" />
      <label className="pill wf-find">
        <SearchIcon size={14} />
        <input
          ref={searchRef}
          type="search"
          aria-label="Search workflows"
          placeholder={SEARCH_PLACEHOLDER}
          value={search}
          onChange={(event) => onSearch(event.target.value)}
        />
        <kbd>⌘F</kbd>
      </label>
    </header>
  );
}

/**
 * Renders the header over an open workflow: a button that hides or shows
 * the list, and the page's name, which leads back to the table. While a
 * filter other than All is on, the filter follows the name, so the column
 * does not pass for the whole list.
 */
export function WorkflowColumnTop({
  filter,
  count,
  isListShown,
  onToggleList,
}: {
  readonly filter: WorkflowListFilter;
  /** How many workflows the column shows. */
  readonly count: number;
  readonly isListShown: boolean;
  readonly onToggleList: () => void;
}): JSX.Element {
  const filterLabel = WORKFLOW_LIST_FILTERS.find((each) => each.filter === filter)?.label;
  const toggleLabel = isListShown ? "Hide the list" : "Show the list";
  return (
    <header className="top">
      <nav className="pill" aria-label="Workflows">
        <button
          type="button"
          className="icon-btn wf-list-toggle"
          aria-label={toggleLabel}
          title={toggleLabel}
          onClick={onToggleList}
        >
          <SidebarIcon />
        </button>
        <Link to="/workflows" className="ptab wf-back" title="Show all workflows">
          Workflows
          {filter === "all" ? <small>{count}</small> : null}
        </Link>
        {filter === "all" ? null : (
          <span className="ptab is-on">
            {filterLabel}
            <small>{count}</small>
          </span>
        )}
      </nav>
    </header>
  );
}

/** Renders the search field at the top of the column. */
export function WorkflowSearchField({ search, onSearch, searchRef }: SearchProps): JSX.Element {
  return (
    <label className="wl-search">
      <SearchIcon size={14} />
      <input
        ref={searchRef}
        type="search"
        aria-label="Search workflows"
        placeholder={SEARCH_PLACEHOLDER}
        value={search}
        onChange={(event) => onSearch(event.target.value)}
      />
      <kbd>⌘F</kbd>
    </label>
  );
}
