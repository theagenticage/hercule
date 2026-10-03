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
import type { ThreadDefaults } from "./thread-defaults";
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

/** The unsent content the composer holds for one thread. */
export interface MessageDraft {
  readonly text: string;
}

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
 * Returns what a thread runs with while the composer is open: its own config
 * with the picks applied. The model options belong to one model on one
 * instance. So the thread's stored options are kept only while the picked
 * instance and model are the ones the thread already has; for any other pair,
 * only the picked options are used.
 */
export const computeEffectiveConfig = (base: ThreadConfig, picks: ThreadPicks): ThreadConfig => {
  const instanceId = picks.instanceId ?? base.instanceId;
  const model = picks.model ?? base.model;
  const same = instanceId === base.instanceId && model === base.model;
  return {
    ...base,
    ...picks,
    model,
    options: same ? { ...base.options, ...picks.options } : { ...picks.options },
  };
};
