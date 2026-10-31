import { Effect, Schema } from "effect";
import {
  PluginError,
  ProviderDefinition,
  type AccountKind,
  type ParseUsageBody,
  type PluginManifest,
  type ProviderRegistrationOptions,
} from "@hercule/plugin-host";
import { toPluginError } from "./errors";
import { mintQualifiedId } from "./qualified-id";
import type { NewContribution } from "./repository";

/**
 * A provider a plugin registered at boot: the plugin's declaration, with `id`
 * replaced by the qualified `<pluginId>/<word>` id the host minted at
 * registration (`anthropic/anthropic`). Every lookup, stored row and catalog
 * entry uses that id. An account kind's own id stays the provider's bare
 * word, because a kind belongs to one provider.
 */
export type RegisteredProvider = Omit<ProviderDefinition, "id"> & {
  readonly id: string;
  /** The id of the plugin that registered the provider. Read it here; never split it off `id`. */
  readonly pluginId: string;
  /**
   * The parser of each kind that reads its usage from an endpoint, by kind id.
   * Code, so it lives here and not in the stored definition.
   */
  readonly parseUsageBody: Readonly<Record<string, ParseUsageBody>>;
};

/**
 * The name a key account's key is stored under. Every key kind has one
 * `credentials` field of this name (spec 06 section 15.2), and the secret
 * migration of an old Z.ai key writes it under the same name.
 */
const API_KEY_SECRET_NAME = "apiKey";

/** The name a minted subscription token is stored under. */
const TOKEN_SECRET_NAME = "token";

/**
 * Returns the name of the Secret that holds an account's credential, decided
 * by its kind:
 *
 * - `apiKey` for a kind with a `credentials` step (a key the user types);
 * - `token` for a kind whose `harness-login` step has the method
 *   `create-token` (a token the runner makes);
 * - `undefined` for any other kind, whose login lives in the Harness Home on
 *   each runner.
 *
 * Registration refuses a kind with more than one of these sources, so at most
 * one step answers. Every place that reads or writes an account's credential
 * asks this function, so no caller repeats either name or looks at the login
 * method itself.
 */
export const findCredentialSecretName = (kind: AccountKind): string | undefined => {
  for (const step of kind.setup) {
    if (step.kind === "credentials") return API_KEY_SECRET_NAME;
    if (step.kind === "harness-login" && step.method === "create-token") return TOKEN_SECRET_NAME;
  }
  return undefined;
};

/**
 * Returns the account kind a Provider Account has, or `undefined` when this
 * build has no such provider or no such kind of it (an account can outlive
 * the plugin that registered its provider).
 */
export const findAccountKind = (
  providers: ReadonlyArray<RegisteredProvider>,
  account: { readonly providerId: string; readonly kind: string },
): AccountKind | undefined =>
  providers
    .find((provider) => provider.id === account.providerId)
    ?.kinds.find((kind) => kind.id === account.kind);

/**
 * Returns what is wrong with the setup steps of a kind, or `undefined` when
 * it is fine. A Provider Account's setup runs the steps `credentials` and
 * `harness-login` (and shows `checklist`). The core does not run an `oauth`,
 * `device` or `pairing` step for accounts yet, so a kind that declares one is
 * refused: accepting it would silently skip a step the plugin said the account
 * needs.
 */
const findUnsupportedStepProblem = (kind: AccountKind): string | undefined => {
  const unsupported = kind.setup.find(
    (step) => step.kind === "oauth" || step.kind === "device" || step.kind === "pairing",
  );
  return unsupported === undefined
    ? undefined
    : `it declares the setup step ${unsupported.kind}, which the core does not run for Provider Accounts yet; use a credentials step or a harness-login step`;
};

/**
 * Returns what is wrong with the credential sources a kind declares, or
 * `undefined` when it is fine. A kind has at most one `credentials` step, at
 * most one `harness-login` step, and never a `credentials` step together with
 * a `harness-login` step that creates a token: an account stores one
 * credential, so a second source would be ignored.
 */
const findCredentialSourceProblem = (kind: AccountKind): string | undefined => {
  const credentialsSteps = kind.setup.filter((step) => step.kind === "credentials");
  const loginSteps = kind.setup.filter((step) => step.kind === "harness-login");
  if (credentialsSteps.length > 1) {
    return "it has more than one credentials step; declare one credentials step with all the fields";
  }
  if (loginSteps.length > 1) {
    return "it has more than one harness-login step; declare one";
  }
  if (credentialsSteps.length > 0 && loginSteps.some((step) => step.method === "create-token")) {
    return "it has both a credentials step and a harness-login step with the method create-token, which are two credential sources; declare a separate account kind for each";
  }
  return undefined;
};

/**
 * Returns what is wrong with a request the controller makes with an account's
 * key, or `undefined` when it is fine. `name` is how the problem names the
 * request (`keyCheck`, `usage`). The URL must be a fixed `https://` URL
 * without placeholders, and a header value may hold the placeholder `{apiKey}`
 * and no other braces. At least one header value must hold `{apiKey}`: a
 * request that does not send the key would let a public endpoint answer for
 * every key. The controller sends the key in those headers, so anything else
 * could send it somewhere it was not meant to go.
 */
const findKeyRequestProblem = (
  name: string,
  request: { readonly url: string; readonly headers: Readonly<Record<string, string>> },
): string | undefined => {
  const url = URL.parse(request.url);
  if (url === null || url.protocol !== "https:" || /[{}]/.test(request.url)) {
    return `its ${name} url ${request.url} is not a fixed https:// URL`;
  }
  const headers = Object.entries(request.headers);
  for (const [header, value] of headers) {
    if (/[{}]/.test(value.replaceAll("{apiKey}", ""))) {
      return `its ${name} header ${header} holds a placeholder other than {apiKey}`;
    }
  }
  if (!headers.some(([, value]) => value.includes("{apiKey}"))) {
    return `its ${name} sends no key, so any key would pass; put {apiKey} in a header value, for example authorization: Bearer {apiKey}`;
  }
  return undefined;
};

/**
 * Returns what is wrong with a kind's `keyCheck`, or `undefined` when it is
 * fine. A kind with a `credentials` step must declare one, and it must pass
 * `findKeyRequestProblem`.
 */
const findKeyCheckProblem = (kind: AccountKind): string | undefined => {
  const holdsKey = kind.setup.some((step) => step.kind === "credentials");
  const { keyCheck } = kind;
  if (keyCheck === undefined) {
    return holdsKey
      ? "it takes an API key but declares no keyCheck; a key that cannot be checked is never stored, so declare the request that checks it"
      : undefined;
  }
  return findKeyRequestProblem("keyCheck", keyCheck);
};

/**
 * Returns what is wrong with a kind's `usage`, or `undefined` when it is fine
 * or absent:
 *
 * - `harness` must name a harness the kind lists in `harnesses`, because the
 *   usage is read by probing the account in that harness.
 * - `endpoint` needs a `credentials` step, because the read is made with the
 *   account's key, and its request must pass `findKeyRequestProblem`.
 */
const findUsageProblem = (kind: AccountKind): string | undefined => {
  const { usage } = kind;
  if (usage === undefined || usage.readBy === "sessions") return undefined;
  if (usage.readBy === "harness") {
    return kind.harnesses.includes(usage.harnessId)
      ? undefined
      : `its usage is read through the harness ${usage.harnessId}, which the kind does not list in harnesses; list it, or read the usage another way`;
  }
  if (!kind.setup.some((step) => step.kind === "credentials")) {
    return "its usage is read from an endpoint with the account's key, but the kind has no credentials step and so holds no key; read the usage through a harness or from sessions";
  }
  return findKeyRequestProblem("usage", usage);
};

/** The name of the provider extension point in the catalog. */
const PROVIDER = "provider";

// An unknown key fails the decode rather than being stripped: dropping a field
// the host does not know would make an unserializable value look accepted.
const decodeProvider = Schema.decodeUnknownEffect(ProviderDefinition, {
  errors: "all",
  onExcessProperty: "error",
});

/**
 * Validates a provider definition and adds it to this registration pass: a
 * catalog row in `declared` and the in-memory entry in `live`. Fails with a
 * `PluginError` for a definition that does not decode, whose qualified id is
 * too long, that declares an account kind twice, that has an account kind whose
 * credentials step is not exactly one field named `apiKey`, that has an account
 * kind with two credential sources (see `findCredentialSourceProblem`), that has
 * an `oauth`, `device` or `pairing` setup step (see `findUnsupportedStepProblem`), that has
 * a key kind without a valid `keyCheck` (one that sends the key), a kind whose `usage` is invalid (see `findUsageProblem`), an `endpoint` kind with no parser or a parser for any other kind, one of whose account kinds does not list the provider's `defaultHarnessId`
 * or its `catalogSource.harnessId`, or that the plugin registered twice.
 *
 * The harnesses an account kind lists are qualified ids and are not checked
 * against the harnesses that are loaded: their plugin may be absent or
 * disabled, and a client then shows the harness as unavailable.
 */
export const registerProviderContribution = (
  manifest: PluginManifest,
  definition: ProviderDefinition,
  declared: Array<NewContribution>,
  live: Array<RegisteredProvider>,
  options: ProviderRegistrationOptions = {},
): Effect.Effect<void, PluginError> =>
  Effect.gen(function* () {
    const decoded = yield* decodeProvider(definition).pipe(Effect.mapError(toPluginError));
    const id = yield* mintQualifiedId(manifest.id, PROVIDER, decoded.id);
    const kindIds = new Set<string>();
    for (const kind of decoded.kinds) {
      if (kindIds.has(kind.id)) {
        return yield* Effect.fail(
          new PluginError({
            message: `the provider ${id} declares the account kind ${kind.id} more than once`,
          }),
        );
      }
      kindIds.add(kind.id);
      // A key account stores one Secret, named `apiKey`, and the controller
      // reads only that one when it sends a harness the key (spec 06 section
      // 15.2). A kind with other fields would accept values that are never
      // used.
      for (const step of kind.setup) {
        if (step.kind !== "credentials") continue;
        if (step.fields.length !== 1 || step.fields[0]?.name !== API_KEY_SECRET_NAME) {
          return yield* Effect.fail(
            new PluginError({
              message:
                `the account kind ${kind.id} of the provider ${id} has a credentials step with ` +
                `the fields ${step.fields.map((field) => field.name).join(", ") || "(none)"}; ` +
                `a credentials step must have exactly one field, named ${API_KEY_SECRET_NAME}`,
            }),
          );
        }
      }
      const unsupportedStepProblem = findUnsupportedStepProblem(kind);
      if (unsupportedStepProblem !== undefined) {
        return yield* Effect.fail(
          new PluginError({
            message: `the account kind ${kind.id} of the provider ${id}: ${unsupportedStepProblem}`,
          }),
        );
      }
      const credentialSourceProblem = findCredentialSourceProblem(kind);
      if (credentialSourceProblem !== undefined) {
        return yield* Effect.fail(
          new PluginError({
            message: `the account kind ${kind.id} of the provider ${id}: ${credentialSourceProblem}`,
          }),
        );
      }
      const keyCheckProblem = findKeyCheckProblem(kind);
      if (keyCheckProblem !== undefined) {
        return yield* Effect.fail(
          new PluginError({
            message: `the account kind ${kind.id} of the provider ${id}: ${keyCheckProblem}`,
          }),
        );
      }
      const usageProblem = findUsageProblem(kind);
      if (usageProblem !== undefined) {
        return yield* Effect.fail(
          new PluginError({
            message: `the account kind ${kind.id} of the provider ${id}: ${usageProblem}`,
          }),
        );
      }
    }
    // The parsers and the `endpoint` kinds must match one to one: a kind
    // without its parser could never be read, and a parser for another kind
    // would never run.
    const parseUsageBody = options.parseUsageBody ?? {};
    for (const kind of decoded.kinds) {
      if (kind.usage?.readBy === "endpoint" && parseUsageBody[kind.id] === undefined) {
        return yield* Effect.fail(
          new PluginError({
            message: `the account kind ${kind.id} of the provider ${id} reads its usage from an endpoint but registers no parseUsageBody for it; pass a parser for ${kind.id} beside the definition`,
          }),
        );
      }
    }
    for (const kindId of Object.keys(parseUsageBody)) {
      if (decoded.kinds.find((kind) => kind.id === kindId)?.usage?.readBy !== "endpoint") {
        return yield* Effect.fail(
          new PluginError({
            message: `the provider ${id} registers a parseUsageBody for ${kindId}, which is not an account kind that reads its usage from an endpoint; remove it, or declare usage readBy endpoint on the kind`,
          }),
        );
      }
    }
    // `providerAccount.create` gives every new account the provider's default
    // harness, whatever its kind, so each kind must allow it.
    const kindsWithoutDefault = decoded.kinds.filter(
      (kind) => !kind.harnesses.includes(decoded.defaultHarnessId),
    );
    if (kindsWithoutDefault.length > 0) {
      return yield* Effect.fail(
        new PluginError({
          message: `the provider ${id} has the default harness ${decoded.defaultHarnessId}, which its account kinds ${kindsWithoutDefault.map((kind) => kind.id).join(", ")} do not list; every account kind must list the default harness, because a new account of any kind starts with it`,
        }),
      );
    }
    // An account's Model Catalog is read by probing this harness, so an
    // account of a kind that cannot run in it would never get a catalog.
    const kindsWithoutCatalogSource = decoded.kinds.filter(
      (kind) => !kind.harnesses.includes(decoded.catalogSource.harnessId),
    );
    if (kindsWithoutCatalogSource.length > 0) {
      return yield* Effect.fail(
        new PluginError({
          message: `the provider ${id} reads its Model Catalog from the harness ${decoded.catalogSource.harnessId}, which its account kinds ${kindsWithoutCatalogSource.map((kind) => kind.id).join(", ")} do not list; every account kind must list the catalog source harness, or an account of that kind could never be read`,
        }),
      );
    }
    if (declared.some((row) => row.extensionPoint === PROVIDER && row.id === id)) {
      return yield* Effect.fail(
        new PluginError({ message: `the ${PROVIDER} contribution ${id} is registered twice` }),
      );
    }
    declared.push({
      owner: manifest.id,
      extensionPoint: PROVIDER,
      id,
      definition: { ...decoded, id },
    });
    live.push({ ...decoded, id, pluginId: manifest.id, parseUsageBody });
  });
