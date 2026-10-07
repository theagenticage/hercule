/**
 * Decides, in one place, every lock, blocker and pill the composer shows.
 * Once a thread is active, most of its configuration is fixed:
 *
 * - its workspace and runner, because a session stays on the runner it
 *   started on;
 * - its access mode, because no provider adapter can switch the mode of a
 *   running session.
 *
 * Only the model and its options can still change, and only within the
 * instance the thread was spawned on, because the session lives in that
 * instance's home, with its login.
 */
import type {
  AccessMode,
  CapabilitySnapshot,
  ModelOption,
  ProviderInstance,
  Runner,
  Workspace,
  WorkspaceStatus,
} from "@hercule/contract";
import { buildAccessModeMenu, type AccessModeMenuItem } from "./access-modes";
import { findAccountName, buildLoginTarget, findSnapshotOn, type LoginTarget } from "./catalog";
import type { ThreadCatalogs, ThreadConfig, ThreadKind, ThreadPicks } from "./config";
import {
  buildRunnerMenu,
  findDimmedReason,
  findReferenceRunner,
  type RunnerMenuRow,
} from "./runner-menu";
import {
  decideDefaultWorkspacePick,
  NO_PROJECT_REASON,
  NO_WORKSPACE_REASON,
  listProjectRepos,
  findReadyPrimary,
  formatRepoName,
  buildWorkspaceLead,
  formatWorkspaceName,
  type Phrase,
  type WorkspacePick,
} from "./workspaces";

export interface ComposerField {
  /** Why the field cannot be changed here, as the tooltip text, or `null` when it can. */
  readonly locked: string | null;
}

/** The model pill: the provider logo, the account name when it is needed, and the model. */
export interface ModelPill {
  readonly providerId: string | null;
  readonly account: string | null;
  readonly name: string | null;
}

export interface ComposerBlocked {
  /**
   * Why the thread cannot start, as a sentence without its full stop, such
   * as "Claude Code is not on moss". Screens show it after "Can't start yet."
   */
  readonly reason: string;
  /** The login that would fix the problem, when a missing login is the problem. */
  readonly login: LoginTarget | null;
}

/** A runner the thread could be placed on, and whether it is the current one. */
export interface MachineRow extends RunnerMenuRow {
  readonly current: boolean;
  /** Whether a new thread goes to this runner when none is picked. Shown as a badge. */
  readonly isDefault: boolean;
  /** `1/4`: the sessions this runner is hosting, out of its maximum. */
  readonly capacity: string;
  /**
   * `webshop is not cloned there · clones on first use`, for a draft that
   * opens in a main workspace. It does not dim the row: a runner without the
   * repo will clone it, which only takes longer.
   */
  readonly notCloned: string | null;
}

/**
 * Returns the line under a machine row in the machine menu. It lists what kind
 * of machine this is (this machine, the default, reserved) and every reason
 * the row is dimmed, joined with " · ", or "" when there is nothing to say. A
 * machine that has not cloned the repo yet can still be picked, because it
 * clones the repo on first use.
 */
export const describeMachineRow = (row: MachineRow): string =>
  [
    row.isLocal ? "this machine" : null,
    row.isDefault ? "default" : null,
    row.reserved ? "reserved" : null,
    row.dimmed,
    row.notCloned,
  ]
    .filter((each) => each !== null)
    .join(" · ");

export interface ComposerFields {
  /** The current access mode, and the four modes the menu offers. */
  readonly accessMode: ComposerField & {
    readonly value: AccessMode;
    readonly rows: readonly AccessModeMenuItem[];
  };
  readonly model: { readonly pill: ModelPill };
  /** The current model's options, or `null` when it has none and there is no selector. */
  readonly options: readonly ModelOption[] | null;
  /** Where the thread works: the current pick, and whether it can still change. */
  readonly workspace: ComposerField & { readonly value: WorkspacePick };
  /** The runner: the current one with the reason it is dimmed, if it is, and all runners. */
  readonly machine: ComposerField & {
    readonly label: string;
    /**
     * The runner every other field reads from. It is not always
     * `config.runnerId`: when no runner is selectable, the draft has picked
     * none, and this falls back to the runner it would really be placed on
     * (`findReferenceRunner`). Anything that checks whether the repo is cloned
     * must check this runner, or the lead sentence and the menu below it would
     * refer to two different runners.
     */
    readonly runnerId: string | null;
    readonly rows: readonly MachineRow[];
  };
  /** The lead sentence above a draft, or `null` for an active thread. */
  readonly lead: readonly Phrase[] | null;
  /** Why the draft cannot start, or `null` when it can and for an active thread. */
  readonly blocked: ComposerBlocked | null;
}

/**
 * Why a draft cannot join a workspace, for each status but `ready`. The
 * controller refuses to start a thread in a workspace that is not ready, so
 * the draft says why before the user tries.
 */
const UNREADY_WORKSPACE_REASONS: Readonly<Record<Exclude<WorkspaceStatus, "ready">, string>> = {
  provisioning: "The workspace it joins is still being set up",
  disposing: "The workspace it joins is being removed",
  failed: "The workspace it joins could not be set up",
  deleted: "The workspace it joins was deleted",
  lost: "The workspace it joins was lost when its machine was retired",
};

/**
 * Returns why a draft cannot start, or `null` when it can. Checks, in the
 * order the user can fix them:
 *
 * - the workspace it joins, if it joins one, which must be ready;
 * - a provider instance to run it with;
 * - a runner to run it on, which must not be retired;
 * - a login for the instance on that runner.
 *
 * Only the last one can be fixed with a button from here.
 */
const findBlocker = (
  joined: Workspace | undefined,
  instance: ProviderInstance | undefined,
  runner: Runner | undefined,
  snapshot: CapabilitySnapshot | undefined,
): ComposerBlocked | null => {
  if (joined !== undefined && joined.status !== "ready")
    return { reason: UNREADY_WORKSPACE_REASONS[joined.status], login: null };
  if (instance === undefined) return { reason: "No provider instance is set up", login: null };
  if (runner === undefined) return { reason: "No machine is connected", login: null };
  if (runner.lifecycle === "retired") return { reason: `${runner.name} is retired`, login: null };
  if (snapshot === undefined)
    return { reason: `${instance.displayName} is not on ${runner.name}`, login: null };
  if (snapshot.auth.status !== "ok")
    return {
      reason: `${instance.displayName} is on ${runner.name} but not logged in`,
      login: buildLoginTarget(instance, runner),
    };
  return null;
};

const findLockedReason = (kind: ThreadKind, field: string): string | null =>
  kind === "active" ? `Create a new thread to change the ${field}` : null;

/** Returns everything the composer shows for a thread's config. */
export const buildComposerFields = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  kind: ThreadKind,
): ComposerFields => {
  const instance = catalogs.instances.find((each) => each.id === config.instanceId);
  const resources = catalogs.resources ?? [];
  const workspaces = catalogs.workspaces ?? [];
  const projectId = config.projectId ?? null;
  const repos = listProjectRepos(resources, projectId);
  // Use the user's pick if there is one; otherwise the default, which follows
  // the stored setting and the project's repos.
  const pick =
    config.workspace ?? decideDefaultWorkspacePick(repos, config.preferredWorkspace ?? null);
  // Only read for a draft. A started thread is locked because it started,
  // which is what its tooltip must say, and its label names its own runner
  // rather than the workspace that chose it.
  const joined =
    kind === "draft" && pick.kind === "existing"
      ? workspaces.find((each) => each.id === pick.workspaceId)
      : undefined;
  // An existing workspace is on one runner and never moves, so a draft that
  // joins one uses that runner. A runner the user picked is already in
  // `config.runnerId`.
  const runner = findReferenceRunner(
    catalogs.runners,
    joined?.runnerId ?? config.runnerId,
    catalogs.thisMacRunnerId,
  );
  const snapshot = instance === undefined ? undefined : findSnapshotOn(instance, runner?.id);
  const descriptor = snapshot?.models.find((model) => model.slug === config.model);

  // The label's name and dimmed reason come from the same runner. A runner
  // shown with another runner's reason would send the user to fix the wrong
  // thing.
  const menu =
    instance === undefined
      ? null
      : buildRunnerMenu(catalogs.runners, catalogs.thisMacRunnerId, instance);
  const countHostedSessions = (runnerId: string): number =>
    (catalogs.sessions ?? []).filter(
      (session) => session.runnerId === runnerId && session.exitedAt === null,
    ).length;
  const rows: readonly MachineRow[] =
    menu?.rows.map((row) => ({
      ...row,
      current: row.runnerId === runner?.id,
      isDefault: row.runnerId === menu.defaultRunnerId,
      capacity: `${String(countHostedSessions(row.runnerId))}/${String(
        catalogs.runners.find((each) => each.id === row.runnerId)?.maxConcurrentSessions ?? 0,
      )}`,
      notCloned:
        pick.kind === "primary" &&
        findReadyPrimary(workspaces, pick.resourceId, row.runnerId) === undefined
          ? `${formatRepoName(resources.find((each) => each.id === pick.resourceId))} is not cloned there · clones on first use`
          : null,
    })) ?? [];
  // Read from the runner rather than from its row, because the menu has no
  // row for a retired runner, and a draft can still refer to one.
  const dimmed =
    instance === undefined || runner === undefined ? null : findDimmedReason(runner, snapshot);
  const name = runner?.name ?? "no machine";

  return {
    accessMode: {
      locked: findLockedReason(kind, "access mode"),
      value: config.accessMode,
      rows:
        instance === undefined
          ? []
          : buildAccessModeMenu(instance.declared.accessModes, instance.displayName),
    },
    model: {
      pill: {
        providerId: instance?.providerId ?? null,
        account: instance === undefined ? null : findAccountName(catalogs.instances, instance),
        // A slug the snapshot no longer offers is still the thread's model, so
        // the pill shows the slug rather than going blank.
        name: descriptor?.name ?? config.model,
      },
    },
    options:
      descriptor === undefined || descriptor.options.length === 0 ? null : descriptor.options,
    workspace: {
      // A project with no repo has no workspace to choose, so the selector is
      // locked, and its reason tells the user how to get one. A draft with no
      // project gets a different reason, because there is no project to add a
      // repo to yet.
      locked:
        findLockedReason(kind, "workspace") ??
        (repos.length > 0 ? null : projectId === null ? NO_PROJECT_REASON : NO_WORKSPACE_REASON),
      value: pick,
    },
    machine: {
      // An existing workspace is on one runner and never moves, so joining it
      // decides the runner instead of offering a choice (spec 02 §Workspace).
      locked:
        joined === undefined
          ? findLockedReason(kind, "machine")
          : "The workspace it joins decides the machine",
      label:
        joined !== undefined
          ? `set by the workspace ${formatWorkspaceName(joined)}`
          : dimmed === null
            ? name
            : `${name} · ${dimmed}`,
      runnerId: runner?.id ?? null,
      rows,
    },
    lead:
      kind === "active"
        ? null
        : buildWorkspaceLead(pick, {
            resources,
            workspaces,
            sessions: catalogs.sessions ?? [],
            machine: name,
            runnerId: runner?.id ?? null,
          }),
    blocked: kind === "active" ? null : findBlocker(joined, instance, runner, snapshot),
  };
};

/**
 * Returns the note the composer shows after a model pick on an active thread,
 * until the pick is sent. The picks travel with the next message, in
 * `session.input`, so until then the thread keeps running its current model.
 */
export const buildPendingModelNote = (kind: ThreadKind, picks: ThreadPicks): string | null =>
  kind === "active" && picks.model !== undefined ? "model change applies on send" : null;
