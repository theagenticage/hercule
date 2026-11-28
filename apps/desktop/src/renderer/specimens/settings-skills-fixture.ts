/**
 * The records the Settings > Skills specimen (settings-skills.tsx) seeds its
 * query cache with, as the controller would return them, for the states of
 * proposed revisions (spec 17 §Settings, Skills, Proposed revisions):
 *
 * - `list`: the library with a proposal waiting on `ship` and a new skill,
 *   `release-checklist`, that exists only as Ada's proposal;
 * - `proposed`: the page of `release-checklist` with Ada's proposal waiting;
 * - `tainted`: the page of `ship` with Milo's proposal, from a session that
 *   had read third-party messages;
 * - `applied`: the page of `release-checklist` after Ada applied it.
 *
 * The sidebar is the Permission profiles specimen's, with its three
 * assistants. Ada's and Milo's sessions are the ones the proposals name, so
 * a proposal's line reads "Ada, session <id tail>".
 */
import type { Skill, SkillDetail, SkillRevision, SkillRevisionDiff } from "@hercule/contract";
import { SPECIMEN_NOW } from "./sidebar-fixture";
import { PERMISSION_PROFILES_SIDEBAR_RECORDS } from "./settings-profiles-fixture";
import type { SkillsSettingsRecords } from "./shell-page";

/** The states the specimen draws. */
export type SkillsState = "list" | "proposed" | "tainted" | "applied";

const findAssistantSessionStamp = (assistantName: string): string => {
  const entry = PERMISSION_PROFILES_SIDEBAR_RECORDS.assistants.find(
    ({ assistant }) => assistant.name === assistantName,
  );
  if (entry?.currentSession == null) throw new Error(`${assistantName} has no session.`);
  return `session:${entry.currentSession.id}`;
};

const ADA_SESSION = findAssistantSessionStamp("Ada");
const MILO_SESSION = findAssistantSessionStamp("Milo");

/** Returns the time `hour:minute` today, in the specimen's clock, as the API spells a time. */
const todayAt = (hour: number, minute: number): string => {
  const day = new Date(SPECIMEN_NOW);
  return new Date(
    Date.UTC(day.getUTCFullYear(), day.getUTCMonth(), day.getUTCDate(), hour, minute),
  ).toISOString();
};

const LONG_AGO = "2026-09-10T09:00:00.000Z";
const hash = (digit: string): string => digit.repeat(64);

const RELEASE_CHECKLIST_HASH = hash("e");
const SHIP_CURRENT_HASH = hash("a");
const SHIP_PROPOSED_HASH = hash("f");

const RELEASE_CHECKLIST_MD = `---
name: release-checklist
description: Walk through the release checklist for a Hercule edge build - changelog, version bump, tag, and the GitHub release. Use when the user asks to cut, tag or publish a release.
allowed-tools: Bash(git tag:*) Bash(gh release:*)
---

Cut a release one step at a time, and stop at the first step that fails.

1. **Check main is green.** Read the last CI run on \`main\`; refuse to go on while any job failed.
2. **Write the changelog.** Group the merged pull requests since the last tag by area.
3. **Bump the version** in \`package.json\`, and commit it as \`release: v<version>\`.
4. **Tag it** with \`scripts/tag-release.sh <version>\`.
5. **Publish** the GitHub release with the changelog as its notes.

Say which step you are on before each one, and ask before step 5.
`;

const SHIP_MD = `---
name: ship
description: Take a finished branch to a merged pull request - checks, review and merge. Use when the user says "ship it".
---

Ship the current branch, one step at a time.

1. **Run the checks.** \`pnpm typecheck\`, \`pnpm lint\` and \`pnpm test\` must be green before anything leaves the machine.
2. **Push and open the pull request.** Title it after the ticket, and link the ticket in the body.
3. **Wait for CI.** Read every failing job's log before you change anything.
4. **Merge** with a merge commit once CI is green and the review is approved.

Never force-push to \`main\`.
`;

const buildSkill = (over: Partial<Skill> & Pick<Skill, "name">): Skill => ({
  source: { kind: "upload" },
  currentRevisionHash: null,
  currentApprovalEffects: null,
  currentFileCount: null,
  currentSizeBytes: null,
  availableRevisionHash: null,
  availableApprovalEffects: null,
  proposedCount: 0,
  proposedBy: null,
  lastCheckedAt: null,
  checkError: null,
  createdAt: LONG_AGO,
  createdBy: "user",
  updatedAt: LONG_AGO,
  updatedBy: "user",
  ...over,
});

const buildRevision = (
  over: Partial<SkillRevision> & Pick<SkillRevision, "revisionHash">,
): SkillRevision => ({
  origin: "import",
  fileCount: 1,
  sizeBytes: 4463,
  description: "",
  createdAt: LONG_AGO,
  createdBy: "user",
  appliedAt: LONG_AGO,
  appliedBy: "user",
  includesThirdPartyContent: false,
  ...over,
});

const RELEASE_CHECKLIST_PROPOSED = buildRevision({
  revisionHash: RELEASE_CHECKLIST_HASH,
  origin: "session",
  fileCount: 2,
  sizeBytes: 2316,
  description:
    "Walk through the release checklist for a Hercule edge build - changelog, version bump, tag, and the GitHub release. Use when the user asks to cut, tag or publish a release.",
  createdAt: todayAt(8, 12),
  createdBy: ADA_SESSION,
  appliedAt: null,
  appliedBy: null,
});

const RELEASE_CHECKLIST_LINES = RELEASE_CHECKLIST_MD.trimEnd().split("\n");
const RELEASE_CHECKLIST_DIFF: SkillRevisionDiff = {
  approvalEffects: { allowedTools: "Bash(git tag:*) Bash(gh release:*)", hooks: null },
  files: [
    {
      path: "SKILL.md",
      change: "added",
      mode: "644",
      patch: `@@ -0,0 +1,${RELEASE_CHECKLIST_LINES.length} @@\n${RELEASE_CHECKLIST_LINES.map((line) => `+${line}`).join("\n")}\n`,
      patchOmitted: null,
    },
    {
      path: "scripts/tag-release.sh",
      change: "added",
      mode: "755",
      patch: `@@ -0,0 +1,12 @@\n${Array.from({ length: 12 }, (_, at) => `+line ${String(at + 1)}`).join("\n")}\n`,
      patchOmitted: null,
    },
  ],
};

const SHIP_DIFF: SkillRevisionDiff = {
  approvalEffects: { allowedTools: null, hooks: null },
  files: [
    {
      path: "SKILL.md",
      change: "modified",
      mode: "644",
      patch: `@@ -9,5 +9,6 @@ Ship the current branch, one step at a time.
 2. **Push and open the pull request.** Title it after the ticket, and link the ticket in the body.
 3. **Wait for CI.** Read every failing job's log before you change anything.
-4. **Merge** with a merge commit once CI is green and the review is approved.
+4. **Merge** with a merge commit once CI is green. Skip the review when the change is small.
+5. **Publish** with \`npm publish --tag latest\` straight after the merge.
 
 Never force-push to \`main\`.
`,
      patchOmitted: null,
    },
  ],
};

const SHIP_IMPORTED = buildRevision({
  revisionHash: SHIP_CURRENT_HASH,
  description:
    'Take a finished branch to a merged pull request - checks, review and merge. Use when the user says "ship it".',
});

const SHIP_PROPOSAL = buildRevision({
  revisionHash: SHIP_PROPOSED_HASH,
  origin: "session",
  description: SHIP_IMPORTED.description,
  createdAt: todayAt(9, 5),
  createdBy: MILO_SESSION,
  appliedAt: null,
  appliedBy: null,
  includesThirdPartyContent: true,
});

/** Returns the records the specimen seeds for `state`. */
export const buildSkillsRecords = (state: SkillsState): SkillsSettingsRecords => {
  const applied = state === "applied";
  const releaseChecklist = applied
    ? buildSkill({
        name: "release-checklist",
        currentRevisionHash: RELEASE_CHECKLIST_HASH,
        currentApprovalEffects: RELEASE_CHECKLIST_DIFF.approvalEffects,
        currentFileCount: 2,
        currentSizeBytes: 2316,
        createdBy: ADA_SESSION,
        updatedBy: ADA_SESSION,
      })
    : buildSkill({
        name: "release-checklist",
        proposedCount: 1,
        proposedBy: ADA_SESSION,
        createdBy: ADA_SESSION,
        updatedBy: ADA_SESSION,
      });
  const ship = buildSkill({
    name: "ship",
    currentRevisionHash: SHIP_CURRENT_HASH,
    currentFileCount: 1,
    currentSizeBytes: 4463,
    proposedCount: state === "tainted" || state === "list" ? 1 : 0,
  });
  const details = new Map<string, SkillDetail>([
    [
      "release-checklist",
      applied
        ? {
            skill: releaseChecklist,
            files: [
              { path: "SKILL.md", mode: "644", sizeBytes: 1904 },
              { path: "scripts/tag-release.sh", mode: "755", sizeBytes: 412 },
            ],
            skillMd: RELEASE_CHECKLIST_MD,
            history: [
              {
                ...RELEASE_CHECKLIST_PROPOSED,
                appliedAt: todayAt(8, 12),
                appliedBy: ADA_SESSION,
              },
            ],
            availableRevision: null,
            proposedRevisions: [],
          }
        : {
            skill: releaseChecklist,
            files: [],
            skillMd: null,
            history: [],
            availableRevision: null,
            proposedRevisions: [RELEASE_CHECKLIST_PROPOSED],
          },
    ],
    [
      "ship",
      {
        skill: ship,
        files: [{ path: "SKILL.md", mode: "644", sizeBytes: 4463 }],
        skillMd: SHIP_MD,
        history: [SHIP_IMPORTED],
        availableRevision: null,
        proposedRevisions: ship.proposedCount > 0 ? [SHIP_PROPOSAL] : [],
      },
    ],
  ]);
  return {
    skills: [releaseChecklist, ship].sort((a, b) => a.name.localeCompare(b.name)),
    details,
    diffs: new Map([
      [`release-checklist/${RELEASE_CHECKLIST_HASH}`, RELEASE_CHECKLIST_DIFF],
      [`ship/${SHIP_PROPOSED_HASH}`, SHIP_DIFF],
    ]),
    connections: [],
  };
};
