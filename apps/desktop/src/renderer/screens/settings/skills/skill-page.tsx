/**
 * The sections of a skill's page in Settings > Skills (spec 17 §Settings,
 * Skills): the lead, `SKILL.md`, Files and History. The route places them,
 * with the Delete section it owns, inside a `.skill-record`.
 *
 * Files and History are drawn whole: a skill holds at most 1000 files, and a
 * History grows by one row per import or applied update.
 */
import type { JSX } from "react";
import {
  describeSkillRevisionApplied,
  describeSkillRevisionOrigin,
  describeSkillSourceInFull,
  formatBytes,
  formatSkillSize,
  isExecutableSkillFile,
  listSkillApprovalEffectLines,
  stripFrontmatter,
  type SkillApprovalEffectWording,
} from "@hercule/client-core";
import type {
  Skill,
  SkillApprovalEffects,
  SkillFileRecord,
  SkillRevision,
} from "@hercule/contract";
import { GlobeIcon } from "../../../icons/globe";
import { ActorMark } from "../../actor/actor-mark";
import { InlineCode } from "../../inline-code";
import { Markdown } from "../../session/markdown";
import "../../session/messages.css";
import "../permission-profiles/permission-profiles.css";
import "./skills.css";

/** The size of the applier's mark in a History row, in CSS pixels. */
const APPLIER_MARK_SIZE = 18;

/** How many characters of a revision's hash a History row shows. */
const SHORT_HASH_LENGTH = 7;

/**
 * Renders the head of the page: `description`, the current revision's, as
 * the lead, then two chips, the skill's source in full and its size, then a
 * warning line for each approval effect of the current revision. Each
 * effect lets tools run without the approval card on Claude Code, so the
 * user sees what the skill does after an import has applied it.
 *
 * While the skill's last update check failed, a last line in `--fail` says
 * so with the check's error: "Last check failed: …".
 */
export function SkillLead({
  skill,
  description,
}: {
  readonly skill: Skill;
  readonly description: string;
}): JSX.Element {
  return (
    <div className="skill-lead">
      <p className="profile-lead">{description}</p>
      <div className="skill-chips">
        <span className="chip">
          {skill.source.kind === "github" && <GlobeIcon size={13} />}
          {describeSkillSourceInFull(skill.source)}
        </span>
        {skill.currentFileCount !== null && skill.currentSizeBytes !== null && (
          <span className="chip">
            {formatSkillSize(skill.currentFileCount, skill.currentSizeBytes)}
          </span>
        )}
      </div>
      <SkillApprovalWarnings effects={skill.currentApprovalEffects} wording="current" />
      {skill.checkError !== null && (
        <p className="profile-note skill-warning skill-warning--fail">
          Last check failed: <InlineCode text={skill.checkError} />
        </p>
      )}
    </div>
  );
}

/**
 * Renders a warning line for each field of `effects`, a revision's approval
 * effects, worded for `wording` (`listSkillApprovalEffectLines`): the text,
 * then each `allowed-tools` rule as code. Renders nothing for null effects
 * or effects with neither field.
 */
export function SkillApprovalWarnings({
  effects,
  wording,
}: {
  readonly effects: SkillApprovalEffects | null;
  readonly wording: SkillApprovalEffectWording;
}): JSX.Element {
  // The lines never change order while drawn, and a rule may repeat, so a
  // line's or a rule's place is its key.
  return (
    <>
      {listSkillApprovalEffectLines(effects, wording).map(({ text, tools }, line) => (
        <p key={line} className="profile-note skill-warning">
          {text}
          {tools.length > 0 && " "}
          {tools.map((tool, at) => (
            <code key={at}>{tool}</code>
          ))}
        </p>
      ))}
    </>
  );
}

/**
 * Renders the section of the current revision's `SKILL.md`, `sizeBytes`
 * long, `text` without its frontmatter, which the lead already shows the
 * description of. A relative link, such as one to `reference.md`, is drawn
 * as its text, because the page cannot open the skill's other files.
 */
export function SkillMdSection({
  text,
  sizeBytes,
}: {
  readonly text: string;
  readonly sizeBytes: number;
}): JSX.Element {
  return (
    <section className="set-sec">
      <h2>
        SKILL.md
        <small>{formatBytes(sizeBytes)}</small>
      </h2>
      <div className="skill-card">
        <div className="msg-body skill-md-body">
          <Markdown text={stripFrontmatter(text)} relativeLinksAsText />
        </div>
      </div>
    </section>
  );
}

/**
 * Renders `files`, the current revision's files, in the order given, each
 * with its path, its size and a mark when it is executable. The heading
 * shows `fileCount` and `sizeBytes`, the current revision's file count and
 * total size.
 */
export function SkillFilesSection({
  files,
  fileCount,
  sizeBytes,
}: {
  readonly files: ReadonlyArray<SkillFileRecord>;
  readonly fileCount: number;
  readonly sizeBytes: number;
}): JSX.Element {
  return (
    <section className="set-sec">
      <h2>
        Files
        <small>{formatSkillSize(fileCount, sizeBytes)}</small>
      </h2>
      <div>
        {files.map((file) => (
          <div key={file.path} className="skill-file">
            <span className="skill-path">{file.path}</span>
            {isExecutableSkillFile(file) && <span className="chip">Executable</span>}
            <span className="skill-size">{formatBytes(file.sizeBytes)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Renders the History: one row per revision of `history` that has been
 * current, in the order given, newest first. Each row has who applied it,
 * how it arrived, and when, as `now` in `timezone` puts it, and the first
 * characters of its hash. The current revision, `currentRevisionHash`, has
 * the chip "Current".
 *
 * `now` is the moment the skill was read, not the moment the page draws, so
 * a time is placed against a moment that changes only when the skill is
 * read again. There is no timer: the section does no work while idle.
 */
export function SkillHistorySection({
  history,
  currentRevisionHash,
  now,
  timezone,
}: {
  readonly history: ReadonlyArray<SkillRevision>;
  readonly currentRevisionHash: string | null;
  readonly now: Date;
  readonly timezone: string;
}): JSX.Element {
  return (
    <section className="set-sec">
      <h2>History</h2>
      <div>
        {history.map((revision) => (
          <div key={revision.revisionHash} className="skill-rev">
            {revision.appliedBy !== null && (
              <ActorMark actor={revision.appliedBy} size={APPLIER_MARK_SIZE} />
            )}
            <span className="skill-rev-text">
              <b>{describeSkillRevisionOrigin(revision.origin)}</b>
              <span>{describeSkillRevisionApplied(revision, now, timezone)}</span>
            </span>
            {revision.revisionHash === currentRevisionHash && <span className="chip">Current</span>}
            <code className="skill-rev-hash">
              {revision.revisionHash.slice(0, SHORT_HASH_LENGTH)}
            </code>
          </div>
        ))}
      </div>
    </section>
  );
}
