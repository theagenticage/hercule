import type { JSX } from "react";
import { findActingConnection } from "@hercule/client-core/inbox";
import type { ActingConnection } from "@hercule/contract";
import "./hand-account.css";

/**
 * Renders the account a hand-off acts as, "as northwind-bot", with a select to
 * pick another. It renders nothing unless there is more than one account to
 * choose from, because a single account needs no choice.
 *
 * `chosenConnectionId` is the account in use. When it is not one of
 * `actingConnections`, the first account is shown, which is the default.
 * `onChoose` is called with the id of the account the user picks.
 */
export function HandAccount({
  actingConnections,
  chosenConnectionId,
  onChoose,
}: {
  readonly actingConnections: readonly ActingConnection[];
  readonly chosenConnectionId: string | undefined;
  readonly onChoose: (connectionId: string) => void;
}): JSX.Element | null {
  const chosen = findActingConnection(actingConnections, chosenConnectionId);
  if (chosen === undefined || actingConnections.length < 2) return null;
  return (
    <label className="hand-account">
      <span>as</span>
      <select
        aria-label="Account to act as"
        value={chosen.id}
        onChange={(event) => {
          onChoose(event.currentTarget.value);
        }}
      >
        {actingConnections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.label}
          </option>
        ))}
      </select>
    </label>
  );
}
