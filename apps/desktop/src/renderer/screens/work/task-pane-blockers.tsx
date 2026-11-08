import { useEffect, useRef, useState, type JSX, type KeyboardEvent } from "react";
import {
  buildTaskBlockerSections,
  listBlockerCandidates,
  nameTaskStage,
  type BlockerList,
  type BlockerRow,
  type TaskBlockers,
} from "@hercule/client-core/work";
import type { WorkCard } from "@hercule/contract";
import { ArrowIcon } from "../../icons/arrow";
import { CloseIcon } from "../../icons/close";
import { LockIcon } from "../../icons/lock";
import { PlusIcon } from "../../icons/plus";

/**
 * Renders one row of Blocked by or Blocks: the Task's title and the stage it
 * is at. A Task at a board stage is a button that opens it in the pane. A
 * Task that is Done or Dropped is plain history. A row of Blocked by also has
 * a button that removes the blocker (`onRemove`). A blocker that no longer
 * holds the Task back reads quietly.
 */
function BlockerRowItem({
  row,
  mark,
  onOpen,
  onRemove,
}: {
  readonly row: BlockerRow;
  readonly mark: JSX.Element;
  readonly onOpen: (taskId: string) => void;
  readonly onRemove?: (row: BlockerRow) => void;
}): JSX.Element {
  const words = (
    <>
      {mark}
      <span className="task-pane-row-text">{row.title}</span>
      <small>{row.stageName}</small>
    </>
  );
  return (
    <li
      className={[
        "task-pane-row task-pane-blocker",
        row.isQuiet && "is-quiet",
        !row.canOpen && "is-plain",
        onRemove !== undefined && "has-remove",
      ]
        .filter((name) => name !== false)
        .join(" ")}
    >
      {row.canOpen ? (
        <button
          type="button"
          className="task-pane-row-open"
          title="Open this Task"
          onClick={() => {
            onOpen(row.id);
          }}
        >
          {words}
        </button>
      ) : (
        <div className="task-pane-row-open">{words}</div>
      )}
      {onRemove !== undefined && (
        <button
          type="button"
          className="task-pane-row-remove"
          title="Remove this blocker"
          aria-label={`Stop waiting on ${row.title}`}
          onClick={(event) => {
            // The second click of a double click may land here, on the button that took the place of the row's state.
            if (event.detail > 1) return;
            onRemove(row);
          }}
        >
          <CloseIcon size={12} />
        </button>
      )}
    </li>
  );
}

/** Renders the rows of one list, and the words for the Tasks past it ("and 12 more"). */
function BlockerRows({
  list,
  mark,
  onOpen,
  onRemove,
}: {
  readonly list: BlockerList;
  readonly mark: JSX.Element;
  readonly onOpen: (taskId: string) => void;
  readonly onRemove?: (row: BlockerRow) => void;
}): JSX.Element {
  return (
    <>
      <ul className="task-pane-blockers">
        {list.rows.map((row) => (
          <BlockerRowItem key={row.id} row={row} mark={mark} onOpen={onOpen} onRemove={onRemove} />
        ))}
      </ul>
      {list.moreWords !== null && <p className="task-pane-more">{list.moreWords}</p>}
    </>
  );
}

/**
 * Renders the "Add a blocker" button and the search it opens over the board's
 * cards. The search offers the best matches by title and summary, not the Task
 * itself and not a Task that blocks it already. Choosing a row (or Return, for
 * the first) calls `onPick` with its card and closes the search. Esc closes
 * the search and leaves the pane open.
 *
 * The cards are the board's, so a Task that is Done or Dropped is not offered:
 * it could not hold anything back.
 */
function AddBlocker({
  cards,
  taskId,
  blockedByIds,
  onPick,
}: {
  readonly cards: readonly WorkCard[];
  readonly taskId: string;
  readonly blockedByIds: readonly string[];
  readonly onPick: (card: WorkCard) => void;
}): JSX.Element {
  const [isOpen, setIsOpen] = useState(false);
  const [text, setText] = useState("");
  const inputRef = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (isOpen) inputRef.current?.focus({ preventScroll: true });
  }, [isOpen]);

  const close = (): void => {
    setIsOpen(false);
    setText("");
  };
  if (!isOpen) {
    return (
      <div className="link-search is-tall">
        <button
          type="button"
          className="link-search-open"
          onClick={() => {
            setIsOpen(true);
          }}
        >
          <PlusIcon size={13} />
          Add a blocker
        </button>
      </div>
    );
  }
  const found = listBlockerCandidates(cards, text, { taskId, blockedByIds });
  const pick = (card: WorkCard): void => {
    close();
    onPick(card);
  };
  const closeOnEscape = (event: KeyboardEvent<HTMLElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    close();
  };
  return (
    <div className="link-search is-tall">
      <div className="link-search-find" onKeyDown={closeOnEscape}>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            const [first] = found;
            if (first !== undefined) pick(first);
          }}
        >
          <input
            ref={inputRef}
            className="link-search-input"
            value={text}
            placeholder="Search the board by title"
            aria-label="Add a blocker"
            autoComplete="off"
            onChange={(event) => {
              setText(event.target.value);
            }}
          />
        </form>
        {text.trim() !== "" && found.length === 0 && (
          <p className="link-search-note" aria-live="polite">
            No other Task on the board matches.
          </p>
        )}
        {found.length > 0 && (
          <ul className="link-search-found">
            {found.map((card) => (
              <li key={card.id}>
                <button
                  type="button"
                  className="link-search-go"
                  onClick={() => {
                    pick(card);
                  }}
                >
                  <span className="link-search-mark">
                    <LockIcon size={13} />
                  </span>
                  <span className="link-search-title">{card.title}</span>
                  <small>{nameTaskStage(card.stage)}</small>
                </button>
              </li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/**
 * Renders Blocked by and Blocks: the Tasks this Task waits on, and the Tasks
 * that wait on it, in the order the details list them. A list with no row is
 * not drawn, except that Blocked by always has "Add a blocker", which is how
 * the first blocker is made. The details list at most 50 of each, and "and 12
 * more" counts the rest.
 *
 * - `blockers` are the details' lists and totals.
 * - `cards` are the board's cards, which "Add a blocker" searches.
 * - `onOpenTask` opens a Task in the pane, from a row at a board stage.
 * - `onAdd` makes the Task wait on the card that was chosen. It resolves to a
 *   refusal when that would close a loop, and the section shows it under the
 *   button, until the next try or until the pane shows another Task. The
 *   message names the path of the loop.
 * - `onRemove` takes a blocker off, from the remove button of a Blocked by row.
 */
export function BlockerSections({
  blockers,
  taskId,
  cards,
  onOpenTask,
  onAdd,
  onRemove,
}: {
  readonly blockers: TaskBlockers;
  readonly taskId: string;
  readonly cards: readonly WorkCard[];
  readonly onOpenTask: (taskId: string) => void;
  readonly onAdd: (blocker: {
    readonly id: string;
    readonly title: string;
  }) => Promise<string | null>;
  readonly onRemove: (blocker: { readonly id: string; readonly title: string }) => void;
}): JSX.Element {
  const { blockedBy, blocks } = buildTaskBlockerSections(blockers);
  const [refusal, setRefusal] = useState<string | null>(null);
  return (
    <>
      <section className="task-pane-sec" aria-label="Blocked by">
        {blockedBy.rows.length > 0 && (
          <>
            <h3>Blocked by</h3>
            <BlockerRows
              list={blockedBy}
              mark={<LockIcon size={14} />}
              onOpen={onOpenTask}
              onRemove={onRemove}
            />
          </>
        )}
        <AddBlocker
          cards={cards}
          taskId={taskId}
          blockedByIds={blockedBy.rows.map((row) => row.id)}
          onPick={(card) => {
            setRefusal(null);
            void onAdd(card).then(setRefusal);
          }}
        />
        {refusal !== null && (
          <p className="task-pane-refusal" role="alert">
            {refusal}
          </p>
        )}
      </section>
      {blocks.rows.length > 0 && (
        <section className="task-pane-sec" aria-label="Blocks">
          <h3>Blocks</h3>
          <BlockerRows list={blocks} mark={<ArrowIcon size={14} />} onOpen={onOpenTask} />
        </section>
      )}
    </>
  );
}
