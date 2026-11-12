"use no memo";
// The Inbox chunk has a size budget (spec 17 §What the Inbox costs). This file draws what is
// shown rarely or rarely changes, so the React Compiler's cache for it would cost more bytes
// than the renders it saves.

import type { JSX } from "react";
import type { ActingConnection } from "@hercule/contract";
import "./hand-account.css";

/**
 * Renders the account a hand-off acts as, "as northwind-bot", with a select to
 * pick another. It renders nothing unless there is more than one account to
 * choose from, because a single account needs no choice.
 *
 * `chosenConnectionId` is the account the user picked, or `undefined` when
 * they picked none: the select then shows the first account, which is the one
 * the controller uses by default. A pick that is no longer in
 * `actingConnections` is kept, never swapped for another account: the select
 * shows it as unable to act, and the controller refuses the hand-off with its
 * reason. `onChoose` is called with the id of the account the user picks.
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
  const isGone =
    chosenConnectionId !== undefined &&
    !actingConnections.some((connection) => connection.id === chosenConnectionId);
  if (actingConnections.length < 2 && !isGone) return null;
  return (
    <label className="hand-account">
      <span>as</span>
      <select
        aria-label="Account to act as"
        value={chosenConnectionId ?? actingConnections[0]?.id}
        onChange={(event) => {
          onChoose(event.currentTarget.value);
        }}
      >
        {isGone && (
          <option value={chosenConnectionId} disabled>
            This account can no longer act
          </option>
        )}
        {actingConnections.map((connection) => (
          <option key={connection.id} value={connection.id}>
            {connection.label}
          </option>
        ))}
      </select>
    </label>
  );
}
