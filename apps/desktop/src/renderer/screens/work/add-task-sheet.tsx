import {
  useEffect,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
  type ReactNode,
} from "react";
import { CheckIcon } from "../../icons/check";
import { SideSheet } from "../desk";
import "./add-task-sheet.css";

/** The lane Add to Work was opened from, which decides the Project of the new Task. */
export interface AddTaskLane {
  readonly id: string;
  readonly name: string;
  /** The Project the new Task joins, or null for the lane of Tasks with no Project. */
  readonly projectId: string | null;
}

/** Returns the line under the title field that says where the new Task will land. */
const describeLanding = (lane: AddTaskLane): string =>
  lane.projectId === null
    ? "Starts in Exploring, with no project."
    : `Starts in Exploring, in ${lane.name}.`;

/**
 * Renders the Add to Work sheet at the right of the board, with New Task: the
 * user types a title and presses Return.
 *
 * - `lane` is where the sheet was opened from, and a line says the new Task
 *   starts in Exploring, in that lane.
 * - `onCreate` creates the Task with the title, trimmed. The title is cleared
 *   when the promise resolves. When it rejects, the caller has already told
 *   the user why, and the title stays so that Return tries again. Return
 *   while a Task is being created does nothing.
 * - `result` says where the last Task landed, such as "Added to Planned.", and
 *   is null before the first.
 * - `fromSource` is the From a source part, drawn under the New Task field,
 *   or `null` when no source can be searched. It handles its own keys, such
 *   as Esc to clear its search.
 * - `onClose` is called by the Close button and by Esc.
 *
 * Esc steps back one thing at a time: in the title field it clears the typed
 * title, and anywhere else, or with nothing typed, it closes the sheet. The
 * title field has the focus on opening, unless `fromSource` took it for its
 * search, and again after a Task is created.
 */
export function AddTaskSheet({
  lane,
  onCreate,
  onClose,
  result,
  fromSource,
}: {
  readonly lane: AddTaskLane;
  readonly onCreate: (title: string) => Promise<void>;
  readonly onClose: () => void;
  readonly result: string | null;
  readonly fromSource: ReactNode;
}): JSX.Element {
  const [title, setTitle] = useState("");
  const [isCreating, setIsCreating] = useState(false);
  const titleRef = useRef<HTMLInputElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);

  // The From a source part focuses its search while it mounts, which is before
  // this runs. The title keeps the focus only when nothing else in the sheet took it.
  useEffect(() => {
    if (bodyRef.current?.contains(document.activeElement) !== true) {
      titleRef.current?.focus({ preventScroll: true });
    }
  }, []);

  const handleKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (title === "" || event.target !== titleRef.current) {
      onClose();
      return;
    }
    setTitle("");
    titleRef.current?.focus({ preventScroll: true });
  };

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    const trimmed = title.trim();
    if (trimmed === "" || isCreating) return;
    setIsCreating(true);
    void onCreate(trimmed)
      .then(
        () => {
          setTitle("");
        },
        () => {
          // The caller told the user why. The title stays, so Return tries again.
        },
      )
      .finally(() => {
        setIsCreating(false);
      });
  };

  return (
    <SideSheet title="Add to Work" onClose={onClose}>
      <div ref={bodyRef} className="add-task" onKeyDown={handleKeyDown}>
        <form onSubmit={handleSubmit}>
          <label className="field add-task-field">
            <input
              ref={titleRef}
              value={title}
              placeholder="New Task"
              aria-label="New Task"
              autoComplete="off"
              onChange={(event) => {
                setTitle(event.target.value);
              }}
            />
            <kbd aria-hidden>↩</kbd>
          </label>
        </form>
        <p className="add-task-landing">{describeLanding(lane)}</p>
        {result !== null && (
          <p className="add-task-result" role="status">
            <CheckIcon size={14} />
            {result}
          </p>
        )}
        {fromSource}
      </div>
    </SideSheet>
  );
}
