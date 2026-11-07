import type { PluginIdentity } from "@hercule/client-core";
import type {
  AddListView,
  AddRow,
  AddSource,
  ScopeOption,
  SearchLine,
  SuggestionGroup,
} from "@hercule/client-core/work";
import type { FormEvent, JSX, KeyboardEvent, Ref } from "react";
import { CheckIcon } from "../../icons/check";
import { ChevronDownIcon } from "../../icons/chevron-down";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { LockIcon } from "../../icons/lock";
import { PlusIcon } from "../../icons/plus";
import { SearchIcon } from "../../icons/search";
import { PluginMark } from "../../marks";
import { ProgressBar } from "../desk";
import { ViewSwitch } from "../view-switch";
import "./add-source-panel.css";

/**
 * The rows that were added since the sheet opened, by ref. The value is the
 * name of the stage the Task went to, or `undefined` while the controller has
 * not answered yet: the row turns to a check at once and learns its stage later.
 */
export type AddedRows = ReadonlyMap<string, string | undefined>;

/** What the suggestions are doing: being read, failed, or ready to list. */
export type SuggestionsView =
  | { readonly status: "loading" }
  | { readonly status: "failed"; readonly reason: string }
  | { readonly status: "ready"; readonly groups: readonly SuggestionGroup[] };

/** Renders three quiet bars where rows will be. They move nothing and spin nothing. */
function QuietBars(): JSX.Element {
  return (
    <div aria-hidden="true">
      {[0, 1, 2].map((index) => (
        <div key={index} className="add-bar">
          <i />
          <i />
        </div>
      ))}
    </div>
  );
}

/**
 * Renders one thing of the list as a button. A new thing is added by a click,
 * a thing that has a Task opens it, and a thing that was added stays where it
 * is as a check with the stage it went to, and takes no more clicks.
 */
function AddRowButton({
  row,
  added,
  isAdded,
  onAdd,
  onOpenTask,
}: {
  readonly row: AddRow;
  readonly added: string | undefined;
  readonly isAdded: boolean;
  readonly onAdd: (row: AddRow) => void;
  readonly onOpenTask: (taskId: string) => void;
}): JSX.Element {
  const isOnWork = !isAdded && row.taskId !== undefined;
  return (
    <button
      type="button"
      className={isAdded ? "add-row is-added" : isOnWork ? "add-row is-on-work" : "add-row"}
      data-ref={row.ref}
      disabled={isAdded}
      title={isOnWork ? "Open it on Work" : undefined}
      onClick={() => {
        if (row.taskId !== undefined) onOpenTask(row.taskId);
        else onAdd(row);
      }}
    >
      <small className="add-ref">{row.identifier}</small>
      <span className="add-words">
        <span className="add-title">{row.title}</span>
        {row.note !== undefined && <small className="add-note">{row.note}</small>}
      </span>
      <small className="add-state">{isAdded ? added : isOnWork ? "On Work" : row.state}</small>
      <i className="add-go">
        {isAdded ? (
          <CheckIcon size={14} />
        ) : isOnWork ? (
          <ChevronRightIcon size={12} />
        ) : (
          <PlusIcon size={14} />
        )}
      </i>
    </button>
  );
}

/** Renders what fills the list for `list`: suggestions, bars, results, or one sentence. */
function AddList({
  list,
  suggestions,
  added,
  onAdd,
  onOpenTask,
  onWiden,
}: {
  readonly list: AddListView;
  readonly suggestions: SuggestionsView;
  readonly added: AddedRows;
  readonly onAdd: (row: AddRow) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onWiden: () => void;
}): JSX.Element {
  const drawRow = (row: AddRow): JSX.Element => (
    <AddRowButton
      key={row.ref}
      row={row}
      added={added.get(row.ref)}
      isAdded={added.has(row.ref)}
      onAdd={onAdd}
      onOpenTask={onOpenTask}
    />
  );
  switch (list.kind) {
    case "searching":
      return (
        <>
          <h4 className="add-label">{list.text}</h4>
          <QuietBars />
        </>
      );
    case "results":
      return (
        <>
          <h4 className="add-label">
            {list.heading}
            <small>{list.caption}</small>
          </h4>
          {list.rows.map(drawRow)}
          {list.note !== undefined && <p className="add-none">{list.note}</p>}
        </>
      );
    case "message":
      return list.lockedHint === undefined ? (
        <>
          <p className="add-none">{list.text}</p>
          {list.widenLabel !== undefined && (
            <button type="button" className="add-widen" onClick={onWiden}>
              {list.widenLabel}
            </button>
          )}
        </>
      ) : (
        <div className="add-locked">
          <LockIcon size={14} />
          <span>
            <b>{list.text}</b>
            <small>{list.lockedHint}</small>
          </span>
        </div>
      );
    case "suggestions":
      return (
        <>
          <h4 className="add-label">
            {list.title}
            <small>{list.text}</small>
          </h4>
          {suggestions.status === "loading" && <QuietBars />}
          {suggestions.status === "failed" && (
            <p className="add-none">Could not read the suggestions. {suggestions.reason}</p>
          )}
          {suggestions.status === "ready" && suggestions.groups.length === 0 && (
            <p className="add-none">Nothing to suggest here.</p>
          )}
          {suggestions.status === "ready" &&
            suggestions.groups.map((group) => (
              <section key={group.ref}>
                {group.heading !== undefined && (
                  <h4 className="add-heading">
                    <b>{group.heading.title}</b>
                    <small>{group.heading.facts}</small>
                    {group.heading.progress !== undefined && (
                      <ProgressBar
                        fraction={group.heading.progress.fraction}
                        {...(group.heading.progress.words === undefined
                          ? {}
                          : { words: group.heading.progress.words })}
                      />
                    )}
                  </h4>
                )}
                {group.rows.map(drawRow)}
              </section>
            ))}
        </>
      );
  }
}

/**
 * Renders the From a source part of the Add to Work sheet: a segmented
 * control with one tab per source, the search as wide as the sheet, the
 * sentence that says where the search reaches, and the list.
 *
 * It decides nothing. The caller passes what each part says (`line`, `list`,
 * `suggestions`) and what to do on each action.
 *
 * - `onTextChange` is called with every change of the search, and `onSubmit`
 *   on Return, which adds the first thing of the list. `onKeyDown` sees every
 *   key pressed inside the part, for Esc.
 * - `scopeOptions` are the contexts the select offers beside "all of
 *   <source>", and `scopeRef` is the one chosen (`""` for all). `line` says
 *   whether the select is on show at all.
 * - `onWiden` is the button of a narrowed search that found nothing.
 * - `plugins` give the tabs their marks.
 */
export function AddSourcePanel({
  sources,
  plugins,
  sourceId,
  onPickSource,
  text,
  placeholder,
  searchRef,
  onTextChange,
  onSubmit,
  onKeyDown,
  line,
  scopeOptions,
  scopeRef,
  onScopeChange,
  list,
  suggestions,
  added,
  onAdd,
  onOpenTask,
  onWiden,
}: {
  readonly sources: readonly AddSource[];
  readonly plugins: ReadonlyArray<PluginIdentity>;
  readonly sourceId: string;
  readonly onPickSource: (sourceId: string) => void;
  readonly text: string;
  readonly placeholder: string;
  readonly searchRef: Ref<HTMLInputElement>;
  readonly onTextChange: (text: string) => void;
  readonly onSubmit: () => void;
  readonly onKeyDown: (event: KeyboardEvent<HTMLElement>) => void;
  readonly line: SearchLine;
  readonly scopeOptions: readonly ScopeOption[];
  readonly scopeRef: string;
  readonly onScopeChange: (scopeRef: string) => void;
  readonly list: AddListView;
  readonly suggestions: SuggestionsView;
  readonly added: AddedRows;
  readonly onAdd: (row: AddRow) => void;
  readonly onOpenTask: (taskId: string) => void;
  readonly onWiden: () => void;
}): JSX.Element {
  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    onSubmit();
  };
  return (
    <section className="add-from" aria-label="From a source" onKeyDown={onKeyDown}>
      <h3 className="add-from-title">From a source</h3>
      <ViewSwitch
        className="seg add-sources"
        label="Source"
        choices={sources.map((source) => ({
          view: source.id,
          label: source.name,
          mark: <PluginMark pluginId={source.id} plugins={plugins} size={14} />,
        }))}
        view={sourceId}
        onPick={onPickSource}
      />
      <form className="add-search" onSubmit={handleSubmit}>
        <SearchIcon size={15} />
        <input
          ref={searchRef}
          value={text}
          placeholder={placeholder}
          aria-label={placeholder}
          autoComplete="off"
          onChange={(event) => {
            onTextChange(event.target.value);
          }}
        />
      </form>
      {line.kind !== "scope" ? (
        <p className={line.kind === "offline" ? "add-reach is-off" : "add-reach"}>{line.text}</p>
      ) : (
        <label className="add-reach">
          <span>{line.lead}</span>
          <span className="add-reach-pick">
            <select
              aria-label="Narrow the search"
              value={scopeRef}
              onChange={(event) => {
                onScopeChange(event.target.value);
              }}
            >
              <option value="">{line.allLabel}</option>
              {scopeOptions.map((option) => (
                <option key={option.ref} value={option.ref}>
                  {option.label}
                </option>
              ))}
            </select>
            <ChevronDownIcon size={11} />
          </span>
          {line.trailing !== null && <span>{line.trailing}</span>}
        </label>
      )}
      <div className="add-list" aria-live="polite" aria-busy={list.kind === "searching"}>
        <AddList
          list={list}
          suggestions={suggestions}
          added={added}
          onAdd={onAdd}
          onOpenTask={onOpenTask}
          onWiden={onWiden}
        />
      </div>
    </section>
  );
}
