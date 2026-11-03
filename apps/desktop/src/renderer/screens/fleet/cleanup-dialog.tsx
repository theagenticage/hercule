/**
 * The cleanup dialog of the Fleet screen (spec 17 §The cleanup dialog),
 * drawn from what `describeCleanupDialog` and the progress of the cleanup
 * hold. These components draw and read nothing: the route-local
 * `-clean-up-button.tsx` owns the ticks and the progress.
 */
import { useEffect, useRef, type JSX, type ReactNode, type RefObject } from "react";
import type {
  CleanupDialog as CleanupDialogDescription,
  CleanupDialogGroup,
  CleanupDialogRow,
  CleanupGroupId,
  CleanupRow,
} from "@hercule/client-core/cleanup";
import type { CleanupOutcomeWords, RemovalOutcome } from "@hercule/client-core/cleanup-progress";
import { CheckIcon } from "../../icons/check";
import { GlassDialog } from "../glass-dialog";
import "./cleanup-dialog.css";

/**
 * Renders the frame of the cleanup dialog: the glass dialog and its head,
 * "Clean up atlas". `children` are the body and the foot. A `locked` dialog
 * ignores Esc and a press on the scrim, while the cleanup is being started.
 * `onClose` is called whenever the dialog closes.
 */
export function CleanupDialogFrame({
  dialogRef,
  title,
  locked,
  onClose,
  children,
}: {
  readonly dialogRef: RefObject<HTMLDialogElement | null>;
  readonly title: string;
  readonly locked: boolean;
  readonly onClose: () => void;
  readonly children: ReactNode;
}): JSX.Element {
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="cleanup-dialog"
      label={title}
      locked={locked}
      onClose={onClose}
    >
      <div className="pop-h cleanup-head">
        <b>{title}</b>
      </div>
      {children}
    </GlassDialog>
  );
}

/** Renders the checkbox of a row or of a group's head, with a dash while `isMixed`. */
function CleanupBox({
  isChecked,
  isMixed,
  onChange,
}: {
  readonly isChecked: boolean;
  readonly isMixed: boolean;
  readonly onChange: () => void;
}): JSX.Element {
  return (
    <span className="choice-box cleanup-box">
      <input
        type="checkbox"
        checked={isChecked}
        ref={(input) => {
          // `indeterminate` is a property of the element, not an attribute React can set.
          if (input !== null) input.indeterminate = isMixed;
        }}
        onChange={onChange}
      />
      <CheckIcon size={12} />
      <i className="cleanup-dash" aria-hidden="true" />
    </span>
  );
}

/** Renders one row of a group: a checkbox, the name, when it was last used, and what removing it frees. */
function CleanupChoiceRow({
  row,
  onToggle,
}: {
  readonly row: CleanupDialogRow;
  readonly onToggle: (workspaceId: string) => void;
}): JSX.Element {
  return (
    <li className="cleanup-row">
      <label
        title={
          row.sizeText === null || row.freesText === null
            ? undefined
            : `${row.sizeText} on disk; removing it frees ${row.freesText}`
        }
      >
        <CleanupBox
          isChecked={row.ticked}
          isMixed={false}
          onChange={() => {
            onToggle(row.workspaceId);
          }}
        />
        <span className="cleanup-name">
          <b>{row.name}</b>
          {row.measuringNote !== null && <span>{row.measuringNote}</span>}
        </span>
        <span className="cleanup-age">{row.lastUsedText}</span>
        <span className="cleanup-frees">{row.freesText ?? "-"}</span>
      </label>
    </li>
  );
}

/** Renders a group: its head, which ticks all of its rows, and the rows. */
function CleanupChoiceGroup({
  group,
  onToggleRow,
  onToggleGroup,
}: {
  readonly group: CleanupDialogGroup;
  readonly onToggleRow: (workspaceId: string) => void;
  readonly onToggleGroup: (groupId: CleanupGroupId, isTicked: boolean) => void;
}): JSX.Element {
  return (
    <section className="cleanup-group">
      <label className="cleanup-group-head">
        <CleanupBox
          isChecked={group.checked === "all"}
          isMixed={group.checked === "some"}
          onChange={() => {
            onToggleGroup(group.id, group.checked !== "all");
          }}
        />
        <span className="cleanup-group-title">
          <b>{group.title}</b>
          <span>{group.hint}</span>
        </span>
        <span className="cleanup-group-summary">{group.summary}</span>
      </label>
      <ul className="cleanup-rows">
        {group.rows.map((row) => (
          <CleanupChoiceRow key={row.workspaceId} row={row} onToggle={onToggleRow} />
        ))}
      </ul>
    </section>
  );
}

/**
 * Renders the body and the foot of the dialog while the user picks what to
 * remove: the groups of `description`, a line that says what removing does, and
 * Cancel and the button that archives and removes. A machine with nothing to
 * clean up shows `description.empty` and Close.
 *
 * - `error`, when given, is shown as an alert over the groups: the archive was
 *   refused or failed, and nothing was removed.
 * - While `isStarting`, the button shows that it works and does nothing.
 * - A disabled button has no effect, and its reason, `description.button.hint`,
 *   shows in place of the foot line.
 */
export function CleanupChoices({
  description,
  error,
  isStarting,
  onToggleRow,
  onToggleGroup,
  onConfirm,
  onClose,
}: {
  readonly description: CleanupDialogDescription;
  readonly error: string | null;
  readonly isStarting: boolean;
  readonly onToggleRow: (workspaceId: string) => void;
  readonly onToggleGroup: (groupId: CleanupGroupId, isTicked: boolean) => void;
  readonly onConfirm: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const { button, empty, foot, groups } = description;
  const note = button.hint ?? foot;
  return (
    <>
      <div className="cleanup-body">
        {error !== null && (
          <p className="cleanup-error" role="alert">
            {error}
          </p>
        )}
        {empty !== null ? (
          <p className="cleanup-empty">{empty}</p>
        ) : (
          groups.map((group) => (
            <CleanupChoiceGroup
              key={group.id}
              group={group}
              onToggleRow={onToggleRow}
              onToggleGroup={onToggleGroup}
            />
          ))
        )}
      </div>
      <div className="cleanup-foot">
        {note !== null && (
          <p className={button.hint === null ? "cleanup-note" : "cleanup-note is-warning"}>
            {note}
          </p>
        )}
        <div className="cleanup-foot-buttons">
          <button
            type="button"
            className={empty === null ? "btn btn--quiet" : "btn"}
            onClick={onClose}
          >
            {empty === null ? "Cancel" : "Close"}
          </button>
          {empty === null && (
            <button
              type="button"
              className="btn btn--danger"
              aria-disabled={button.disabled || isStarting || undefined}
              title={button.hint ?? undefined}
              onClick={() => {
                if (!button.disabled && !isStarting) onConfirm();
              }}
            >
              {isStarting ? (
                <>
                  <span className="spin" aria-hidden="true" /> Archiving…
                </>
              ) : (
                button.label
              )}
            </button>
          )}
        </div>
      </div>
    </>
  );
}

/** Renders where one row of the progress stands, at the right end of the row. */
function CleanupRowOutcome({
  outcome,
  onRetry,
}: {
  readonly outcome: RemovalOutcome;
  readonly onRetry: () => void;
}): JSX.Element | null {
  if (outcome.kind === "removing") {
    return (
      <span className="cleanup-status">
        <span className="spin" aria-hidden="true" /> Removing…
      </span>
    );
  }
  if (outcome.kind === "removed") return <span className="cleanup-status">Removed</span>;
  return outcome.retry ? (
    <button type="button" className="btn btn--sm" onClick={onRetry}>
      Try again
    </button>
  ) : null;
}

/**
 * Renders the body and the foot of the dialog while workspaces are being
 * removed, and after: one line for each of `rows`, with its outcome. `result`
 * is the words of the result (such as "Archived 9 threads. Removed 4 of 6
 * workspaces."), drawn as a paragraph at the top of the body, under the
 * title, once every row has an outcome; else `null`. A refused row
 * shows its reason under the name and Try again, which calls `onRetry` with
 * the workspace's id, unless asking again cannot succeed. The Close button
 * takes the focus when the view appears and after a Try again, because the
 * button that had it is gone by then.
 */
export function CleanupProgressView({
  rows,
  outcomes,
  result,
  onRetry,
  onClose,
}: {
  readonly rows: readonly CleanupRow[];
  readonly outcomes: ReadonlyMap<string, RemovalOutcome>;
  readonly result: CleanupOutcomeWords | null;
  readonly onRetry: (workspaceId: string) => void;
  readonly onClose: () => void;
}): JSX.Element {
  const closeRef = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    closeRef.current?.focus();
  }, []);
  return (
    <>
      <div className="cleanup-body">
        {result !== null && (
          <p className="cleanup-result" role="status">
            {result.text}
          </p>
        )}
        <ul className="cleanup-rows cleanup-rows--progress">
          {rows.map((row) => {
            const outcome = outcomes.get(row.workspaceId) ?? { kind: "removing" as const };
            return (
              <li key={row.workspaceId} className="cleanup-row cleanup-result-row">
                <span className="cleanup-name">
                  <b>{row.name}</b>
                  {outcome.kind === "refused" && (
                    <span className="is-refusal">{outcome.message}</span>
                  )}
                </span>
                <CleanupRowOutcome
                  outcome={outcome}
                  onRetry={() => {
                    closeRef.current?.focus();
                    onRetry(row.workspaceId);
                  }}
                />
                <span className="cleanup-frees">{row.freesText ?? "-"}</span>
              </li>
            );
          })}
        </ul>
      </div>
      <div className="cleanup-foot">
        <div className="cleanup-foot-buttons">
          <button ref={closeRef} type="button" className="btn" onClick={onClose}>
            Close
          </button>
        </div>
      </div>
    </>
  );
}
