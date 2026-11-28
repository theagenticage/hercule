import * as Context from "effect/Context";
import type * as Effect from "effect/Effect";
import type { SqlError } from "effect/sql/SqlError";

/**
 * A profile that cannot be read or written because the database fails. A
 * stored body that no longer decodes is a defect (the implementation dies),
 * because the controller wrote it itself.
 */
type MembershipError = SqlError;

/**
 * The models an account puts into a Model Profile when its first catalog read
 * lands: their slugs in catalog order, and the one the provider marks as its
 * default, if it is among them.
 */
export interface DefaultSelection {
  readonly models: ReadonlyArray<string>;
  readonly defaultModel: string | null;
}

/**
 * A model that a profile would list twice in one section if the account's
 * default harness changed: the profile's name and the model's slug.
 */
export interface DefaultHarnessClash {
  readonly profileName: string;
  readonly model: string;
}

/**
 * What the provider-accounts domain needs from Model Profiles: to take an
 * account out of every profile when the account is deleted, to fill the
 * profile sections that wait for the account's first catalog read, and to
 * learn whether a new default harness would break a profile.
 *
 * Profiles are kept in another domain that depends on this one, so this
 * domain cannot import it. It declares what it needs as this service, and the
 * model-profiles domain provides it over the profile table. All three methods
 * run in the caller's transaction, so the profiles and the account change
 * together.
 */
export class ModelProfileMembership extends Context.Service<
  ModelProfileMembership,
  {
    /**
     * Removes the account from every profile that holds it, moving a default
     * entry that belonged to the account to the profile's first remaining
     * entry (or to none), and raising the revision of each profile it changed.
     */
    readonly removeProviderAccount: (
      providerAccountId: string,
    ) => Effect.Effect<void, MembershipError>;
    /**
     * Gives the account's Default Selection to every profile section of the
     * account that has none yet. Returns whether any profile changed. It
     * changes nothing when no section is waiting, so it is safe to call after
     * every successful catalog read. Every selected model is added, even one
     * the section's harness is known not to list: that entry then shows
     * `harness-lacks-model` on read, and nothing is dropped silently.
     */
    readonly fillPendingSelections: (
      providerAccountId: string,
      selection: DefaultSelection,
    ) => Effect.Effect<boolean, MembershipError>;
    /**
     * Lists the models that would appear twice in one section if the account's
     * default harness became `defaultHarnessId`. An entry that follows the
     * account's default harness moves with it, and lands on an entry of the
     * same model that already names `defaultHarnessId`. A profile is checked
     * as stored; nothing is changed.
     */
    readonly findDefaultHarnessClashes: (
      providerAccountId: string,
      defaultHarnessId: string,
    ) => Effect.Effect<ReadonlyArray<DefaultHarnessClash>, MembershipError>;
  }
>()("hercule/controller/provider-accounts/ModelProfileMembership") {}
