/**
 * Decides what a thread runs with right now, from the thread, the picks the
 * user made and the catalogs. This is the only place that decides it: the
 * composer's fields, the draft view and the request a send builds all read
 * the result, so they cannot disagree.
 *
 * The picks are intent. A pick the current catalogs cannot honour does not
 * apply, but it stays in the picks, so it applies again when the catalogs
 * allow it (Max on model X, switch to model Y without Max, back to X: Max).
 */
import type {
  CapabilitySnapshot,
  ModelDescriptor,
  ModelOption,
  ProviderAccount,
  Runner,
  Workspace,
} from "@hercule/contract";
import { resolveThreadHarnessId } from "../provider-accounts";
import { findSnapshotOn } from "./catalog";
import {
  readThreadConfig,
  type Thread,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadPicks,
} from "./config";
import { buildRunnerMenu, findReferenceRunner } from "./runner-menu";
import { findDefaultModel } from "./thread-defaults";
import { decideDefaultWorkspacePick, listProjectRepos, type WorkspacePick } from "./workspaces";

type ModelOptions = ThreadConfig["options"];

/** A thread's config once the workspace is decided: a draft with none picked gets the default one. */
export type ResolvedConfig = ThreadConfig & { readonly workspace: WorkspacePick };

/** What a Draft Thread runs with and starts with. */
export interface ResolvedDraft {
  readonly kind: "draft";
  readonly config: ResolvedConfig;
  /** The existing workspace the draft joins, or `undefined` when it joins none. */
  readonly joined: Workspace | undefined;
  /**
   * The runner the draft is placed on: `config.runnerId` found in the
   * catalogs. `undefined` when there is none. The request sends the id.
   */
  readonly runner: Runner | undefined;
  /**
   * A runner the composer names only to explain why the draft cannot start,
   * such as "Claude Code is not on moss". It is set only when `runner` is
   * `undefined`, and it is never sent.
   */
  readonly diagnosticRunner: Runner | undefined;
  /** The account's snapshot on `runner`, or on `diagnosticRunner` when there is no `runner`. */
  readonly snapshot: CapabilitySnapshot | undefined;
  /** The descriptor of `config.model` in `snapshot`, or `undefined` for a model it does not list. */
  readonly descriptor: ModelDescriptor | undefined;
}

/**
 * What an input changes on a thread that has started. A key is left out when
 * the Session keeps its value.
 */
export interface OutgoingChange {
  readonly model?: string;
  readonly options?: ModelOptions;
}

/** A thread that has started: its Session fixes everything but the model and its options. */
export interface ResolvedActive {
  readonly kind: "active";
  readonly sessionId: string;
  readonly config: ResolvedConfig;
  readonly runner: Runner | undefined;
  readonly snapshot: CapabilitySnapshot | undefined;
  readonly descriptor: ModelDescriptor | undefined;
  readonly outgoing: OutgoingChange;
}

export type ResolvedThread = ResolvedDraft | ResolvedActive;

/** Checks that `value` is one of the values `option` accepts. */
const acceptsValue = (option: ModelOption, value: string | boolean): boolean =>
  option.kind === "boolean"
    ? typeof value === "boolean"
    : (option.choices ?? []).some((choice) => choice.value === value);

/**
 * Returns the entries of `candidates` that `descriptor` offers: an option it
 * declares, with a value valid for it. Returns none when there is no
 * descriptor, because the composer shows no options selector then.
 */
const keepOfferedOptions = (
  descriptor: ModelDescriptor | undefined,
  candidates: ModelOptions,
): ModelOptions =>
  Object.fromEntries(
    Object.entries(candidates).filter(([id, value]) =>
      (descriptor?.options ?? []).some((option) => option.id === id && acceptsValue(option, value)),
    ),
  );

/**
 * Returns the runner id a draft runs on, when no existing workspace decides
 * it. In order:
 *
 * 1. The runner the user picked, while the account has a snapshot there in the
 *    draft's harness. A snapshot means the harness is installed on that
 *    runner, whatever its availability: when the runner is offline, draining
 *    or the account is signed out, the draft keeps the runner and the
 *    composer says why it cannot start.
 * 2. The draft's own runner, for the account the draft started with.
 * 3. The default runner of another account, which may be `null`.
 */
const decideDraftRunnerId = (
  catalogs: ThreadCatalogs,
  base: ThreadConfig,
  picks: ThreadPicks,
  account: ProviderAccount | undefined,
  harnessId: string | null,
): string | null => {
  if (account === undefined || harnessId === null) return picks.runnerId ?? base.runnerId;
  if (picks.runnerId != null && findSnapshotOn(account, harnessId, picks.runnerId) !== undefined)
    return picks.runnerId;
  return account.id === base.providerAccountId
    ? base.runnerId
    : buildRunnerMenu(catalogs.runners, catalogs.thisMacRunnerId, account, harnessId)
        .defaultRunnerId;
};

const resolveDraft = (
  catalogs: ThreadCatalogs,
  base: ThreadConfig,
  picks: ThreadPicks,
): ResolvedDraft => {
  const providerAccountId = picks.providerAccountId ?? base.providerAccountId;
  const account = catalogs.accounts.find((each) => each.id === providerAccountId);
  // The harness named for the draft's own account stays. Another account runs
  // in its default harness, because the named one belonged to the first.
  const namedHarnessId = account?.id === base.providerAccountId ? base.harnessId : null;
  const harnessId = account === undefined ? null : resolveThreadHarnessId(account, namedHarnessId);
  const workspace =
    picks.workspace ??
    base.workspace ??
    decideDefaultWorkspacePick(
      listProjectRepos(catalogs.resources ?? [], base.projectId ?? null),
      base.preferredWorkspace ?? null,
    );
  const joined =
    workspace.kind === "existing"
      ? (catalogs.workspaces ?? []).find((each) => each.id === workspace.workspaceId)
      : undefined;
  // An existing workspace is on one runner and never moves, so joining it
  // decides the runner.
  const runnerId =
    joined?.runnerId ?? decideDraftRunnerId(catalogs, base, picks, account, harnessId);
  const model =
    picks.model !== undefined
      ? picks.model
      : providerAccountId === base.providerAccountId
        ? base.model
        : account === undefined || harnessId === null
          ? null
          : findDefaultModel(account, harnessId, runnerId);

  const runner = catalogs.runners.find((each) => each.id === runnerId);
  const diagnosticRunner =
    runner === undefined
      ? findReferenceRunner(catalogs.runners, runnerId, catalogs.thisMacRunnerId)
      : undefined;
  const snapshot =
    account === undefined || harnessId === null
      ? undefined
      : findSnapshotOn(account, harnessId, (runner ?? diagnosticRunner)?.id);
  const descriptor = snapshot?.models.find((each) => each.slug === model);
  return {
    kind: "draft",
    config: {
      ...base,
      providerAccountId,
      harnessId: namedHarnessId,
      runnerId,
      model,
      accessMode: picks.accessMode ?? base.accessMode,
      options: keepOfferedOptions(descriptor, { ...base.options, ...picks.options }),
      workspace,
    },
    joined,
    runner,
    diagnosticRunner,
    snapshot,
    descriptor,
  };
};

const resolveActive = (
  catalogs: ThreadCatalogs,
  thread: Extract<Thread, { kind: "active" }>,
  picks: ThreadPicks,
): ResolvedActive => {
  const { session } = thread;
  const stored = readThreadConfig(thread);
  const account = catalogs.accounts.find((each) => each.id === session.providerAccountId);
  const runner = catalogs.runners.find((each) => each.id === session.runnerId);
  const snapshot =
    account === undefined
      ? undefined
      : findSnapshotOn(account, session.harnessId, session.runnerId ?? undefined);
  const model = picks.model ?? stored.model;
  const descriptor = snapshot?.models.find((each) => each.slug === model);

  const modelChanges = model !== stored.model;
  // The picked options that the model offers. Without a descriptor nothing
  // can be checked, so no pick applies and the stored options stay as they are.
  const pickedOptions = keepOfferedOptions(descriptor, picks.options ?? {});
  // A model change clears the stored options in the controller, so only the
  // options the new model also offers carry over. Without a model change the
  // controller merges, so the stored options stay whole.
  const options = modelChanges
    ? keepOfferedOptions(descriptor, { ...stored.options, ...picks.options })
    : { ...stored.options, ...pickedOptions };
  const changedOptions = modelChanges
    ? options
    : Object.fromEntries(
        Object.entries(pickedOptions).filter(([id, value]) => stored.options[id] !== value),
      );
  return {
    kind: "active",
    sessionId: session.id,
    config: {
      ...stored,
      model,
      options,
      workspace: stored.workspace ?? { kind: "none" },
    },
    runner,
    snapshot,
    descriptor,
    outgoing: {
      ...(modelChanges && model !== null ? { model } : {}),
      ...(Object.keys(changedOptions).length === 0 ? {} : { options: changedOptions }),
    },
  };
};

/**
 * Returns what `thread` runs with now, given the user's `picks` and the
 * `catalogs`. Never fails: whatever cannot run is described in the result, and
 * the composer turns that into a reason.
 *
 * A Draft Thread resolves each field from the picks, then the draft's own
 * config, then the catalogs:
 *
 * - account: the picked one, else the draft's;
 * - workspace: the picked one, else the draft's, else the default the composer
 *   shows. The draft starts in that workspace;
 * - runner: the joined existing workspace's runner, else the picked runner
 *   (see `decideDraftRunnerId`);
 * - model: the picked one, else the draft's model for the draft's own account,
 *   else the default model of the other account on the runner;
 * - model options: the draft's own options and the picked ones, those the
 *   model offers.
 *
 * A thread that has started always runs on the Session's account, runner and
 * workspace, with the Session's access mode. Only the model and its options
 * resolve from the picks, and `outgoing` holds what the next input changes.
 *
 * A caller that knows which kind of thread it holds gets that kind back.
 */
export function resolveThreadConfig(
  catalogs: ThreadCatalogs,
  thread: Extract<Thread, { kind: "draft" }>,
  picks: ThreadPicks,
): ResolvedDraft;
export function resolveThreadConfig(
  catalogs: ThreadCatalogs,
  thread: Extract<Thread, { kind: "active" }>,
  picks: ThreadPicks,
): ResolvedActive;
export function resolveThreadConfig(
  catalogs: ThreadCatalogs,
  thread: Thread,
  picks: ThreadPicks,
): ResolvedThread;
export function resolveThreadConfig(
  catalogs: ThreadCatalogs,
  thread: Thread,
  picks: ThreadPicks,
): ResolvedThread {
  return thread.kind === "draft"
    ? resolveDraft(catalogs, thread.config, picks)
    : resolveActive(catalogs, thread, picks);
}
