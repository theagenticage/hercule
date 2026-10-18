/**
 * PROTOTYPE (#731). The card that shows how a pending revision differs from
 * the current one: the book's `.card.files` from a Thread's changed files,
 * one row per file, and the unified diff of a file under its row.
 */
import type { JSX } from "react";
import { DiffIcon } from "../../icons/diff";
import type { FileChange } from "./fixture";

/** The chip each kind of change shows beside its path. */
const CHANGE_LABEL: Readonly<Record<FileChange["change"], string>> = {
  added: "Added",
  removed: "Removed",
  modified: "Modified",
};

/**
 * Renders the changed files of a pending revision: a head with the number
 * of files and the lines added and removed, then a row per file, and under
 * a file that carries a patch, its unified diff with each line coloured by
 * whether it is added, removed or context.
 */
export function FileChanges({
  changes,
}: {
  readonly changes: ReadonlyArray<FileChange>;
}): JSX.Element {
  const added = changes.reduce((sum, each) => sum + each.added, 0);
  const removed = changes.reduce((sum, each) => sum + each.removed, 0);
  return (
    <div className="skill-card skill-changes">
      <div className="skill-changes-head">
        <DiffIcon size={16} />
        <span>{`${changes.length} changed ${changes.length === 1 ? "file" : "files"}`}</span>
        <span className="skill-plus">{`+${added}`}</span>
        <span className="skill-minus">{`-${removed}`}</span>
      </div>
      {changes.map((change) => (
        <div key={change.path}>
          <div className="skill-changes-row">
            <span className="skill-path">{change.path}</span>
            {change.executable === true && <span className="chip">Executable</span>}
            <span className={`chip skill-change skill-change--${change.change}`}>
              {CHANGE_LABEL[change.change]}
            </span>
            <span className="skill-spacer" />
            <span className="skill-plus">{`+${change.added}`}</span>
            <span className="skill-minus">{`-${change.removed}`}</span>
          </div>
          {change.patch !== undefined && <Patch text={change.patch} />}
        </div>
      ))}
    </div>
  );
}

/** Returns the class of one line of a unified diff: a hunk header, an added or removed line, or context. */
const classifyPatchLine = (line: string): string | undefined => {
  if (line.startsWith("@@")) return "is-hunk";
  if (line.startsWith("+")) return "is-add";
  if (line.startsWith("-")) return "is-del";
  return undefined;
};

/** Renders a unified diff, one line per row, coloured by `classifyPatchLine`. */
function Patch({ text }: { readonly text: string }): JSX.Element {
  // A diff's lines never change while the card is drawn, so a line's place is its key.
  return (
    <pre className="skill-patch">
      {text.split("\n").map((line, at) => (
        <span key={at} className={classifyPatchLine(line)}>
          {`${line}\n`}
        </span>
      ))}
    </pre>
  );
}
