import type { AddListView, AddRow, SuggestionGroup } from "@hercule/client-core/work";
import type { JSX } from "react";
import { CheckIcon } from "../../icons/check";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { LockIcon } from "../../icons/lock";
import { PlusIcon } from "../../icons/plus";
import { ProgressBar } from "../desk";
import "./add-list.css";

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

/**
 * Renders what fills the list of the From a source part for `list`:
 * suggestions, bars, results, or one sentence. It decides nothing: `onAdd`
 * adds a new thing, `onOpenTask` opens one that has a Task, and `onWiden` is
 * the button of a narrowed search that found nothing.
 */
export function AddList({
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
