/**
 * Every lock, blocker and pill part the composer shows, decided in one place.
 * A thread's placement is copied at spawn and never read through afterwards
 * (spec 02 §Session), so once a thread is active its access mode, workspace
 * and machine are facts rather than fields - only the model and its options
 * stay live, and they stay live inside the instance the thread spawned in.
 */
import type {
  AccessMode,
  CapabilitySnapshot,
  ModelOption,
  ProviderInstance,
  Runner,
} from "@hercule/contract";
import { accessModeMenu, type AccessModeMenuItem } from "./access-modes";
import { accountName, loginTarget, snapshotOn, type LoginTarget } from "./catalog";
import type { ThreadCatalogs, ThreadConfig, ThreadKind, ThreadPicks } from "./config";
import { referenceRunner, runnerMenu, type RunnerMenuRow } from "./runner-menu";
import {
  defaultWorkspacePick,
  NO_PROJECT_REASON,
  NO_WORKSPACE_REASON,
  projectRepos,
  readyPrimary,
  repoName,
  workspaceLead,
  workspaceName,
  type Phrase,
  type WorkspacePick,
} from "./workspaces";

export interface ComposerField {
  /** Why this cannot be changed here, as the sentence the tooltip reads. */
  readonly locked: string | null;
}

/** The provider mark, the account where it is worth naming, and the model. */
export interface ModelPill {
  readonly providerId: string | null;
  readonly account: string | null;
  readonly name: string | null;
}

export interface ComposerBlocked {
  readonly reason: string;
  /** The login that would clear it, where logging in is what is missing. */
  readonly login: LoginTarget | null;
}

/** One machine the thread could be placed on, and whether it is the one in force. */
export interface MachineRow extends RunnerMenuRow {
  readonly current: boolean;
  /** Where a new thread would land without a pick, as the row's own badge. */
  readonly isDefault: boolean;
  /** `1/4`: the sessions this machine is hosting, against what it will host. */
  readonly capacity: string;
  /**
   * `webshop is not cloned there · clones on first use`, on a draft opening in
   * a main workspace. It dims nothing: a machine without the repo yet is a
   * machine that clones it, which is a wait and not a refusal.
   */
  readonly notCloned: string | null;
}

export interface ComposerFields {
  /** The mode in force, and the four the menu offers under it. */
  readonly accessMode: ComposerField & {
    readonly value: AccessMode;
    readonly rows: readonly AccessModeMenuItem[];
  };
  readonly model: { readonly pill: ModelPill };
  /** What the current model offers to pick under it; none means no selector. */
  readonly options: readonly ModelOption[] | null;
  /** Where the thread works: the pick in force, and whether it can still change. */
  readonly workspace: ComposerField & { readonly value: WorkspacePick };
  /** The machine: the one in force, named with why it is dimmed, and the fleet. */
  readonly machine: ComposerField & {
    readonly label: string;
    /**
     * The machine everything else reads from. It is not `config.runnerId`: a
     * draft whose fleet holds nothing selectable has picked none, and falls
     * back to the machine it would really be placed on (`referenceRunner`).
     * Anything asking "is the repo cloned there" has to ask about that one, or
     * the lead sentence and the menu under it name two different machines.
     */
    readonly runnerId: string | null;
    readonly rows: readonly MachineRow[];
  };
  /** The sentence a draft stands under; an active thread stands under none. */
  readonly lead: readonly Phrase[] | null;
  /** Why this draft cannot start at all; null once it can, and on a thread that has. */
  readonly blocked: ComposerBlocked | null;
}

/**
 * Why a draft cannot start, in the order the user can act on: something to
 * run it with, a machine to run it on, then a login on that machine. Only the
 * last of the three is something a button can fix from here.
 */
const blockerOf = (
  instance: ProviderInstance | undefined,
  runner: Runner | undefined,
  snapshot: CapabilitySnapshot | undefined,
): ComposerBlocked | null => {
  if (instance === undefined) return { reason: "no provider instance is set up", login: null };
  if (runner === undefined) return { reason: "no machine is connected", login: null };
  if (snapshot === undefined)
    return { reason: `${instance.displayName} is not on ${runner.name}`, login: null };
  if (snapshot.auth.status !== "ok")
    return {
      reason: `${instance.displayName} is on ${runner.name} but not logged in`,
      login: loginTarget(instance, runner),
    };
  return null;
};

const lockedReason = (kind: ThreadKind, field: string): string | null =>
  kind === "active" ? `Create a new thread to change the ${field}` : null;

export const composerFields = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
  kind: ThreadKind,
): ComposerFields => {
  const instance = catalogs.instances.find((each) => each.id === config.instanceId);
  const resources = catalogs.resources ?? [];
  const workspaces = catalogs.workspaces ?? [];
  const projectId = config.projectId ?? null;
  const repos = projectRepos(resources, projectId);
  // The pick the user made stands; otherwise the default follows the stored
  // setting, and the repos of the project are what either can name.
  const pick = config.workspace ?? defaultWorkspacePick(repos, config.preferredWorkspace ?? null);
  // Read only on a draft: a thread that has started is locked because it
  // started, which is what its tooltip has to say, and its own machine is the
  // one worth naming rather than the workspace that chose it.
  const joined =
    kind === "draft" && pick.kind === "existing"
      ? workspaces.find((each) => each.id === pick.workspaceId)
      : undefined;
  // A workspace that already stands is on one machine and never moves, so a
  // draft joining one takes that machine as its default before anything is
  // read off it; a machine the user picked is in `config.runnerId` already.
  const runner = referenceRunner(
    catalogs.runners,
    joined?.runnerId ?? config.runnerId,
    catalogs.localRunnerId,
  );
  const snapshot = instance === undefined ? undefined : snapshotOn(instance, runner?.id);
  const descriptor = snapshot?.models.find((model) => model.slug === config.model);

  // The name and the reason come off one machine, never off two: a machine
  // named with another's reason would send the user to fix the wrong thing.
  const menu =
    instance === undefined ? null : runnerMenu(catalogs.runners, catalogs.localRunnerId, instance);
  const hosted = (runnerId: string): number =>
    (catalogs.sessions ?? []).filter(
      (session) => session.runnerId === runnerId && session.exitedAt === null,
    ).length;
  const rows: readonly MachineRow[] =
    menu?.rows.map((row) => ({
      ...row,
      current: row.runnerId === runner?.id,
      isDefault: row.runnerId === menu.defaultRunnerId,
      capacity: `${String(hosted(row.runnerId))}/${String(
        catalogs.runners.find((each) => each.id === row.runnerId)?.maxConcurrentSessions ?? 0,
      )}`,
      notCloned:
        pick.kind === "primary" &&
        readyPrimary(workspaces, pick.resourceId, row.runnerId) === undefined
          ? `${repoName(resources.find((each) => each.id === pick.resourceId))} is not cloned there · clones on first use`
          : null,
    })) ?? [];
  const dimmed = rows.find((row) => row.current)?.dimmed ?? null;
  const name = runner?.name ?? "no machine";

  return {
    accessMode: {
      locked: lockedReason(kind, "access mode"),
      value: config.accessMode,
      rows:
        instance === undefined
          ? []
          : accessModeMenu(instance.declared.accessModes, instance.displayName),
    },
    model: {
      pill: {
        providerId: instance?.providerId ?? null,
        account: instance === undefined ? null : accountName(catalogs.instances, instance),
        // A slug the snapshot no longer offers is still what the thread runs
        // under, so the pill names it rather than going blank.
        name: descriptor?.name ?? config.model,
      },
    },
    options:
      descriptor === undefined || descriptor.options.length === 0 ? null : descriptor.options,
    workspace: {
      // A project with no repo works in none, so there is nothing to choose
      // between and the selector is its value with the way out as its reason
      // (D-20d) - which is a different way out on a draft that stands in no
      // project at all, where there is nothing to add a repo to yet.
      locked:
        lockedReason(kind, "workspace") ??
        (repos.length > 0 ? null : projectId === null ? NO_PROJECT_REASON : NO_WORKSPACE_REASON),
      value: pick,
    },
    machine: {
      // A workspace that already stands is on one machine and never moves, so
      // joining it settles the machine rather than offering it (spec 02
      // §Workspace).
      locked:
        joined === undefined
          ? lockedReason(kind, "machine")
          : "The workspace it joins decides the machine",
      label:
        joined !== undefined
          ? `set by the workspace ${workspaceName(joined)}`
          : dimmed === null
            ? name
            : `${name} · ${dimmed}`,
      runnerId: runner?.id ?? null,
      rows,
    },
    lead:
      kind === "active"
        ? null
        : workspaceLead(pick, {
            resources,
            workspaces,
            sessions: catalogs.sessions ?? [],
            machine: name,
            runnerId: runner?.id ?? null,
          }),
    blocked: kind === "active" ? null : blockerOf(instance, runner, snapshot),
  };
};

/**
 * What the card says between a model pick and the submission that carries it.
 * A pick does not reach the session on its own (spec 14 §What locks at start:
 * the picks ride `session.input`), so the thread still runs the model it
 * runs this turn with until the next message goes out.
 */
export const pendingModelNote = (kind: ThreadKind, picks: ThreadPicks): string | null =>
  kind === "active" && picks.model !== undefined ? "model change applies on send" : null;
