import type { JSX, ReactNode } from "react";
import type { AccountIdentityLine } from "@hercule/client-core";
import { FleetIcon } from "../../../icons/fleet";
import { IdentityLine } from "./identity-line";
import "./providers.css";

/** One machine of a per-machine account, as its card draws it. */
export interface MachinePip {
  readonly runnerName: string;
  /** Whether the account is signed in on the machine. */
  readonly signedIn: boolean;
}

/** Returns what a pip says, such as "moss: ready", for its tooltip and its accessible name. */
const describePip = ({ runnerName, signedIn }: MachinePip): string =>
  `${runnerName}: ${signedIn ? "ready" : "not signed in"}`;

/**
 * Renders the fleet icon and one pip for each machine: filled where the
 * account is signed in, a ring where it is not. Renders nothing when there
 * is no machine to show.
 */
function MachinePips({
  machines,
}: {
  readonly machines: ReadonlyArray<MachinePip>;
}): JSX.Element | null {
  if (machines.length === 0) return null;
  const description = machines.map(describePip).join(" · ");
  return (
    <span className="pa-pips" role="img" aria-label={description} title={description}>
      <FleetIcon size={11} />
      {machines.map((machine) => (
        <i key={machine.runnerName} className={machine.signedIn ? "pa-pip" : "pa-pip is-you"} />
      ))}
    </span>
  );
}

/**
 * Renders the card of one Provider Account as a single button that opens its
 * sheet: the provider's `mark`, the account's `name`, the `identity`
 * line under it, and where the account works.
 *
 * `machines` lists the machines of an account that signs in on each one,
 * drawn as pips beside the name. It is `null` for an account whose
 * credential every machine uses, which the card says in words under the
 * identity line.
 */
export function AccountCard({
  mark,
  name,
  identity,
  machines,
  onOpen,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly identity: AccountIdentityLine;
  readonly machines: ReadonlyArray<MachinePip> | null;
  readonly onOpen: () => void;
}): JSX.Element {
  return (
    <button type="button" className="pa-card" title={`Open ${name}`} onClick={onOpen}>
      <span className="pa-card-top">
        {mark}
        <b>{name}</b>
        {machines !== null && <MachinePips machines={machines} />}
      </span>
      <IdentityLine line={identity} className="pa-card-identity" />
      {machines === null && (
        <span className="pa-card-reach">
          <FleetIcon size={11} />
          Every machine
        </span>
      )}
    </button>
  );
}
