/**
 * PROTOTYPE (#731). Settings > Skills, the list: the built-in skill first,
 * then the Skill Library by name, each row leading to the skill's page. The
 * scene picks what the list holds: the 24 skills, none, or the badges the
 * update checks and proposals of slices 4 and 5 add.
 */
import { useRef, useState, type JSX } from "react";
import { Link } from "@tanstack/react-router";
import { Face, HERCULE_LOOK } from "../../faces";
import { ChevronRightIcon } from "../../icons/chevron-right";
import { SkillIcon } from "../../icons/skill";
import { ConfirmDialog } from "../../screens/confirm-dialog";
import { SettingsHeaderActions } from "../../screens/settings/settings-frame";
import {
  APPROVAL_CHANGES,
  FAILED_CHECK,
  LAST_CHECKED,
  LIBRARY,
  PROPOSED_REVISION_SKILL,
  RELEASE_CHECKLIST,
  UPDATED_SKILLS,
  type LibrarySkill,
} from "./fixture";
import { describeFiles, describeSource, splitAllowedTools } from "./format";
import { ImportDialog } from "./import-dialog";
import { findScene, usePrototype, type Scene } from "./prototype-state";

/**
 * The list's route component. A new list per scene, so the import dialog
 * opens again when the switcher picks the import scene a second time.
 */
export function SkillsListRoute(): JSX.Element {
  const { scene } = usePrototype();
  return <SkillsList key={scene} scene={scene} />;
}

/**
 * Renders the list for `scene`: the header's actions, the banner, the
 * built-in row, and the library, or the empty note when the library holds
 * no skill. The import dialog opens from the header, from the empty note,
 * and at the start of the import scene; the Update all confirmation opens
 * from the header and at the start of its scene.
 */
function SkillsList({ scene }: { readonly scene: Scene }): JSX.Element {
  const [importing, setImporting] = useState(scene === "import");
  const [updatingAll, setUpdatingAll] = useState(scene === "update-all");
  const later = findScene(scene).later;
  const library =
    scene === "empty"
      ? []
      : later
        ? [...LIBRARY, RELEASE_CHECKLIST].toSorted((a, b) => a.name.localeCompare(b.name))
        : LIBRARY;
  return (
    <div className="skill-list">
      <SettingsHeaderActions>
        {later && (
          <>
            <span className="time">{`Checked ${LAST_CHECKED}`}</span>
            <button type="button" className="btn btn--sm">
              Check now
            </button>
            <button type="button" className="btn btn--sm" onClick={() => setUpdatingAll(true)}>
              {`Update all ${UPDATED_SKILLS.size}`}
            </button>
          </>
        )}
        <button type="button" className="btn btn--sm" onClick={() => setImporting(true)}>
          Import from a folder
        </button>
      </SettingsHeaderActions>
      <p className="profile-lead">
        A skill is a folder of instructions, led by its <code>SKILL.md</code>, that an agent loads
        when a task calls for it. The library keeps one copy of each, for every runner.
      </p>
      <p className="skill-banner">
        Threads don&apos;t use the library yet. Until they do, agents read skills from the folders
        on their runner, such as <code>~/.claude/skills</code>.
      </p>
      <section>
        <div className="skill-list-head">
          <span />
          <span>Skill</span>
          <span />
          <span>Size</span>
          <span />
        </div>
        <div className="skill-row is-built-in">
          <span className="profile-mark">
            <Face look={HERCULE_LOOK} pose="idle" size={22} />
          </span>
          <span className="profile-name">
            <b>hercule</b>
            <span>Built in. Teaches every agent the hercule CLI.</span>
          </span>
          <span className="skill-badges">
            <span className="chip">Read-only</span>
          </span>
          <span />
          <span />
        </div>
        {library.map((skill) => (
          <SkillRow key={skill.name} skill={skill} later={later} />
        ))}
      </section>
      {library.length === 0 && (
        <div className="set-empty">
          <b>No skills yet</b>
          <span>
            Import a folder of skills, such as <code>~/.agents/skills</code>.
          </span>
          <button
            type="button"
            className="btn btn--accent skill-empty-act"
            onClick={() => setImporting(true)}
          >
            Import from a folder
          </button>
        </div>
      )}
      {importing && <ImportDialog onClose={() => setImporting(false)} />}
      {updatingAll && <UpdateAllDialog onClose={() => setUpdatingAll(false)} />}
    </div>
  );
}

/**
 * Renders the confirmation Update all asks for. It names the skills that
 * update, and lists apart the ones whose update changes approvals, each
 * with the warning line its page shows, so nothing new runs without asking
 * unseen.
 */
function UpdateAllDialog({ onClose }: { readonly onClose: () => void }): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const names = [...UPDATED_SKILLS];
  return (
    <ConfirmDialog
      dialogRef={dialogRef}
      title={`Update ${names.length} skills?`}
      actionLabel="Update all"
      actionClass="accent"
      initialFocus="close"
      onConfirm={() => dialogRef.current?.close()}
      onClose={onClose}
    >
      <p>
        {`${names.join(" and ")} take the revision GitHub has now. New Threads use it; running Threads keep the copy they started with.`}
      </p>
      <p>
        {APPROVAL_CHANGES.size === 1
          ? "One update changes approvals:"
          : "These updates change approvals:"}
      </p>
      <ul className="skill-approvals">
        {[...APPROVAL_CHANGES].map(([name, tools]) => (
          <li key={name}>
            <b>{name}</b>
            <span>
              Lets tools run without asking:{" "}
              {splitAllowedTools(tools).map((tool) => (
                <code key={tool}>{tool}</code>
              ))}
            </span>
          </li>
        ))}
      </ul>
    </ConfirmDialog>
  );
}

/**
 * Renders one skill's row, linked to its page. In the later scenes a row
 * also shows what slices 4 and 5 add: an update waiting, a failed check
 * with its reason, or a proposal.
 */
function SkillRow({
  skill,
  later,
}: {
  readonly skill: LibrarySkill;
  readonly later: boolean;
}): JSX.Element {
  const failed = later && skill.name === FAILED_CHECK.name;
  const isNew = later && skill.name === RELEASE_CHECKLIST.name;
  const proposed = isNew || (later && skill.name === PROPOSED_REVISION_SKILL);
  const updated = later && UPDATED_SKILLS.has(skill.name);
  const changesApprovals = updated && APPROVAL_CHANGES.has(skill.name);
  return (
    <Link
      // The prototype's routes are not in the app's route tree, so the address is cast.
      to={"/settings/skills/$name" as never}
      params={{ name: skill.name } as never}
      className={failed ? "skill-row is-fail" : "skill-row"}
    >
      <span className="profile-mark">
        <SkillIcon size={16} />
      </span>
      <span className="profile-name">
        <b>{skill.name}</b>
        {failed ? (
          <span className="skill-fail-line">{`Last check failed: ${FAILED_CHECK.reason}`}</span>
        ) : (
          <span>{isNew ? "Proposed by Ada, session s_12" : describeSource(skill.source)}</span>
        )}
      </span>
      <span className="skill-badges">
        {updated && (
          <span className="chip chip--you">
            {changesApprovals ? "Update changes approvals" : "Update available"}
          </span>
        )}
        {proposed && <span className="chip chip--you">Proposed</span>}
        {failed && (
          <span className="chip chip--fail" title={FAILED_CHECK.reason}>
            Check failed
          </span>
        )}
      </span>
      <span className="skill-size">{describeFiles(skill.fileCount, skill.totalBytes)}</span>
      <ChevronRightIcon size={14} />
    </Link>
  );
}
