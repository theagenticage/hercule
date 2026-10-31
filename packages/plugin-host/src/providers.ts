/**
 * Providers as a plugin declares them: the company that serves models, the
 * ways a user can hold an account there, and the setup each way takes. The
 * core owns the accounts, their credentials and every screen; a provider
 * plugin contributes only these facts.
 */
import { Schema } from "effect";
import { SetupStep } from "./connections";
import { ContributionName, ContributionWord, QualifiedContributionId } from "./contributions";

/**
 * The setup step that signs in with the harness's own login, on a runner the
 * user picks. It belongs to account kinds only: a Connection type has no
 * harness to sign in to, so `SetupStep` does not include it.
 */
export const HarnessLoginStep = Schema.Struct({ kind: Schema.Literal("harness-login") });

export type HarnessLoginStep = Schema.Schema.Type<typeof HarnessLoginStep>;

/**
 * One step of an account kind's setup: any step a Connection type can declare,
 * or `harness-login`. The core draws every step.
 */
export const AccountSetupStep = Schema.Union([...SetupStep.members, HarnessLoginStep]);

export type AccountSetupStep = Schema.Schema.Type<typeof AccountSetupStep>;

/**
 * One way to hold an account at a provider: an API key, a subscription signed
 * in on each machine, or a subscription token. The user picks a kind when
 * adding an account, so `title` and `description` are the words that choice
 * is made with.
 */
export const AccountKind = Schema.Struct({
  /** The provider's own word for the kind, such as `api-key`. It is not qualified: a kind belongs to one provider. */
  id: ContributionWord,
  title: ContributionName,
  description: Schema.String.check(Schema.isMinLength(1)),
  setup: Schema.Array(AccountSetupStep),
  /** The qualified ids of the harnesses the provider's terms allow this kind to run in. */
  harnesses: Schema.Array(QualifiedContributionId),
});

export type AccountKind = Schema.Schema.Type<typeof AccountKind>;

/**
 * A provider's static self-description, which is all a provider plugin
 * contributes for now. `id` is the plugin's bare word; the host mints the
 * qualified id (`anthropic/anthropic`) at registration.
 */
export const ProviderDefinition = Schema.Struct({
  id: ContributionWord,
  displayName: ContributionName,
  kinds: Schema.NonEmptyArray(AccountKind),
  /**
   * The model slug this provider suggests for text generation: a small, cheap
   * model from its catalog, written as the provider's own model id. Absent
   * when the provider suggests none.
   */
  suggestedTextGenerationModel: Schema.optionalKey(Schema.NonEmptyString),
});

export type ProviderDefinition = Schema.Schema.Type<typeof ProviderDefinition>;
