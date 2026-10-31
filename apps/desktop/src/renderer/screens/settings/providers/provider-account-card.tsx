import type { JSX, ReactNode } from "react";
import type {
  AccountFix,
  AccountState,
  AccountUsage,
  ProviderAccountIdentityLine,
} from "@hercule/client-core";
import { FleetIcon } from "../../../icons/fleet";
import { AccountStateLine } from "./account-state-line";
import { IdentityLine } from "./identity-line";
import { UsageGauge } from "./usage-gauge";
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
 * Renders the card of one Provider Account: a button that opens its sheet,
 * holding the provider's `mark`, the account's `name`, the `identity` line
 * under it, where the account works, and then one of two things:
 *
 * - the account's `state`, when it needs the user: what is wrong, and a
 *   second button under the card that fixes it, which calls `onFix`. The card
 *   takes the state's hue. The fix is a button of its own and not part of the
 *   card's button, because a button cannot hold a button;
 * - else the usage `usage` as a gauge, with when it was read. An account with
 *   no usage has no gauge.
 *
 * `machines` lists the machines of an account that signs in on each one,
 * drawn as pips beside the name. It is `null` for an account whose
 * credential every machine uses, which the card says in words under the
 * identity line.
 */
export function ProviderAccountCard({
  mark,
  name,
  identity,
  machines,
  usage,
  state,
  onOpen,
  onFix,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly identity: ProviderAccountIdentityLine;
  readonly machines: ReadonlyArray<MachinePip> | null;
  readonly usage: AccountUsage | null;
  readonly state: AccountState;
  readonly onOpen: () => void;
  readonly onFix: (fix: AccountFix) => void;
}): JSX.Element {
  const fix = state.kind === "ok" ? null : state.fix;
  return (
    <div className={state.kind === "ok" ? "pa-card" : `pa-card is-${state.tone}`}>
      <button
        type="button"
        className={fix === null ? "pa-card-open" : "pa-card-open has-foot"}
        title={`Open ${name}`}
        onClick={onOpen}
      >
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
        {state.kind !== "ok" ? (
          <AccountStateLine state={state} />
        ) : (
          usage !== null && <UsageGauge usage={usage} />
        )}
      </button>
      {fix !== null && (
        <div className="pa-card-foot">
          <button
            type="button"
            className={`pa-card-fix is-${state.kind === "ok" ? "fail" : state.tone}`}
            onClick={() => onFix(fix)}
          >
            {fix.label}
          </button>
        </div>
      )}
    </div>
  );
}
