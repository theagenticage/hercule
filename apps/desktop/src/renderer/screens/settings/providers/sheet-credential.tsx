import type { JSX } from "react";
import type { AccountState } from "@hercule/client-core";
import { AccountStateLine } from "./account-state-line";
import "./providers.css";

/**
 * Renders the Credential section's body for a key or token account, in the
 * order the card uses: the account's `state` first, drawn as the card draws it
 * (so "Key refused", then when, then the provider's own words), then when the
 * credential expires, then the `button` that replaces it, "Replace key" or
 * "Make a new token".
 *
 * `expiry` is such as "Expires 31 Oct 2027", or `null` when there is nothing
 * to add: the credential does not expire, or the `state` already says it.
 */
export function SheetCredential({
  state,
  expiry,
  button,
}: {
  readonly state: AccountState;
  readonly expiry: string | null;
  readonly button: { readonly label: string; readonly onPress: () => void };
}): JSX.Element {
  return (
    <div className="pa-cred">
      {state.kind !== "ok" && <AccountStateLine state={state} />}
      {state.kind === "failed" && state.message !== null && (
        <p className="pa-cred-message" role="status">
          {state.message}
        </p>
      )}
      {expiry !== null && <p className="pa-cred-expiry">{expiry}</p>}
      <button type="button" className="btn btn--sm" onClick={button.onPress}>
        {button.label}
      </button>
    </div>
  );
}
