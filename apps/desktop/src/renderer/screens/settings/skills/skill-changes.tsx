/**
 * The parts of an update on a skill's page in Settings > Skills (spec 17
 * §Settings, Skills, Updates): the band that offers the update, and the card
 * of the files it changes.
 *
 * Every changed file gets its row, but a patch's lines are drawn in steps.
 * `skill.diff` keeps the patches of one revision under 1 MiB in total, yet
 * 1 MiB of short lines is hundreds of thousands of lines, and one element per
 * line would make the page slow to draw and heavy to hold. So the card draws
 * at most `PATCH_LINES_AT_FIRST` lines across all its files when it opens, at
 * most `PATCH_LINES_PER_STEP` of them per file, and each file whose patch is
 * not drawn whole ends with a button that draws its next
 * `PATCH_LINES_PER_STEP` lines.
 */
import { useState, type JSX, type ReactNode } from "react";
import {
  describeOmittedPatch,
  describeSkillFileChange,
  parseSkillPatch,
  type SkillPatch,
} from "@hercule/client-core";
import type { SkillFileChange } from "@hercule/contract";
import { DiffIcon } from "../../../icons/diff";
import "./skills.css";

/**
 * Renders the band over an update from the GitHub repository `repo`:
 * "Update available from mattpocock/skills. Nothing changes until you
 * update.", with `action`, the Update button, at its end.
 */
export function SkillUpdateBand({
  repo,
  action,
}: {
  readonly repo: string;
  readonly action: ReactNode;
}): JSX.Element {
  return (
    <div className="skill-band">
      <span>{`Update available from ${repo}. Nothing changes until you update.`}</span>
      {action}
    </div>
  );
}

/** The most lines of one file's patch drawn when the card opens, and the most each Show more draws. */
const PATCH_LINES_PER_STEP = 500;

/** The most patch lines the card draws, across all its files, when it opens. */
const PATCH_LINES_AT_FIRST = 2000;

/**
 * Returns how many lines of each of `patches` the card draws when it opens,
 * in the order given: each patch's lines up to `PATCH_LINES_PER_STEP`, until
 * the card's `PATCH_LINES_AT_FIRST` are used up. A null patch draws none.
 */
const countPatchLinesAtFirst = (
  patches: ReadonlyArray<SkillPatch | null>,
): ReadonlyArray<number> => {
  let linesLeft = PATCH_LINES_AT_FIRST;
  return patches.map((patch) => {
    const lines = Math.min(patch?.lines.length ?? 0, PATCH_LINES_PER_STEP, linesLeft);
    linesLeft -= lines;
    return lines;
  });
};

/**
 * Renders the card of the files a revision changes, `files` in the order
 * given: a head with the number of files and the lines added and removed in
 * all of them, then a row per file, and under a file with a patch, the patch
 * with each line coloured by what it is.
 *
 * A file's row has its path, "Executable" for an executable file, the kind of
 * change, and its own counts. A file whose patch was left out shows why in
 * place of the counts, and a file whose mode alone changed shows no counts.
 */
export function SkillFileChanges({
  files,
}: {
  readonly files: ReadonlyArray<SkillFileChange>;
}): JSX.Element {
  // A file whose mode alone changed has an empty patch, with no lines to show.
  const parsed = files.map((change) => ({
    change,
    patch: change.patch === null || change.patch === "" ? null : parseSkillPatch(change.patch),
  }));
  const linesAtFirst = countPatchLinesAtFirst(parsed.map(({ patch }) => patch));
  const added = parsed.reduce((sum, { patch }) => sum + (patch?.added ?? 0), 0);
  const removed = parsed.reduce((sum, { patch }) => sum + (patch?.removed ?? 0), 0);
  return (
    <div className="skill-card skill-changes">
      <div className="skill-changes-head">
        <DiffIcon size={16} />
        <span>{`${String(files.length)} changed ${files.length === 1 ? "file" : "files"}`}</span>
        <span className="skill-plus">{`+${String(added)}`}</span>
        <span className="skill-minus">{`-${String(removed)}`}</span>
      </div>
      {parsed.map(({ change, patch }, at) => (
        <div key={change.path}>
          <div className="skill-changes-row">
            <span className="skill-path">{change.path}</span>
            {change.change !== "modeChanged" && change.mode === "755" && (
              <span className="chip">Executable</span>
            )}
            <span className={`chip skill-change skill-change--${change.change}`}>
              {describeSkillFileChange(change)}
            </span>
            <span className="skill-spacer" />
            {change.patchOmitted !== null ? (
              <span className="skill-omitted">{describeOmittedPatch(change.patchOmitted)}</span>
            ) : (
              change.change !== "modeChanged" && (
                <>
                  <span className="skill-plus">{`+${String(patch?.added ?? 0)}`}</span>
                  <span className="skill-minus">{`-${String(patch?.removed ?? 0)}`}</span>
                </>
              )
            )}
          </div>
          {patch !== null && <PatchLines patch={patch} linesAtFirst={linesAtFirst[at] ?? 0} />}
        </div>
      ))}
    </div>
  );
}

/**
 * Renders the first `linesAtFirst` lines of `patch`, one per row, each with
 * the class of its kind. While lines are left, a button under them draws the
 * next `PATCH_LINES_PER_STEP`: "Show 500 more lines", or "Show 12 lines"
 * while none are drawn yet.
 */
function PatchLines({
  patch,
  linesAtFirst,
}: {
  readonly patch: SkillPatch;
  readonly linesAtFirst: number;
}): JSX.Element {
  const [drawn, setDrawn] = useState(linesAtFirst);
  const shown = Math.min(drawn, patch.lines.length);
  const next = Math.min(patch.lines.length - shown, PATCH_LINES_PER_STEP);
  // A patch line has no identity of its own, so its place is its key.
  return (
    <>
      {shown > 0 && (
        <pre className="skill-patch">
          {patch.lines.slice(0, shown).map((line, at) => (
            <span key={at} className={line.kind === "context" ? undefined : `is-${line.kind}`}>
              {`${line.text}\n`}
            </span>
          ))}
        </pre>
      )}
      {next > 0 && (
        <div className={shown > 0 ? "skill-patch-more" : "skill-patch-more is-alone"}>
          <button
            type="button"
            className="btn btn--quiet btn--sm"
            onClick={() => setDrawn(shown + PATCH_LINES_PER_STEP)}
          >
            {`Show ${String(next)} ${shown > 0 ? "more " : ""}${next === 1 ? "line" : "lines"}`}
          </button>
        </div>
      )}
    </>
  );
}
