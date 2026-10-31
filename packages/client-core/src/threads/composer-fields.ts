/**
 * Decides, in one place, every lock, blocker and pill the composer shows.
 * Once a thread is active, most of its configuration is fixed:
 *
 * - its workspace and runner, because a session stays on the runner it
 *   started on;
 * - its access mode, because no harness adapter can switch the mode of a
 *   running session.
 *
 * Only the model and its options can still change, and only within the
 * account and harness the thread was spawned on, because the session lives in
 * that account's home for the harness, with its sign-in.
 */
import type {
  AccessMode,
  CapabilitySnapshot,
  ModelDescriptor,
  ModelOption,
  Provider,
  ProviderAccount,
  Runner,
  Workspace,
  WorkspaceStatus,
} from "@hercule/contract";
import { buildAccessModeMenu, type AccessModeMenuItem } from "./access-modes";
import {
  buildProviderAccountName,
  findProviderAccountNameIfAmbiguous,
  resolveThreadHarnessId,
} from "../provider-accounts";
import { buildSignInTarget, type SignInTarget } from "./catalog";
import type { ThreadCatalogs, ThreadKind } from "./config";
import { buildRunnerMenu, findDimmedReason, type RunnerMenuRow } from "./runner-menu";
import type { ResolvedThread } from "./resolve-thread";
import {
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

/** The model pill: the harness logo, the account name when it is needed, and the model. */
export interface ModelPill {
  readonly harnessId: string | null;
  readonly account: string | null;
  readonly name: string | null;
}

export interface ComposerBlocked {
  /**
   * Why the thread cannot start, as a sentence without its full stop, such
   * as "Anthropic is not signed in on moss". Screens show it after "Can't
   * start yet."
   */
  readonly reason: string;
  /** The sign-in that would fix the problem, when a missing sign-in is the problem. */
  readonly signIn: SignInTarget | null;
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
  readonly model: {
    readonly pill: ModelPill;
    /**
     * The images the selected model takes, with its own size limit if it has
     * one, or `null` when it takes none. A model the runner's snapshot does
     * not list counts as one that takes none, because the controller refuses
     * images for it too.
     */
    readonly imageInput: ModelDescriptor["imageInput"];
    /** The selected model's name, for a sentence such as "glm-5.3 does not accept images". */
    readonly modelName: string;
  };
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
     * (the resolved thread's `diagnosticRunner`). Anything that checks whether the repo is cloned
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
 * - a Provider Account to run it with, and its harness;
 * - a runner to run it on, which must not be retired, offline or draining;
 * - a sign-in for the account on that runner.
 *
 * Only the last one can be fixed with a button from here.
 */
const findBlocker = (
  joined: Workspace | undefined,
  providers: readonly Provider[],
  account: ProviderAccount | undefined,
  runner: Runner | undefined,
  snapshot: CapabilitySnapshot | undefined,
): ComposerBlocked | null => {
  if (joined !== undefined && joined.status !== "ready")
    return { reason: joined.message ?? UNREADY_WORKSPACE_REASONS[joined.status], signIn: null };
  if (account === undefined) return { reason: "No account is set up", signIn: null };
  if (runner === undefined) return { reason: "No machine is connected", signIn: null };
  if (runner.lifecycle === "retired") return { reason: `${runner.name} is retired`, signIn: null };
  // A runner the user picked stays the draft's runner while it is away, so
  // the draft says why it cannot start rather than moving to another runner.
  if (runner.connectivity !== "online")
    return { reason: `${runner.name} is ${runner.connectivity}`, signIn: null };
  if (runner.lifecycle === "draining")
    return { reason: `${runner.name} is draining`, signIn: null };
  const name = buildProviderAccountName(providers, account);
  if (snapshot === undefined) return { reason: `${name} is not on ${runner.name}`, signIn: null };
  if (snapshot.auth.status !== "ok")
    return {
      reason: `${name} is not signed in on ${runner.name}`,
      signIn: buildSignInTarget(providers, account, runner),
    };
  return null;
};

const findLockedReason = (kind: ThreadKind, field: string): string | null =>
  kind === "active" ? `Create a new thread to change the ${field}` : null;

/**
 * Returns everything the composer shows for a resolved thread. It reads the
 * runner, snapshot and descriptor from `resolved`, never from the catalogs
 * again, so every field refers to the same runner.
 */
export const buildComposerFields = (
  catalogs: ThreadCatalogs,
  resolved: ResolvedThread,
): ComposerFields => {
  const { config, kind, snapshot, descriptor } = resolved;
  const account = catalogs.accounts.find((each) => each.id === config.providerAccountId);
  const harnessId =
    account === undefined ? null : resolveThreadHarnessId(account, config.harnessId);
  const harness = catalogs.harnesses.find((each) => each.id === harnessId);
  const resources = catalogs.resources ?? [];
  const workspaces = catalogs.workspaces ?? [];
  const projectId = config.projectId ?? null;
  const repos = listProjectRepos(resources, projectId);
  const pick = config.workspace;
  // Only a draft joins a workspace. A started thread is locked because it
  // started, which is what its tooltip must say, and its label names its own
  // runner rather than the workspace that chose it.
  const joined = resolved.kind === "draft" ? resolved.joined : undefined;
  // A draft with no operational runner still names the runner it would be
  // placed on, to say why it cannot start.
  const runner =
    resolved.kind === "draft" ? (resolved.runner ?? resolved.diagnosticRunner) : resolved.runner;

  // The label's name and dimmed reason come from the same runner. A runner
  // shown with another runner's reason would send the user to fix the wrong
  // thing.
  const menu =
    account === undefined || harnessId === null
      ? null
      : buildRunnerMenu(catalogs.runners, catalogs.thisMacRunnerId, account, harnessId);
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
          ? `${formatRepoName(resources.find((each) => each.id === pick.resourceId))} has no main workspace there · prepares on first use`
          : null,
    })) ?? [];
  // Read from the runner rather than from its row, because the menu has no
  // row for a retired runner, and a draft can still refer to one.
  const dimmed =
    account === undefined || runner === undefined ? null : findDimmedReason(runner, snapshot);
  const name = runner?.name ?? "no machine";

  return {
    accessMode: {
      locked: findLockedReason(kind, "access mode"),
      value: config.accessMode,
      rows:
        harness === undefined
          ? []
          : buildAccessModeMenu(harness.declared.accessModes, harness.displayName),
    },
    model: {
      pill: {
        harnessId,
        account:
          account === undefined
            ? null
            : findProviderAccountNameIfAmbiguous(catalogs.accounts, catalogs.providers, account),
        // A slug the snapshot no longer offers is still the thread's model, so
        // the pill shows the slug rather than going blank.
        name: descriptor?.name ?? config.model,
      },
      imageInput: descriptor?.imageInput ?? null,
      modelName: descriptor?.name ?? config.model ?? "The model",
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
    blocked:
      kind === "active" ? null : findBlocker(joined, catalogs.providers, account, runner, snapshot),
  };
};

/**
 * Returns the note the composer shows after a model pick on an active thread,
 * until the pick is sent. The change travels with the next message, in
 * `session.input`, so until then the thread keeps running its current model.
 * Returns `null` for a draft and for an active thread whose model does not
 * change.
 */
export const buildPendingModelNote = (resolved: ResolvedThread): string | null =>
  resolved.kind === "active" && resolved.outgoing.model !== undefined
    ? "model change applies on send"
    : null;
