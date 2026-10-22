/**
 * What a thread runs with, and what the composer holds while the user changes
 * it. The picks are a partial config: a value the user has not touched is
 * absent, rather than a stale copy of the catalog from when the composer first
 * rendered. That lets a draft use a fresh catalog after a login without losing
 * the choices already made.
 */
import type {
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  ThreadWorkspace,
  Workspace,
} from "@hercule/contract";
import type { ShelfItem } from "../attachments/shelf";
import { buildRunnerMenu } from "./runner-menu";
import { findDefaultModel, type ThreadDefaults } from "./thread-defaults";
import type { WorkspacePick } from "./workspaces";

/**
 * What a thread runs with: the defaults a new thread starts from, plus the
 * model options and where the thread works.
 *
 * The three placement fields are optional, because a screen with no project
 * (Settings > Threads, or a thread created before projects existed) leaves
 * them out rather than setting all three to null. `workspace` is the picked
 * workspace. `null` means nothing has been picked and the default applies,
 * which is different from `{ kind: "none" }`: a thread that deliberately works
 * without a checkout.
 */
export interface ThreadConfig extends ThreadDefaults {
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly projectId?: string | null;
  readonly workspace?: WorkspacePick | null;
  /** The stored `thread.workspace` setting, or `null` while it is unset. */
  readonly preferredWorkspace?: ThreadWorkspace | null;
}

/**
 * What the user has changed since the last submission. The permission profile
 * is not included, because the composer has no control for it.
 */
export type ThreadPicks = Partial<Omit<ThreadConfig, "profileId">>;

/**
 * The unsent content the composer holds for one thread: its text and the
 * images on its shelf. A draft with images and no text can be sent.
 */
export interface MessageDraft {
  readonly text: string;
  readonly attachments: readonly ShelfItem[];
}

/**
 * Checks whether `message` holds something to send: text that is not blank,
 * or at least one image. The composer sends only such a message, and the
 * sidebar marks a thread whose composer holds one as having unsent work.
 */
export const holdsMessageContent = (message: MessageDraft): boolean =>
  message.text.trim() !== "" || message.attachments.length > 0;

/** A thread the user is still composing, or one that exists as a session. */
export type Thread =
  | { readonly kind: "draft"; readonly config: ThreadConfig }
  | { readonly kind: "active"; readonly session: Session };

export type ThreadKind = Thread["kind"];

/**
 * The records every composer view model reads. The project fields are
 * optional for the same reason as the config's placement fields: a caller
 * with no project on screen passes only what it has.
 */
export interface ThreadCatalogs {
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly thisMacRunnerId: string | null;
  readonly projects?: readonly Project[];
  readonly resources?: readonly Resource[];
  readonly workspaces?: readonly Workspace[];
  /** The sessions, used to compute how much capacity each runner has free. */
  readonly sessions?: readonly Session[];
}

/**
 * Returns what the thread runs with before any pick: the draft's own config,
 * or the config stored on the session.
 */
export const readThreadConfig = (thread: Thread): ThreadConfig =>
  thread.kind === "draft"
    ? thread.config
    : {
        instanceId: thread.session.instanceId,
        model: thread.session.modelSelection.model,
        options: thread.session.modelSelection.options,
        accessMode: thread.session.accessMode,
        runnerId: thread.session.runnerId,
        profileId: thread.session.permissionProfileId,
        projectId: thread.session.projectId,
        workspace:
          thread.session.workspaceId === null
            ? { kind: "none" }
            : { kind: "existing", workspaceId: thread.session.workspaceId },
      };

/**
 * Returns the existing workspace `config` joins, or `undefined` when it joins
 * none or the workspace is not in the catalogs. An existing workspace is on one
 * runner and never moves, so a thread that joins one runs there.
 */
export const findJoinedWorkspace = (
  catalogs: ThreadCatalogs,
  config: ThreadConfig,
): Workspace | undefined => {
  const picked = config.workspace;
  return picked?.kind === "existing"
    ? (catalogs.workspaces ?? []).find((each) => each.id === picked.workspaceId)
    : undefined;
};

/**
 * Returns what a thread runs with while the composer is open: its own config
 * with the picks applied. The model options belong to one model on one
 * instance. So the thread's stored options are kept only while the picked
 * instance and model are the ones the thread already has; for any other pair,
 * only the picked options are used.
 *
 * The picks hold only what the user chose. When they pick an account but no
 * runner, the runner is the account's default runner (or the runner of the
 * existing workspace the draft joins). When they pick no model either, the
 * model is the account's default model on that runner. These are computed here
 * on every call and never stored in the picks, so a later account change
 * cannot mistake an earlier account's default for a choice of the user. An
 * explicit `null` in the picks is a pick of "none" (an account with no models),
 * not a missing pick, so only `undefined` falls back.
 */
export const computeEffectiveConfig = (
  catalogs: ThreadCatalogs,
  base: ThreadConfig,
  picks: ThreadPicks,
): ThreadConfig => {
  const instanceId = picks.instanceId === undefined ? base.instanceId : picks.instanceId;
  const pickedInstance =
    picks.instanceId === undefined
      ? undefined
      : catalogs.instances.find((each) => each.id === picks.instanceId);
  const merged = { ...base, ...picks };
  const runnerId =
    pickedInstance === undefined || picks.runnerId !== undefined
      ? merged.runnerId
      : (findJoinedWorkspace(catalogs, merged)?.runnerId ??
        buildRunnerMenu(catalogs.runners, catalogs.thisMacRunnerId, pickedInstance)
          .defaultRunnerId);
  const model =
    picks.model !== undefined
      ? picks.model
      : pickedInstance === undefined
        ? base.model
        : findDefaultModel(pickedInstance, runnerId);
  const same = instanceId === base.instanceId && model === base.model;
  return {
    ...merged,
    instanceId,
    runnerId,
    model,
    options: same ? { ...base.options, ...picks.options } : { ...picks.options },
  };
};
