/**
 * Builds what a Draft Thread shows: its configuration, the composer's fields,
 * the menus of its lip and the words on them, and the sidebar row it is drawn
 * as until it starts.
 */
import type { Profile, SettingsState, Workspace } from "@hercule/contract";
import { buildBranchField, type BranchField } from "./branch-menu";
import { buildComposerFields, type ComposerFields } from "./composer-fields";
import {
  computeEffectiveConfig,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadPicks,
} from "./config";
import { decideDraftPlaceForPick, type DraftPlace } from "./groups";
import { buildDraftConfig } from "./thread-defaults";
import { buildWorkspaceMenu, type WorkspaceMenu } from "./workspace-menu";
import { listProjectRepos } from "./workspaces";

/**
 * The records a Draft Thread is built from, as the app's queries return them:
 * every catalog a thread's configuration is checked against, the settings
 * that hold the user's defaults, and the permission profiles.
 */
export interface DraftReads extends Required<ThreadCatalogs> {
  readonly settings: SettingsState;
  readonly profiles: readonly Profile[];
}

/** Where a Draft Thread is: its project, and the workspace it joins. Either can be `null`. */
export interface DraftAddress {
  readonly projectId: string | null;
  readonly workspaceId: string | null;
}

/** What a Draft Thread shows and starts with. */
export interface DraftView {
  readonly catalogs: Required<ThreadCatalogs>;
  /** What the draft runs with before the user picks anything. Each pick is compared with it. */
  readonly base: ThreadConfig;
  /** What the draft runs with, the user's picks included. */
  readonly config: ThreadConfig;
  readonly fields: ComposerFields;
  readonly workspaceMenu: WorkspaceMenu;
  /** The workspace the draft joins, or `undefined` when it starts in a workspace of its own or in none. */
  readonly joinedWorkspace: Workspace | undefined;
  /** The words the lip shows for the workspace: "Main workspace", "New workspace", or a branch. */
  readonly workspaceLabel: string;
  /** The words the lip shows for the machine: its name, and why it is dimmed when it is. */
  readonly machineLabel: string;
  /** The branch menu, or `null` when the draft joins a workspace or has no checkout. */
  readonly branch: BranchField | null;
  /** The sidebar group the draft will belong to once it starts, which the sidebar draws it in. */
  readonly place: DraftPlace;
  /** Where the draft will work and on which machine, as its sidebar row says: "New workspace · studio-mac". */
  readonly rowMeta: string;
}

/**
 * Builds a Draft Thread from the records, the project and workspace its
 * address names, and the user's picks.
 *
 * The draft screen and the sidebar's draft row both call this, so the row
 * names the same workspace and machine the screen shows. A draft keeps no
 * configuration of its own: it is built again on every render, so a catalog
 * that changes while the draft is open, such as a runner coming online, fills
 * in whatever the user has not picked.
 */
export const buildDraftView = (
  reads: DraftReads,
  address: DraftAddress,
  picks: ThreadPicks,
): DraftView => {
  const { instances, runners, thisMacRunnerId, resources, workspaces, sessions } = reads;
  const base = buildDraftConfig({
    settingsUser: reads.settings.user,
    instances,
    runners,
    profiles: reads.profiles,
    thisMacRunnerId,
    ...address,
  });
  const config = computeEffectiveConfig(base, picks);
  const fields = buildComposerFields(reads, config, "draft");
  const pick = fields.workspace.value;
  // The menus use the machine the fields settled on, not the raw pick. Before
  // anything is picked the two differ, and the raw pick would make the menu
  // talk about a machine the lead never named.
  const runnerId = fields.machine.runnerId;
  const workspaceMenu = buildWorkspaceMenu({
    repos: listProjectRepos(resources, address.projectId),
    workspaces,
    sessions,
    runners,
    runnerId,
    pick,
  });
  const joined =
    pick.kind === "existing" ? workspaces.find((each) => each.id === pick.workspaceId) : undefined;
  // The menu labels a main workspace it has no row for with its repo and its
  // machine, so the label stands alone. The lip shows the machine on its
  // right, so it names the workspace as a started thread's lip does.
  const workspaceLabel = joined?.kind === "primary" ? "Main workspace" : workspaceMenu.label;
  const machine = runners.find((each) => each.id === runnerId)?.name ?? "no machine";
  return {
    catalogs: reads,
    base,
    config,
    fields,
    workspaceMenu,
    joinedWorkspace: joined,
    workspaceLabel,
    // A joined workspace's machine is labelled "set by the workspace …",
    // for a machine menu that stands apart from the workspace's. The lip
    // shows the two side by side, so it names the machine, and its tooltip
    // says why it cannot change.
    machineLabel: joined === undefined ? fields.machine.label : machine,
    branch: buildBranchField(pick, { workspaces, runnerId }),
    // The group follows the workspace the lip shows, so a pick moves the row.
    place:
      address.projectId === null
        ? { projectId: null, workspaceId: null, createsWorkspace: false }
        : decideDraftPlaceForPick({ projectId: address.projectId, pick, workspaces, runnerId }),
    rowMeta: `${workspaceLabel} · ${machine}`,
  };
};
