import type { JSX, ReactNode } from "react";
import type {
  AccountFix,
  AccountState,
  AccountUsageGauge,
  ProviderAccountIdentityLine,
} from "@hercule/client-core";
import { CheckIcon } from "../../../icons/check";
import { FleetIcon } from "../../../icons/fleet";
import { PlusIcon } from "../../../icons/plus";
import { AccountStateLine } from "./account-state-line";
import { IdentityLine } from "./identity-line";
import { ProfileFace } from "./profile-face";
import { UsageGauge } from "./usage-gauge";
import "./providers.css";

/** One machine of a per-machine account, as its card draws it. */
export interface MachinePip {
  readonly runnerName: string;
  /** Whether the account is signed in on the machine. */
  readonly signedIn: boolean;
}

/** How an account stands with the Model Profiles, as its card draws it. */
export interface ProfileUse {
  /** The profiles that hold the account, in the profiles' order. */
  readonly holders: ReadonlyArray<{ readonly id: string; readonly name: string }>;
  /** The name of the profile open on the Models section. */
  readonly openName: string;
  /** Whether the open profile holds the account. */
  readonly inOpen: boolean;
  /** Whether there is more than one profile. With one, the card does not draw the faces. */
  readonly severalProfiles: boolean;
  /** Whether adding the account to the open profile is waiting or running. */
  readonly saving: boolean;
  /** The message of the last refused addition to the open profile, or `null`. */
  readonly error: string | null;
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
 * `profileUse` is how the account stands with the Model Profiles, or `null`
 * when there is no profile. Under the body is a foot with the faces of the
 * profiles that hold the account at the left (with one profile, the words "Not
 * in the menu" for an account it does not hold) and, at the right, "In
 * <profile>" when the open profile holds it or a button "Use in <profile>"
 * that calls `onUse`. With one profile, an account it holds has no foot. A card
 * the open profile does not hold is drawn dimmed. The button is a sibling of
 * the card's button, so pressing it never opens the sheet.
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
  profileUse,
  onOpen,
  onFix,
  onUse,
}: {
  readonly mark: ReactNode;
  readonly name: string;
  readonly identity: ProviderAccountIdentityLine;
  readonly machines: ReadonlyArray<MachinePip> | null;
  readonly usage: AccountUsageGauge | null;
  readonly state: AccountState;
  readonly profileUse: ProfileUse | null;
  readonly onOpen: () => void;
  readonly onFix: (fix: AccountFix) => void;
  readonly onUse: () => void;
}): JSX.Element {
  const fix = state.kind === "ok" ? null : state.fix;
  const tone = state.kind === "ok" ? null : state.tone;
  const hasProfileFoot = profileUse !== null && (profileUse.severalProfiles || !profileUse.inOpen);
  const classes = [
    "pa-card",
    tone === null ? null : `is-${tone}`,
    profileUse === null ? null : profileUse.inOpen ? "is-member" : "is-out",
  ];
  return (
    <div className={classes.filter(Boolean).join(" ")}>
      <button
        type="button"
        className={fix === null && !hasProfileFoot ? "pa-card-open" : "pa-card-open has-foot"}
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
      {fix !== null && tone !== null && (
        <div className="pa-card-foot">
          <button type="button" className={`pa-card-fix is-${tone}`} onClick={() => onFix(fix)}>
            {fix.label}
          </button>
        </div>
      )}
      {profileUse !== null && hasProfileFoot && <ProfileFoot use={profileUse} onUse={onUse} />}
    </div>
  );
}

/**
 * Renders the foot of a card that tells which profiles use the account: see
 * `ProviderAccountCard`. A refused addition shows under the foot.
 */
function ProfileFoot({
  use,
  onUse,
}: {
  readonly use: ProfileUse;
  readonly onUse: () => void;
}): JSX.Element {
  const names = use.holders.map(({ name }) => name).join(", ");
  return (
    <div className="pa-card-profiles">
      <div className="pa-card-foot">
        {use.severalProfiles && use.holders.length > 0 ? (
          <span className="pa-card-faces" role="img" aria-label={`Used in ${names}`} title={names}>
            {use.holders.map(({ id, name }) => (
              <ProfileFace key={id} name={name} size="xs" />
            ))}
          </span>
        ) : (
          <span className="pa-card-out">
            {use.severalProfiles ? "No profile yet" : "Not in the menu"}
          </span>
        )}
        {use.inOpen ? (
          <span className="pa-card-in">
            <CheckIcon size={11} />
            {`In ${use.openName}`}
          </span>
        ) : (
          <button type="button" className="pa-card-use" disabled={use.saving} onClick={onUse}>
            <PlusIcon size={11} />
            {use.saving ? "Adding…" : use.severalProfiles ? `Use in ${use.openName}` : "Use"}
          </button>
        )}
      </div>
      {use.error === null ? null : (
        <p className="pa-card-err" role="alert">
          {use.error}
        </p>
      )}
    </div>
  );
}
