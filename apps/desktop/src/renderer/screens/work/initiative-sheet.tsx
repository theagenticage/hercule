import {
  useEffect,
  useId,
  useRef,
  useState,
  type FormEvent,
  type JSX,
  type KeyboardEvent,
} from "react";
import { readErrorMessage } from "@hercule/client-core";
import { INITIATIVE_HUE_NAMES, type InitiativeDraft } from "@hercule/client-core/work";
import { INITIATIVE_HUES } from "@hercule/contract";
import { HueFlag, SideSheet } from "../desk";
import "./initiative-sheet.css";

/** A Project the Initiative can draw in the lane of. */
export interface InitiativeSheetProject {
  readonly id: string;
  readonly name: string;
}

/** The Initiative the sheet edits: what its foot and its title need to say. */
export interface InitiativeSheetSubject {
  readonly name: string;
  readonly isClosed: boolean;
}

/** Returns whether the two drafts hold the same values. */
const isSameDraft = (a: InitiativeDraft, b: InitiativeDraft): boolean =>
  a.name === b.name &&
  a.intent === b.intent &&
  a.target === b.target &&
  a.targetDay === b.targetDay &&
  a.projectId === b.projectId &&
  a.hue === b.hue;

/** How far each arrow key moves the choice of colour. */
const ARROW_STEPS: Readonly<Record<string, number>> = {
  ArrowRight: 1,
  ArrowDown: 1,
  ArrowLeft: -1,
  ArrowUp: -1,
};

/**
 * Returns the index of the swatch that `key` moves to from the swatch `at`, as
 * a radio group does: the arrows go around, Home and End go to the ends.
 * Returns `undefined` for any other key.
 */
const readSwatchTarget = (key: string, at: number): number | undefined => {
  const count = INITIATIVE_HUES.length;
  if (key === "Home") return 0;
  if (key === "End") return count - 1;
  const step = ARROW_STEPS[key];
  return step === undefined ? undefined : (at + step + count) % count;
};

/**
 * Renders the sheet that creates an Initiative or edits one, at the right of
 * the board, on the shared side sheet. Its fields are Name, Intent, Target,
 * Target date, Project and Colour (twelve flags, one is chosen).
 *
 * - `initial` is what the fields hold on opening. The sheet keeps its own
 *   copy while it is open, so a read that arrives meanwhile never overwrites
 *   what the user typed. Give the sheet a new `key` to open it on other values.
 * - `subject` is the Initiative being edited, or `null` for a new one. It
 *   titles the sheet and adds the Close and Delete parts to the foot.
 * - `onSave` gets the fields as they are, untrimmed. It resolves when saved,
 *   after which the caller takes the sheet away. When it rejects, the foot
 *   line shows the error's message and the fields stay as they are.
 *   `onCloseInitiative`, `onReopenInitiative` and `onDelete` work the same
 *   way. Deleting asks to be confirmed first, in words, in the foot: the
 *   Delete button gives way to a "Delete initiative" button at the other end
 *   of the foot, so a double click on Delete never confirms it. Focus goes to
 *   Cancel, so a held Return does not confirm it either.
 * - `onDismiss` is called by the Close button of the sheet and by Esc.
 *
 * Name has the focus on opening, and Return in any text field saves. Esc steps
 * back one thing at a time: it takes back a delete that was asked for, then
 * puts the fields back to what they were on opening, then dismisses the sheet.
 * While a request runs, the foot's buttons do nothing.
 */
export function InitiativeSheet({
  initial,
  projects,
  subject,
  onSave,
  onCloseInitiative,
  onReopenInitiative,
  onDelete,
  onDismiss,
}: {
  readonly initial: InitiativeDraft;
  readonly projects: readonly InitiativeSheetProject[];
  readonly subject: InitiativeSheetSubject | null;
  readonly onSave: (draft: InitiativeDraft) => Promise<void>;
  readonly onCloseInitiative: () => Promise<void>;
  readonly onReopenInitiative: () => Promise<void>;
  readonly onDelete: () => Promise<void>;
  readonly onDismiss: () => void;
}): JSX.Element {
  const [draft, setDraft] = useState(initial);
  const [isBusy, setIsBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [isConfirmingDelete, setIsConfirmingDelete] = useState(false);
  const nameRef = useRef<HTMLInputElement>(null);
  const swatchesRef = useRef<HTMLDivElement>(null);
  const cancelDeleteRef = useRef<HTMLButtonElement>(null);
  const ids = useId();
  const labelOf = (field: string): string => `${ids}-${field}`;

  useEffect(() => {
    nameRef.current?.focus({ preventScroll: true });
  }, []);

  useEffect(() => {
    if (isConfirmingDelete) cancelDeleteRef.current?.focus({ preventScroll: true });
  }, [isConfirmingDelete]);

  const change = (patch: Partial<InitiativeDraft>): void => {
    setDraft((before) => ({ ...before, ...patch }));
  };

  /** Runs a request of the foot: one at a time, with its error shown in the foot line. */
  const run = (request: () => Promise<void>): void => {
    if (isBusy) return;
    setIsBusy(true);
    setError(null);
    void request()
      .catch((failure: unknown) => {
        setError(readErrorMessage(failure));
      })
      .finally(() => {
        setIsBusy(false);
      });
  };

  const canSave = draft.name.trim() !== "";

  const handleSubmit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    if (!canSave || isConfirmingDelete) return;
    run(() => onSave(draft));
  };

  const handleKeyDown = (event: KeyboardEvent<HTMLFormElement>): void => {
    if (event.key !== "Escape") return;
    event.stopPropagation();
    if (isConfirmingDelete) {
      setIsConfirmingDelete(false);
    } else if (!isSameDraft(draft, initial)) {
      setDraft(initial);
      nameRef.current?.focus({ preventScroll: true });
    } else {
      onDismiss();
    }
  };

  /** Moves the choice of colour, and the focus with it, the way arrow keys do in a radio group. */
  const handleSwatchKeyDown = (event: KeyboardEvent<HTMLButtonElement>, at: number): void => {
    const target = readSwatchTarget(event.key, at);
    if (target === undefined) return;
    event.preventDefault();
    change({ hue: INITIATIVE_HUES[target] ?? draft.hue });
    swatchesRef.current?.querySelectorAll<HTMLElement>('[role="radio"]')[target]?.focus();
  };

  return (
    <SideSheet title={subject?.name ?? "New initiative"} onClose={onDismiss}>
      <form className="initiative-sheet" onSubmit={handleSubmit} onKeyDown={handleKeyDown}>
        <div className="initiative-sheet-body">
          <div className="initiative-field">
            <label htmlFor={labelOf("name")}>Name</label>
            <span className="field initiative-name">
              <input
                ref={nameRef}
                id={labelOf("name")}
                value={draft.name}
                autoComplete="off"
                onChange={(event) => {
                  change({ name: event.target.value });
                }}
              />
              <kbd aria-hidden>↩</kbd>
            </span>
          </div>
          <div className="initiative-field">
            <label htmlFor={labelOf("intent")}>Intent</label>
            <textarea
              id={labelOf("intent")}
              className="field initiative-intent"
              value={draft.intent}
              placeholder="What this is for"
              onChange={(event) => {
                change({ intent: event.target.value });
              }}
            />
          </div>
          <div className="initiative-field">
            <label htmlFor={labelOf("target")}>Target</label>
            <span className="field">
              <input
                id={labelOf("target")}
                value={draft.target}
                placeholder="What finished looks like"
                autoComplete="off"
                onChange={(event) => {
                  change({ target: event.target.value });
                }}
              />
            </span>
          </div>
          <div className="initiative-field">
            <label htmlFor={labelOf("target-date")}>Target date</label>
            <span className="field">
              <input
                id={labelOf("target-date")}
                type="date"
                value={draft.targetDay}
                onChange={(event) => {
                  change({ targetDay: event.target.value });
                }}
              />
            </span>
          </div>
          <div className="initiative-field">
            <label htmlFor={labelOf("project")}>Project</label>
            <span className="field field--select">
              <select
                id={labelOf("project")}
                value={draft.projectId ?? ""}
                onChange={(event) => {
                  change({ projectId: event.target.value === "" ? null : event.target.value });
                }}
              >
                <option value="">No project</option>
                {projects.map((project) => (
                  <option key={project.id} value={project.id}>
                    {project.name}
                  </option>
                ))}
              </select>
            </span>
          </div>
          <div className="initiative-field">
            <span id={labelOf("colour")} className="initiative-label">
              Colour
            </span>
            <div
              ref={swatchesRef}
              className="initiative-swatches"
              role="radiogroup"
              aria-labelledby={labelOf("colour")}
            >
              {INITIATIVE_HUES.map((hue, at) => (
                <button
                  key={hue}
                  type="button"
                  role="radio"
                  aria-checked={hue === draft.hue}
                  aria-label={INITIATIVE_HUE_NAMES[hue]}
                  title={INITIATIVE_HUE_NAMES[hue]}
                  tabIndex={hue === draft.hue ? 0 : -1}
                  className="initiative-swatch"
                  onClick={() => {
                    change({ hue });
                  }}
                  onKeyDown={(event) => {
                    handleSwatchKeyDown(event, at);
                  }}
                >
                  <HueFlag hue={hue} size={16} />
                </button>
              ))}
            </div>
          </div>
        </div>
        <footer className="initiative-sheet-foot">
          {isConfirmingDelete && subject !== null && (
            <p className="initiative-sheet-line" role="alert">
              {`Delete ${subject.name}? Its Tasks stay, and leave it. This cannot be undone.`}
            </p>
          )}
          {error !== null && (
            <p className="initiative-sheet-line initiative-sheet-line--error" role="alert">
              {error}
            </p>
          )}
          <div className="initiative-sheet-actions">
            {isConfirmingDelete ? (
              <>
                <button
                  type="button"
                  className="btn btn--danger"
                  aria-disabled={isBusy}
                  onClick={() => {
                    run(onDelete);
                  }}
                >
                  Delete initiative
                </button>
                <button
                  ref={cancelDeleteRef}
                  type="button"
                  className="btn btn--quiet"
                  onClick={() => {
                    setIsConfirmingDelete(false);
                  }}
                >
                  Cancel
                </button>
              </>
            ) : (
              <>
                <button
                  type="submit"
                  className="btn btn--accent"
                  disabled={!canSave}
                  aria-disabled={isBusy}
                >
                  {subject === null ? "Create initiative" : "Save"}
                </button>
                {subject !== null && (
                  <button
                    type="button"
                    className="btn btn--quiet"
                    aria-disabled={isBusy}
                    onClick={() => {
                      run(subject.isClosed ? onReopenInitiative : onCloseInitiative);
                    }}
                  >
                    {subject.isClosed ? "Reopen" : "Close initiative"}
                  </button>
                )}
                {subject !== null && (
                  <button
                    type="button"
                    className="btn btn--quiet btn--danger initiative-sheet-end"
                    aria-disabled={isBusy}
                    onClick={() => {
                      setError(null);
                      setIsConfirmingDelete(true);
                    }}
                  >
                    Delete
                  </button>
                )}
              </>
            )}
          </div>
        </footer>
      </form>
    </SideSheet>
  );
}
