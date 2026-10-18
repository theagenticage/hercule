import type { JSX } from "react";
import { Link } from "@tanstack/react-router";
import { describeSkillSource, formatSkillSize } from "@hercule/client-core";
import { BUILT_IN_SKILL_NAME, type Skill } from "@hercule/contract";
import { ChevronRightIcon } from "../../../icons/chevron-right";
import { SkillIcon } from "../../../icons/skill";
import "../permission-profiles/permission-profiles.css";
import "./skills.css";

/**
 * Renders the Skill Library's list (spec 17 §Settings, Skills): the lead, the
 * banner that says no Thread uses the library yet, and a table whose first
 * row is the built-in `hercule` skill, then one row per skill of `skills`, in
 * the order given. Each skill's row shows its source and size, and links to
 * its page. The built-in row has no page, so it is not a link.
 *
 * With no skill in `skills`, the empty block follows the built-in row, with
 * a button that calls `onImport`.
 *
 * The list is drawn whole. The library holds at most `MAX_SKILLS` (256)
 * skills, so every row is drawn, as on Permission profiles.
 */
export function SkillList({
  skills,
  onImport,
}: {
  readonly skills: ReadonlyArray<Skill>;
  readonly onImport: () => void;
}): JSX.Element {
  return (
    <div className="skill-list">
      <p className="profile-lead">
        A skill is a folder of instructions, led by its <code>SKILL.md</code>, that an agent loads
        when a task calls for it. The library keeps one copy of each, for every runner.
      </p>
      <p className="skill-banner">Threads don&apos;t use the library yet.</p>
      <section aria-label="Skills">
        <div className="set-table-head skill-list-head">
          <span />
          <span>Skill</span>
          <span />
          <span>Size</span>
          <span />
        </div>
        <div className="set-table-row skill-row">
          <span className="profile-mark">
            <SkillIcon size={16} />
          </span>
          <span className="profile-name">
            <b>{BUILT_IN_SKILL_NAME}</b>
            <span>Built in</span>
          </span>
        </div>
        {skills.map((skill) => (
          <Link
            key={skill.name}
            to="/settings/skills/$name"
            params={{ name: skill.name }}
            className="set-table-row skill-row"
          >
            <span className="profile-mark">
              <SkillIcon size={16} />
            </span>
            <span className="profile-name">
              <b>{skill.name}</b>
              <span>{describeSkillSource(skill.source)}</span>
            </span>
            {/* The badges for updates and proposed revisions are not drawn yet;
                they go here (spec 17 §Settings, Skills, Badges; #735, #736). */}
            <span className="skill-badges" />
            <span className="skill-size">
              {skill.currentFileCount === null || skill.currentSizeBytes === null
                ? null
                : formatSkillSize(skill.currentFileCount, skill.currentSizeBytes)}
            </span>
            <ChevronRightIcon size={14} />
          </Link>
        ))}
      </section>
      {skills.length === 0 && (
        <div className="set-empty">
          <b>No skills yet</b>
          <span>
            Import a folder of skills, such as <code>~/.agents/skills</code>.
          </span>
          <button type="button" className="btn btn--accent skill-empty-act" onClick={onImport}>
            Import from a folder
          </button>
        </div>
      )}
    </div>
  );
}
