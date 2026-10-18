/**
 * PROTOTYPE (#731). The import dialog, in the four steps spec 17 gives it:
 * - `picked`: one row per skill folder `skillFolders.pick` found, each
 *   checked, with its source under its name. Nothing is known yet about
 *   what importing it will do: main checks no content rule.
 * - `running`: the checked skills import one at a time, and a refusal
 *   shows under its row as soon as it comes back, from main's
 *   `skillArchive.build` or from the controller.
 * - `conflict`: once every skill has run, the skills that exist with
 *   different content wait for the user's confirmation.
 * - `done`: the summary, with the refusals still under their rows.
 * Nothing is sent in the prototype; each button moves to the next step.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { GlassDialog } from "../../screens/glass-dialog";
import { PICKED_FOLDER, PICKED_SKILLS, readImportResult, type PickedSkill } from "./fixture";
import { describeSource } from "./format";

/** The step of the import the dialog shows. */
export type ImportStep = "picked" | "running" | "conflict" | "done";

/** How many skills have run in the `running` step: the 21st, `to-spec`, is running. */
const RUNNING_AT = 20;

const CONFLICTS = PICKED_SKILLS.filter(({ name }) => readImportResult(name).kind === "conflict");

const FIRST_REFUSED = PICKED_SKILLS.find(
  ({ name }) => readImportResult(name).kind === "refused",
)?.name;

/** Returns the reason importing `skill` was refused, or `null` when it was not. */
const findRefusal = (skill: PickedSkill): string | null => {
  const result = readImportResult(skill.name);
  return result.kind === "refused" ? result.reason : null;
};

/**
 * Returns the summary the `done` step shows, counting the skills that
 * exist with different content as imported, because the user confirmed
 * them.
 */
const describeSummary = (): string => {
  const kinds = PICKED_SKILLS.map(({ name }) => readImportResult(name).kind);
  const count = (wanted: ReadonlyArray<string>): number =>
    kinds.filter((kind) => wanted.includes(kind)).length;
  return `Imported ${count(["imported", "conflict"])}, ${count(["unchanged"])} unchanged, ${count(["refused"])} refused`;
};

/**
 * Renders the import dialog for the folder the user picked, starting at
 * step `initialStep`. The step's main button has the focus when the
 * dialog opens.
 */
export function ImportDialog({
  initialStep,
  onClose,
}: {
  readonly initialStep: ImportStep;
  readonly onClose: () => void;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [step, setStep] = useState(initialStep);
  const close = (): void => dialogRef.current?.close();
  // Runs after the dialog has opened, which happens in a child's effect.
  // Opening focuses the first control, the list, which scrolls, and rings
  // the whole list, so the step's main button takes the focus instead. The
  // running step has no button and focuses nothing.
  useEffect(() => {
    const dialog = dialogRef.current;
    if (dialog === null) return;
    const action = dialog.querySelector<HTMLElement>("[data-autofocus]");
    if (action === null) (document.activeElement as HTMLElement | null)?.blur();
    else action.focus();
    const row = dialog.querySelector<HTMLElement>("[data-scroll-to]");
    const list = row?.parentElement;
    if (row == null || list == null) return;
    // The list scrolls itself, not the page behind the dialog.
    const top = row.offsetTop - list.offsetTop;
    list.scrollTop =
      row.dataset.scrollTo === "end" ? top - list.clientHeight + row.offsetHeight + 6 : top - 6;
  }, [step]);
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="skill-import"
      label={`Import from ${PICKED_FOLDER}`}
      onClose={onClose}
    >
      <div className="pop-h">
        <b>
          Import from <code>{PICKED_FOLDER}</code>
        </b>
        <span>{`${PICKED_SKILLS.length} skills`}</span>
      </div>
      {step === "conflict" ? (
        <ConflictStep onDone={() => setStep("done")} />
      ) : (
        <SkillsStep key={step} step={step} onImport={() => setStep("conflict")} onClose={close} />
      )}
    </GlassDialog>
  );
}

/**
 * Renders the list of skill folders and the foot for the `picked`,
 * `running` and `done` steps. In `running` the list is scrolled to show
 * the row being imported at its foot; in `done`, the first refusal at its
 * top.
 */
function SkillsStep({
  step,
  onImport,
  onClose,
}: {
  readonly step: Exclude<ImportStep, "conflict">;
  readonly onImport: () => void;
  readonly onClose: () => void;
}): JSX.Element {
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(PICKED_SKILLS.map((each) => each.name)),
  );
  const ran = step === "running" ? RUNNING_AT : step === "done" ? PICKED_SKILLS.length : 0;
  const toggle = (name: string): void => {
    const next = new Set(picked);
    if (!next.delete(name)) next.add(name);
    setPicked(next);
  };
  return (
    <>
      <div className="pop-sec skill-import-list">
        {PICKED_SKILLS.map((skill, at) => {
          const refusal = at < ran ? findRefusal(skill) : null;
          const scrollTo =
            step === "running" && at === RUNNING_AT
              ? "end"
              : step === "done" && skill.name === FIRST_REFUSED
                ? "start"
                : undefined;
          return (
            <label
              key={skill.name}
              className={refusal === null ? "skill-import-row" : "skill-import-row is-refused"}
              data-scroll-to={scrollTo}
            >
              <span className="choice-box">
                <input
                  type="checkbox"
                  checked={picked.has(skill.name)}
                  disabled={step !== "picked"}
                  onChange={() => toggle(skill.name)}
                />
                <CheckIcon size={12} />
              </span>
              <span className="skill-import-name">
                <b>{skill.name}</b>
                <small>
                  {refusal === null ? describeSource(skill.source) : renderInlineCode(refusal)}
                </small>
              </span>
            </label>
          );
        })}
      </div>
      <div className="skill-import-foot">
        {step === "picked" && (
          <>
            <span className="time">{`${picked.size} of ${PICKED_SKILLS.length} selected`}</span>
            <button type="button" className="btn btn--quiet" onClick={onClose}>
              Cancel
            </button>
            <button
              type="button"
              className="btn btn--accent"
              aria-disabled={picked.size === 0}
              data-autofocus
              onClick={onImport}
            >
              {`Import ${picked.size}`}
            </button>
          </>
        )}
        {step === "running" && (
          <span className="time">{`Importing ${RUNNING_AT + 1} of ${PICKED_SKILLS.length}`}</span>
        )}
        {step === "done" && (
          <>
            <span className="time">{describeSummary()}</span>
            <button type="button" className="btn btn--accent" data-autofocus onClick={onClose}>
              Done
            </button>
          </>
        )}
      </div>
    </>
  );
}

/**
 * Renders the confirmation for the skills that exist with different
 * content, each checked. Importing them makes the folder's content their
 * current revision; it never makes a second skill. Skip leaves them as
 * they are.
 */
function ConflictStep({ onDone }: { readonly onDone: () => void }): JSX.Element {
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(CONFLICTS.map((each) => each.name)),
  );
  const toggle = (name: string): void => {
    const next = new Set(picked);
    if (!next.delete(name)) next.add(name);
    setPicked(next);
  };
  return (
    <>
      <div className="pop-sec skill-import-list">
        {CONFLICTS.map((skill) => (
          <label key={skill.name} className="skill-import-row">
            <span className="choice-box">
              <input
                type="checkbox"
                checked={picked.has(skill.name)}
                onChange={() => toggle(skill.name)}
              />
              <CheckIcon size={12} />
            </span>
            <span className="skill-import-name">
              <span>
                <code>{skill.name}</code> exists with different content.
              </span>
            </span>
          </label>
        ))}
      </div>
      <div className="skill-import-foot">
        <button type="button" className="btn btn--quiet" onClick={onDone}>
          Skip
        </button>
        <button
          type="button"
          className="btn btn--accent"
          aria-disabled={picked.size === 0}
          data-autofocus
          onClick={onDone}
        >
          Import as new revisions
        </button>
      </div>
    </>
  );
}

/** Renders `text` with each word between backticks drawn as code. */
function renderInlineCode(text: string): ReactNode {
  // Splitting at the backticks puts the code at the odd places.
  return text.split("`").map((part, at) => (at % 2 === 1 ? <code key={at}>{part}</code> : part));
}
