/**
 * PROTOTYPE (#731). Settings > Skills, the page of one skill: its
 * `SKILL.md`, its files, its history and Delete. In the later scenes the
 * page also shows an update waiting from GitHub, and a session's proposal
 * with Apply and Reject.
 */
import { useRef, useState, type JSX } from "react";
import { formatBytes } from "@hercule/client-core";
import { useParams } from "@tanstack/react-router";
import { buildAssistantLook, Face, UserAvatar } from "../../faces";
import { GlobeIcon } from "../../icons/globe";
import { ConfirmDialog } from "../../screens/confirm-dialog";
import { Markdown } from "../../screens/session/markdown";
import { SettingsHeaderActions, SettingsHeaderTitle } from "../../screens/settings/settings-frame";
import { FileChanges } from "./file-changes";
import {
  APPROVAL_CHANGES,
  CODE_REVIEW_UPDATE,
  LAST_CHECKED,
  PROPOSED_REVISION_SKILL,
  RELEASE_CHECKLIST,
  RELEASE_CHECKLIST_PROPOSAL,
  readSkillDetail,
  SHIP_PROPOSAL,
  TRIAGE_UPDATE,
  UPDATED_SKILLS,
  type Applier,
  type HistoryRow,
  type LibrarySkill,
  type PendingRevision,
  type SkillFile,
} from "./fixture";
import {
  describeApplier,
  describeFiles,
  describeRevisionKind,
  describeSource,
  splitAllowedTools,
  splitSkillMd,
  unlinkRelativeLinks,
} from "./format";
import { findScene, usePrototype, type Scene } from "./prototype-state";

/**
 * The page's route component. A new page per scene and skill, so the
 * delete confirmation opens again when the switcher picks its scene.
 */
export function SkillPageRoute(): JSX.Element {
  const { scene } = usePrototype();
  // The prototype's routes are not in the app's route tree, so the params are read loosely.
  const { name } = useParams({ strict: false }) as { readonly name: string };
  return <SkillPage key={`${scene}:${name}`} scene={scene} name={name} />;
}

/**
 * Returns the revision waiting on skill `name` in the later scenes: an
 * update from GitHub, or a session's proposal for a skill the library holds.
 * Returns `null` when nothing waits.
 */
const findPendingRevision = (name: string): PendingRevision | null => {
  if (name === "triage") return TRIAGE_UPDATE;
  if (UPDATED_SKILLS.has(name)) return CODE_REVIEW_UPDATE;
  if (name === PROPOSED_REVISION_SKILL) return SHIP_PROPOSAL;
  return null;
};

/** Renders the page of skill `name` as scene `scene` shows it. */
function SkillPage({ scene, name }: { readonly scene: Scene; readonly name: string }): JSX.Element {
  const later = findScene(scene).later;
  const detail = readSkillDetail(name, scene === "applied");
  // A skill with no applied SKILL.md exists only as a session's proposal.
  const { skill, skillMd } = detail;
  const pending = later ? findPendingRevision(name) : null;
  const approvalChange = later ? APPROVAL_CHANGES.get(name) : undefined;
  return (
    <div className="skill-record">
      <SettingsHeaderTitle
        // The prototype's routes are not in the app's route tree, so the address is cast.
        parent={{ title: "Skills", to: "/settings/skills" as never }}
        title={name}
      />
      {skillMd !== null && (
        <SettingsHeaderActions>
          {later && skill.source.kind === "github" && (
            <>
              <span className="time">{`Checked ${LAST_CHECKED}`}</span>
              <button type="button" className="btn btn--sm">
                Check now
              </button>
            </>
          )}
          <button type="button" className="btn btn--sm">
            Upload new version
          </button>
        </SettingsHeaderActions>
      )}
      {skillMd !== null ? (
        <>
          <SkillLead skill={skill} skillMd={skillMd} />
          {pending !== null && <PendingBand skill={skill} revision={pending} />}
          {pending !== null && (
            <section className="set-sec">
              <h2>What it changes</h2>
              {approvalChange !== undefined && (
                <AllowedToolsWarning
                  label="After the update, lets tools run without asking:"
                  value={approvalChange}
                />
              )}
              <FileChanges changes={pending.changes} />
            </section>
          )}
          <SkillMdSection
            text={skillMd}
            bytes={detail.files.find(({ path }) => path === "SKILL.md")?.bytes ?? 0}
          />
          <FilesSection files={detail.files} />
          <HistorySection rows={detail.history} />
          <DeleteSection name={name} confirmAtStart={scene === "delete"} />
        </>
      ) : (
        <>
          <PendingBand skill={skill} revision={RELEASE_CHECKLIST_PROPOSAL} />
          <SkillLead skill={skill} skillMd={RELEASE_CHECKLIST_PROPOSAL.skillMd} />
          <section className="set-sec">
            <h2>What it adds</h2>
            <FileChanges changes={RELEASE_CHECKLIST_PROPOSAL.changes} />
          </section>
        </>
      )}
    </div>
  );
}

/**
 * Renders the band over a revision that waits on `skill`, with the buttons
 * that act on it.
 *
 * - An update from GitHub names the repository, and has Update.
 * - A session's proposal names the session and when it proposed, marks a
 *   session that had read third-party messages, and has Reject and Apply.
 */
function PendingBand({
  skill,
  revision,
}: {
  readonly skill: LibrarySkill;
  readonly revision: PendingRevision;
}): JSX.Element {
  const { proposal } = revision;
  if (proposal === undefined) {
    return (
      <div className="skill-band">
        <span>
          {`Update available from ${skill.source.kind === "github" ? skill.source.repo : "GitHub"}. Nothing changes until you update.`}
        </span>
        <button type="button" className="btn btn--accent btn--sm">
          Update
        </button>
      </div>
    );
  }
  return (
    <div className="skill-band">
      <Face look={buildAssistantLook(proposal.by.assistantId)} pose="idle" size={22} />
      <span className="skill-band-text">
        <span className="skill-band-line">
          {`Proposed by ${describeApplier(proposal.by)}, ${proposal.at}`}
          {proposal.readThirdParty && (
            <span
              className="chip chip--fail"
              title={`${proposal.by.assistant}'s session had read third-party messages when it proposed this revision, so the changes may carry their words. Read them before you apply.`}
            >
              Includes third-party content
            </span>
          )}
        </span>
        <span className="skill-band-line skill-band-note">
          {skill.name === RELEASE_CHECKLIST.name
            ? "A new skill: no Thread gets it until you apply it."
            : "Nothing changes until you apply it."}
        </span>
      </span>
      <button type="button" className="btn btn--quiet btn--sm">
        Reject
      </button>
      <button type="button" className="btn btn--accent btn--sm">
        Apply
      </button>
    </div>
  );
}

/**
 * Renders the head of the page from `skill` and its `SKILL.md`: the
 * description from the frontmatter, then where the skill comes from and
 * its size, as chips, and the warning line when the frontmatter has
 * `allowed-tools`.
 */
function SkillLead({
  skill,
  skillMd,
}: {
  readonly skill: LibrarySkill;
  readonly skillMd: string;
}): JSX.Element {
  const { fields } = splitSkillMd(skillMd);
  const description = fields.find(({ key }) => key === "description")?.value;
  const allowedTools = fields.find(({ key }) => key === "allowed-tools")?.value;
  return (
    <div className="skill-lead">
      <p className="profile-lead">{description}</p>
      <div className="skill-chips">
        <span className="chip">
          {skill.source.kind === "github" && <GlobeIcon size={13} />}
          {skill.source.kind === "github"
            ? `${skill.source.repo} · ${skill.source.path}`
            : describeSource(skill.source)}
        </span>
        <span className="chip">{describeFiles(skill.fileCount, skill.totalBytes)}</span>
      </div>
      {allowedTools !== undefined && <AllowedToolsWarning value={allowedTools} />}
    </div>
  );
}

/**
 * Renders the line that warns of a skill that lets tools run without
 * asking, `label` and then one code chip per tool in `value`.
 */
function AllowedToolsWarning({
  label = "Lets tools run without asking:",
  value,
}: {
  readonly label?: string;
  readonly value: string;
}): JSX.Element {
  return (
    <p className="profile-note skill-warning">
      {label}{" "}
      {splitAllowedTools(value).map((tool) => (
        <code key={tool}>{tool}</code>
      ))}
    </p>
  );
}

/** The frontmatter fields the page's title and lead already show, so the card leaves them out. */
const SHOWN_ABOVE: ReadonlySet<string> = new Set(["name", "description"]);

/**
 * Renders the current revision's `SKILL.md`, `bytes` long: the frontmatter
 * fields other than the name and the description, which head the page, then
 * the body as markdown.
 */
function SkillMdSection({
  text,
  bytes,
}: {
  readonly text: string;
  readonly bytes: number;
}): JSX.Element {
  const { fields, body } = splitSkillMd(text);
  const otherFields = fields.filter(({ key }) => !SHOWN_ABOVE.has(key));
  return (
    <section className="set-sec">
      <h2>
        SKILL.md
        <small>{formatBytes(bytes)}</small>
      </h2>
      <div className="skill-card skill-md">
        {otherFields.length > 0 && (
          <dl className="skill-frontmatter">
            {otherFields.map(({ key, value }) => (
              <div key={key}>
                <dt>{key}</dt>
                <dd>{value}</dd>
              </div>
            ))}
          </dl>
        )}
        <div className="msg-body skill-md-body">
          <Markdown text={unlinkRelativeLinks(body)} />
        </div>
      </div>
    </section>
  );
}

/** Renders the current revision's files: path, an executable mark, and size. */
function FilesSection({ files }: { readonly files: ReadonlyArray<SkillFile> }): JSX.Element {
  const total = files.reduce((sum, file) => sum + file.bytes, 0);
  return (
    <section className="set-sec">
      <h2>
        Files
        <small>{describeFiles(files.length, total)}</small>
      </h2>
      <div className="skill-files">
        {files.map((file) => (
          <div key={file.path} className="skill-file">
            <span className="skill-path">{file.path}</span>
            {file.executable === true && <span className="chip">Executable</span>}
            <span className="skill-size">{formatBytes(file.bytes)}</span>
          </div>
        ))}
      </div>
    </section>
  );
}

/** Renders who applied a revision: the user's avatar, or the face of the assistant whose session it was. */
function ApplierMark({ applier }: { readonly applier: Applier }): JSX.Element {
  return applier === "you" ? (
    <UserAvatar name="Rogier" size={18} />
  ) : (
    <Face look={buildAssistantLook(applier.assistantId)} pose="idle" size={18} />
  );
}

/** Renders the applied revisions, newest first, with the current one marked. */
function HistorySection({ rows }: { readonly rows: ReadonlyArray<HistoryRow> }): JSX.Element {
  return (
    <section className="set-sec">
      <h2>History</h2>
      <div className="skill-history">
        {rows.map((row) => (
          <div key={row.hash} className="skill-rev">
            <ApplierMark applier={row.appliedBy} />
            <span className="skill-rev-text">
              <b>{describeRevisionKind(row.kind)}</b>
              <span>{`applied by ${describeApplier(row.appliedBy)}, ${row.appliedAt}`}</span>
            </span>
            {row.isCurrent && <span className="chip">Current</span>}
            <code className="skill-rev-hash">{row.hash}</code>
          </div>
        ))}
      </div>
    </section>
  );
}

/**
 * Renders the Delete section of skill `name`, whose button asks in a
 * dialog before anything goes. `confirmAtStart` opens the dialog at once,
 * as the delete scene shows it. The focus starts on Cancel, so a stray
 * Enter deletes nothing.
 */
function DeleteSection({
  name,
  confirmAtStart,
}: {
  readonly name: string;
  readonly confirmAtStart: boolean;
}): JSX.Element {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [confirming, setConfirming] = useState(confirmAtStart);
  return (
    <section className="set-sec">
      <h2>{`Delete ${name}`}</h2>
      <div className="set-row">
        <span className="set-label">
          <b>Delete skill</b>
          <span>Deletes it and all its revisions. New Threads stop getting it.</span>
        </span>
        <button type="button" className="btn btn--danger" onClick={() => setConfirming(true)}>
          Delete…
        </button>
      </div>
      {confirming && (
        <ConfirmDialog
          dialogRef={dialogRef}
          title={`Delete ${name}?`}
          actionLabel="Delete"
          actionClass="danger"
          initialFocus="close"
          onConfirm={() => dialogRef.current?.close()}
          onClose={() => setConfirming(false)}
        >
          <p>{`This deletes ${name} and all its revisions. This cannot be undone.`}</p>
          <p>Threads that are running keep the copy they started with.</p>
        </ConfirmDialog>
      )}
    </section>
  );
}
