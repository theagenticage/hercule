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
  ModelDescriptor,
  ModelOption,
  ProviderAccount,
  ResolvedModelProfileEntry,
  Runner,
  Workspace,
} from "@hercule/contract";
import { findProfileEntry } from "../model-profiles/profile-entries";
import { findProviderAccountReadiness, resolveThreadHarnessId } from "../provider-accounts";
import {
  readThreadConfig,
  type Thread,
  type ThreadCatalogs,
  type ThreadConfig,
  type ThreadPicks,
} from "./config";
import { buildRunnerMenu, findReferenceRunner } from "./runner-menu";
import { decideDefaultWorkspacePick, listProjectRepos, type WorkspacePick } from "./workspaces";

type ModelOptions = ThreadConfig["options"];

/** What the composer shows of the thread's model: its name, the options it offers and the images it takes. */
export type ModelDescription = Pick<ResolvedModelProfileEntry, "name" | "options" | "imageInput">;

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
  /**
   * The harness the draft runs in: the config's own, else the account's
   * default. `null` while the draft has no account.
   */
  readonly resolvedHarnessId: string | null;
  /**
   * The profile entry for the config's account, harness and model, or
   * `undefined` for a model no profile offers. It holds the model's name,
   * options and image input.
   */
  readonly entry: ResolvedModelProfileEntry | undefined;
  /** The model's name, options and image input: those of `entry`, or `undefined` for a model no profile offers. */
  readonly description: ModelDescription | undefined;
  /**
   * The runner the model menu judges every entry on: the joined workspace's
   * runner, else the one the user picked, else `null` while any runner will
   * do. It is never the runner the draft would be placed on by default,
   * because the menu must not dim entries by a runner nobody chose.
   */
  readonly menuRunnerId: string | null;
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
  /** The session's harness. */
  readonly resolvedHarnessId: string;
  /**
   * The model's name, options and image input, from the profile entry for the
   * session's account, harness and model. When no profile offers the model,
   * they come from the account's newest good probe in the session's harness
   * (`findProbedModel`); `undefined` when that lists the model no more than
   * the profiles do.
   */
  readonly description: ModelDescription | undefined;
  readonly outgoing: OutgoingChange;
}

export type ResolvedThread = ResolvedDraft | ResolvedActive;

/** Checks that `value` is one of the values `option` accepts. */
const acceptsValue = (option: ModelOption, value: string | boolean): boolean =>
  option.kind === "boolean"
    ? typeof value === "boolean"
    : (option.choices ?? []).some((choice) => choice.value === value);

/**
 * Returns the entries of `candidates` that the model of `description` offers: an
 * option it declares, with a value valid for it. Returns none when there is
 * no description, because the composer shows no options selector then.
 */
const keepOfferedOptions = (
  description: ModelDescription | undefined,
  candidates: ModelOptions,
): ModelOptions =>
  Object.fromEntries(
    Object.entries(candidates).filter(([id, value]) =>
      (description?.options ?? []).some(
        (option) => option.id === id && acceptsValue(option, value),
      ),
    ),
  );

/**
 * Returns the model of `account` in the harness `harnessId` as the account's
 * newest `ok` probe lists it, or `undefined` when no `ok` probe lists the
 * model. It mirrors the controller's `findSnapshotModel` in
 * `resolve-profile.ts`, which fills a profile entry's name, options and image
 * input from the same probe, so a model that left every profile keeps the
 * descriptor its entry had.
 *
 * It only describes the model. Whether the account can run it comes from
 * `ProviderAccount.readiness`, and whether a profile offers it from the
 * profiles; a probe says neither.
 */
const findProbedModel = (
  account: ProviderAccount | undefined,
  harnessId: string,
  slug: string,
): ModelDescriptor | undefined => {
  let newest: { readonly probedAt: string; readonly model: ModelDescriptor } | undefined;
  for (const snapshot of account?.snapshots ?? []) {
    if (snapshot.harnessId !== harnessId || snapshot.auth.status !== "ok") continue;
    const model = snapshot.models.find((each) => each.slug === slug);
    if (model !== undefined && (newest === undefined || snapshot.probedAt > newest.probedAt)) {
      newest = { probedAt: snapshot.probedAt, model };
    }
  }
  return newest?.model;
};

/**
 * Returns the runner id a draft runs on, when no existing workspace decides
 * it. In order:
 *
 * 1. The runner the user picked, while the draft's harness can run there:
 *    the account has a readiness row for it that is not `harness-missing`.
 *    Whatever the runner's availability, when it is offline, draining or the
 *    account is signed out, the draft keeps the runner and the composer says
 *    why it cannot start.
 * 2. The draft's own runner, for the account and harness the draft started
 *    with.
 * 3. The default runner of another account or harness, which may be `null`.
 */
const decideDraftRunnerId = (
  catalogs: ThreadCatalogs,
  base: ThreadConfig,
  picks: ThreadPicks,
  account: ProviderAccount | undefined,
  harnessId: string | null,
): string | null => {
  if (account === undefined || harnessId === null) return picks.runnerId ?? base.runnerId;
  const picked = catalogs.runners.find((runner) => runner.id === picks.runnerId);
  if (
    picked !== undefined &&
    findProviderAccountReadiness(account, harnessId, picked.id) !== "harness-missing"
  )
    return picked.id;
  return account.id === base.providerAccountId &&
    harnessId === resolveThreadHarnessId(account, base.harnessId)
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
  // A pick names its harness together with its account. Without one, the
  // harness named for the draft's own account stays, and another account runs
  // in its default harness, because the named one belonged to the first.
  const namedHarnessId =
    picks.harnessId !== undefined
      ? picks.harnessId
      : account?.id === base.providerAccountId
        ? base.harnessId
        : null;
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
  // A pick of another account that names no model leaves the model open: the
  // controller starts the thread on its default entry for the account.
  const model =
    picks.model !== undefined
      ? picks.model
      : providerAccountId === base.providerAccountId
        ? base.model
        : null;

  const runner = catalogs.runners.find((each) => each.id === runnerId);
  const diagnosticRunner =
    runner === undefined
      ? findReferenceRunner(catalogs.runners, runnerId, catalogs.thisMacRunnerId)
      : undefined;
  const entry =
    providerAccountId === null || harnessId === null || model === null
      ? undefined
      : findProfileEntry(catalogs.modelProfiles, { providerAccountId, harnessId, model });
  return {
    kind: "draft",
    config: {
      ...base,
      providerAccountId,
      harnessId: namedHarnessId,
      runnerId,
      model,
      accessMode: picks.accessMode ?? base.accessMode,
      options: keepOfferedOptions(entry, { ...base.options, ...picks.options }),
      workspace,
    },
    joined,
    runner,
    diagnosticRunner,
    resolvedHarnessId: harnessId,
    entry,
    description: entry,
    menuRunnerId: joined?.runnerId ?? picks.runnerId ?? null,
  };
};

const resolveActive = (
  catalogs: ThreadCatalogs,
  thread: Extract<Thread, { kind: "active" }>,
  picks: ThreadPicks,
): ResolvedActive => {
  const { session } = thread;
  const stored = readThreadConfig(thread);
  const runner = catalogs.runners.find((each) => each.id === session.runnerId);
  const model = picks.model ?? stored.model;
  const description: ModelDescription | undefined =
    model === null
      ? undefined
      : (findProfileEntry(catalogs.modelProfiles, {
          providerAccountId: session.providerAccountId,
          harnessId: session.harnessId,
          model,
        }) ??
        findProbedModel(
          catalogs.accounts.find((each) => each.id === session.providerAccountId),
          session.harnessId,
          model,
        ));

  const modelChanges = model !== stored.model;
  // The picked options that the model offers. Without a description nothing
  // can be checked, so no pick applies and the stored options stay as they are.
  const pickedOptions = keepOfferedOptions(description, picks.options ?? {});
  // A model change clears the stored options in the controller, so only the
  // options the new model also offers carry over. Without a model change the
  // controller merges, so the stored options stay whole.
  const options = modelChanges
    ? keepOfferedOptions(description, { ...stored.options, ...picks.options })
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
    resolvedHarnessId: session.harnessId,
    description,
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
 * - account and harness: the picked ones, else the draft's. A pick that names
 *   an account but no harness runs in the account's default harness;
 * - workspace: the picked one, else the draft's, else the default the composer
 *   shows. The draft starts in that workspace;
 * - runner: the joined existing workspace's runner, else the picked runner
 *   (see `decideDraftRunnerId`);
 * - model: the picked one, else the draft's model for the draft's own account,
 *   else none;
 * - model options: the draft's own options and the picked ones, those the
 *   model's profile entry offers.
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
