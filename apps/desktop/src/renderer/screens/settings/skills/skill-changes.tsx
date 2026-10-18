/**
 * The parts of an update on a skill's page in Settings > Skills (spec 17
 * §Settings, Skills, Updates): the band that offers the update, the warning
 * lines for what the update lets run without asking, and the card of the
 * files it changes.
 *
 * Every changed file is drawn whole, with its patch: `skill.diff` keeps the
 * patches of one revision under 1 MiB in total, and leaves out any patch
 * past that.
 */
import type { JSX, ReactNode } from "react";
import {
  describeOmittedPatch,
  describeSkillFileChange,
  parseSkillPatch,
  splitAllowedTools,
  SKILL_UPDATE_ALLOWED_TOOLS_WARNING,
  SKILL_UPDATE_HOOKS_WARNING,
  type SkillPatch,
} from "@hercule/client-core";
import type { SkillApprovalEffects, SkillFileChange } from "@hercule/contract";
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

/**
 * Renders a warning line for each field of `effects`, the update's approval
 * effects: "After the update, lets tools run without asking:" with each
 * `allowed-tools` rule as code, and a line for `hooks`. Renders nothing for
 * null effects.
 */
export function SkillUpdateWarnings({
  effects,
}: {
  readonly effects: SkillApprovalEffects | null;
}): JSX.Element | null {
  if (effects === null) return null;
  return (
    <>
      {effects.allowedTools !== null && (
        <p className="profile-note skill-warning">
          {SKILL_UPDATE_ALLOWED_TOOLS_WARNING}{" "}
          {splitAllowedTools(effects.allowedTools).map((tool) => (
            <code key={tool}>{tool}</code>
          ))}
        </p>
      )}
      {effects.hooks !== null && (
        <p className="profile-note skill-warning">{SKILL_UPDATE_HOOKS_WARNING}</p>
      )}
    </>
  );
}

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
      {parsed.map(({ change, patch }) => (
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
          {patch !== null && <PatchLines patch={patch} />}
        </div>
      ))}
    </div>
  );
}

/** Renders the lines of `patch`, one per row, each with the class of its kind. */
function PatchLines({ patch }: { readonly patch: SkillPatch }): JSX.Element {
  // A patch's lines never change while the card is drawn, so a line's place is its key.
  return (
    <pre className="skill-patch">
      {patch.lines.map((line, at) => (
        <span key={at} className={line.kind === "context" ? undefined : `is-${line.kind}`}>
          {`${line.text}\n`}
        </span>
      ))}
    </pre>
  );
}
