import type { JSX } from "react";
import type { AccountState } from "@hercule/client-core";
import "./providers.css";

/**
 * Renders the state of an account that needs the user: what is wrong, in the
 * state's hue, such as "Key refused", and under it when, such as "at 11:57".
 * The card shows it in place of the gauge and the account sheet's Credential
 * section shows it first, so the two always say the same.
 */
export function AccountStateLine({
  state,
}: {
  readonly state: Exclude<AccountState, { kind: "ok" }>;
}): JSX.Element {
  return (
    <span className="pa-card-state">
      <span className={`pa-card-state-text is-${state.tone}`}>{state.text}</span>
      {state.detail !== null && (
        <span className={`pa-card-sub is-${state.tone}`}>{state.detail}</span>
      )}
    </span>
  );
}
