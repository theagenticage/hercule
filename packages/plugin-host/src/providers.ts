/**
 * Providers as a plugin declares them: the company that serves models, the
 * ways a user can hold an account there, and the setup each way takes. The
 * core owns the accounts, their credentials and every screen; a provider
 * plugin contributes only these facts.
 */
import { Schema } from "effect";
import { LoginMethod, type Timestamp, type UsageReading } from "@hercule/protocol";
import { SetupStep } from "./connections";
import { ContributionName, ContributionWord, QualifiedContributionId } from "./contributions";

/**
 * The setup step that runs the harness's own login, on a runner the user
 * picks. It belongs to account kinds only: a Connection type has no harness to
 * sign in to, so `SetupStep` does not include it.
 *
 * - `method: "sign-in"` leaves the login in the account's Harness Home on that
 *   runner, so the account works only on runners where it was signed in.
 * - `method: "create-token"` makes a long-lived token. The controller stores
 *   it as the account's credential, so the account works on every runner.
 */
export const HarnessLoginStep = Schema.Struct({
  kind: Schema.Literal("harness-login"),
  method: LoginMethod,
});

export type HarnessLoginStep = Schema.Schema.Type<typeof HarnessLoginStep>;

/**
 * One step of an account kind's setup: any step a Connection type can declare,
 * or `harness-login`. The core draws every step.
 */
export const AccountSetupStep = Schema.Union([...SetupStep.members, HarnessLoginStep]);

export type AccountSetupStep = Schema.Schema.Type<typeof AccountSetupStep>;

/**
 * How the controller checks that an API key is accepted before it stores the
 * key (spec 06 section 15.2): one GET request, answered with a 2xx status for
 * a good key.
 *
 * - `url` is a fixed `https://` URL. The controller does not follow redirects,
 *   because a redirect would carry the key to another host.
 * - `headers` are sent with the request. A value may contain the placeholder
 *   `{apiKey}`, which the controller replaces with the key (`Bearer {apiKey}`).
 *   No other placeholder is allowed.
 */
export const KeyCheck = Schema.Struct({
  url: Schema.String.check(Schema.isMinLength(1)),
  headers: Schema.Record(Schema.String, Schema.String),
});

export type KeyCheck = Schema.Schema.Type<typeof KeyCheck>;

/**
 * What a provider's usage endpoint answered, turned into readings or a refusal.
 * `body` is the parsed JSON of a 2xx answer. `takenAt` is the time the
 * controller received the answer, and the parser puts it on every reading
 * unchanged: the controller owns the clock, so a parser is a pure function of
 * what it is given. `refused` is the provider's own words for why it rejected
 * the credential (spec 06 section 15.6). A body that is not the expected
 * shape is a defect of the plugin and is thrown, not returned.
 */
export type ParseUsageBody = (
  body: unknown,
  takenAt: Timestamp,
) => { readonly readings: ReadonlyArray<UsageReading> } | { readonly refused: string };

/**
 * How an Account Kind's Account Usage is read (spec 06 section 18). A kind
 * that declares none shows no usage, and usage that running sessions report for
 * it is dropped.
 *
 * - `sessions`: the account's running sessions report it. Nothing else reads it.
 * - `harness`: running sessions report it, and the controller also reads it
 *   through the probe of the harness `harnessId`.
 * - `endpoint`: running sessions report it, and the controller also reads it
 *   with the account's key: one GET request to `url` with `headers`. `url` and
 *   `headers` follow the rules of `KeyCheck`, and only a kind with a
 *   `credentials` step can declare this. The function that turns the response
 *   body into readings is code, not data, so the plugin passes it beside the
 *   definition when it registers the provider (`ProviderRegistrationOptions`).
 */
export const AccountUsageDeclaration = Schema.Union([
  Schema.Struct({ readBy: Schema.Literal("sessions") }),
  Schema.Struct({ readBy: Schema.Literal("harness"), harnessId: QualifiedContributionId }),
  Schema.Struct({
    readBy: Schema.Literal("endpoint"),
    ...KeyCheck.fields,
  }),
]);

export type AccountUsageDeclaration = Schema.Schema.Type<typeof AccountUsageDeclaration>;

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
  /**
   * How to check a key before it is stored. The host refuses a kind whose setup
   * has a `credentials` step and no `keyCheck`, because a key that could not be
   * checked is never stored.
   */
  keyCheck: Schema.optionalKey(KeyCheck),
  /** How the account's usage is read. Absent when the kind has no usage to show. */
  usage: Schema.optionalKey(AccountUsageDeclaration),
  /** The qualified ids of the harnesses the provider's terms allow this kind to run in. */
  harnesses: Schema.Array(QualifiedContributionId),
});

export type AccountKind = Schema.Schema.Type<typeof AccountKind>;

/**
 * Where the controller reads a provider's Model Catalog from. Only one source
 * exists so far: probing a harness.
 *
 * - `harness-probe` reads the catalog from the list of models that a probe of
 *   `harnessId` returns for the account, on a runner where the account is
 *   ready in that harness. A probe of any other harness never changes the
 *   catalog.
 */
export const CatalogSource = Schema.Struct({
  kind: Schema.Literal("harness-probe"),
  /** The qualified id of the harness to probe, such as `claude-code/claude-code`. */
  harnessId: QualifiedContributionId,
});

export type CatalogSource = Schema.Schema.Type<typeof CatalogSource>;

/**
 * Which models of a provider's catalog go into a Model Profile when the
 * account is first added to it (spec 06 section 17).
 *
 * - `current-models`: every model the catalog read returned that is not marked
 *   legacy, in the catalog's order.
 * - `none`: nothing. The user picks each model.
 */
export const DefaultSelection = Schema.Literals(["current-models", "none"]);

export type DefaultSelection = Schema.Schema.Type<typeof DefaultSelection>;

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
   * The qualified id of the harness a new account of this provider starts with,
   * such as `claude-code/claude-code`. Every one of the provider's account kinds
   * lists it in `harnesses`, because a new account of any kind starts with it. The harness need not be installed anywhere yet.
   */
  defaultHarnessId: QualifiedContributionId,
  /**
   * Where the controller reads an account's Model Catalog from. The host
   * refuses a provider when one of its account kinds does not list
   * `catalogSource.harnessId` in `harnesses`, because an account of that kind
   * could never be read.
   */
  catalogSource: CatalogSource,
  /** Which models of the catalog an account brings into a Model Profile when it is first added. */
  defaultSelection: DefaultSelection,
  /**
   * The model slug this provider suggests for text generation: a small, cheap
   * model from its catalog, written as the provider's own model id. Absent
   * when the provider suggests none.
   */
  suggestedTextGenerationModel: Schema.optionalKey(Schema.NonEmptyString),
});

export type ProviderDefinition = Schema.Schema.Type<typeof ProviderDefinition>;
