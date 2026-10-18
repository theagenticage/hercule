/**
 * PROTOTYPE (#731). The import sheet: what picking `~/.agents/skills`
 * finds, one row per skill folder, each with a checkbox, its source from
 * `.skill-lock.json`, its file count and size, and what importing it would
 * do. Import does nothing in the prototype but close the sheet.
 */
import { useEffect, useRef, useState, type JSX, type ReactNode } from "react";
import { CheckIcon } from "../../icons/check";
import { GlassDialog } from "../../screens/glass-dialog";
import { IMPORT_CANDIDATES, type ImportCandidate } from "./fixture";
import { describeFiles, describeSource } from "./format";

/** Checks whether importing `candidate` would change the library, so its box can be ticked. */
const canImport = ({ outcome }: ImportCandidate): boolean =>
  outcome === "new" || outcome === "different";

/**
 * Renders the import sheet for the folder the user picked. Every skill that
 * importing would change starts ticked. A skill that is already in Skills
 * with the same content, or that breaks a content rule, cannot be ticked,
 * and its row says why. Import reads the number of ticked skills, and has
 * the focus when the sheet opens.
 */
export function ImportDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const importRef = useRef<HTMLButtonElement>(null);
  // The browser would focus the first control, the list, which scrolls, and
  // draw its ring around the whole list. Import is what the sheet is for.
  useEffect(() => {
    importRef.current?.focus();
  }, []);
  const [picked, setPicked] = useState<ReadonlySet<string>>(
    () => new Set(IMPORT_CANDIDATES.filter(canImport).map((each) => each.name)),
  );
  const toggle = (name: string): void => {
    const next = new Set(picked);
    if (!next.delete(name)) next.add(name);
    setPicked(next);
  };
  return (
    <GlassDialog
      dialogRef={dialogRef}
      className="skill-import"
      label="Import from skills"
      onClose={onClose}
    >
      <div className="pop-h">
        <b>Import from skills</b>
        <span>{`~/.agents/skills · ${IMPORT_CANDIDATES.length} skills`}</span>
      </div>
      <div className="pop-sec skill-import-list">
        {IMPORT_CANDIDATES.map((candidate) => (
          <label
            key={candidate.name}
            className={`skill-import-row is-${candidate.outcome}`}
            title={candidate.problem}
          >
            <span className="choice-box">
              <input
                type="checkbox"
                checked={picked.has(candidate.name)}
                disabled={!canImport(candidate)}
                onChange={() => toggle(candidate.name)}
              />
              <CheckIcon size={12} />
            </span>
            <span className="skill-import-name">
              <b>{candidate.name}</b>
              <small>{describeOutcome(candidate)}</small>
            </span>
            <span className="skill-size">
              {describeFiles(candidate.fileCount, candidate.totalBytes)}
            </span>
          </label>
        ))}
      </div>
      <div className="skill-import-foot">
        <span className="time">{`${picked.size} of ${IMPORT_CANDIDATES.length} selected`}</span>
        <button type="button" className="btn btn--quiet" onClick={() => dialogRef.current?.close()}>
          Cancel
        </button>
        <button
          ref={importRef}
          type="button"
          className="btn btn--accent"
          aria-disabled={picked.size === 0}
          onClick={() => dialogRef.current?.close()}
        >
          {`Import ${picked.size}`}
        </button>
      </div>
    </GlassDialog>
  );
}

/**
 * Returns the line under a candidate's name: where it comes from, and for a
 * skill that is not new, what importing it would do or why it cannot be
 * imported.
 */
function describeOutcome(candidate: ImportCandidate): ReactNode {
  switch (candidate.outcome) {
    case "new":
      return describeSource(candidate.source);
    case "different":
      return "Exists with different content - importing adds a new revision";
    case "unchanged":
      return "Already in Skills";
    case "refused":
      return renderInlineCode(candidate.problem ?? "");
  }
}

/** Renders `text` with each word between backticks drawn as code. */
function renderInlineCode(text: string): ReactNode {
  // Splitting at the backticks puts the code at the odd places.
  return text.split("`").map((part, at) => (at % 2 === 1 ? <code key={at}>{part}</code> : part));
}
