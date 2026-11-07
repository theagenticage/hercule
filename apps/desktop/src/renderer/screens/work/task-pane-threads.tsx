import { Fragment, useEffect, useRef, useState, type JSX } from "react";
import { buildTaskThreadRow, describeNextThreadJoin } from "@hercule/client-core/work";
import type { TaskDetail } from "@hercule/contract";
import { buildLook, Face } from "../../faces";

/**
 * Renders the line under a Thread's row that asks before the Thread moves to a
 * new Task. Moving a Thread leaves the workspace's link to the old Task, so it
 * says first that the next Thread there still joins the old Task. Esc takes
 * the line back and keeps the pane open.
 */
function MoveThreadConfirm({
  taskTitle,
  onConfirm,
  onCancel,
}: {
  readonly taskTitle: string;
  readonly onConfirm: () => void;
  readonly onCancel: () => void;
}): JSX.Element {
  const confirmRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    confirmRef.current?.focus();
  }, []);
  return (
    <div
      className="task-pane-confirm"
      role="group"
      aria-label="Move this Thread to a new Task"
      onKeyDown={(event) => {
        if (event.key !== "Escape") return;
        event.preventDefault();
        event.stopPropagation();
        onCancel();
      }}
    >
      <p>{describeNextThreadJoin({ title: taskTitle })}</p>
      <div className="task-pane-confirm-buttons">
        <button type="button" className="task-pane-btn" ref={confirmRef} onClick={onConfirm}>
          Move
        </button>
        <button type="button" className="task-pane-btn" onClick={onCancel}>
          Cancel
        </button>
      </div>
    </div>
  );
}

/** Renders the Threads of the Task, and says how many more there are than the pane lists. */
export function ThreadsSection({
  detail,
  taskTitle,
  onOpenThread,
  onMoveThreadToNewTask,
}: {
  readonly detail: TaskDetail;
  /** The title of the Task the pane shows, which the note before a move names. */
  readonly taskTitle: string;
  readonly onOpenThread: (sessionId: string) => void;
  readonly onMoveThreadToNewTask: (sessionId: string) => void;
}): JSX.Element | null {
  // The Thread whose "Move to a new Task" asks for a second press, and the
  // buttons that opened it, so the focus can go back to the one that did.
  const [confirmingId, setConfirmingId] = useState<string | null>(null);
  const moveButtons = useRef(new Map<string, HTMLButtonElement>());
  if (detail.sessions.length === 0) return null;
  const hidden = detail.sessionCount - detail.sessions.length;
  return (
    <section className="task-pane-sec" aria-label="Threads">
      <h3>
        Threads <span>{detail.sessionCount}</span>
      </h3>
      {detail.sessions.map((session) => {
        const row = buildTaskThreadRow(session);
        return (
          <Fragment key={row.id}>
            <div className="task-pane-row">
              <button
                type="button"
                className="task-pane-row-open"
                onClick={() => {
                  onOpenThread(row.id);
                }}
              >
                <Face look={buildLook(row.id)} pose={row.pose} size={20} />
                <span className="task-pane-row-text">{row.label}</span>
                {row.state !== null && <small>{row.state}</small>}
              </button>
              {row.canMoveToNewTask && (
                <button
                  type="button"
                  className="task-pane-row-action"
                  aria-expanded={confirmingId === row.id}
                  ref={(button) => {
                    if (button === null) moveButtons.current.delete(row.id);
                    else moveButtons.current.set(row.id, button);
                  }}
                  onClick={() => {
                    setConfirmingId(confirmingId === row.id ? null : row.id);
                  }}
                >
                  Move to a new Task
                </button>
              )}
            </div>
            {confirmingId === row.id && (
              <MoveThreadConfirm
                taskTitle={taskTitle}
                onConfirm={() => {
                  setConfirmingId(null);
                  onMoveThreadToNewTask(row.id);
                }}
                onCancel={() => {
                  setConfirmingId(null);
                  moveButtons.current.get(row.id)?.focus();
                }}
              />
            )}
          </Fragment>
        );
      })}
      {hidden > 0 && <p className="task-pane-more">and {hidden} more</p>}
    </section>
  );
}
