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

export type ThreadPicks = Partial<ThreadConfig>;

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
