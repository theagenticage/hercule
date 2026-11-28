/**
 * A helper for tests of the hooks that take an account scope: opens the scope
 * of the user "ada" on a test controller, over `client` and `queryClient`,
 * with the intents kept in the page's `localStorage`.
 */
import type { QueryClient } from "@tanstack/react-query";
import type { HerculeClient } from "@hercule/client-core";
import { createAccountScopes, type AccountScope, type AccountScopes } from "./account-scope";

/**
 * Returns the holder for a test controller and the scope of "ada" it opened.
 * Closing the holder is what sign-out does.
 */
export const openTestAccountScope = (
  client: HerculeClient,
  queryClient: QueryClient,
): { readonly scopes: AccountScopes; readonly scope: AccountScope } => {
  const scopes = createAccountScopes({
    controllerUrl: "http://127.0.0.1:4937",
    client,
    queryClient,
    storage: localStorage,
  });
  return { scopes, scope: scopes.open("ada") };
};
