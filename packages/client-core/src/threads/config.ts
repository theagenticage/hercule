/**
 * What a thread runs with, and what the composer holds while the user changes
 * it. The picks are a partial config, so a value the user has not touched is
 * absent rather than a stale copy of what the catalog said when the composer
 * first rendered: that is what lets a draft pick up a fresh catalog after a
 * login without losing the choices already made.
 */
import type { ProviderInstance, Runner, Session } from "@hydra/contract";
import type { ThreadDefaults } from "./thread-defaults";

/** What a thread runs with: the defaults a new one starts from, plus the per-model choices. */
export interface ThreadConfig extends ThreadDefaults {
  readonly options: Readonly<Record<string, string | boolean>>;
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

/** The fleet and the provider instances every composer view model reads. */
export interface ThreadCatalogs {
  readonly instances: readonly ProviderInstance[];
  readonly runners: readonly Runner[];
  readonly localRunnerId: string | null;
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
