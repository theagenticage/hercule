/**
 * The workflow list's floating header: the page's name and the filters in
 * one pill, and the search in another at the far end (spec 17 §Workflows,
 * "The filters and search").
 */
import { useEffect, useRef, type JSX } from "react";
import { WORKFLOW_LIST_FILTERS, type WorkflowListFilter } from "@hercule/client-core";
import { SearchIcon } from "../../icons/search";
import "../session/floating-header.css";
import "./workflow-list.css";

/**
 * Renders the header. `filter` is the pressed filter, and `counts` holds how
 * many workflows each filter keeps. `search` is the search field's text.
 * Pressing a filter calls `onFilterChange`, and typing calls
 * `onSearchChange`.
 *
 * While the header is mounted, ⌘F focuses the search field and selects its
 * text, so typing replaces the last search.
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
  const searchRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    const focusSearch = (event: KeyboardEvent): void => {
      if (!event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return;
      if (event.key !== "f") return;
      event.preventDefault();
      searchRef.current?.focus();
      searchRef.current?.select();
    };
    window.addEventListener("keydown", focusSearch);
    return () => window.removeEventListener("keydown", focusSearch);
  }, []);

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
      <label className="pill find">
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
    </div>
  );
}
