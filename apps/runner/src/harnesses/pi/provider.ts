/**
 * Reads pi's name for a model provider from an account's model argument. pi
 * names a model as `<provider>/<model id>`, and takes the provider again by
 * itself in `set_model`, in `auth check --provider`, and in its model list. The
 * account's model argument is the one place the controller says which provider
 * the account is for, so the adapter reads the name from there.
 */

/** The ending that marks the model id in a pi model argument. */
const MODEL_SUFFIX = "/{model}";

/**
 * Returns the pi provider in a model argument of the form `<provider>/{model}`
 * (`zai/{model}` gives `zai`). Throws an `Error` that names the argument when
 * it has another form, because pi cannot pick a model without a provider.
 */
export const readPiProvider = (modelArgument: string): string => {
  const provider = modelArgument.endsWith(MODEL_SUFFIX)
    ? modelArgument.slice(0, -MODEL_SUFFIX.length)
    : "";
  if (provider === "" || provider.includes("/") || provider.includes("{")) {
    throw new Error(
      `pi needs a model argument of the form <provider>/{model}, but this account's is "${modelArgument}"`,
    );
  }
  return provider;
};
