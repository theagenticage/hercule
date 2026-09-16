/**
 * What a thread runs with, and what the composer holds while the user changes
 * it. The picks are a partial config, so a value the user has not touched is
 * absent rather than a stale copy of what the catalog said when the composer
 * first rendered: that is what lets a draft pick up a fresh catalog after a
 * login without losing the choices already made.
 */
import type {
  Project,
  ProviderInstance,
  Resource,
  Runner,
  Session,
  ThreadWorkspace,
  Workspace,
} from "@hydra/contract";
import type { ThreadDefaults } from "./thread-defaults";
import type { WorkspacePick } from "./workspaces";

/**
 * What a thread runs with: the defaults a new one starts from, plus the
 * per-model choices and where it works.
 *
 * The three placement fields are optional because a surface that has no
 * project to speak of - Settings > Threads, a thread that predates them - says
 * nothing about them rather than saying null three times. `workspace` is the
 * pick in the config: `null` means nothing has been picked and the default
 * stands, which is not the same as `{ kind: "none" }`, a thread deliberately
 * working without a checkout.
 */
export interface ThreadConfig extends ThreadDefaults {
  readonly options: Readonly<Record<string, string | boolean>>;
  readonly projectId?: string | null;
  readonly workspace?: WorkspacePick | null;
  /** The stored `thread.workspace` setting; null while it is unset. */
  readonly preferredWorkspace?: ThreadWorkspace | null;
}

/**
 * What the user has touched since the last submission. The permission profile
 * is not among them: nothing in the composer offers it.
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
 * The records every composer view model reads. The last three are optional for
 * the same reason the config's placement fields are: a caller with no project
 * surface at all hands over what it has.
 */
export interface ThreadCatalogs {
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly localRunnerId: string | null;
  readonly projects?: readonly Project[];
  readonly resources?: readonly Resource[];
  readonly workspaces?: readonly Workspace[];
}

/**
 * What the thread itself runs with, before any pick: the draft's own config,
 * or what the session was spawned with and still carries.
 */
export const threadConfig = (thread: Thread): ThreadConfig =>
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
 * What a thread runs with while the composer is open: its own configuration
 * with the picks over it. The per-model choices belong to the model that
 * offered them on the account that offered it, so they stand over what the
 * thread stored only while both are the ones it stored them for; any other
 * pair shows its own defaults.
 */
export const effectiveConfig = (base: ThreadConfig, picks: ThreadPicks): ThreadConfig => {
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
